// Fixed-layout ("comic book") EPUB pipeline.
//
// Page images are checked by decoding the PNGs and sampling pixels rather than
// by eyeballing them: a blank page or a page rendered in the wrong font still
// produces a valid PNG, so file existence proves nothing.

import { PANEL, htmlToBlocks, renderBlocksToPages, renderPdfPages } from '../lib/render.mjs';
import { buildImageEpub } from '../lib/epub.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AssetStore } from '../lib/assets.mjs';
import { extractArticle } from '../lib/extract.mjs';
import { buildEpub } from '../lib/epub.mjs';
import { renderMarkdown } from '../lib/markdown.mjs';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

const isPng = (b) => b.subarray(1, 4).toString('latin1') === 'PNG';
const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9;

/** Decoded dimensions, whichever format the page came out as. */
async function imageSize(buffer) {
  const img = await loadImage(buffer);
  return { width: img.width, height: img.height };
}

/**
 * Decode a PNG to raw pixels.
 *
 * loadImage() rather than `new Image(); img.src = buf`: the latter reports the
 * right dimensions but draws nothing, which silently turned every pixel check
 * below into a tautology against a transparent canvas.
 */
async function pixels(buffer) {
  const img = await loadImage(buffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  // White ground first, so a fully transparent decode can't masquerade as ink.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, img.width, img.height);
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, img.width, img.height).data, width: img.width, height: img.height, ctx };
}

/** Fraction of pixels darker than near-white — i.e. how much ink is on the page. */
async function inkRatio(buffer) {
  const { data } = await pixels(buffer);
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 200) dark++;
  return dark / (data.length / 4);
}

/** True when every pixel has r === g === b. */
async function isGrayscale(buffer) {
  const { data } = await pixels(buffer);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2]) return false;
  }
  return true;
}

// ------------------------------------------------------------ html -> blocks

console.log('== html -> blocks ==');
const blocks = htmlToBlocks(
  '<h2>Attribution</h2><p>First paragraph.</p><blockquote><p>A quote.</p></blockquote>' +
    '<ul><li>One</li><li>Two</li></ul><ol><li>Alpha</li><li>Beta</li></ol>' +
    '<hr/><table><tr><th>Year</th><th>N</th></tr><tr><td>2026</td><td>84</td></tr></table>' +
    '<img src="/assets/0123456789abcdef.jpg" alt="A chart"/><img alt="Missing art"/><h3>Sub</h3><pre>code here</pre>'
);
const types = blocks.map((b) => b.type).join(',');
assert(types.startsWith('h2,p,quote,li,li,li,li'), `block types in order: ${types}`);
assert(blocks.filter((b) => b.type === 'li').length === 4, 'list items from both ul and ol');
assert(
  blocks.find((b) => b.type === 'li' && b.text === 'Alpha')?.ordinal === 1,
  'ordered list items are numbered'
);
assert(
  blocks.find((b) => b.type === 'li' && b.text === 'One')?.ordinal == null,
  'unordered list items are not numbered'
);
assert(blocks.some((b) => b.type === 'hr'), 'hr preserved');
assert(blocks.some((b) => b.text === 'Year · N'), 'table rows flattened to text');
const imageBlock = blocks.find((b) => b.type === 'image');
assert(
  imageBlock?.src === '/assets/0123456789abcdef.jpg' && imageBlock.text === 'A chart',
  'an img with a src becomes an image block carrying its alt text'
);
assert(
  blocks.some((b) => b.type === 'quote' && /\[image: Missing art\]/.test(b.text)),
  'an img with no src falls back to its alt text'
);
assert(blocks.some((b) => b.type === 'pre' && /code here/.test(b.text)), 'pre preserved');

// Inline markup must not leak into the flattened text.
const inline = htmlToBlocks('<p>A <strong>bold</strong> and <em>italic</em> run.</p>');
assert(
  inline.length === 1 && inline[0].text === 'A bold and italic run.',
  `inline tags flattened: ${JSON.stringify(inline[0]?.text)}`
);

// ------------------------------------------------------------ text -> pages

console.log('\n== text layout ==');
const long = 'The question of who is accountable for a published claim does not disappear when a machine drafts the sentence. ';
const textPages = await renderBlocksToPages({
  blocks: [
    { type: 'h1', text: 'Media Ethics' },
    { type: 'p', text: long.repeat(20) },
    { type: 'h2', text: 'Attribution' },
    { type: 'p', text: long.repeat(20) },
  ],
  title: 'Media Ethics',
  scale: 1,
  fontSize: 21,
});

