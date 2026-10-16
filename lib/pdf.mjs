// PDF -> reflowable chapters.
//
// A PDF is a page-layout format: it stores glyph runs at coordinates, not
// paragraphs. To get text that reflows on a 6" e-ink screen we have to rebuild
// the structure from geometry — group runs into lines, lines into paragraphs,
// and guess headings from font size. That reconstruction is inherently lossy,
// so anything uncertain is reported as a warning rather than hidden.
//
// Scanned PDFs have no text layer at all; those are detected and rejected with
// an explanation instead of producing an empty book.

import { createRequire } from 'node:module';
import { escapeXml } from './extract.mjs';
import { cropFigures, findImageBoxes } from './pdfimages.mjs';

const require = createRequire(import.meta.url);

let pdfjsPromise = null;
function loadPdfjs() {
  // The legacy build is the one that runs under Node without a DOM.
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

const MAX_PAGES = 1200;

/**
 * @param {object} opts
 * @param {Buffer|Uint8Array} opts.data  Raw PDF bytes.
 * @param {string} [opts.name]           Original filename, used as a title fallback.
 * @param {boolean} [opts.includeImages] Pull the PDF's pictures into the book.
 * @param {Function} [opts.normalizeImage] Re-encodes a picture for the reader;
 *        images are only extracted when one is given.
 * @returns {Promise<{title, byline, lang, source, siteName, chapters, images, warnings, textLength}>}
 */
export async function extractPdf({ data, name = '', includeImages = true, normalizeImage = null }) {
  const wantImages = Boolean(includeImages && normalizeImage);
  const pdfjs = await loadPdfjs();
  const warnings = [];

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
    // No network, no eval, no system font probing: keep it hermetic and quiet.
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    disableFontFace: true,
    stopAtErrors: false,
    // Malformed embedded fonts are common and irrelevant to text extraction;
    // without this pdf.js writes a wall of warnings to stdout.
    verbosity: 0,
  });
  const doc = await loadingTask.promise;

  const pageCount = Math.min(doc.numPages, MAX_PAGES);
  if (doc.numPages > MAX_PAGES) {
    warnings.push(`Only the first ${MAX_PAGES} of ${doc.numPages} pages were converted.`);
  }

  // ---- pass 1: geometry -> lines, per page
  const pages = [];
  for (let n = 1; n <= pageCount; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent({ includeMarkedContent: false });
    pages.push({
      number: n,
      width: viewport.width,
      height: viewport.height,
      lines: buildLines(content.items, viewport),
      // Where pictures are drawn; cropped out after the text pass.
      boxes: wantImages ? findImageBoxes(await page.getOperatorList(), pdfjs.OPS, viewport) : [],
    });
    page.cleanup();
  }

  const allLines = pages.flatMap((p) => p.lines);
  const rawTextLength = allLines.reduce((sum, l) => sum + l.text.length, 0);

  if (rawTextLength < 20) {
    const meta = await doc.getMetadata().catch(() => null);
    await loadingTask.destroy();
    const scanned = new Error(
      'This PDF has no text layer — it is a scan or an image export. Converting it needs OCR, ' +
        'which this app does not do. Run it through OCR first (Preview, Acrobat, or `ocrmypdf`), then drop it again.'
    );
    scanned.code = 'NO_TEXT_LAYER';
    scanned.detail = { pages: doc.numPages, producer: meta?.info?.Producer || '' };
    throw scanned;
  }

  // ---- pass 2: strip running heads/feet that repeat across pages
  const dropped = dropRepeatedLines(pages);
  if (dropped) warnings.push(`Removed ${dropped} repeated header/footer line(s).`);

  // ---- pictures: crop each figure out of a rendered copy of its page
  if (wantImages && pages.some((p) => p.boxes.length)) {
    const { figures, warnings: imageWarnings } = await cropFigures({
      data,
      boxesByPage: new Map(pages.map((p) => [p.number, p.boxes])),
      normalize: normalizeImage,
    });
    for (const page of pages) page.figures = figures.get(page.number) || [];
    warnings.push(...imageWarnings);
  }

  // ---- pass 3: profile the fonts, then rebuild paragraphs and headings
  const profile = buildStyleProfile(pages);
  const blocks = buildBlocks(pages, profile, warnings);

  // Number the pictures in reading order; chapters refer to them by path.
  const images = [];
  for (const block of blocks) {
    if (block.type !== 'image') continue;
    block.path = `images/pdf-${images.length + 1}.${block.image.extension || 'jpg'}`;
    images.push({ path: block.path, mediaType: block.image.mediaType, data: block.image.data });
  }
  if (images.length) warnings.push(`Included ${images.length} picture(s) from the PDF.`);

  const meta = await doc.getMetadata().catch(() => null);
  await loadingTask.destroy();

  const info = meta?.info || {};
  const title = pickTitle(info.Title, blocks, name);
  const byline = cleanAuthor(info.Author);

  const chapters = buildChapters(blocks, title);
  const textLength = blocks.reduce((sum, b) => sum + b.text.length, 0);

  if (!chapters.some((c) => c.title !== title)) {
    warnings.push('No headings detected — the whole document is one chapter.');
  }

  // A slide deck or an image-heavy export has a text layer, but almost all of
  // the content lives in pictures that this converter does not extract. Say so
  // rather than quietly handing back a nearly empty book.
  const perPage = Math.round(textLength / Math.max(1, pageCount));
  if (perPage < 150) {
    warnings.push(
      `Only ~${perPage} characters of text per page across ${pageCount} page(s) — this looks like a ` +
        'slide deck or a mostly-image PDF. Text in images is not extracted.'
    );
  }

  return {
    title,
    byline,
    lang: 'en',
    siteName: '',
    source: '',
    chapters,
    images,
    warnings,
    textLength,
  };
}

