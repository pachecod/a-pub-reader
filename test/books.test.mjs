// Catalogue browsing: picking the right EPUB and refusing the wrong download.
//
// Feed parsing and file selection run against fixtures; the download guard runs
// against a local server, so no test depends on a live catalogue being up.

import http from 'node:http';
import JSZip from 'jszip';
import { CATALOGUES, bookFilename, downloadBook, fetchCatalogue, pickEpub } from '../lib/books.mjs';
import { parseFeed } from '../lib/rss.mjs';
import { safeFilename } from '../lib/epub.mjs';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

// ------------------------------------------------------------ picking a file

console.log('== choosing which file to download ==');

// The shape Standard Ebooks actually publishes: several builds per title.
const enclosures = [
  { href: 'https://x.test/b/book.epub?source=feed', type: 'application/epub+zip', title: 'Recommended compatible epub', bytes: 576298 },
  { href: 'https://x.test/b/book_advanced.epub?source=feed', type: 'application/epub+zip', title: 'Advanced epub', bytes: 1248934 },
  { href: 'https://x.test/b/book.kepub.epub?source=feed', type: 'application/kepub+zip', title: 'Kobo Kepub epub', bytes: 513479 },
  { href: 'https://x.test/b/book.azw3?source=feed', type: 'application/x-mobipocket-ebook', title: 'Amazon Kindle azw3', bytes: 593581 },
  { href: 'https://x.test/b/text/single-page', type: 'application/xhtml+xml', title: 'XHTML', bytes: 309903 },
];

const picked = pickEpub(enclosures);
assert(/book\.epub/.test(picked.href), `the compatible build is chosen: ${picked.title}`);
assert(!/advanced/.test(picked.href), 'not the advanced build, which uses features this reader may not handle');
assert(!/kepub/.test(picked.href), "not Kobo's kepub, which is a different format wearing an epub extension");
assert(pickEpub([]) === null, 'no enclosures means no book');
assert(
  pickEpub([{ href: 'a.azw3', type: 'application/x-mobipocket-ebook' }]) === null,
  'a Kindle-only entry is not offered'
);

// Falling back when nothing is labelled "compatible": smallest real EPUB wins.
const unlabelled = pickEpub([
  { href: 'big.epub', type: 'application/epub+zip', title: '', bytes: 9000 },
  { href: 'small.epub', type: 'application/epub+zip', title: '', bytes: 3000 },
]);
assert(unlabelled.href === 'small.epub', 'with no labels the smallest EPUB is chosen');

// A kepub that declares itself as a plain epub is still excluded, by filename.
const sneaky = pickEpub([
  { href: 'https://x.test/b.kepub.epub', type: 'application/epub+zip', title: 'Kepub', bytes: 100 },
  { href: 'https://x.test/b.epub', type: 'application/epub+zip', title: '', bytes: 500 },
]);
assert(sneaky.href === 'https://x.test/b.epub', 'a .kepub.epub is excluded even when typed as application/epub+zip');

console.log('\n== catalogue parsing ==');
const CATALOGUE_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Ebooks</title>
  <entry>
    <id>https://x.test/ebooks/a-author/a-title</id>
    <title>A Title</title>
    <author><name>A. Author</name></author>
    <published>2026-08-31T21:31:29Z</published>
    <content type="html">&lt;p&gt;A &lt;i&gt;blurb&lt;/i&gt; describing the book.&lt;/p&gt;</content>
    <link href="https://x.test/ebooks/a-author/a-title" rel="alternate" type="application/xhtml+xml"/>
    <link href="https://x.test/dl/a.epub" rel="enclosure" type="application/epub+zip" title="Recommended compatible epub" length="123456"/>
    <link href="https://x.test/dl/a_advanced.epub" rel="enclosure" type="application/epub+zip" title="Advanced epub" length="999999"/>
  </entry>
  <entry>
    <id>https://x.test/articles/no-book</id>
    <title>An Article, Not A Book</title>
    <content type="html">Just text.</content>
    <link href="https://x.test/articles/no-book" rel="alternate"/>
  </entry>