assert(textPages.pages.length >= 3, `long text paginated into ${textPages.pages.length} pages`);
const first = textPages.pages[0];
assert(isJpeg(first.data), 'pages are JPEG by default — the format the reader reliably decodes');
assert(first.mediaType === 'image/jpeg' && first.extension === 'jpg', 'page records carry their media type');
const size = await imageSize(first.data);
assert(
  size.width === PANEL.width && size.height === PANEL.height,
  `page is panel-sized at 1x: ${size.width}x${size.height}`
);
assert(await isGrayscale(first.data), 'pages are grayscale');

const ink = await inkRatio(first.data);
assert(ink > 0.02 && ink < 0.5, `first page has text on it (ink ratio ${ink.toFixed(3)})`);
const inkPerPage = [];
for (const p of textPages.pages) inkPerPage.push(await inkRatio(p.data));
assert(inkPerPage.every((r) => r > 0.01), `no page came out blank (min ink ${Math.min(...inkPerPage).toFixed(3)})`);

// Every page must carry a footer: ink in the bottom band.
const footerInk = await (async () => {
  const { ctx, width, height } = await pixels(textPages.pages[1].data);
  const band = ctx.getImageData(0, height - 40, width, 36).data;
  let dark = 0;
  for (let i = 0; i < band.length; i += 4) if (band[i] < 200) dark++;
  // A whole-band hit means the decode failed, not that a footer is present.
  return dark < width * 36 ? dark : 0;
})();
assert(footerInk > 0, `page 2 has a footer drawn (${footerInk} dark px in the bottom band)`);

console.log('\n== scale ==');
const at2x = await renderBlocksToPages({ blocks: [{ type: 'p', text: long.repeat(5) }], scale: 2, fontSize: 21 });
const size2x = await imageSize(at2x.pages[0].data);
assert(
  size2x.width === PANEL.width * 2 && size2x.height === PANEL.height * 2,
  `2x doubles the pixel size: ${size2x.width}x${size2x.height}`
);

// Bigger type at the same page size must need more pages for the same text.
const smallType = await renderBlocksToPages({ blocks: [{ type: 'p', text: long.repeat(12) }], fontSize: 15 });
const largeType = await renderBlocksToPages({ blocks: [{ type: 'p', text: long.repeat(12) }], fontSize: 32 });
assert(
  largeType.pages.length > smallType.pages.length,
  `larger text yields more pages (${smallType.pages.length} at 15px vs ${largeType.pages.length} at 32px)`
);

console.log('\n== long word handling ==');
const unbroken = await renderBlocksToPages({
  blocks: [{ type: 'p', text: 'x'.repeat(400) }],
  fontSize: 21,
});
assert(unbroken.pages.length >= 1 && (await inkRatio(unbroken.pages[0].data)) > 0.01, 'a word wider than the column is broken, not dropped');

const emptyBlocks = await renderBlocksToPages({ blocks: [], fontSize: 21 });
assert(emptyBlocks.pages.length === 1, 'no blocks still produces one (blank) page rather than crashing');

// ------------------------------------------------------------ pdf -> pages

console.log('\n== pdf rasterizing ==');
const pdf = makeTwoPagePdf();

const whole = await renderPdfPages({ data: pdf, scale: 1, split: 'whole' });
assert(whole.pages.length === 2, `whole mode gives one image per PDF page (${whole.pages.length})`);
assert((await imageSize(whole.pages[0].data)).width === PANEL.width, 'rendered at panel width');
assert((await inkRatio(whole.pages[0].data)) > 0.001, 'PDF page actually rendered content');
assert(await isGrayscale(whole.pages[0].data), 'PDF pages are grayscale');

const halves = await renderPdfPages({ data: pdf, scale: 1, split: 'halves' });
assert(halves.pages.length === 4, `halves mode doubles the page count (${halves.pages.length})`);
assert(
  (await imageSize(halves.pages[0].data)).height < (await imageSize(whole.pages[0].data)).height,
  'a half is shorter than the whole page'
);
assert(halves.pages[0].label === 'Page 1 (1/2)', `slices are labelled: ${halves.pages[0].label}`);

const thirds = await renderPdfPages({ data: pdf, scale: 1, split: 'thirds' });
assert(thirds.pages.length === 6, `thirds mode triples the page count (${thirds.pages.length})`);

const capped = await renderPdfPages({ data: pdf, scale: 1, maxPages: 1 });
assert(capped.pages.length === 1, 'maxPages is honoured');
assert(capped.warnings.some((w) => /Only the first/.test(w)), 'truncation is reported, not silent');