// ------------------------------------------------------------------ lines

/**
 * Group glyph runs into visual lines. pdf.js gives each run a transform whose
 * e/f are the x/y of its baseline in PDF space (y grows upward).
 */
function buildLines(items, viewport) {
  const runs = [];
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str.length) continue;
    const t = item.transform;
    const size = Math.abs(t[3]) || Math.abs(t[0]) || 10;
    // Skip rotated text; it is almost always a watermark or a sideways figure.
    if (Math.abs(t[1]) > 0.4 * size || Math.abs(t[2]) > 0.4 * size) continue;
    runs.push({
      text: item.str,
      x: t[4],
      // Flip to top-down so "smaller y" reads as "higher on the page".
      y: viewport.height - t[5],
      width: item.width || 0,
      size,
      // pdf.js reports fonts as opaque ids ("g_d0_f2"), never real names, so
      // bold/italic can't be read off the name. What is reliable is that a
      // document uses one style for body text and different ones for headings,
      // so identify styles by (font id, size) and profile them per document.
      styleKey: `${item.fontName || '?'}@${size.toFixed(1)}`,
    });
  }
  if (!runs.length) return [];

  const columns = detectColumns(runs, viewport.width);

  const lines = [];
  for (const column of columns) {
    column.sort((a, b) => a.y - b.y || a.x - b.x);
    let current = null;
    for (const run of column) {
      const tolerance = Math.max(2, run.size * 0.5);
      if (!current || Math.abs(run.y - current.y) > tolerance) {
        current = { y: run.y, runs: [run] };
        lines.push(current);
      } else {
        current.runs.push(run);
      }
    }
  }

  return lines
    .map((line) => {
      line.runs.sort((a, b) => a.x - b.x);
      return finalizeLine(line);
    })
    .filter((line) => line.text.length > 0);
}

function finalizeLine(line) {
  let text = '';
  let previous = null;
  for (const run of line.runs) {
    if (previous) {
      const gap = run.x - (previous.x + previous.width);
      const spaceWidth = previous.size * 0.22;
      // pdf.js emits separate runs mid-word (kerning, font switches), so only
      // insert a space when the visual gap justifies one.
      const needsSpace = gap > spaceWidth && !/\s$/.test(text) && !/^\s/.test(run.text);
      if (needsSpace) text += ' ';
    }
    text += run.text;
    previous = run;
  }

  const sizes = line.runs.map((r) => r.size);
  const first = line.runs[0];
  const last = line.runs.at(-1);

  // Characters per style, so the line's dominant style ignores a stray
  // superscript or a single italicized word.
  const styles = new Map();
  for (const run of line.runs) {
    styles.set(run.styleKey, (styles.get(run.styleKey) || 0) + run.text.length);
  }
  let styleKey = first.styleKey;
  let best = 0;
  for (const [key, count] of styles) {
    if (count > best) {
      best = count;
      styleKey = key;
    }
  }

  return {
    text: text.replace(/\s+/g, ' ').trim(),
    y: line.y,
    x: first.x,
    right: last.x + last.width,
    size: Math.max(...sizes),
    styles,
    styleKey,
    allCaps: /[A-Z]/.test(text) && text === text.toUpperCase(),
  };
}

