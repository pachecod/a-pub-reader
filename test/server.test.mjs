// Drives the real server over HTTP: convert -> send -> verify on a mock device.
//
// Boots a mock CrossPoint firmware and the actual server.mjs as a child
// process, then exercises the same endpoints the browser UI calls.

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_PORT = 4399;

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

// ------------------------------------------------------------ mock firmware

const sd = new Map([['/', { isDirectory: true }]]);

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

const device = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  const json = (code, payload) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const norm = (p) => {
    const c = String(p || '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    return c === '' ? '/' : c.startsWith('/') ? c : `/${c}`;
  };

  if (url.pathname === '/api/status') {
    return json(200, { version: '1.4.2', ip: '127.0.0.1', mode: 'STA', rssi: -47, device: 'X4' });
  }
  if (url.pathname === '/api/files') {
    const dir = norm(url.searchParams.get('path'));
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
  if (url.pathname === '/mkdir') {
    const form = new URLSearchParams((await readBody(req)).toString('utf8'));
    const parent = norm(form.get('path'));
    sd.set(parent === '/' ? `/${form.get('name')}` : `${parent}/${form.get('name')}`, { isDirectory: true });
    res.writeHead(200);
    return res.end('Folder created');
  }
  if (url.pathname === '/delete') {
    const form = new URLSearchParams((await readBody(req)).toString('utf8'));
    const paths = form.get('paths') ? JSON.parse(form.get('paths')) : [form.get('path')];
    let n = 0;
    for (const p of paths) {
      const target = norm(p);
      const entry = sd.get(target);
      if (!entry) continue;
      // Mirror the firmware: non-empty folders are rejected.
      if (entry.isDirectory && [...sd.keys()].some((k) => k.startsWith(`${target}/`))) continue;
      sd.delete(target);
      n++;
    }
    res.writeHead(200);
    return res.end(`Deleted ${n}`);
  }
  if (url.pathname === '/upload') {
    const dir = norm(url.searchParams.get('path'));
    const buffer = await readBody(req);
    const filename = /filename="([^"]*)"/.exec(buffer.subarray(0, 800).toString('latin1'))?.[1] || 'unknown';
    sd.set(dir === '/' ? `/${filename}` : `${dir}/${filename}`, { data: buffer });
    res.writeHead(200);
    return res.end(`File uploaded successfully: ${filename}`);
  }
  json(404, { error: 'not found' });
});

await new Promise((r) => device.listen(0, '127.0.0.1', r));
const DEVICE_HOST = `127.0.0.1:${device.address().port}`;

// ------------------------------------------------------------ boot the app

// A sandbox for everything the spawned server writes. It previously used the
// real out/, config.json, drafts/ and feeds.json, so every run left test
// books sitting in the live queue.
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'apub-server-test-'));

const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    EPUB_DROP_OUT_DIR: path.join(sandbox, 'out'),
    EPUB_DROP_CONFIG: path.join(sandbox, 'config.json'),
    EPUB_DROP_STATE: sandbox,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const appLog = [];
app.stdout.on('data', (d) => appLog.push(d.toString()));
app.stderr.on('data', (d) => appLog.push(d.toString()));

const api = async (route, options = {}) => {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${route}`, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// Wait for the listener rather than sleeping a fixed amount.
for (let i = 0; i < 60; i++) {
  try {
    await fetch(`http://127.0.0.1:${APP_PORT}/api/config`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const cleanup = async () => {
  app.kill();
  device.close();
  await fs.rm(sandbox, { recursive: true, force: true });
};

