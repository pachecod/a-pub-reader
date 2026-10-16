// Storage for images placed in drafts.
//
// Uploads are normalized on the way in — decoded, downscaled, and re-encoded in
// a format the firmware decodes — so a 12 MP phone photo doesn't end up inside
// an EPUB that an ESP32 has to open. The stored file is what both the browser
// preview and the EPUB build use, so what you see in the editor is what ships.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';

// Wide enough to stay sharp when the reader zooms, small enough to stay light.
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 2400;
const MAX_INPUT_BYTES = 24 * 1024 * 1024;

// Everything is re-encoded to JPEG, whatever came in.
//
// The reader can decode PNG, but its PNG path needs ~60 KB of free heap against
// ~36 KB for JPEG, on a device with ~320 KB of RAM. When that check fails
// mid-render the firmware skips the image and draws an empty box, so a PNG is a
// coin flip depending on how much heap the layout engine is holding. JPEG is
// the format that reliably renders.
const JPEG_QUALITY = 90;

/** Identify a format from its magic bytes, for error messages and routing. */
export function sniffFormat(buffer) {
  const b = buffer;
  if (b.length < 12) return 'unknown';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (b.subarray(0, 2).toString('latin1') === 'BM') return 'bmp';
  if (b.subarray(0, 4).toString('latin1') === 'II*\0' || b.subarray(0, 4).toString('latin1') === 'MM\0*') return 'tiff';
  // ISO base media: the brand at offset 8 distinguishes HEIC/HEIF from AVIF.
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('latin1');
    if (/^(heic|heix|hevc|heim|heis|hevm|mif1|msf1)$/.test(brand)) return 'heic';
    if (/^av01|avif$/.test(brand)) return 'avif';
    return 'iso-media';
  }
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (/^\s*<(\?xml|svg)/i.test(b.subarray(0, 200).toString('utf8'))) return 'svg';
  return 'unknown';
}

/**
 * Convert with macOS's built-in `sips` when the bundled decoder can't read the
 * format. HEIC is the case that matters — it is what iPhones shoot by default,
 * and Skia has no HEIC decoder. `sips` resamples and re-encodes in one pass, so
 * there is only ever one lossy step.
 */
async function sipsToJpeg(buffer, maxDimension) {
  if (process.platform !== 'darwin') return null;

  const run = (args) =>
    new Promise((resolve, reject) => {
      // execFile with an argument array: no shell, so a filename can't inject.
      execFile('sips', args, { timeout: 30000 }, (err, stdout) =>
        err ? reject(err) : resolve(String(stdout))
      );
    });

  let dir;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epub-drop-img-'));
    const input = path.join(dir, 'in');
    const output = path.join(dir, 'out.jpg');
    await fs.writeFile(input, buffer);

    // Ask for the real dimensions first. `-Z` resamples in both directions, so
    // passing it unconditionally would blow a small image up to the cap.
    const probe = await run(['-g', 'pixelWidth', '-g', 'pixelHeight', input]);
    const width = Number(/pixelWidth:\s*(\d+)/.exec(probe)?.[1]) || 0;
    const height = Number(/pixelHeight:\s*(\d+)/.exec(probe)?.[1]) || 0;
    if (!width || !height) return null;

    const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90'];
    if (Math.max(width, height) > maxDimension) args.push('-Z', String(maxDimension));
    args.push(input, '--out', output);
    await run(args);

    return await fs.readFile(output);
  } catch {
    return null;
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Re-encode arbitrary image bytes into something the reader will actually draw.
 *
 * Used for images pulled out of web pages as well as ones added in the editor.
 * Besides the PNG heap problem, the firmware ships decoders for JPEG and PNG
 * only — no GIF, WebP or AVIF — so anything else has to be converted rather
 * than passed through and silently skipped on the device.
 *
 * @returns {Promise<{data: Buffer, mediaType: string, extension: string}|null>}
 *          null when the bytes can't be decoded at all.
 */
export async function normalizeForDevice(buffer, { maxWidth = MAX_WIDTH, maxHeight = MAX_HEIGHT } = {}) {
  let image = null;
  try {
    image = await loadImage(buffer);
  } catch {
    /* fall through to the sips conversion below */
  }

  if (!image?.width || !image?.height) {
    // HEIC, TIFF and friends: hand off to the OS, then load the JPEG it makes.
    const converted = await sipsToJpeg(buffer, Math.max(maxWidth, maxHeight));
    if (!converted) return null;
    try {
      const reloaded = await loadImage(converted);
      // sips already resampled and encoded at quality 90; re-encoding here
      // would only lose more, so return its output directly.
      if (reloaded.width && reloaded.height) {
        return { data: converted, mediaType: 'image/jpeg', extension: 'jpg' };
      }
    } catch {
      /* the conversion produced something unreadable */
    }
    return null;
  }

  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);

  return {
    data: canvas.toBuffer('image/jpeg', JPEG_QUALITY),
    mediaType: 'image/jpeg',
    extension: 'jpg',
  };
}