/**
 * Work out which style is body text and which styles mark headings. The body
 * style is whichever covers the most characters; a heading style is any other
 * style that is used sparingly and is not smaller than body text.
 */
function buildStyleProfile(pages) {
  const chars = new Map();
  let total = 0;
  for (const page of pages) {
    for (const line of page.lines) {
      for (const [key, count] of line.styles) {
        chars.set(key, (chars.get(key) || 0) + count);
        total += count;
      }
    }
  }

  const sizeOf = (key) => Number(key.split('@').at(-1)) || 10;

  let bodyKey = null;
  let bodyChars = 0;
  for (const [key, count] of chars) {
    if (count > bodyChars) {
      bodyChars = count;
      bodyKey = key;
    }
  }

  const bodySize = bodyKey ? sizeOf(bodyKey) : 10;
  const headingKeys = new Map();
  for (const [key, count] of chars) {
    if (key === bodyKey) continue;
    // A style used for a large share of the document is alternate body text
    // (a long note, a quoted passage), not a heading style.
    if (total > 0 && count / total > 0.3) continue;
    if (sizeOf(key) < bodySize * 0.95) continue;
    headingKeys.set(key, sizeOf(key));
  }

  const maxHeadingSize = headingKeys.size ? Math.max(...headingKeys.values()) : bodySize;

  return { bodyKey, bodySize, headingKeys, maxHeadingSize, sizeOf };
}

/**
 * Detect a two-column layout by looking for a vertical gutter near the middle
 * that almost no text crosses. Conservative: a false positive scrambles the
 * reading order, so it needs a wide, clean gap and real text on both sides.
 */
function detectColumns(runs, pageWidth) {
  if (runs.length < 40) return [runs];

  const mid = pageWidth / 2;
  const left = runs.filter((r) => r.x + r.width <= mid + pageWidth * 0.02);
  const right = runs.filter((r) => r.x >= mid - pageWidth * 0.02);
  const crossing = runs.length - left.length - right.length;

  const minShare = runs.length * 0.25;
  if (left.length < minShare || right.length < minShare) return [runs];
  // Full-width lines (titles, abstracts) crossing the gutter rule it out.
  if (crossing > runs.length * 0.08) return [runs];

  const gutter = Math.min(...right.map((r) => r.x)) - Math.max(...left.map((r) => r.x + r.width));
  if (gutter < pageWidth * 0.03) return [runs];

  return [left, right];
}

// ------------------------------------------------------------------ cleanup

/** Remove lines that repeat at the same height across pages: running heads, folios. */
function dropRepeatedLines(pages) {
  let removed = 0;

  // Bare folios in the margin go regardless of page count — a page number is
  // never body text.
  for (const page of pages) {
    const zone = page.height * 0.08;
    for (let i = page.lines.length - 1; i >= 0; i--) {
      const line = page.lines[i];
      const inMargin = line.y < zone || line.y > page.height - zone;
      if (inMargin && /^[ivxlcdm]{1,7}$|^\d{1,4}$/i.test(line.text)) {
        page.lines.splice(i, 1);
        removed++;
      }
    }
  }

  if (pages.length < 2) return removed;

  const counts = new Map();
  for (const page of pages) {
    const zone = page.height * 0.08;
    for (const line of page.lines) {
      const inMargin = line.y < zone || line.y > page.height - zone;
      if (!inMargin) continue;
      // Normalize digits so "Page 4" and "Page 5" collapse to one key.
      const key = line.text.replace(/\d+/g, '#').toLowerCase().trim();
      if (key.length < 2) continue;
      if (!counts.has(key)) counts.set(key, []);
      counts.get(key).push({ page, line });
    }
  }

  // On a 2-page excerpt a running head appears twice; on a long document
  // require it on a meaningful share of pages before calling it furniture.
  const threshold = pages.length <= 4 ? 2 : Math.max(3, Math.ceil(pages.length * 0.3));
  for (const [, hits] of counts) {
    if (hits.length < threshold) continue;
    for (const { page, line } of hits) {
      const index = page.lines.indexOf(line);
      if (index !== -1) {
        page.lines.splice(index, 1);
        removed++;
      }
    }
  }

  return removed;
}

