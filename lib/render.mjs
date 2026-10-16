// Rasterizers for fixed-layout ("comic book") EPUBs.
//
// Two sources, one output shape — an ordered list of PNG page images sized for
// the reader's panel:
//
//   PDFs   pdf.js paints each page onto a canvas, preserving the original
//          layout: figures, tables, equations and columns survive intact,
//          which is the whole point of choosing images over reflowed text.
//   Text   HTML and editor drafts have no page geometry to preserve, so we lay
//          the text out ourselves at the panel's exact size. Controlling the
//          type size and margins directly gives a crisper result than shrinking
//          a letter-sized page down to a 6" screen.

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { JSDOM } from 'jsdom';

// The X4 panel. The firmware's own sleep-screen constants are 480x800.
export const PANEL = { width: 480, height: 800 };

const MAX_PAGES = 400;
const SERIF = 'Georgia, "Times New Roman", Times, serif';

/** Flatten every channel to luma: e-ink is grayscale, and it compresses better. */
function grayscale(ctx, width, height) {
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const luma = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    px[i] = px[i + 1] = px[i + 2] = luma;
  }
  ctx.putImageData(image, 0, 0);
}

/**
 * Encode a page for the reader.
 *
 * JPEG by default, and not for file size — the firmware's PNG path needs ~60 KB
 * of free heap (PNGdec is ~44 KB plus headroom) while its JPEG path needs ~36 KB
 * (JPEGDEC is ~20 KB). An X4 has ~320 KB of RAM total and reports around 70 KB
 * free at rest, so a PNG decode is refused mid-render and the reader draws an
 * empty box where the picture should be. JPEG clears the bar with room to spare.
 *
 * Quality is kept high because the alternative is ringing around black text on
 * white, and the panel's own dithering hides the rest.
 */
const JPEG_QUALITY = 92;

export function encodePage(canvas, { format = 'jpeg', gray = true } = {}) {
  if (gray) grayscale(canvas.getContext('2d'), canvas.width, canvas.height);
  return format === 'png'
    ? { data: canvas.toBuffer('image/png'), mediaType: 'image/png', extension: 'png' }
    : { data: canvas.toBuffer('image/jpeg', JPEG_QUALITY), mediaType: 'image/jpeg', extension: 'jpg' };
}

// --------------------------------------------------------------------- PDF

/**
 * Render PDF pages to images.
 *
 * @param {object} opts
 * @param {Buffer|Uint8Array} opts.data
 * @param {number} [opts.width]   Target width in device pixels before scale.
 * @param {number} [opts.scale]   1 = panel width, 2 = double for zooming.
 * @param {'whole'|'halves'|'thirds'} [opts.split]
 *        Dense body text is unreadable when a whole letter page is squeezed
 *        into 480px, so a page can be cut into stacked slices instead.
 * @returns {Promise<{pages: Array<{data: Buffer, width: number, height: number, label: string}>, warnings: string[]}>}
 */
export async function renderPdfPages({
  data,
  width = PANEL.width,
  scale = 1,
  split = 'whole',
  maxPages = MAX_PAGES,
  format = 'jpeg',
}) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const warnings = [];

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
    verbosity: 0,
    // Unlike text extraction, rendering wants real fonts so glyphs are correct.
    useSystemFonts: true,
    isEvalSupported: false,
    stopAtErrors: false,
  });
  const doc = await loadingTask.promise;

  const targetWidth = Math.round(width * scale);
  const count = Math.min(doc.numPages, maxPages);
  if (doc.numPages > count) {
    warnings.push(`Only the first ${count} of ${doc.numPages} pages were rendered.`);
  }

  const slices = split === 'thirds' ? 3 : split === 'halves' ? 2 : 1;
  const pages = [];

  for (let n = 1; n <= count; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: targetWidth / base.width });

    const full = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = full.getContext('2d');
    // PDFs assume paper; without this, transparent areas render black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, full.width, full.height);

    try {
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (err) {
      warnings.push(`Page ${n} failed to render (${err.message}); left blank.`);
    }
    page.cleanup();

    if (slices === 1) {
      pages.push({ ...encodePage(full, { format }), width: full.width, height: full.height, label: `Page ${n}` });
      continue;
    }

    // Overlap slices slightly so a line of text split by the cut is still
    // readable in full on one of the two slices.
    const overlap = Math.round(full.height * 0.03);
    const sliceHeight = Math.ceil(full.height / slices);

    for (let s = 0; s < slices; s++) {
      const top = Math.max(0, s * sliceHeight - (s > 0 ? overlap : 0));
      const bottom = Math.min(full.height, (s + 1) * sliceHeight);
      const height = bottom - top;
      if (height <= 0) continue;

      const slice = createCanvas(full.width, height);
      const sctx = slice.getContext('2d');
      sctx.fillStyle = '#ffffff';
      sctx.fillRect(0, 0, slice.width, slice.height);
      sctx.drawImage(full, 0, -top);

      pages.push({
        ...encodePage(slice, { format }),
        width: slice.width,
        height: slice.height,
        label: `Page ${n}${slices > 1 ? ` (${s + 1}/${slices})` : ''}`,
      });
    }
  }

  await loadingTask.destroy();
  return { pages, warnings };
}

