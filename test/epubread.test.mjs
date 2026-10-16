// Reading a built EPUB back out, which is what the preview does.
//
// Round-trip tests: build a book with the app's own writers, then read it back
// and check the chapters, titles and images match what went in. That is the
// only way to know a preview reflects the file rather than the intermediate
// state it came from.

import { readEpub, readChapter, readEpubFile, mediaTypeFor } from '../lib/epubread.mjs';
import { buildEpub, buildImageEpub } from '../lib/epub.mjs';
import { extractArticle } from '../lib/extract.mjs';
import { encodePage } from '../lib/render.mjs';
import { createCanvas } from '@napi-rs/canvas';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epub-drop-read-'));
const imageUrl = (internal) => `/img/${internal}`;

// ------------------------------------------------------------ reflowable

console.log('== reflowable round trip ==');
const article = await extractArticle({
  html:
    '<!DOCTYPE html><body>' +
    '<h2>First Section</h2><p>Opening paragraph.</p>' +
    '<blockquote><p>A quote worth keeping.</p></blockquote>' +
    '<h2>Second Section</h2><p>Closing paragraph.</p>' +
    '<ul><li>One</li><li>Two</li></ul>' +
    '</body>',
  fragment: true,
  includeImages: false,
});
article.title = 'Round Trip';
article.byline = 'Dana Reyes';

const built = await buildEpub(article);
const flowPath = path.join(dir, built.filename);
await fs.writeFile(flowPath, built.buffer);

const book = await readEpub(flowPath);
assert(book.title === 'Round Trip', `title read from the package: ${book.title}`);
assert(book.author === 'Dana Reyes', `author read from the package: ${book.author}`);
assert(book.layout === 'reflowable', `layout detected as reflowable: ${book.layout}`);
assert(book.spine.length === 2, `spine has both chapters (${book.spine.length})`);
assert(
  book.spine.map((c) => c.title).join(' | ') === 'First Section | Second Section',
  `chapter titles come from the nav document: ${book.spine.map((c) => c.title).join(' | ')}`
);

const first = await readChapter(book, 0, { imageUrl });
assert(first.title === 'First Section', 'chapter title returned');
assert(first.total === 2, 'total chapter count returned, for the pager');
assert(/Opening paragraph/.test(first.html), 'chapter body returned');
assert(/<blockquote>/.test(first.html), 'structure preserved');
assert(!/xmlns=/.test(first.html), 'the XHTML namespace is stripped from every element');
assert(/<h1>Round Trip<\/h1>/.test(first.html), 'the title page heading is part of chapter one');

const second = await readChapter(book, 1, { imageUrl });
assert(/Closing paragraph/.test(second.html) && /<li>Two<\/li>/.test(second.html), 'second chapter reads');

let outOfRange = false;
try {
  await readChapter(book, 99, { imageUrl });
} catch {
  outOfRange = true;
}
assert(outOfRange, 'asking for a chapter past the end errors rather than returning nothing');

// ------------------------------------------------------------ images inside

console.log('\n== embedded images ==');
const png = (() => {
  const canvas = createCanvas(40, 30);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(0, 0, 40, 30);
  return canvas.toBuffer('image/png');
})();

const withImage = {
  ...article,
  title: 'Has Pictures',
  chapters: [
    {
      title: 'Only Chapter',
      isFirst: true,
      body: '<p>Before.</p><p><img src="../images/img-1.png" alt="A red block"/></p><p>After.</p>',
    },
  ],
  images: [{ path: 'images/img-1.png', mediaType: 'image/png', data: png }],
};
const imageBook = await buildEpub(withImage);
const imagePath = path.join(dir, imageBook.filename);
await fs.writeFile(imagePath, imageBook.buffer);

const opened = await readEpub(imagePath);
const chapter = await readChapter(opened, 0, { imageUrl });
assert(
  /src="\/img\/OEBPS\/images\/img-1\.png"/.test(chapter.html),
  `image src rewritten to the serving endpoint: ${/src="([^"]+)"/.exec(chapter.html)?.[1]}`
);

