// Pictures inside a PDF, pulled out for the reflowable book.
//
// The text pass rebuilds paragraphs from glyph positions and has no idea where
// the figures were. This finds them in the page's drawing operations — every
// image is painted as a unit square stretched by the current transform, so
// tracking that transform gives each picture's box on the page — and then
// crops each box out of a rendered copy of the page.
//
// Cropping the rendered page, rather than decoding the embedded image data, is
// deliberate: PDFs store pictures as JPEG, JPEG 2000, CCITT, indexed or CMYK
// rasters, often with a separate soft mask, and the renderer already gets all
// of those right. It also means a figure built from several tiles comes out as
// one picture, because overlapping boxes are merged first.

import { createCanvas } from '@napi-rs/canvas';

/** Smaller than this (in points, on either side) is an icon, bullet or rule. */
const MIN_SIDE = 48;
/** Covering this much of the page is a background or a scanned page, not a figure. */
const MAX_PAGE_COVERAGE = 0.85;
/** Upper bounds, so a picture-heavy PDF cannot balloon the book. */
const MAX_IMAGES = 80;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
/** Rendering resolution for the crops, in pixels per point. */
const RENDER_SCALE = 2;
/** The longest side a rendered page may have, whatever its size in points. */
const MAX_RENDER_SIDE = 3000;

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** m1 ∘ m2, in the canvas convention pdf.js uses: apply m2, then m1. */
function multiply(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * Boxes where images are painted on one page, top-down in points.
 *
 * @param {{fnArray: number[], argsArray: any[]}} operatorList  From page.getOperatorList().
 * @param {object} OPS        pdf.js operator codes.
 * @param {object} viewport   The page's scale-1 viewport, for the flip to top-down.
 * @returns {Array<{left, top, right, bottom}>}
 */
export function findImageBoxes(operatorList, OPS, viewport) {
  const boxes = [];
  const stack = [];
  let ctm = IDENTITY;

  const paint = () => {
    const corners = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)].map(([x, y]) =>
      viewport.convertToViewportPoint(x, y)
    );
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    boxes.push({ left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) });
  };

  const { fnArray, argsArray } = operatorList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || IDENTITY;
    else if (fn === OPS.transform) ctm = multiply(ctm, [...args]);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args?.[0]) ctm = multiply(ctm, [...args[0]]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || IDENTITY;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) paint();
    else if (fn === OPS.paintImageXObjectRepeat) {
      // A tiled image: [id, scaleX, scaleY, positions[]]. Each tile is the
      // unit square scaled and placed; the figure is all of them together.
      const [, sx, sy, positions = []] = args || [];
      for (let p = 0; p + 1 < positions.length; p += 2) {
        const saved = ctm;
        ctm = multiply(ctm, [sx, 0, 0, sy, positions[p], positions[p + 1]]);
        paint();
        ctm = saved;
      }
    }
  }

  return keepFigures(mergeBoxes(boxes), viewport);
}

/** Union boxes that overlap or touch, so a tiled figure is one picture. */
function mergeBoxes(boxes) {
  const merged = [];
  for (const box of boxes) {
    let current = { ...box };
    for (let i = merged.length - 1; i >= 0; i--) {
      const other = merged[i];
      const touches =
        current.left <= other.right + 1 &&
        other.left <= current.right + 1 &&
        current.top <= other.bottom + 1 &&
        other.top <= current.bottom + 1;
      if (!touches) continue;
      current = {
        left: Math.min(current.left, other.left),
        top: Math.min(current.top, other.top),
        right: Math.max(current.right, other.right),
        bottom: Math.max(current.bottom, other.bottom),
      };
      merged.splice(i, 1);
    }
    merged.push(current);
  }
  return merged;
}

function keepFigures(boxes, viewport) {
  const pageArea = viewport.width * viewport.height;
  return boxes
    .map((b) => ({
      // Clip to the page: images often bleed past the edge.
      left: Math.max(0, b.left),
      top: Math.max(0, b.top),
      right: Math.min(viewport.width, b.right),
      bottom: Math.min(viewport.height, b.bottom),
    }))
    .filter((b) => {
      const width = b.right - b.left;
      const height = b.bottom - b.top;
      if (width < MIN_SIDE || height < MIN_SIDE) return false;
      return (width * height) / pageArea <= MAX_PAGE_COVERAGE;
    })
    .sort((a, b) => a.top - b.top || a.left - b.left);
}

/**
 * Render each page that has figures and crop them out.
 *
 * @param {object} options
 * @param {Uint8Array|Buffer} options.data  The PDF.
 * @param {Map<number, Array>} options.boxesByPage  Page number → boxes from findImageBoxes.
 * @param {(buffer: Buffer) => Promise<{data, mediaType, extension}|null>} options.normalize
 *        Re-encodes for the reader (JPEG, sized for the panel).
 * @returns {Promise<{figures: Map<number, Array<{top, bottom, image}>>, warnings: string[]}>}
 */
export async function cropFigures({ data, boxesByPage, normalize }) {
  const figures = new Map();
  const warnings = [];
  const wanted = [...boxesByPage.entries()].filter(([, boxes]) => boxes.length);
  if (!wanted.length) return { figures, warnings };

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
    verbosity: 0,
    useSystemFonts: true,
    isEvalSupported: false,
    stopAtErrors: false,
  });
  const doc = await loadingTask.promise;

  let count = 0;
  let bytes = 0;
  let dropped = 0;
  let failed = 0;

  try {
    for (const [pageNumber, boxes] of wanted) {
      if (count >= MAX_IMAGES || bytes >= MAX_TOTAL_BYTES) {
        dropped += boxes.length;
        continue;
      }

      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(RENDER_SCALE, MAX_RENDER_SIDE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });

      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      try {
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch {
        failed += boxes.length;
        page.cleanup();
        continue;
      }
      page.cleanup();

      const onPage = [];
      for (const box of boxes) {
        if (count >= MAX_IMAGES || bytes >= MAX_TOTAL_BYTES) {
          dropped++;
          continue;
        }
        const sx = Math.floor(box.left * scale);
        const sy = Math.floor(box.top * scale);
        const width = Math.max(1, Math.ceil((box.right - box.left) * scale));
        const height = Math.max(1, Math.ceil((box.bottom - box.top) * scale));

        const crop = createCanvas(width, height);
        const cctx = crop.getContext('2d');
        cctx.fillStyle = '#ffffff';
        cctx.fillRect(0, 0, width, height);
        cctx.drawImage(canvas, sx, sy, width, height, 0, 0, width, height);

        const usable = await normalize(crop.toBuffer('image/png')).catch(() => null);
        if (!usable) {
          failed++;
          continue;
        }
        count++;
        bytes += usable.data.length;
        onPage.push({ top: box.top, bottom: box.bottom, image: usable });
      }
      if (onPage.length) figures.set(pageNumber, onPage);
    }
  } finally {
    await loadingTask.destroy();
  }

  if (dropped) warnings.push(`${dropped} more picture(s) were left out to keep the book a manageable size.`);
  if (failed) warnings.push(`${failed} picture(s) could not be rendered and were left out.`);
  return { figures, warnings };
}
