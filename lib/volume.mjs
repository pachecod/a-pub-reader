// Offline transfer: copy to the reader's SD card as a mounted volume.
//
// Two ways that card shows up on a Mac:
//
//   USB Drive mode  Models with USB-OTG (X4 Pro, X4C, Paper Mono — the ESP32-S3
//                   builds, where FREEINK_CAP_USB_MSC is set) can hand the raw
//                   card to the host. The base X4 is an ESP32-C3 whose USB is
//                   serial/JTAG only, so it cannot do this.
//   Card reader     Eject the card and put it in a reader. Works on every model.
//
// Either way it lands in /Volumes, and copying files there needs no network at
// all — which is the point on a locked-down campus or guest Wi-Fi where the
// reader and the Mac can't reach each other.

import fs from 'node:fs/promises';
import path from 'node:path';

// Overridable so tests can point at a fixture directory.
const VOLUMES_ROOT = process.env.EPUB_DROP_VOLUMES_ROOT || '/Volumes';

// Evidence that a volume is a CrossPoint card rather than someone's backup
// drive. Any hit is enough to mark it as likely; the folders the firmware and
// this app create are the strongest signals.
const MARKERS = [
  '.crosspoint',
  'XTCache',
  'Pushed Books',
  'Pushed Images',
  'screenshots',
  'A-pub Books',
  'A-pub Feeds',
  'A-pub Notes',
  // Names earlier versions used; a card written by one should still be
  // recognised rather than looking like an unrelated drive.
  'Epub-Dropped',
  'RSS2Epub',
  'Articles',
  'Books',
];

/**
 * List mounted volumes that could be the reader's card.
 *
 * @returns {Promise<Array<{name, path, likely: boolean, markers: string[], writable: boolean, freeBytes: number|null}>>}
 */
export async function listVolumes() {
  let names;
  try {
    names = await fs.readdir(VOLUMES_ROOT);
  } catch {
    return [];
  }

  const volumes = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const target = path.join(VOLUMES_ROOT, name);

    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      continue; // a stale mount point, or one we can't see into
    }
    if (!stat.isDirectory()) continue;
    // The boot volume is never the reader's card, and is the one place where a
    // stray write would do real damage.
    if (await isBootVolume(target)) continue;

    let entries = [];
    try {
      entries = await fs.readdir(target);
    } catch {
      /* mounted but unreadable */
    }

    const markers = MARKERS.filter((m) => entries.includes(m));
    volumes.push({
      name,
      path: target,
      likely: markers.length > 0,
      markers,
      writable: await isWritable(target),
      freeBytes: await freeSpace(target),
    });
  }

  // Likely cards first, then alphabetically, so the picker's default is right.
  return volumes.sort((a, b) => Number(b.likely) - Number(a.likely) || a.name.localeCompare(b.name));
}

async function isBootVolume(target) {
  try {
    const [root, candidate] = await Promise.all([fs.stat('/'), fs.stat(target)]);
    // A firmlink to the boot volume reports the same device and inode as "/".
    return root.dev === candidate.dev && root.ino === candidate.ino;
  } catch {
    return false;
  }
}

async function isWritable(target) {
  try {
    await fs.access(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function freeSpace(target) {
  try {
    const stats = await fs.statfs(target);
    return stats.bsize * stats.bavail;
  } catch {
    return null;
  }
}

/**
 * Resolve a volume path the client asked for.
 *
 * The client sends a path, so it has to be checked rather than trusted: it must
 * be a direct child of the volumes root and currently mounted. That keeps this
 * from becoming a write-anywhere endpoint.
 */
export async function resolveVolume(volumePath) {
  const wanted = path.resolve(String(volumePath || ''));
  const volumes = await listVolumes();
  return volumes.find((v) => path.resolve(v.path) === wanted) || null;
}

/** Where files go on a volume: <volume>/<folder>, with the folder scoped. */
export function targetDir(volume, folder) {
  const segments = String(folder || '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..');
  return path.join(volume.path, ...segments);
}

/** Copy one EPUB onto the card, creating the folder if needed. */
export async function copyToVolume(volume, folder, filename, buffer) {
  if (!volume.writable) throw new Error(`${volume.name} is mounted read-only.`);

  const dir = targetDir(volume, folder);
  await fs.mkdir(dir, { recursive: true });

  // Reject rather than quietly reduce: basename() would turn "../x.epub" into
  // "x.epub" and write it here under a name the caller didn't ask for, which
  // hides the bug instead of surfacing it.
  const raw = String(filename);
  const safe = path.basename(raw);
  if (!safe || safe !== raw || safe.startsWith('.')) {
    throw new Error(`Invalid filename: ${raw}`);
  }

  // Write to a temp name and rename, so pulling the card mid-copy can't leave a
  // half-written book that the reader will try to open.
  const target = path.join(dir, safe);
  const temp = `${target}.part`;
  await fs.writeFile(temp, buffer);
  await fs.rename(temp, target);

  return target;
}

/** Files directly inside the managed folder — the delete allowlist. */
export async function listVolumeFiles(volume, folder) {
  const dir = targetDir(volume, folder);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() || entry.name.startsWith('.')) continue;
    const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
    files.push({
      name: entry.name,
      size: stat?.size || 0,
      isEpub: entry.name.toLowerCase().endsWith('.epub'),
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Delete named files from the managed folder on a volume.
 *
 * Same rule as the Wi-Fi path: the allowlist comes from a fresh listing of that
 * folder, so a name containing `..` or a separator simply isn't in it, and
 * directories are never candidates.
 */
export async function deleteFromVolume(volume, folder, names) {
  const dir = targetDir(volume, folder);
  const allowed = new Set((await listVolumeFiles(volume, folder)).map((f) => f.name));
  const results = [];

  for (const name of names) {
    if (!allowed.has(name)) {
      results.push({ name, ok: false, error: `Not a file in ${folder} on ${volume.name} — refusing to delete.` });
      continue;
    }
    try {
      await fs.unlink(path.join(dir, name));
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
    }
  }
  return results;
}
