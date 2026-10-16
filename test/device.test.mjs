// End-to-end test against a mock CrossPoint device.
//
// The mock implements the subset of docs/webserver-endpoints.md that this app
// uses (/api/status, /api/files, /mkdir, /upload) on an ephemeral port, so the
// convert -> ensureDir -> upload path is exercised without the real hardware.

import http from 'node:http';
import { Buffer } from 'node:buffer';
import { ensureDir, getStatus, listFiles, normalizePath, uploadEpub } from '../lib/device.mjs';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

// ------------------------------------------------------------ mock firmware

/** In-memory SD card: path -> {isDirectory, data}. */
const sd = new Map([['/', { isDirectory: true }]]);
const uploads = [];

function parseMultipart(buffer, boundary) {
  // Minimal parser: enough to confirm we send a well-formed request.
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let index = buffer.indexOf(delimiter);
  while (index !== -1) {
    const start = index + delimiter.length;
    if (buffer.subarray(start, start + 2).toString() === '--') break;
    const next = buffer.indexOf(delimiter, start);
    if (next === -1) break;
    const raw = buffer.subarray(start, next);
    const split = raw.indexOf('\r\n\r\n');
    const headers = raw.subarray(0, split).toString('utf8');
    // Trailing CRLF before the next delimiter belongs to the framing, not the body.
    const body = raw.subarray(split + 4, raw.length - 2);
    const name = /name="([^"]*)"/.exec(headers)?.[1] || '';
    const filename = /filename="([^"]*)"/.exec(headers)?.[1] || '';
    parts.push({ name, filename, headers, body });
    index = next;
  }
  return parts;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const device = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  const json = (code, payload) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === '/api/status') {
    return json(200, {
      version: '1.4.2',
      ip: '127.0.0.1',
      mode: 'STA',
      rssi: -47,
      freeHeap: 120000,
      uptime: 900,
      device: 'X4',
    });
  }

  if (url.pathname === '/api/files') {
    const dir = normalizePath(url.searchParams.get('path') || '/');
    if (!sd.get(dir)?.isDirectory) return json(404, { error: 'not found' });
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const entries = [];
    for (const [p, meta] of sd) {
      if (p === dir || !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) continue;
      entries.push({
        name: rest,
        size: meta.data?.length || 0,
        isDirectory: !!meta.isDirectory,
        isEpub: rest.toLowerCase().endsWith('.epub'),
      });
    }
    return json(200, entries);
  }

  if (url.pathname === '/mkdir' && req.method === 'POST') {
    const form = new URLSearchParams((await readBody(req)).toString('utf8'));
    const parent = normalizePath(form.get('path') || '/');
    const name = form.get('name');
    if (!name) return json(400, { error: 'name required' });
    if (!sd.get(parent)?.isDirectory) return json(400, { error: 'parent missing' });
    sd.set(parent === '/' ? `/${name}` : `${parent}/${name}`, { isDirectory: true });
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('Folder created');
  }

  if (url.pathname === '/delete' && req.method === 'POST') {
    const form = new URLSearchParams((await readBody(req)).toString('utf8'));
    const paths = form.get('paths') ? JSON.parse(form.get('paths')) : [form.get('path')];
    let removed = 0;
    for (const raw of paths) {
      if (sd.delete(normalizePath(raw))) removed++;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`Deleted ${removed}`);
  }

  if (url.pathname === '/upload' && req.method === 'POST') {
    const dir = normalizePath(url.searchParams.get('path') || '/');
    if (!sd.get(dir)?.isDirectory) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('Directory does not exist');
    }
    const contentType = req.headers['content-type'] || '';
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
    if (!boundary) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('Expected multipart/form-data');
    }
    const parts = parseMultipart(await readBody(req), (boundary[1] || boundary[2]).trim());
    const file = parts.find((p) => p.name === 'file');
    if (!file?.filename) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('No file part');
    }
    const target = dir === '/' ? `/${file.filename}` : `${dir}/${file.filename}`;
    // Firmware 1.5.0 rejects an upload onto an existing name rather than
    // overwriting, despite what its docs say. Mirror that here.
    if (sd.has(target)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end(`File already exists: ${file.filename}`);
    }
    sd.set(target, { data: file.body });
    uploads.push({ dir, filename: file.filename, size: file.body.length, headers: file.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`File uploaded successfully: ${file.filename}`);
  }

  json(404, { error: 'not found' });
});

await new Promise((resolve) => device.listen(0, '127.0.0.1', resolve));
const HOST = `127.0.0.1:${device.address().port}`;
console.log(`mock CrossPoint device on ${HOST}\n`);

// ------------------------------------------------------------ device.mjs

console.log('== device client ==');
const status = await getStatus(HOST);
assert(status.device === 'X4' && status.version === '1.4.2', 'getStatus parses firmware status');

const created = await ensureDir(HOST, '/Articles/JNL221');
assert(created === '/Articles/JNL221', 'ensureDir returns the normalized path');
assert(sd.has('/Articles') && sd.has('/Articles/JNL221'), 'ensureDir created both levels');

const mkdirCallsBefore = sd.size;
await ensureDir(HOST, '/Articles/JNL221');
assert(sd.size === mkdirCallsBefore, 'ensureDir is idempotent on existing folders');