// ------------------------------------------------------------ epub packaging

console.log('\n== fixed-layout EPUB ==');
const epub = await buildImageEpub({
  title: 'Syllabus Scan',
  byline: 'Dan Pacheco',
  pages: whole.pages,
});
assert(epub.filename === 'Syllabus Scan.epub', `filename from title: ${epub.filename}`);
assert(epub.pages === 2, 'page count reported');

const sig = epub.buffer.subarray(30, 38).toString('latin1');
assert(sig === 'mimetype', 'mimetype is still the first zip entry');
assert(epub.buffer.readUInt16LE(8) === 0, 'mimetype still stored uncompressed');

const zip = await JSZip.loadAsync(epub.buffer);
const names = Object.keys(zip.files);
assert(names.includes('OEBPS/images/p0001.jpg'), 'page images included with the right extension');
assert(names.includes('OEBPS/text/p0001.xhtml'), 'one XHTML wrapper per page');
assert(names.filter((n) => /images\/p\d+\.jpg$/.test(n)).length === 2, 'exactly one image per page');

const opf = await zip.file('OEBPS/content.opf').async('string');
assert(/rendition:layout">pre-paginated/.test(opf), 'declared pre-paginated (fixed layout)');
assert(/properties="cover-image"/.test(opf), 'first page marked as the cover image');
assert(/Dan Pacheco/.test(opf), 'author in metadata');

// Every manifest href must resolve, and every image must be manifested exactly once.
const opfDoc = new JSDOM(opf, { contentType: 'application/xml' }).window.document;
const hrefs = [...opfDoc.querySelectorAll('manifest > item')].map((i) => i.getAttribute('href'));
assert(hrefs.every((h) => names.includes(`OEBPS/${h}`)), 'every manifest href exists in the zip');
assert(new Set(hrefs).size === hrefs.length, 'no duplicate manifest hrefs');
const ids = new Set([...opfDoc.querySelectorAll('manifest > item')].map((i) => i.getAttribute('id')));
const idrefs = [...opfDoc.querySelectorAll('spine > itemref')].map((i) => i.getAttribute('idref'));
assert(idrefs.length === 2 && idrefs.every((r) => ids.has(r)), 'spine references manifest ids');

const pageXhtml = await zip.file('OEBPS/text/p0001.xhtml').async('string');
assert(/media-type="image\/jpeg"/.test(opf), 'manifest declares the real media type');
const expected = await imageSize(whole.pages[0].data);
assert(
  pageXhtml.includes(`content="width=${expected.width}, height=${expected.height}"`),
  'page viewport matches the real image size'
);
assert(/<img src="\.\.\/images\/p0001\.jpg"/.test(pageXhtml), 'page points at its image');

let xmlOk = true;
for (const name of names.filter((n) => /\.(xhtml|opf|ncx|xml)$/.test(n))) {
  const text = await zip.file(name).async('string');
  try {
    if (new JSDOM(text, { contentType: 'application/xml' }).window.document.querySelector('parsererror')) {
      xmlOk = false;
      console.log(`   bad XML: ${name}`);
    }
  } catch {
    xmlOk = false;
  }
}
assert(xmlOk, 'every XML part parses');

let refused = false;
try {
  await buildImageEpub({ title: 'Nothing', pages: [] });
} catch {
  refused = true;
}
assert(refused, 'building with zero pages is refused rather than emitting a broken EPUB');


// ------------------------------------------------------- editor images

console.log('\n== editor images ==');

const assetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'epub-drop-assets-'));
const store = new AssetStore(assetDir);

// A small red PNG, so we can prove the actual bytes land in the EPUB.
const source = createCanvas(300, 200);
const sctx = source.getContext('2d');
sctx.fillStyle = '#c0392b';
sctx.fillRect(0, 0, 300, 200);
const sourcePng = source.toBuffer('image/png');

const saved = await store.save(sourcePng, 'image/png');
assert(/^[0-9a-f]{16}\.jpg$/.test(saved.name), `stored as JPEG under a content-addressed name: ${saved.name}`);
assert(saved.url === `/assets/${saved.name}`, 'returns the URL the draft will reference');
assert(saved.width === 300 && saved.height === 200, 'reports real dimensions');

const again = await store.save(sourcePng, 'image/png');
assert(again.name === saved.name, 'the same image saved twice is stored once');