</feed>`;

const parsed = parseFeed(CATALOGUE_XML);
assert(parsed.items[0].enclosures.length === 2, `enclosures parsed from Atom links (${parsed.items[0].enclosures.length})`);
assert(parsed.items[1].enclosures.length === 0, 'an article entry has none');

// RSS 2.0 uses a single <enclosure> element instead.
const RSS_ENCLOSURE = `<?xml version="1.0"?><rss version="2.0"><channel><title>R</title>
  <item><title>An RSS Book</title><link>https://x.test/p</link>
    <enclosure url="https://x.test/dl/r.epub" type="application/epub+zip" length="4242"/>
  </item></channel></rss>`;
const rssParsed = parseFeed(RSS_ENCLOSURE);
assert(
  rssParsed.items[0].enclosures[0]?.href === 'https://x.test/dl/r.epub',
  'RSS 2.0 <enclosure url=...> is read too'
);
assert(rssParsed.items[0].enclosures[0].bytes === 4242, 'declared length is captured');

console.log('\n== built-in catalogue ==');
assert(CATALOGUES.length >= 1, 'at least one catalogue ships with the app');
assert(
  CATALOGUES.every((c) => /^https:\/\//.test(c.url) && c.label && c.id),
  'each has an https URL, a label and an id'
);

console.log('\n== filenames ==');
assert(
  bookFilename({ title: 'The Trap', author: 'Dorothy M. Richardson' }, safeFilename) ===
    'Dorothy M. Richardson - The Trap.epub',
  'author and title, in a form that sorts usefully on the device'
);
assert(
  bookFilename({ title: 'Untitled', author: '' }, safeFilename) === 'Untitled.epub',
  'a missing author is simply omitted'
);
assert(
  !/[/:*?"<>|]/.test(bookFilename({ title: 'A/B: Yes?', author: 'X' }, safeFilename)),
  'reserved characters are removed for FAT32'
);

// ------------------------------------------------------------ downloads

console.log('\n== download guard ==');

const realEpub = await (async () => {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container/>');
  return zip.generateAsync({ type: 'nodebuffer' });
})();

const notAnEpubZip = await (async () => {
  const zip = new JSZip();
  zip.file('hello.txt', 'not a book');
  return zip.generateAsync({ type: 'nodebuffer' });
})();

const server = http.createServer((req, res) => {
  if (req.url === '/good.epub') {
    res.writeHead(200, { 'content-type': 'application/epub+zip' });
    return res.end(realEpub);
  }
  if (req.url === '/error-page') {
    // The case that matters: a 200 carrying HTML instead of the file.
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html><body>Sorry, members only.</body></html>');
  }
  if (req.url === '/wrong-zip') {
    res.writeHead(200, { 'content-type': 'application/epub+zip' });
    return res.end(notAnEpubZip);
  }
  if (req.url === '/empty') {
    res.writeHead(200, { 'content-type': 'application/epub+zip' });
    return res.end(Buffer.alloc(0));
  }
  if (req.url === '/huge') {
    res.writeHead(200, { 'content-type': 'application/epub+zip', 'content-length': String(200 * 1024 * 1024) });
    return res.end(Buffer.alloc(16));
  }
  res.writeHead(404);
  res.end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const good = await downloadBook(`${base}/good.epub`);
assert(good.equals(realEpub), 'a real EPUB downloads byte-for-byte, untouched');

for (const [path, label, expect] of [
  ['/error-page', 'an HTML error page served with a 200', /not an EPUB/i],
  ['/wrong-zip', 'a zip that is not an EPUB', /container|not a readable/i],
  ['/empty', 'an empty response', /empty/i],
  ['/huge', 'a file declared far too large', /too large/i],
  ['/missing', 'a 404', /HTTP 404/],
]) {
  let message = '';
  try {
    await downloadBook(`${base}${path}`);
  } catch (err) {
    message = err.message;
  }
  assert(expect.test(message), `${label} is rejected: ${message.slice(0, 60)}`);
}

let unreachable = '';
try {
  await downloadBook('http://127.0.0.1:45999/x.epub');
} catch (err) {
  unreachable = err.message;
}
assert(/hotspot/i.test(unreachable), `an unreachable host hints at the hotspot case: ${unreachable.slice(0, 50)}`);

console.log('\n== catalogue with no books ==');
// Pointing this at an article feed should say so, not look broken.
const articleServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Articles</title>
    <item><title>One</title><link>https://x.test/1</link><description>text</description></item>
    <item><title>Two</title><link>https://x.test/2</link><description>text</description></item>
  </channel></rss>`);
});
await new Promise((r) => articleServer.listen(0, '127.0.0.1', r));
const articleFeed = await fetchCatalogue(`http://127.0.0.1:${articleServer.address().port}/feed`);
assert(articleFeed.books.length === 0, 'an article feed yields no books');
assert(articleFeed.skipped === 2, `and reports how many entries were skipped (${articleFeed.skipped})`);

server.close();
articleServer.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
