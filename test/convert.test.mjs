// Convert a synthetic page and validate the resulting EPUB.
import { extractArticle } from '../lib/extract.mjs';
import { buildEpub } from '../lib/epub.mjs';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Site — Media Ethics in the Age of Automation</title>
  <meta property="og:site_name" content="The Example Review">
  <script>alert('xss')</script>
  <style>.x{color:red}</style>
</head>
<body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<div class="ad">SUBSCRIBE NOW! Limited offer!! Sign up for our newsletter today.</div>
<article>
  <h1>Media Ethics in the Age of Automation</h1>
  <p class="byline">By Dana Reyes</p>
  <p>Newsrooms adopting automated tools face a familiar problem in an unfamiliar form. The question of who is accountable for a published claim does not disappear when a machine drafts the sentence; it simply becomes harder to locate. This is a long paragraph designed to clear Readability's character threshold so that the extractor treats this element as genuine article content rather than boilerplate navigation or promotional chrome.</p>
  <h2>Attribution</h2>
  <p>Attribution practices developed for human sources translate poorly. Consider a summary assembled from six documents, each paraphrased at a different level of fidelity. Editors need a record of provenance that survives the editing process, and most content management systems were never designed to carry one. Without that record, corrections become guesswork and the audience has no way to audit what it reads.</p>
  <blockquote cite="https://example.com/report"><p>Provenance is not metadata. It is editorial substance.</p></blockquote>
  <figure>
    <img src="/images/chart.png" alt="Chart of newsroom automation adoption" width="600" onerror="alert(1)">
    <figcaption>Adoption climbed sharply after 2024.</figcaption>
  </figure>
  <h2>Corrections</h2>
  <p>A correction policy that assumes a single identifiable author will fail on generated text. Newsrooms need a policy that names a responsible editor for every automated output, and that names them before publication rather than after a complaint arrives. Several outlets have begun publishing these assignments, and the early results suggest the practice is workable at scale.</p>
  <table>
    <tr><th>Year</th><th>Outlets</th></tr>
    <tr><td>2024</td><td>12</td></tr>
    <tr><td>2026</td><td>84</td></tr>
  </table>
  <ul><li>Name a responsible editor.</li><li>Keep a provenance log.</li><li>Publish the policy.</li></ul>
  <p>None of this is technically difficult. It is organizationally uncomfortable, which is a different obstacle and one that tooling alone will not remove. The newsrooms that resolve it first will have an advantage that compounds, because trust is expensive to rebuild and cheap to maintain.</p>
</article>
<footer>© 2026 The Example Review. All rights reserved.</footer>
</body></html>`;

const article = await extractArticle({ html, url: 'https://example.com/ethics', includeImages: false });

console.log('== extraction ==');
console.log('title    :', article.title);
console.log('byline   :', article.byline);
console.log('site     :', article.siteName);
console.log('lang     :', article.lang);
console.log('chapters :', article.chapters.length, '->', article.chapters.map((c) => c.title));
console.log('textLen  :', article.textLength);
console.log('warnings :', article.warnings);

const joined = article.chapters.map((c) => c.body).join('\n');
let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

console.log('\n== sanitization ==');
assert(!/<script/i.test(joined), 'no <script>');
assert(!/<style/i.test(joined), 'no <style>');
assert(!/onerror/i.test(joined), 'no event handlers');
assert(!/SUBSCRIBE NOW/.test(joined), 'promo block removed');
assert(!/All rights reserved/.test(joined), 'footer removed');
assert(!/>Home</.test(joined), 'nav removed');
assert(!/<div|<span|<section|<article/i.test(joined), 'wrapper elements unwrapped');
assert(!/class="(byline|ad)"|width=/i.test(joined), 'source attributes stripped (our own cp-meta class is intentional)');
assert(/<blockquote/.test(joined), 'blockquote kept');
assert(/<table/.test(joined), 'table kept');
assert(/<li>Keep a provenance log/.test(joined), 'list kept');
assert(/Provenance is not metadata/.test(joined), 'quote text kept');
assert(!/<img/.test(joined), 'local image dropped when images disabled');

const { filename, buffer, chapters } = await buildEpub(article);
console.log('\n== epub ==');
console.log('filename :', filename);
console.log('size     :', buffer.length, 'bytes,', chapters, 'chapters');
if (process.env.EPUB_OUT) fs.writeFileSync(process.env.EPUB_OUT, buffer);

// mimetype must be entry #0 and stored uncompressed.
const sig = buffer.subarray(30, 38).toString('latin1');
assert(sig === 'mimetype', `first zip entry is "mimetype" (got "${sig}")`);
const method = buffer.readUInt16LE(8);
assert(method === 0, `mimetype stored uncompressed (method ${method})`);

const zip = await JSZip.loadAsync(buffer);
const names = Object.keys(zip.files).sort();
console.log('entries  :', names.join(', '));
for (const required of ['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/toc.ncx', 'OEBPS/style.css']) {
  assert(names.includes(required), `contains ${required}`);
}

// Every XML part must actually parse, and manifest hrefs must resolve.
console.log('\n== xml well-formedness ==');
for (const name of names.filter((n) => /\.(xhtml|opf|ncx|xml)$/.test(n))) {
  const text = await zip.file(name).async('string');
  let ok = true;
  let detail = '';
  try {
    const dom = new JSDOM(text, { contentType: 'application/xml' });
    const err = dom.window.document.querySelector('parsererror');
    if (err) { ok = false; detail = err.textContent.slice(0, 120); }
  } catch (e) { ok = false; detail = e.message.slice(0, 120); }
  assert(ok, `parses: ${name} ${detail}`);
}

const opfText = await zip.file('OEBPS/content.opf').async('string');
const opf = new JSDOM(opfText, { contentType: 'application/xml' }).window.document;
const hrefs = [...opf.querySelectorAll('manifest > item')].map((i) => i.getAttribute('href'));
for (const href of hrefs) assert(names.includes(`OEBPS/${href}`), `manifest href exists: ${href}`);
const idrefs = [...opf.querySelectorAll('spine > itemref')].map((i) => i.getAttribute('idref'));
const ids = new Set([...opf.querySelectorAll('manifest > item')].map((i) => i.getAttribute('id')));
for (const idref of idrefs) assert(ids.has(idref), `spine idref in manifest: ${idref}`);
assert(opf.querySelector('metadata > *[property="dcterms:modified"]') !== null, 'dcterms:modified present');
assert(/Dana Reyes/.test(opfText), 'author in metadata');

const navText = await zip.file('OEBPS/nav.xhtml').async('string');
const navHrefs = [...new JSDOM(navText, { contentType: 'application/xml' }).window.document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
for (const href of navHrefs) assert(names.includes(`OEBPS/${href}`), `nav href exists: ${href}`);
console.log('nav toc  :', navHrefs.length, 'entries');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