try {
  console.log(`mock device ${DEVICE_HOST}, app :${APP_PORT}\n`);

  console.log('== static + config ==');
  const page = await fetch(`http://127.0.0.1:${APP_PORT}/`);
  const pageHtml = await page.text();
  assert(page.ok && /A-Pub Reader/.test(pageHtml), 'serves the UI at /');
  assert((await fetch(`http://127.0.0.1:${APP_PORT}/app.js`)).ok, 'serves /app.js');
  assert((await fetch(`http://127.0.0.1:${APP_PORT}/style.css`)).ok, 'serves /style.css');

  const traversal = await fetch(`http://127.0.0.1:${APP_PORT}/../server.mjs`, { redirect: 'manual' });
  const traversalBody = await traversal.text();
  assert(!/import http/.test(traversalBody), 'path traversal cannot read server source');

  const saved = await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ host: `http://${DEVICE_HOST}/`, folder: '/Articles/', includeImages: false }),
  });
  assert(saved.body.host === DEVICE_HOST, `config normalizes the host: ${saved.body.host}`);
  // The folder names are fixed. Anything else — a hand-edited config, a stale
  // value from an older version — is clamped to the books folder, so the app can
  // never be pointed at a folder it does not manage.
  assert(saved.body.folder === '/A-pub Books', `an unmanaged folder is clamped: ${saved.body.folder}`);

  const picked = await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ host: DEVICE_HOST, folder: '/A-pub Feeds' }),
  });
  assert(picked.body.folder === '/A-pub Feeds', "one of the app's own folders is kept");

  const listed = await api('/api/folders');
  const paths = listed.body.folders.map((f) => f.path).join(',');
  assert(
    paths === '/A-pub Books,/A-pub Notes,/A-pub Feeds',
    `the folder list the UI builds from is fixed: ${paths}`
  );

  console.log('\n== device status ==');
  const dev = await api(`/api/device?host=${encodeURIComponent(DEVICE_HOST)}`);
  assert(dev.body.ok && dev.body.status.device === 'X4', 'reports a reachable device');

  const dead = await api('/api/device?host=127.0.0.1:45999');
  // The message must name a cause and a next step, not just "fetch failed".
  assert(
    dead.body.ok === false &&
      /refused|unreachable|did not respond|Could not reach/.test(dead.body.error || '') &&
      /File Transfer/.test(dead.body.error || ''),
    `unreachable device explains why and what to do: "${dead.body.error}"`
  );
  assert(!/^fetch failed$/.test(dead.body.error || ''), 'raw fetch error is never surfaced');

  // With no reader anywhere, the guidance must cover hotspot mode too, since
  // that is the other way the device can be reached.
  const nowhere = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ ids: ['none'], host: 'crosspoint.local', folder: '/A-pub Books' }),
  });
  assert(
    /hotspot|CrossPoint-Reader/i.test(nowhere.body.error || '') || nowhere.body.results?.length,
    `no-reader guidance mentions hotspot mode: "${nowhere.body.error}"`
  );

  const badName = await api('/api/device?host=nonexistent-host.invalid');
  assert(
    /resolve/i.test(badName.body.error || ''),
    `DNS failure gets a useful message: "${badName.body.error}"`
  );

  console.log('\n== convert ==');
  const paragraph =
    'Readability needs a decent run of prose before it will treat an element as the article body, so this sentence is padding with enough length to qualify. ';
  const convert = await api('/api/convert', {
    method: 'POST',
    body: JSON.stringify({
      includeImages: false,
      items: [
        {
          name: 'week-01-reading.html',
          text: `<html lang="en"><head><title>Framing the News | The Review</title></head><body><article><h1>Framing the News</h1><p class="byline">By Sam Ito</p><p>${paragraph.repeat(3)}</p><h2>Method</h2><p>${paragraph.repeat(3)}</p></article></body></html>`,
        },
        { name: 'empty.html', text: '   ' },
        { url: 'http://127.0.0.1:45999/nope' },
      ],
    }),
  });

  const [ok, empty, unreachable] = convert.body.results;
  assert(ok.ok === true, 'converts a dropped HTML file');
  assert(ok.title === 'Framing the News', `title dropped the site suffix: "${ok.title}"`);
  assert(ok.author === 'Sam Ito', `byline cleaned: "${ok.author}"`);
  assert(ok.chapters === 2, `split into ${ok.chapters} chapters on <h2>`);
  assert(ok.filename === 'Framing the News.epub', `filename derived from title: ${ok.filename}`);
  assert(empty.ok === false && /empty/i.test(empty.error), `empty file reports an error: "${empty.error}"`);
  assert(unreachable.ok === false, `unreachable URL reports an error: "${unreachable.error}"`);

  const download = await fetch(`http://127.0.0.1:${APP_PORT}/out/${ok.id}`);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert(
    download.headers.get('content-type') === 'application/epub+zip' && bytes.length === ok.size,
    `local download serves the EPUB (${bytes.length} bytes)`
  );

  console.log('\n== web reading page ==');
  const web = await fetch(`http://127.0.0.1:${APP_PORT}/read/${ok.id}`);
  const webHtml = await web.text();
  assert(web.ok && /text\/html/.test(web.headers.get('content-type')), 'an unsent item has a web reading page');
  assert(/<h1>Framing the News<\/h1>/.test(webHtml), 'the page is titled with the book');
  assert(/id="ch-1"/.test(webHtml) && /id="ch-2"/.test(webHtml), 'every chapter is on the one page');
  assert(/href="#ch-2"/.test(webHtml), 'a contents list links to each chapter');
  assert(webHtml.includes(`/?epub=${ok.id}`), 'it links to the ePub view');
  assert(
    /script-src 'none'/.test(web.headers.get('content-security-policy') || ''),
    'scripts are forbidden on the reading page'
  );
  const missing = await fetch(`http://127.0.0.1:${APP_PORT}/read/00000000-0000-0000-0000-000000000000`);
  assert(missing.status === 404, 'an unknown item is a 404');

  // The route itself; the directory is checked live, so only its shape is pinned.
  const discover = await api('/api/feeds/discover');
  assert(
    discover.status === 200 && Array.isArray(discover.body.groups) && discover.body.groups.length > 0,
    `find feeds returns topic groups: ${discover.body.groups?.length}`
  );

  console.log('\n== send ==');
  const send = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ ids: [ok.id], host: DEVICE_HOST, folder: '/Articles/JNL221' }),
  });
  assert(send.body.ok === true, 'send reports success');
  // A folder in the request is ignored: where something lands follows what it
  // is — a note or a feed carries its own folder, everything else is a book.
  assert(send.body.folder === '/A-pub Books', `send ignored the requested folder: ${send.body.folder}`);
  assert(sd.has('/A-pub Books'), 'the books folder was created on the device');
  assert(sd.has('/A-pub Books/Framing the News.epub'), 'EPUB present on the device');

  const stale = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ ids: ['not-a-real-id'], host: DEVICE_HOST, folder: '/Articles' }),
  });
  assert(stale.body.results[0].ok === false, `unknown id fails cleanly: "${stale.body.results[0].error}"`);

  const noDevice = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ ids: [ok.id], host: '127.0.0.1:45999', folder: '/Articles' }),
  });
  // An explicit host that doesn't answer must report an error rather than
  // quietly redirecting to whatever else is on the network.
  assert(
    noDevice.body.ok === false && /did not answer|File Transfer/.test(noDevice.body.error || ''),
    `send to a dead explicit host reports it: "${noDevice.body.error}"`
  );
  assert(
    !noDevice.body.host || noDevice.body.host === '127.0.0.1:45999',
    'send did not silently fall back to a different device'
  );

  console.log('\n== device browse ==');
  const files = await api(`/api/device/files?host=${DEVICE_HOST}&path=/A-pub Books`);
  assert(files.body.ok && files.body.entries.some((e) => e.isEpub), 'can list the device folder');

  console.log('\n== library view and delete ==');
  // Scope is read from saved config, which can only hold a managed folder.
  await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ host: DEVICE_HOST, folder: '/A-pub Books', includeImages: false }),
  });

  // Files the app did not create, plus a subfolder and a sibling outside scope.
  sd.set('/A-pub Books/Hand Copied.epub', { data: Buffer.from('x'.repeat(2048)) });
  sd.set('/A-pub Books/Nested', { isDirectory: true });
  sd.set('/A-pub Books/Nested/deep.epub', { data: Buffer.from('deep') });
  sd.set('/A-pub Notes/outside.epub', { data: Buffer.from('outside') });
  sd.set('/toplevel.epub', { data: Buffer.from('top') });

  const lib = await api(`/api/library?host=${DEVICE_HOST}`);
  assert(lib.body.ok && lib.body.folder === '/A-pub Books', 'library reads the configured folder');
  assert(lib.body.canDelete === true, 'delete is enabled for a non-root folder');
  const libNames = lib.body.entries.map((e) => e.name).sort();
  assert(
    libNames.join(',') === 'Framing the News.epub,Hand Copied.epub',
    `library lists only plain files in the folder: ${libNames.join(', ')}`
  );
  assert(!libNames.includes('Nested'), 'subfolders are not listed as deletable');

  // Paths that try to escape the managed folder.
  const escapes = await api('/api/library/delete', {
    method: 'POST',
    body: JSON.stringify({
      host: DEVICE_HOST,
      names: ['../A-pub Notes/outside.epub', '../toplevel.epub', '/toplevel.epub', 'Nested', 'Nested/deep.epub', 'nope.epub'],
    }),
  });
  assert(escapes.body.results.every((r) => !r.ok), 'every out-of-scope name is refused');
  assert(
    escapes.body.results.every((r) => /refusing to delete/i.test(r.error)),
    'refusals say why'
  );
  assert(sd.has('/A-pub Notes/outside.epub'), 'a file in a sibling A-pub folder survived');
  assert(sd.has('/toplevel.epub'), 'root file survived');
  assert(sd.has('/A-pub Books/Nested'), 'subfolder survived');
  assert(sd.has('/A-pub Books/Nested/deep.epub'), 'file inside the subfolder survived');

  // A real delete of a file that is genuinely in the folder.
  const del = await api('/api/library/delete', {
    method: 'POST',
    body: JSON.stringify({ host: DEVICE_HOST, names: ['Hand Copied.epub'] }),
  });
  assert(del.body.ok === true, 'deletes a file inside the managed folder');
  assert(!sd.has('/A-pub Books/Hand Copied.epub'), 'file is gone from the device');
  assert(sd.has('/A-pub Books/Framing the News.epub'), 'unselected file untouched');

  const noSelection = await api('/api/library/delete', {
    method: 'POST',
    body: JSON.stringify({ host: DEVICE_HOST, names: [] }),
  });
  assert(noSelection.status === 400, 'empty selection is rejected');

  // The SD-card root used to be selectable, which meant the delete controls
  // could be aimed at the whole card. It is no longer a value the config accepts.
  const rooted = await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ host: DEVICE_HOST, folder: '/', includeImages: false }),
  });
  assert(rooted.body.folder === '/A-pub Books', `the card root is clamped away: ${rooted.body.folder}`);

  const rootLib = await api(`/api/library?host=${DEVICE_HOST}`);
  assert(rootLib.body.folder === '/A-pub Books', 'the library cannot be scoped to the card root');
  assert(rootLib.body.canDelete === true, 'delete stays enabled for the clamped folder');

  const rootDel = await api('/api/library/delete', {
    method: 'POST',
    body: JSON.stringify({ host: DEVICE_HOST, names: ['toplevel.epub'] }),
  });
  assert(
    rootDel.body.results.every((r) => !r.ok),
    'a root file is still out of scope after the clamp'
  );
  assert(sd.has('/toplevel.epub'), 'root file still survived');

  console.log('\n== forgetting takes the reader\'s copy too ==');
  // The bug this covers: the Read tab and the device disagreed. Forgetting
  // dropped the app's record and left the file sitting on the reader, with
  // nothing in the interface saying so.
  await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ host: DEVICE_HOST, folder: '/A-pub Books', includeImages: false }),
  });

  const keepEntry = (await api('/api/outbox')).body.items.find((i) => i.deliveredAt);
  assert(Boolean(keepEntry), 'there is a delivered entry to forget');
  assert(sd.has(`/A-pub Books/${keepEntry.filename}`), 'its file is on the device to begin with');

  // Forgetting without asking for the device leaves the reader's copy alone.
  const forgetLocal = await api('/api/outbox/remove', {
    method: 'POST',
    body: JSON.stringify({ id: keepEntry.id, fromDevice: false }),
  });
  assert(forgetLocal.body.ok === true, 'forgetting locally succeeds');
  assert(forgetLocal.body.pending === 0, 'nothing was queued for removal');
  assert(sd.has(`/A-pub Books/${keepEntry.filename}`), "the reader's copy was left alone");

  // Send it again so there is something delivered to forget properly.
  const rebuilt = await api('/api/convert', {
    method: 'POST',
    body: JSON.stringify({
      includeImages: false,
      items: [
        {
          name: 'gone.html',
          text: `<html lang="en"><head><title>Doomed Reading</title></head><body><article><h1>Doomed Reading</h1><p>${paragraph.repeat(3)}</p></article></body></html>`,
        },
      ],
    }),
  });
  const doomed = rebuilt.body.results.find((r) => r.ok);
  await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ ids: [doomed.id], host: DEVICE_HOST }),
  });
  assert(sd.has(`/A-pub Books/${doomed.filename}`), 'the doomed file reached the device');

  const forgetBoth = await api('/api/outbox/remove', {
    method: 'POST',
    body: JSON.stringify({ id: doomed.id, fromDevice: true }),
  });
  assert(forgetBoth.body.pending === 1, `the removal was queued: ${forgetBoth.body.pending}`);
  // Queued, not done: the reader may not be connected when you tidy up.
  assert(sd.has(`/A-pub Books/${doomed.filename}`), 'the file is still there until a sync');

  const queued = await api('/api/removals');
  assert(
    queued.body.removals[0]?.filename === doomed.filename,
    'the queue names the file and its folder'
  );

  // A sync with nothing to upload still carries out the removal.
  const sweep = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ ids: [], host: DEVICE_HOST }),
  });
  assert(sweep.status === 400, 'a send with no ids and no removals is still rejected');

  const sweep2 = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ ids: [keepEntry.id], host: DEVICE_HOST }),
  });
  assert(
    !sd.has(`/A-pub Books/${doomed.filename}`),
    'the sync deleted the forgotten file from the device'
  );
  assert(
    sweep2.body.removed?.some((r) => r.ok && r.filename === doomed.filename),
    'the sync reports what it removed'
  );
  assert((await api('/api/removals')).body.removals.length === 0, 'the removal queue is now empty');

  console.log('\n== remove everything ==');
  // Both forgets above emptied the queue of delivered items, so put two back.
  for (const title of ['Wipe Me', 'Wipe Me Too']) {
    const built = await api('/api/convert', {
      method: 'POST',
      body: JSON.stringify({
        includeImages: false,
        items: [
          {
            name: `${title}.html`,
            text: `<html lang="en"><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${paragraph.repeat(3)}</p></article></body></html>`,
          },
        ],
      }),
    });
    const entry = built.body.results.find((r) => r.ok);
    await api('/api/send', {
      method: 'POST',
      body: JSON.stringify({ ids: [entry.id], host: DEVICE_HOST }),
    });
  }
  assert(sd.has('/A-pub Books/Wipe Me.epub'), 'two files staged on the device to wipe');

  // Everything else the wipe should take: an unsent item, a followed feed, a
  // draft, and a stray file the queue no longer knows about.
  await api('/api/convert', {
    method: 'POST',
    body: JSON.stringify({
      includeImages: false,
      items: [
        {
          name: 'Never Sent.html',
          text: `<html lang="en"><head><title>Never Sent</title></head><body><article><h1>Never Sent</h1><p>${paragraph.repeat(3)}</p></article></body></html>`,
        },
      ],
    }),
  });
  await api('/api/feeds/add', { method: 'POST', body: JSON.stringify({ url: 'http://127.0.0.1:45999/feed' }) });
  await api('/api/drafts/save', { method: 'POST', body: JSON.stringify({ title: 'Wipe this draft', markdown: 'Gone soon.' }) });
  const stray = path.join(sandbox, 'out', '00000000-0000-0000-0000-000000000000-Stray.epub');
  await fs.writeFile(stray, 'not really an epub');
  const keepMe = path.join(sandbox, 'out', 'notes-to-self.txt');
  await fs.writeFile(keepMe, 'not written by the app');

  const unconfirmed = await api('/api/remove-everything', {
    method: 'POST',
    body: JSON.stringify({ fromDevice: true }),
  });
  assert(unconfirmed.status === 400, 'removing everything needs the typed phrase');
  assert((await api('/api/outbox')).body.items.length > 0, 'nothing was removed without it');
  const wrong = await api('/api/remove-everything', {
    method: 'POST',
    body: JSON.stringify({ confirm: 'yes', fromDevice: true }),
  });
  assert(wrong.status === 400, 'any other phrase is refused');

  const wiped = await api('/api/remove-everything', {
    method: 'POST',
    body: JSON.stringify({ confirm: 'i agree', fromDevice: true }),
  });
  assert(wiped.body.ok === true, `the phrase is accepted case-insensitively`);
  assert(wiped.body.items === 3, `sent and unsent items are both removed: ${wiped.body.items}`);
  assert(wiped.body.pending === 2, `only what reached the reader is queued for it: ${wiped.body.pending}`);
  assert((await api('/api/outbox')).body.items.length === 0, 'the queue is empty');
  assert((await api('/api/feeds')).body.feeds.length === 0, 'no feeds are followed');
  assert((await api('/api/drafts')).body.drafts.length === 0, 'no drafts are left');
  assert(!(await fs.stat(stray).catch(() => null)), 'a stray built file is deleted');
  assert(!!(await fs.stat(keepMe).catch(() => null)), 'a file the app did not write is left alone');
  const config = await api('/api/config');
  assert(config.body.host === DEVICE_HOST, 'settings survive');
} finally {
  await cleanup();
}

if (fail) console.log('\napp output:\n' + appLog.join(''));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