// -------------------------------------------------------------------- text

const BLOCK_STYLES = {
  h1: { size: 1.55, bold: true, before: 0.6, after: 0.35, align: 'left' },
  h2: { size: 1.3, bold: true, before: 0.9, after: 0.3, align: 'left' },
  h3: { size: 1.12, bold: true, before: 0.7, after: 0.25, align: 'left' },
  h4: { size: 1.0, bold: true, before: 0.6, after: 0.2, align: 'left' },
  p: { size: 1, before: 0, after: 0.45 },
  quote: { size: 1, italic: true, indent: 1.2, before: 0.35, after: 0.45 },
  li: { size: 1, bullet: true, indent: 1.1, before: 0, after: 0.2 },
  pre: { size: 0.85, mono: true, before: 0.35, after: 0.4 },
  image: { before: 0.5, after: 0.5 },
  hr: { rule: true, before: 0.6, after: 0.6 },
};

/**
 * Lay text blocks out into fixed-size pages.
 *
 * @param {object} opts
 * @param {Array<{type: string, text: string, ordinal?: number}>} opts.blocks
 * @param {number} [opts.fontSize] Base body size in px at 1x.
 */
export async function renderBlocksToPages({
  blocks,
  width = PANEL.width,
  height = PANEL.height,
  scale = 1,
  fontSize = 21,
  title = '',
  maxPages = MAX_PAGES,
  format = 'jpeg',
  // Maps an image block's src to bytes on disk. Without it, image blocks fall
  // back to their alt text.
  loadAsset = null,
}) {
  const W = Math.round(width * scale);
  const H = Math.round(height * scale);
  const base = fontSize * scale;

  const margin = {
    top: Math.round(base * 1.9),
    bottom: Math.round(base * 2.3),
    left: Math.round(base * 1.5),
    right: Math.round(base * 1.5),
  };
  const contentWidth = W - margin.left - margin.right;
  const lineHeight = base * 1.5;

  const pages = [];
  let canvas = null;
  let ctx = null;
  let y = 0;

  const font = (style) => {
    const weight = style.bold ? 'bold ' : '';
    const slant = style.italic ? 'italic ' : '';
    const family = style.mono ? 'Menlo, monospace' : SERIF;
    return `${slant}${weight}${Math.round(base * (style.size || 1))}px ${family}`;
  };

  const newPage = () => {
    if (canvas) pages.push(finishPage(canvas, pages.length + 1));
    canvas = createCanvas(W, H);
    ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000000';
    ctx.textBaseline = 'alphabetic';
    y = margin.top;
  };

  const finishPage = (page, number) => {
    const pctx = page.getContext('2d');
    // Footer: page number centered, running title on the left. The title is
    // truncated by measured width, not character count, so it can never
    // collide with the page number.
    const footerY = H - Math.round(base * 0.8);
    pctx.fillStyle = '#555555';
    pctx.font = `${Math.round(base * 0.62)}px ${SERIF}`;
    pctx.textAlign = 'center';
    pctx.fillText(String(number), W / 2, footerY);

    if (title) {
      pctx.textAlign = 'left';
      const available = W / 2 - margin.left - base * 1.5;
      let short = title;
      if (pctx.measureText(short).width > available) {
        while (short.length > 1 && pctx.measureText(`${short}…`).width > available) {
          short = short.slice(0, -1);
        }
        short = `${short.trimEnd()}…`;
      }
      if (available > base * 2) pctx.fillText(short, margin.left, footerY);
    }
    pctx.textAlign = 'left';
    return {
      ...encodePage(page, { format }),
      width: W,
      height: H,
      label: `Page ${number}`,
    };
  };

  const room = (needed) => y + needed <= H - margin.bottom;

  /**
   * Draw an image scaled to fit the column, moving to a fresh page when it
   * won't fit in what's left. Returns false if the image couldn't be loaded.
   */
  async function drawImageBlock(block) {
    if (!loadAsset) return false;
    let image;
    try {
      const bytes = await loadAsset(block.src);
      if (!bytes) return false;
      image = await loadImage(bytes);
    } catch {
      return false;
    }

    const maxHeight = H - margin.top - margin.bottom;
    const fit = Math.min(contentWidth / image.width, maxHeight / image.height, 1);
    // Never enlarge past the column, but do scale small images up a little so
    // a 200px screenshot isn't a stamp in the middle of the page.
    const boost = fit === 1 && image.width < contentWidth ? Math.min(contentWidth / image.width, 2) : 1;
    const drawWidth = Math.round(image.width * fit * boost);
    const drawHeight = Math.round(image.height * fit * boost);

    if (!room(drawHeight)) newPage();

    const x = margin.left + Math.max(0, Math.round((contentWidth - drawWidth) / 2));
    ctx.drawImage(image, x, Math.round(y), drawWidth, drawHeight);
    y += drawHeight;

    // Caption under the image, when there is alt text worth showing.
    if (block.text) {
      const captionStyle = { size: 0.72, italic: true };
      ctx.font = font(captionStyle);
      const captionHeight = lineHeight * captionStyle.size;
      const captionLines = wrap(ctx, block.text, contentWidth);
      y += captionHeight * 0.35;
      for (const line of captionLines) {
        if (!room(captionHeight)) newPage();
        ctx.font = font(captionStyle);
        ctx.fillStyle = '#444444';
        const width = ctx.measureText(line).width;
        ctx.fillText(line, margin.left + Math.max(0, (contentWidth - width) / 2), y + captionHeight * 0.75);
        y += captionHeight;
      }
      ctx.fillStyle = '#000000';
    }

    y += base * 0.5;
    return true;
  }

  newPage();

  // `let`, because an image that fails to load is rewritten to its alt text.
  for (let block of blocks) {
    const style = BLOCK_STYLES[block.type] || BLOCK_STYLES.p;
    y += (style.before || 0) * base;

    if (style.rule) {
      if (!room(base)) newPage();
      ctx.strokeStyle = '#999999';
      ctx.lineWidth = Math.max(1, Math.round(scale));
      ctx.beginPath();
      ctx.moveTo(margin.left + contentWidth * 0.25, Math.round(y));
      ctx.lineTo(margin.left + contentWidth * 0.75, Math.round(y));
      ctx.stroke();
      y += (style.after || 0) * base;
      continue;
    }

    if (block.type === 'image') {
      const drawn = await drawImageBlock(block);
      if (drawn) continue;
      // Couldn't load it — fall through and show the alt text instead of
      // silently dropping the reader's only clue that an image was here.
      if (!block.text) continue;
      block = { ...block, text: `[image: ${block.text}]` };
    }

    if (!block.text) continue;

    ctx.font = font(style);
    const indent = (style.indent || 0) * base;
    const bullet = style.bullet ? (block.ordinal ? `${block.ordinal}.` : '•') : '';
    const textWidth = contentWidth - indent;
    const lines = wrap(ctx, block.text, textWidth);
    const blockLineHeight = lineHeight * (style.size || 1);

    // Don't strand a heading at the foot of a page.
    if (style.bold && !room(blockLineHeight * Math.min(2, lines.length + 1))) newPage();

    for (let i = 0; i < lines.length; i++) {
      if (!room(blockLineHeight)) newPage();
      // Set the font every line: newPage() swaps in a fresh context with
      // default 10px sans, and it can be triggered either here or by the
      // widow check above.
      ctx.font = font(style);
      ctx.fillStyle = '#000000';
      const x = margin.left + indent;
      if (bullet && i === 0) {
        const saved = ctx.font;
        ctx.fillText(bullet, margin.left + indent - base * 0.95, y + blockLineHeight * 0.75);
        ctx.font = saved;
      }
      ctx.fillText(lines[i], x, y + blockLineHeight * 0.75);
      y += blockLineHeight;

      if (pages.length >= maxPages) break;
    }

    y += (style.after || 0) * base;
    if (pages.length >= maxPages) break;
  }

  if (canvas) pages.push(finishPage(canvas, pages.length + 1));
  return { pages, warnings: pages.length >= maxPages ? [`Stopped at ${maxPages} pages.`] : [] };
}

