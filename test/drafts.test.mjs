// Draft store + markdown -> EPUB pipeline.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DraftStore } from '../lib/drafts.mjs';
import { markdownText, renderMarkdown } from '../lib/markdown.mjs';
import { extractArticle } from '../lib/extract.mjs';
import { buildEpub } from '../lib/epub.mjs';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epub-drop-drafts-'));
const store = new DraftStore(dir);

console.log('== draft store ==');
assert((await store.list()).length === 0, 'a fresh store is empty');

const created = await store.save({
  title: 'Week 3 Notes',
  author: 'Dan Pacheco',
  markdown: '## Framing\n\nFirst paragraph.\n',
});
assert(!!created.id, 'save returns a new draft with an id');
assert(created.createdAt && created.updatedAt, 'timestamps recorded');

const updated = await store.save({ id: created.id, title: 'Week 3 Notes', author: 'Dan Pacheco', markdown: '## Framing\n\nRevised paragraph.\n' });
assert(updated.id === created.id, 'saving with an id updates in place');
assert(/Revised/.test((await store.get(created.id)).markdown), 'the update persisted');
assert((await store.list()).length === 1, 'updating did not create a second draft');

const listed = (await store.list())[0];
// "## Framing / Revised paragraph." — the "##" must not count as a word.
assert(listed.words === 3, `word count from markdown, ignoring syntax (got ${listed.words})`);

// A second draft, to check ordering and isolation.
await new Promise((r) => setTimeout(r, 5));
const second = await store.save({ title: 'Later', markdown: 'newer' });
const order = (await store.list()).map((d) => d.id);
assert(order[0] === second.id, 'list is most-recently-updated first');

// A well-formed id that simply isn't there is a miss, not an error.
assert((await store.get('11111111-2222-3333-4444-555555555555')) === null, 'unknown id returns null');

for (const bad of ['nope', '../../etc/passwd', '../drafts/../../config', '']) {
  let rejected = false;
  try {
    await store.get(bad);
  } catch {
    rejected = true;
  }
  assert(rejected, `malformed id rejected: ${JSON.stringify(bad)}`);
}

assert((await store.remove(second.id)) === true, 'remove deletes a draft');
assert((await store.remove(second.id)) === false, 'removing twice reports false');
assert((await store.list()).length === 1, 'only the remaining draft is listed');

let saveRejected = false;
try {
  await store.save({ id: second.id, markdown: 'x' });
} catch {
  saveRejected = true;
}
assert(saveRejected, 'saving over a deleted draft errors instead of resurrecting it');

console.log('\n== markdown rendering ==');
const md = [
  '## Attribution',
  '',
  'Editors need a record of **provenance** that survives *editing*.',
  '',
  '> Provenance is not metadata.',
  '',
  '- Name an editor',
  '- Keep a log',
  '',
  '### A sub-point',
  '',
  'Sub-sections stay inside their chapter.',
  '',
  '## Corrections',
  '',
  'See [the policy](https://example.com/policy).',
].join('\n');

const html = renderMarkdown(md);
assert(/<h2[^>]*>Attribution<\/h2>/.test(html), 'h2 rendered');
assert(/<strong>provenance<\/strong>/.test(html), 'bold rendered');
assert(/<em>editing<\/em>/.test(html), 'italic rendered');
assert(/<blockquote>/.test(html), 'blockquote rendered');
assert(/<li>Name an editor<\/li>/.test(html), 'list rendered');
assert(/href="https:\/\/example.com\/policy"/.test(html), 'link rendered');
assert(markdownText(md).length > 40 && !/[#>*]/.test(markdownText(md)), 'markdownText strips syntax');

console.log('\n== markdown -> EPUB ==');
const article = await extractArticle({
  html: `<!DOCTYPE html><body>${html}</body>`,
  includeImages: false,
  fragment: true,
});
article.title = 'Week 3 Notes';
article.byline = 'Dan Pacheco';

assert(article.chapters.length === 2, `split on headings into 2 chapters (got ${article.chapters.length})`);
assert(
  article.chapters.map((c) => c.title).join(' | ') === 'Attribution | Corrections',
  `chapter titles from headings: ${article.chapters.map((c) => c.title).join(' | ')}`
);

const joined = article.chapters.map((c) => c.body).join('\n');
// h3 marks a sub-section, so it stays in the chapter rather than starting one.
assert(/<h3>A sub-point<\/h3>/.test(joined), 'h3 kept inline instead of splitting a chapter');
assert(/<blockquote>/.test(joined), 'blockquote survived into the EPUB body');
assert(/<strong>provenance<\/strong>/.test(joined), 'inline emphasis survived');
assert(/<li>Keep a log<\/li>/.test(joined), 'list survived');

const epub = await buildEpub(article);
assert(epub.filename === 'Week 3 Notes.epub', `filename from the draft title: ${epub.filename}`);

const zip = await JSZip.loadAsync(epub.buffer);
let xmlOk = true;
for (const name of Object.keys(zip.files).filter((n) => /\.(xhtml|opf|ncx|xml)$/.test(n))) {
  const text = await zip.file(name).async('string');
  try {
    if (new JSDOM(text, { contentType: 'application/xml' }).window.document.querySelector('parsererror')) {
      xmlOk = false;
    }
  } catch {
    xmlOk = false;
  }
}
assert(xmlOk, 'every XML part of the draft EPUB parses');

const opf = await zip.file('OEBPS/content.opf').async('string');
assert(/Dan Pacheco/.test(opf), 'draft author reached the EPUB metadata');

console.log('\n== short drafts are not discarded ==');
// Readability drops anything under its character threshold; fragment mode must
// bypass it so a one-line note still converts.
const tiny = await extractArticle({
  html: `<!DOCTYPE html><body>${renderMarkdown('A single short note.')}</body>`,
  includeImages: false,
  fragment: true,
});
assert(/A single short note/.test(tiny.chapters.map((c) => c.body).join('')), 'a one-line draft survives conversion');

await fs.rm(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