const bytes = await readEpubFile(opened, 'OEBPS/images/img-1.png');
assert(bytes?.equals(png), 'the image reads back byte-identical');
assert((await readEpubFile(opened, 'OEBPS/images/nope.png')) === null, 'a missing entry returns null');
assert(
  (await readEpubFile(opened, '../../etc/passwd')) === null,
  'a traversal path is not an archive entry, so it simply misses'
);
assert(mediaTypeFor('a/b/c.jpg') === 'image/jpeg' && mediaTypeFor('x.png') === 'image/png', 'media types by extension');

// An <img> pointing at something absent must not leave a broken reference.
const brokenBook = await buildEpub({
  ...article,
  title: 'Broken Image',
  chapters: [{ title: 'One', isFirst: true, body: '<p><img src="../images/gone.png" alt="missing"/></p>' }],
  images: [],
});
const brokenPath = path.join(dir, 'broken.epub');
await fs.writeFile(brokenPath, brokenBook.buffer);
const brokenChapter = await readChapter(await readEpub(brokenPath), 0, { imageUrl });
assert(!/src=/.test(brokenChapter.html), 'an image that is not in the archive has its src removed');

// ------------------------------------------------------------ links

console.log('\n== links ==');
const linked = await buildEpub({
  ...article,
  title: 'Links',
  chapters: [
    {
      title: 'One',
      isFirst: true,
      body: '<p><a href="https://example.com/x">external</a> and <a href="ch002.xhtml">internal</a></p>',
    },
  ],
  images: [],
});
const linkPath = path.join(dir, 'links.epub');
await fs.writeFile(linkPath, linked.buffer);
const linkChapter = await readChapter(await readEpub(linkPath), 0, { imageUrl });
assert(/href="https:\/\/example.com\/x"/.test(linkChapter.html), 'external links survive');
assert(/target="_blank"/.test(linkChapter.html), 'and open in a new tab rather than replacing the app');
assert(
  />internal</.test(linkChapter.html) && !/href="ch002/.test(linkChapter.html),
  'an internal link keeps its text but loses the jump, which would navigate the app away'
);

// ------------------------------------------------------------ fixed layout

console.log('\n== fixed layout ==');
const pages = [1, 2].map((n) => {
  const canvas = createCanvas(120, 200);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 120, 200);
  ctx.fillStyle = '#000000';
  ctx.font = '16px Georgia';
  ctx.fillText(`p${n}`, 20, 40);
  return { ...encodePage(canvas), width: 120, height: 200, label: `Page ${n}` };
});
const fixed = await buildImageEpub({ title: 'Scanned Thing', byline: 'Nobody', pages });
const fixedPath = path.join(dir, fixed.filename);
await fs.writeFile(fixedPath, fixed.buffer);

const fixedBook = await readEpub(fixedPath);
assert(fixedBook.layout === 'pre-paginated', `fixed layout is detected: ${fixedBook.layout}`);
assert(fixedBook.spine.length === 2, 'both pages are in the spine');
assert(
  fixedBook.spine.map((c) => c.title).join(', ') === 'Page 1, Page 2',
  `page labels read back: ${fixedBook.spine.map((c) => c.title).join(', ')}`
);
const fixedChapter = await readChapter(fixedBook, 0, { imageUrl });
assert(/src="\/img\/OEBPS\/images\/p0001\.jpg"/.test(fixedChapter.html), 'the page image is addressable');

// ------------------------------------------------------------ bad input

console.log('\n== bad input ==');
const notEpub = path.join(dir, 'not.epub');
await fs.writeFile(notEpub, 'this is not a zip at all');
let rejected = false;
try {
  await readEpub(notEpub);
} catch {
  rejected = true;
}
assert(rejected, 'a file that is not a zip is rejected');

// A valid zip with no container.xml is not an EPUB.
const JSZip = (await import('jszip')).default;
const bogus = new JSZip();
bogus.file('hello.txt', 'hi');
const bogusPath = path.join(dir, 'bogus.epub');
await fs.writeFile(bogusPath, await bogus.generateAsync({ type: 'nodebuffer' }));
let noContainer = false;
try {
  await readEpub(bogusPath);
} catch (err) {
  noContainer = /container/i.test(err.message);
}
assert(noContainer, 'a zip without container.xml is rejected by name');

await fs.rm(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
