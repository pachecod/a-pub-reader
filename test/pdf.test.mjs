// PDF -> EPUB tests against hand-built PDFs.
//
// The fixtures are written here as raw, uncompressed PDF syntax rather than
// checked in as binaries, so the exact text, font sizes and coordinates that
// each assertion depends on are visible and adjustable.

import { extractPdf } from '../lib/pdf.mjs';
import { buildEpub } from '../lib/epub.mjs';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { normalizeForDevice } from '../lib/assets.mjs';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

// ------------------------------------------------------------ PDF fixture

const PAGE_W = 612;
const PAGE_H = 792;

/**
 * Build a single-page content stream. Each line is
 * {text, size, y, x, font} in PDF coordinates (y grows upward).
 */
function contentStream(lines) {
  const parts = ['BT'];
  for (const line of lines) {
    const font = line.font || 'F1';
    const escaped = line.text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    parts.push(`/${font} ${line.size} Tf`);
    parts.push(`1 0 0 1 ${line.x} ${line.y} Tm`);
    parts.push(`(${escaped}) Tj`);
  }
  parts.push('ET');
  return parts.join('\n');
}

/** Assemble a minimal but valid multi-page PDF with a correct xref table. */
function makePdf(pages, info = {}) {
  const objects = [];
  const pageCount = pages.length;

  // 1 = catalog, 2 = pages, 3..(2+n) = page objects,
  // then n content streams, then two fonts, then optional info.
  const pageIds = pages.map((_, i) => 3 + i);
  const contentIds = pages.map((_, i) => 3 + pageCount + i);
  const fontRegular = 3 + pageCount * 2;
  const fontBold = fontRegular + 1;
  const infoId = fontBold + 1;

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] =
    `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;

  pages.forEach((lines, i) => {
    objects[pageIds[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> ` +
      `/Contents ${contentIds[i]} 0 R >>`;
    const stream = contentStream(lines);
    objects[contentIds[i]] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });

  objects[fontRegular] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[fontBold] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`;

  const infoEntries = Object.entries(info)
    .map(([k, v]) => `/${k} (${String(v).replace(/([()\\])/g, '\\$1')})`)
    .join(' ');
  if (infoEntries) objects[infoId] = `<< ${infoEntries} >>`;

  // Serialize, recording byte offsets for the xref table.
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    if (!objects[id]) continue;
    offsets[id] = Buffer.byteLength(pdf);
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefStart = Buffer.byteLength(pdf);
  const maxId = objects.length - 1;
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    pdf += offsets[id]
      ? `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
      : '0000000000 65535 f \n';
  }
  pdf +=
    `trailer\n<< /Size ${maxId + 1} /Root 1 0 R${infoEntries ? ` /Info ${infoId} 0 R` : ''} >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

// A two-page article: a 16pt heading, wrapped body paragraphs at 12pt, an
// indented new paragraph, a hyphenated line break, a second heading, and a
// running footer plus page numbers on both pages.
const LEADING = 16;
const LEFT = 72;
const RIGHT_EDGE = 'x'.repeat(0); // documentation only; widths come from the font

function bodyPage({ heading, paragraphs, pageNumber }) {
  const lines = [];
  let y = PAGE_H - 90;

  if (heading) {
    lines.push({ text: heading, size: 16, x: LEFT, y, font: 'F2' });
    y -= LEADING * 1.8;
  }

  for (const paragraph of paragraphs) {
    paragraph.forEach((text, i) => {
      lines.push({ text, size: 12, x: i === 0 ? LEFT + paragraph.indent0 : LEFT, y });
      y -= LEADING;
    });
    y -= LEADING * 0.6; // paragraph spacing
  }

  // Running footer and folio, both inside the bottom 8% margin.
  lines.push({ text: 'Field Testing the Future', size: 9, x: LEFT, y: 40 });
  lines.push({ text: String(pageNumber), size: 9, x: PAGE_W / 2, y: 26 });
  return lines;
}

const para = (lines, indent0 = 0) => Object.assign(lines, { indent0 });

const pdf = makePdf(
  [
    bodyPage({
      heading: 'Finding the Problem',
      paragraphs: [
        para([
          'Newsrooms adopting automated tools face a familiar problem in an unfamiliar',
          'form, because the question of who is accountable for a published claim does',
          'not simply disappear when a machine drafts the sentence.',
        ]),
        para(
          [
            'Attribution practices built for human sources translate poorly to cross-',
            'platform summaries, and editors need a record that survives editing.',
          ],
          24
        ),
      ],
      pageNumber: 1,
    }),
    bodyPage({
      heading: 'Identify Failures',
      paragraphs: [
        para([
          'A correction policy that assumes a single identifiable author will fail on',
          'generated text, so newsrooms need to name a responsible editor up front.',
        ]),
      ],
      pageNumber: 2,
    }),
  ],
  { Title: 'Microsoft Word - draft7.docx', Author: 'Dana Reyes' }
);

// ------------------------------------------------------------ tests

console.log('== text layer ==');
const article = await extractPdf({ data: pdf, name: 'week-03-reading.pdf' });
const allText = article.chapters.map((c) => c.body).join('\n');

console.log('title    :', JSON.stringify(article.title));
console.log('byline   :', JSON.stringify(article.byline));
console.log('chapters :', article.chapters.map((c) => c.title));
console.log('warnings :', article.warnings);

assert(article.chapters.length === 2, `split into 2 chapters, got ${article.chapters.length}`);
assert(
  article.chapters[0].title === 'Finding the Problem' && article.chapters[1].title === 'Identify Failures',
  'both headings became chapter titles'
);
assert(/<h[23]>Finding the Problem<\/h[23]>/.test(allText), 'heading rendered as a heading element');

console.log('\n== paragraph reconstruction ==');
assert(
  /Newsrooms adopting automated tools face a familiar problem in an unfamiliar form, because/.test(allText),
  'wrapped lines rejoined into one paragraph'
);
assert(
  /cross-platform summaries/.test(allText),
  'end-of-line hyphenation healed ("cross-" + "platform")'
);
assert(!/cross- platform/.test(allText), 'no stray space left at the healed hyphen');
const paragraphCount = (allText.match(/<p>/g) || []).length;
assert(paragraphCount === 3, `indent started a new paragraph (${paragraphCount} paragraphs, expected 3)`);

console.log('\n== running heads and folios ==');
assert(!/Field Testing the Future/.test(allText), 'repeated footer removed');
assert(!/<p>1<\/p>|<p>2<\/p>/.test(allText), 'page numbers removed');
assert(article.warnings.some((w) => /repeated header\/footer/.test(w)), 'reported what it removed');

console.log('\n== metadata ==');
assert(
  article.title === 'Finding the Problem' || article.title === 'week-03-reading',
  `junk "Microsoft Word - draft7.docx" title rejected, used "${article.title}"`
);
assert(article.byline === 'Dana Reyes', 'author taken from PDF metadata');

console.log('\n== epub output ==');
const epub = await buildEpub(article);
const zip = await JSZip.loadAsync(epub.buffer);
const names = Object.keys(zip.files);
assert(epub.chapters === 2, 'EPUB has both chapters in the spine');

let xmlOk = true;
for (const name of names.filter((n) => /\.(xhtml|opf|ncx|xml)$/.test(n))) {
  const text = await zip.file(name).async('string');
  try {
    const doc = new JSDOM(text, { contentType: 'application/xml' }).window.document;
    if (doc.querySelector('parsererror')) xmlOk = false;
  } catch {
    xmlOk = false;
  }
}
assert(xmlOk, 'every XML part of the PDF-derived EPUB parses');

console.log('\n== scanned PDF (no text layer) ==');
const scanned = makePdf([[]], { Title: 'Scan' });
try {
  await extractPdf({ data: scanned, name: 'scan.pdf' });
  assert(false, 'a PDF with no text layer is rejected');
} catch (err) {
  assert(err.code === 'NO_TEXT_LAYER', `no text layer rejected with a clear code (${err.code})`);
  assert(/OCR/.test(err.message), 'error message points the user at OCR');
}

console.log('\n== pictures in a PDF ==');

/**
 * One page: a heading, a paragraph, a 300x225pt picture, another paragraph,
 * and an 8pt icon that should be ignored. The picture is an uncompressed RGB
 * raster, so its pixels are known.
 */
function pdfWithPicture() {
  const W = 40;
  const H = 30;
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      px[i] = x * 6;
      px[i + 1] = y * 8;
      px[i + 2] = 200;
    }
  }
  const text = (s, y, size = 12) => `BT /F1 ${size} Tf 1 0 0 1 72 ${y} Tm (${s}) Tj ET`;
  const content = [
    text('Figures in a PDF', 720, 18),
    text('This paragraph comes before the picture and says what it shows.', 690),
    'q 300 0 0 225 72 440 cm /Im1 Do Q',
    text('This paragraph comes after the picture and carries on.', 410),
    'q 8 0 0 8 72 380 cm /Im1 Do Q',
  ].join('\n');

  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (chunk) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    parts.push(buf);
    length += buf.length;
  };
  const object = (id, body) => {
    offsets[id] = length;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };

  push('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 4 0 R >>`);
  object(4, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  offsets[6] = length;
  push(`6 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${px.length} >>\nstream\n`);
  push(px);
  push('\nendstream\nendobj\n');

  const xref = length;
  let table = 'xref\n0 7\n0000000000 65535 f \n';
  for (let id = 1; id <= 6; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(`${table}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const pictured = await extractPdf({ data: pdfWithPicture(), name: 'figures.pdf', normalizeImage: normalizeForDevice });
assert(pictured.images.length === 1, `the figure is extracted and the 8pt icon is not: ${pictured.images.length}`);
const picture = pictured.images[0];
assert(picture?.mediaType === 'image/jpeg' && picture.path === 'images/pdf-1.jpg', `it is re-encoded as JPEG for the reader: ${picture?.path}`);

const { loadImage } = await import('@napi-rs/canvas');
const decoded = picture ? await loadImage(picture.data) : null;
const ratio = decoded ? decoded.width / decoded.height : 0;
assert(Math.abs(ratio - 300 / 225) < 0.05, `the crop keeps the figure's shape: ${decoded?.width}x${decoded?.height}`);

const pictureBody = pictured.chapters.map((c) => c.body).join('\n');
const before = pictureBody.indexOf('comes before the picture');
const figureAt = pictureBody.indexOf('<img src="../images/pdf-1.jpg"');
const after = pictureBody.indexOf('comes after the picture');
assert(before >= 0 && figureAt > before && after > figureAt, 'the figure sits between the paragraphs around it');

const noPictures = await extractPdf({ data: pdfWithPicture(), name: 'figures.pdf', includeImages: false, normalizeImage: normalizeForDevice });
assert(noPictures.images.length === 0 && !/<img/.test(noPictures.chapters.map((c) => c.body).join('')), 'Include images off leaves them out');

const picturedEpub = await buildEpub(pictured);
const picturedZip = await JSZip.loadAsync(picturedEpub.buffer);
assert(Boolean(picturedZip.file('OEBPS/images/pdf-1.jpg')), 'the picture is packed into the EPUB');
const picturedOpf = await picturedZip.file('OEBPS/content.opf').async('string');
assert(/href="images\/pdf-1\.jpg"[^>]*media-type="image\/jpeg"|media-type="image\/jpeg"[^>]*href="images\/pdf-1\.jpg"/.test(picturedOpf), 'and listed in the package manifest');

console.log('\n== not a PDF ==');
try {
  await extractPdf({ data: Buffer.from('this is not a pdf at all'), name: 'x.pdf' });
  assert(false, 'garbage input rejects');
} catch (err) {
  assert(true, `garbage input rejects (${err.name}: ${String(err.message).slice(0, 60)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