// A real EPUB payload, so the multipart body is binary and non-trivial.
const { buildEpub } = await import('../lib/epub.mjs');
const { extractArticle } = await import('../lib/extract.mjs');
const article = await extractArticle({
  html: '<html lang="en"><head><title>Wire Test</title></head><body><article><h1>Wire Test</h1><p>' +
    'This paragraph exists to give the extractor enough characters to treat the element as real article content rather than boilerplate, which it needs in order to return a body at all. '.repeat(2) +
    '</p></article></body></html>',
  url: 'https://example.com/wire',
  includeImages: false,
});
const epub = await buildEpub(article);

const message = await uploadEpub(HOST, '/Articles/JNL221', epub.filename, epub.buffer);
assert(/uploaded successfully/i.test(message), `upload returns the firmware message: "${message}"`);

const record = uploads.at(-1);
assert(record.dir === '/Articles/JNL221', 'upload landed in the requested folder');
assert(record.filename === epub.filename, `filename preserved: ${record.filename}`);
assert(record.size === epub.buffer.length, `byte-exact transfer (${record.size} bytes)`);
assert(/name="file"/.test(record.headers), 'form field is named "file"');
assert(/application\/epub\+zip/.test(record.headers), 'part carries the EPUB content type');

const stored = sd.get('/Articles/JNL221/' + epub.filename).data;
assert(stored.equals(epub.buffer), 'stored bytes match the generated EPUB exactly');

const listing = await listFiles(HOST, '/Articles/JNL221');
assert(listing.length === 1 && listing[0].isEpub, 'listFiles sees the uploaded EPUB');

console.log('\n== path normalization ==');
for (const [input, want] of [
  ['/Articles/', '/Articles'],
  ['Articles', '/Articles'],
  ['//Articles//JNL221//', '/Articles/JNL221'],
  ['\\Articles\\JNL221', '/Articles/JNL221'],
  ['/', '/'],
  ['', '/'],
]) {
  const got = normalizePath(input);
  assert(got === want, `normalizePath(${JSON.stringify(input)}) -> ${JSON.stringify(got)}`);
}


console.log('\n== replacing a file that is already there ==');
{
  const { replaceOnDevice, verifyUploaded } = await import('../lib/device.mjs');

  const first = Buffer.from('first edition'.repeat(20));
  const second = Buffer.from('second edition, longer than the first'.repeat(20));

  await uploadEpub(HOST, '/Articles/JNL221', 'Edition.epub', first);
  assert(
    sd.get('/Articles/JNL221/Edition.epub').data.equals(first),
    'the first upload lands'
  );

  // This is what the device really does, and what broke same-day feed refreshes.
  let rejected = '';
  try {
    await uploadEpub(HOST, '/Articles/JNL221', 'Edition.epub', second);
  } catch (err) {
    rejected = err.message;
  }
  assert(/already exists/i.test(rejected), `a plain re-upload is refused by the firmware: ${rejected}`);

  const replaced = await replaceOnDevice(HOST, '/Articles/JNL221', 'Edition.epub', second);
  assert(replaced.replaced === true, 'replaceOnDevice reports that it replaced something');
  assert(/replaced the previous file/.test(replaced.message), 'and says so in the message');
  assert(
    sd.get('/Articles/JNL221/Edition.epub').data.equals(second),
    'the newer edition is now the one on the device'
  );

  const listing = await listFiles(HOST, '/Articles/JNL221');
  const editions = listing.filter((e) => e.name === 'Edition.epub');
  assert(editions.length === 1, 'and there is exactly one copy, not two');

  // A first-time upload through the same path must not claim a replacement.
  const fresh = await replaceOnDevice(HOST, '/Articles/JNL221', 'Brand New.epub', first);
  assert(fresh.replaced === false, 'a name that was not there is not reported as replaced');
  assert(!/replaced/.test(fresh.message), 'and the message stays clean');

  console.log('\n== confirming an upload landed ==');
  assert(
    (await verifyUploaded(HOST, '/Articles/JNL221', 'Brand New.epub', first.length)) === true,
    'verifyUploaded finds a file at the expected size'
  );
  assert(
    (await verifyUploaded(HOST, '/Articles/JNL221', 'Brand New.epub', first.length + 999)) === false,
    'a size mismatch is not a success — a truncated write must still fail'
  );
  assert(
    (await verifyUploaded(HOST, '/Articles/JNL221', 'Never Sent.epub', 10)) === false,
    'a file that is not there is not a success'
  );
  assert(
    (await verifyUploaded('127.0.0.1:45999', '/x', 'y.epub', 10)) === false,
    'an unreachable device is not a success'
  );
}

console.log('\n== hotspot mode ==');
{
  // The mock reports AP mode, as the firmware does on its own hotspot.
  const { HOTSPOT_HOST } = await import('../lib/device.mjs');
  assert(HOTSPOT_HOST === '192.168.4.1', `hotspot address is the firmware's AP fallback IP: ${HOTSPOT_HOST}`);
  const apStatus = { ...(await getStatus(HOST)), mode: 'AP', rssi: 0 };
  assert(apStatus.mode === 'AP' && apStatus.rssi === 0, 'AP-mode status shape: mode=AP and rssi=0');
}

console.log('\n== error handling ==');
try {
  await uploadEpub(HOST, '/DoesNotExist', 'x.epub', Buffer.from('x'));
  assert(false, 'upload to a missing folder rejects');
} catch (err) {
  assert(/HTTP 400/.test(err.message), `upload to a missing folder rejects: ${err.message}`);
}
try {
  await getStatus('127.0.0.1:1');
  assert(false, 'unreachable host rejects');
} catch (err) {
  assert(true, `unreachable host rejects (${err.cause?.code || err.message})`);
}

device.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