export class AssetStore {
  constructor(dir) {
    this.dir = dir;
  }

  async #ensure() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** Reject anything that isn't a plain generated filename. */
  #pathFor(name) {
    if (!/^[0-9a-f]{16}\.(png|jpg)$/i.test(String(name || ''))) throw new Error('Invalid asset name.');
    return path.join(this.dir, name);
  }

  /**
   * @param {Buffer} buffer Raw uploaded bytes.
   * @param {string} [mime]  Declared content type, used only as a hint.
   * @returns {Promise<{name: string, url: string, width: number, height: number, bytes: number}>}
   */
  async save(buffer, mime = '') {
    await this.#ensure();

    if (!buffer?.length) throw new Error('Empty image.');
    if (buffer.length > MAX_INPUT_BYTES) throw new Error('That image is too large (24 MB max).');

    // One conversion path for every format, including the HEIC/TIFF fallback,
    // so the editor and the article extractor accept exactly the same inputs.
    const normalized = await normalizeForDevice(buffer);
    if (!normalized) {
      const format = sniffFormat(buffer);
      const named = format === 'unknown' ? 'That file' : `A ${format.toUpperCase()} image`;
      throw new Error(
        `${named} could not be converted. Re-save it as JPEG or PNG and try again.`
      );
    }

    const { data, extension } = normalized;

    // Content-addressed: pasting the same image twice stores it once.
    const name = `${createHash('sha256').update(data).digest('hex').slice(0, 16)}.${extension}`;
    const target = path.join(this.dir, name);
    try {
      await fs.access(target);
    } catch {
      await fs.writeFile(target, data);
    }

    const stored = await loadImage(data).catch(() => null);
    return {
      name,
      url: `/assets/${name}`,
      width: stored?.width || 0,
      height: stored?.height || 0,
      bytes: data.length,
    };
  }

  async read(name) {
    try {
      return await fs.readFile(this.#pathFor(name));
    } catch {
      return null;
    }
  }

  /**
   * Resolve an in-app asset URL to bytes plus media type, for embedding into an
   * EPUB. Returns null for anything that isn't one of our own assets.
   */
  async resolve(src) {
    const match = /^\/assets\/([0-9a-f]{16}\.(?:png|jpg))$/i.exec(String(src || '').split('?')[0]);
    if (!match) return null;
    const data = await this.read(match[1]);
    if (!data) return null;
    return {
      data,
      mediaType: match[1].toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png',
    };
  }

  /** Absolute path, for the page-image renderer which decodes from disk. */
  pathOf(src) {
    const match = /^\/assets\/([0-9a-f]{16}\.(?:png|jpg))$/i.exec(String(src || '').split('?')[0]);
    return match ? path.join(this.dir, match[1]) : null;
  }
}
