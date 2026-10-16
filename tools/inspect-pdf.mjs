import { extractPdf } from '../lib/pdf.mjs';
import { buildEpub } from '../lib/epub.mjs';
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const data = fs.readFileSync(file);
console.log(`\n════ ${path.basename(file)} (${(data.length/1024).toFixed(0)} KB) ════`);
try {
  const t0 = Date.now();
  const a = await extractPdf({ data, name: path.basename(file) });
  const ms = Date.now() - t0;
  console.log('title    :', JSON.stringify(a.title));
  console.log('byline   :', JSON.stringify(a.byline));
  console.log('chapters :', a.chapters.length);
  console.log('textLen  :', a.textLength, `(${ms} ms)`);
  console.log('warnings :', a.warnings);
  console.log('TOC      :', a.chapters.slice(0, 12).map(c => c.title));
  const epub = await buildEpub(a);
  console.log('epub     :', epub.filename, `${(epub.buffer.length/1024).toFixed(0)} KB`);
  const out = process.env.SAVE_DIR;
  if (out) fs.writeFileSync(path.join(out, epub.filename), epub.buffer);
  console.log('\n--- first 1200 chars of chapter 1 body ---');
  console.log(a.chapters[0].body.slice(0, 1200));
} catch (e) {
  console.log('ERROR:', e.code || '', e.message);
}