// ------------------------------------------------------------------ blocks

/**
 * Turn lines into paragraph/heading blocks. Paragraph breaks come from
 * vertical gaps, first-line indents, and short "ragged" final lines.
 */
function buildBlocks(pages, profile, warnings) {
  const bodySize = profile.bodySize;
  const lines = [];
  for (const page of pages) {
    for (const line of page.lines) lines.push({ ...line, page: page.number, pageWidth: page.width });
  }
  if (!lines.length) return [];

  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].page !== lines[i - 1].page) continue;
    const gap = lines[i].y - lines[i - 1].y;
    if (gap > 0 && gap < bodySize * 4) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const lineGap = gaps[Math.floor(gaps.length / 2)] || bodySize * 1.2;

  const bodyLeft = mode(lines.filter((l) => l.text.length > 40).map((l) => Math.round(l.x)));
  const bodyRight = percentile(lines.map((l) => l.right), 0.9);

  const blocks = [];
  let headingCount = 0;

  // Pictures go in where they sat on the page: before the first line whose
  // baseline is below the picture's middle. A picture breaks the paragraph
  // around it, since text on either side of a figure is rarely one sentence.
  const pending = new Map(pages.map((p) => [p.number, [...(p.figures || [])]]));
  const placeFigures = (pageNumber, beforeY = Infinity) => {
    for (const [number, list] of pending) {
      if (number > pageNumber) break;
      const limit = number < pageNumber ? Infinity : beforeY;
      while (list.length && (list[0].top + list[0].bottom) / 2 < limit) {
        blocks.push({ type: 'image', text: '', image: list.shift().image });
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const previous = lines[i - 1];
    placeFigures(line.page, line.y);

    const samePage = previous && previous.page === line.page;
    const gap = samePage ? line.y - previous.y : lineGap;
    // "Continues" means the previous line sits directly above this one at
    // normal leading and reached the right margin — i.e. text that wrapped.
    const continues =
      samePage && gap <= lineGap * 1.45 && previous.right >= bodyRight - bodySize * 1.5;

    if (isHeading(line, profile, { bodyRight, previous, continues })) {
      blocks.push({ type: 'heading', text: line.text, level: headingLevel(line, profile) });
      headingCount++;
      continue;
    }

    const last = blocks.at(-1);

    let startNew = !last || last.type !== 'paragraph';
    if (!startNew && previous) {
      const indented = bodyLeft !== null && line.x - bodyLeft > bodySize * 0.6;
      const bigGap = samePage && gap > lineGap * 1.45;
      // A line that stops well short of the right margin ends its paragraph,
      // unless it is the last line before a page break (where we can't tell).
      const ragged = samePage && previous.right < bodyRight - bodySize * 2.2;
      const sentenceEnd = /[.!?]["'”’)]?\s*$/.test(last.text);

      startNew = bigGap || indented || (ragged && sentenceEnd);
    }

    if (startNew) {
      blocks.push({ type: 'paragraph', text: line.text });
    } else {
      last.text = joinWrapped(last.text, line.text);
    }
  }

  placeFigures(Infinity);

  if (!headingCount) warnings.push('No font-size changes looked like headings.');

  return blocks
    .map((b) => ({ ...b, text: b.text.replace(/\s+/g, ' ').trim() }))
    .filter((b) => b.type === 'image' || b.text.length > 0);
}

// Words that stay hyphenated when a line break lands on their hyphen. Without
// this, "cross-\nplatform" is rebuilt as "crossplatform".
const KEPT_HYPHEN_PREFIX =
  /(?:^|[\s"“(])(?:cross|self|non|pre|post|anti|multi|inter|intra|sub|semi|pseudo|quasi|co|re|ex|non|well|ill|half|full|long|short|high|low|over|under|out|off|on|up|down|first|second|third|one|two|three|de|un|re)$/i;

/** Join a wrapped line, healing end-of-line hyphenation where appropriate. */
function joinWrapped(head, tail) {
  // Only consider de-hyphenating a lowercase-to-lowercase break: "1990-\n1995"
  // and "self-\nEsteem" keep their hyphens either way.
  if (/[a-z]-$/.test(head) && /^[a-z]/.test(tail)) {
    const stem = head.slice(0, -1);
    const lastWord = stem.split(/[\s"“(]/).pop();
    // A genuine compound keeps its hyphen; a word split by typesetting loses it.
    if (KEPT_HYPHEN_PREFIX.test(` ${lastWord}`)) return `${head}${tail}`;
    return stem + tail;
  }
  return `${head} ${tail}`;
}

function isHeading(line, profile, ctx) {
  const { text, size, allCaps, styleKey } = line;
  if (text.length > 120) return false;
  // Headings don't end mid-sentence.
  if (/[.;,:]$/.test(text)) return false;
  if (text.split(/\s+/).length > 20) return false;

  // A line that runs to the right margin is wrapped body text, whatever font
  // it uses. Without this, a note or pull-quote set in its own font gets
  // chopped into one "heading" per visual line.
  if (line.right >= ctx.bodyRight - profile.bodySize) return false;

  // Likewise if the previous line is the same style flowing into this one.
  if (ctx.previous && ctx.previous.styleKey === styleKey && ctx.continues) return false;

  // Word and InDesign exports often bump headings only a point or two, so a
  // small size increase counts as long as the line is short.
  const bigger = size > profile.bodySize * 1.05;
  const distinctStyle = styleKey !== profile.bodyKey && profile.headingKeys.has(styleKey);
  const numbered =
    /^(chapter|section|part|appendix)\b/i.test(text) || /^\d+(\.\d+)*\s+\S/.test(text);

  if (bigger && (distinctStyle || numbered || allCaps || text.length <= 90)) return true;
  if (distinctStyle && (allCaps || numbered || text.length <= 90)) return true;
  return false;
}

/** Bigger heading styles become h2; the rest h3. */
function headingLevel(line, profile) {
  return line.size >= profile.maxHeadingSize - 0.01 ? 2 : 3;
}

// ------------------------------------------------------------------ output

function buildChapters(blocks, fallbackTitle) {
  const groups = [{ title: null, blocks: [] }];

  for (const block of blocks) {
    if (block.type === 'heading') {
      const current = groups.at(-1);
      if (!current.blocks.length && current.title === null) current.title = block.text;
      else groups.push({ title: block.text, blocks: [] });
      // Keep the heading visible in the text as well as in the TOC.
      groups.at(-1).blocks.push(block);
      continue;
    }
    groups.at(-1).blocks.push(block);
  }

  const useSplit = groups.length >= 2;
  const chapters = useSplit ? groups : [{ title: null, blocks }];

  return chapters
    .map((group, i) => ({
      title: group.title || fallbackTitle,
      isFirst: i === 0,
      body: group.blocks.map(renderBlock).filter(Boolean).join('\n'),
    }))
    .filter((c) => c.body);
}

function renderBlock(block) {
  if (block.type === 'image') return `<figure><img src="../${block.path}" alt=""/></figure>`;
  const text = escapeXml(block.text);
  if (!text) return '';
  if (block.type === 'heading') return `<h${block.level}>${text}</h${block.level}>`;
  return `<p>${text}</p>`;
}

function pickTitle(metaTitle, blocks, filename) {
  const clean = String(metaTitle || '').replace(/\s+/g, ' ').trim();
  // Exporters love to leave the source path or "Microsoft Word - foo.doc" here.
  const junk =
    !clean ||
    clean.length < 4 ||
    /^(untitled|document\d*|microsoft word|print|slide\s*\d*)/i.test(clean) ||
    /\.(docx?|pdf|indd|pages|tex)$/i.test(clean) ||
    /[\\/]/.test(clean);

  if (!junk) return clean;

  // Otherwise the first heading, then the biggest early line, then the filename.
  const heading = blocks.find((b) => b.type === 'heading' && b.text.length >= 6);
  if (heading) return heading.text;

  const fromFile = String(filename || '')
    .replace(/\.pdf$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return fromFile || 'Untitled';
}

function cleanAuthor(author) {
  const clean = String(author || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 120) return '';
  if (/^(unknown|user|admin|owner|microsoft|adobe|acrobat)$/i.test(clean)) return '';
  return clean;
}

function mode(values) {
  if (!values.length) return null;
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