// Oversized input must be downscaled rather than shipped at full size.
const huge = createCanvas(4000, 3000);
const hctx = huge.getContext('2d');
hctx.fillStyle = '#333';
hctx.fillRect(0, 0, 4000, 3000);
const bigSaved = await store.save(huge.toBuffer('image/png'), 'image/png');
assert(bigSaved.width <= 1600 && bigSaved.height <= 2400, `downscaled to ${bigSaved.width}x${bigSaved.height}`);

let badRejected = false;
try {
  await store.save(Buffer.from('not an image'), 'image/png');
} catch {
  badRejected = true;
}
assert(badRejected, 'a non-image is rejected with a clear error');

assert((await store.resolve(saved.url))?.mediaType === 'image/jpeg', 'resolve() returns bytes and media type');
assert((await store.resolve('/assets/../../etc/passwd')) === null, 'resolve() refuses path traversal');
assert((await store.resolve('https://example.com/x.png')) === null, 'resolve() ignores remote URLs');

console.log('\n== images into a reflowable EPUB ==');
const bodyHtml = renderMarkdown(`# Notes\n\nBefore.\n\n![A red block](${saved.url})\n\nAfter.\n`);
const article = await extractArticle({
  html: `<!DOCTYPE html><body>${bodyHtml}</body>`,
  fragment: true,
  includeImages: true,
  resolveAsset: (src) => store.resolve(src),
});
assert(article.images.length === 1, `draft image embedded (${article.images.length})`);
assert(/<img src="\.\.\/images\/img-1\.jpg"/.test(article.chapters.map((c) => c.body).join('\n')), 'src rewritten to an in-EPUB path');

const flowEpub = await buildEpub(article);
const flowZip = await JSZip.loadAsync(flowEpub.buffer);
assert(Object.keys(flowZip.files).includes('OEBPS/images/img-1.jpg'), 'image file present in the EPUB');
const embedded = await flowZip.file('OEBPS/images/img-1.jpg').async('nodebuffer');
assert(isJpeg(embedded), 'embedded image is JPEG');
assert(embedded.length > 0 && (await imageSize(embedded)).width === 300, 'embedded image decodes at the expected size');
assert(/media-type="image\/jpeg"/.test(await flowZip.file('OEBPS/content.opf').async('string')), 'image declared in the manifest');

// A draft referencing an asset that has been deleted must warn, not crash.
const brokenArticle = await extractArticle({
  html: '<!DOCTYPE html><body><p>x</p><img src="/assets/ffffffffffffffff.png" alt="gone"></body>',
  fragment: true,
  includeImages: true,
  resolveAsset: (src) => store.resolve(src),
});
assert(brokenArticle.images.length === 0, 'a missing asset is not embedded');
assert(brokenArticle.warnings.some((w) => /missing from the assets folder/.test(w)), 'missing asset is reported');

console.log('\n== images into page images ==');
const imageBlocks = htmlToBlocks(bodyHtml);
assert(imageBlocks.some((b) => b.type === 'image' && b.src === saved.url), 'image block keeps the asset URL');

const withPicture = await renderBlocksToPages({
  blocks: imageBlocks,
  scale: 1,
  fontSize: 21,
  loadAsset: async (src) => (await store.resolve(src))?.data || null,
});
const withoutPicture = await renderBlocksToPages({ blocks: imageBlocks, scale: 1, fontSize: 21 });
const inkWith = await inkRatio(withPicture.pages[0].data);
const inkWithout = await inkRatio(withoutPicture.pages[0].data);
assert(
  inkWith > inkWithout + 0.05,
  `the picture is actually drawn (ink ${inkWith.toFixed(3)} with vs ${inkWithout.toFixed(3)} without)`
);

await fsp.rm(assetDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// ------------------------------------------------------------ fixture

/** Two-page PDF with visible text, uncompressed so it stays readable here. */
function makeTwoPagePdf() {
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>';
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>';
  objects[4] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>';

  const stream = (label) => {
    const lines = [];
    // Enough lines, spread down the page, that every slice has ink in it.
    for (let i = 0; i < 30; i++) {
      lines.push(`BT /F1 18 Tf 1 0 0 1 72 ${740 - i * 24} Tm (${label} line ${i + 1}) Tj ET`);
    }
    return lines.join('\n');
  };

  const s1 = stream('One');
  const s2 = stream('Two');
  objects[5] = `<< /Length ${Buffer.byteLength(s1)} >>\nstream\n${s1}\nendstream`;
  objects[6] = `<< /Length ${Buffer.byteLength(s2)} >>\nstream\n${s2}\nendstream`;
  objects[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(pdf);
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  const max = objects.length - 1;
  pdf += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= max; id++) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