/** Greedy word wrap against the canvas's own text metrics. */
function wrap(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // A single word wider than the column has to be broken mid-word.
    if (ctx.measureText(word).width > maxWidth) {
      let chunk = '';
      for (const char of word) {
        if (ctx.measureText(chunk + char).width > maxWidth && chunk) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      line = chunk;
    } else {
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Flatten sanitized article HTML into the linear block list the layout wants.
 * Inline markup is dropped: the rasterizer paints one font per block, and
 * mixed runs would need a full inline layout engine to be worth keeping.
 */
export function htmlToBlocks(html) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
  const doc = dom.window.document;
  const blocks = [];

  const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();

  const emitImage = (node) => {
    const src = node.getAttribute('src') || '';
    const alt = node.getAttribute('alt') || '';
    if (src) blocks.push({ type: 'image', src, text: alt });
    // No source to draw, but the alt text still says what was here.
    else if (alt) blocks.push({ type: 'quote', text: `[image: ${alt}]` });
  };

  const walk = (parent) => {
    for (const node of parent.children) {
      const tag = node.tagName.toLowerCase();

      if (/^h[1-4]$/.test(tag)) {
        blocks.push({ type: tag, text: text(node) });
      } else if (tag === 'p' || tag === 'figure') {
        // Markdown renders `![alt](src)` as an image inside a paragraph, so a
        // paragraph's images have to be pulled out rather than flattened away
        // with the rest of its inline content.
        const value = text(node);
        if (value) blocks.push({ type: tag === 'figure' ? 'quote' : 'p', text: value });
        for (const img of node.querySelectorAll('img')) emitImage(img);
      } else if (tag === 'blockquote') {
        for (const line of splitParagraphs(node, text)) blocks.push({ type: 'quote', text: line });
      } else if (tag === 'ul' || tag === 'ol') {
        let ordinal = 1;
        for (const li of node.children) {
          if (li.tagName.toLowerCase() !== 'li') continue;
          const value = text(li);
          if (value) blocks.push({ type: 'li', text: value, ordinal: tag === 'ol' ? ordinal++ : null });
        }
      } else if (tag === 'pre') {
        blocks.push({ type: 'pre', text: node.textContent.replace(/\n+/g, ' ').trim() });
      } else if (tag === 'hr') {
        blocks.push({ type: 'hr' });
      } else if (tag === 'table') {
        // Tables can't be laid out in a single-font renderer; emit rows as text
        // so the information survives even though the grid does not.
        for (const row of node.querySelectorAll('tr')) {
          const cells = [...row.children].map((c) => text(c)).filter(Boolean);
          if (cells.length) blocks.push({ type: 'p', text: cells.join(' · ') });
        }
      } else if (tag === 'img') {
        emitImage(node);
      } else if (node.children.length) {
        walk(node);
      } else {
        const value = text(node);
        if (value) blocks.push({ type: 'p', text: value });
      }
    }
  };

  walk(doc.body);
  return blocks;
}

function splitParagraphs(node, text) {
  const paragraphs = [...node.querySelectorAll('p')].map(text).filter(Boolean);
  return paragraphs.length ? paragraphs : [text(node)].filter(Boolean);
}
