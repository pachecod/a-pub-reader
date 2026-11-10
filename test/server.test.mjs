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
import JSZip from 'jszip';

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
    // Keep the real synced cloud folders on this Mac out of the test app.
    EPUB_DROP_CLOUD_ROOT: path.join(sandbox, 'cloud'),
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
  // Where each item goes is decided by what it is, so the config no longer
  // keeps a folder; one sent by an older page is simply dropped.
  assert(!('folder' in saved.body), 'the config keeps no folder');

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

  console.log('\n== download all eBooks ==');
  // A name outside plain ASCII (accents, a dash, curly quotes) must not break the download header.
  const fancyTitle = 'Café Notes – “Quoted” Edition';
  const fancy = await api('/api/convert', {
    method: 'POST',
    body: JSON.stringify({ items: [{ name: 'fancy.html', text: `<html><head><title>${fancyTitle}</title></head><body><article><h1>${fancyTitle}</h1><p>${'A sentence long enough for Readability to keep. '.repeat(12)}</p></article></body></html>` }] }),
  });
  const fancyItem = fancy.body.results.find((r) => r.ok);
  const fancyDownload = await fetch(`http://127.0.0.1:${APP_PORT}/out/${fancyItem.id}`);
  const disposition = fancyDownload.headers.get('content-disposition') || '';
  assert(fancyDownload.ok && /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/.test(disposition), `a file name with accents, dashes or curly quotes downloads (${disposition.slice(0, 60)}…)`);
  assert(decodeURIComponent(disposition.split("UTF-8''")[1]) === fancyItem.filename, 'and keeps its exact name for browsers that read it');
  await api('/api/outbox/remove', { method: 'POST', body: JSON.stringify({ id: fancyItem.id, fromDevice: false }) });

  const all = await fetch(`http://127.0.0.1:${APP_PORT}/download/ebooks.zip`);
  assert(all.ok && all.headers.get('content-type') === 'application/zip', 'the library downloads as one zip');
  assert(/attachment; filename="A-Pub Reader eBooks \d{4}-\d{2}-\d{2}\.zip"/.test(all.headers.get('content-disposition') || ''), 'named for the app and the day');
  const archive = await JSZip.loadAsync(Buffer.from(await all.arrayBuffer()));
  const names = Object.keys(archive.files).filter((n) => !archive.files[n].dir);
  const inZip = names.find((n) => n.endsWith('/Framing the News.epub'));
  assert(inZip && /^A-pub \w+\//.test(inZip), `each eBook sits in its reader folder: ${inZip}`);
  assert(inZip && (await archive.file(inZip).async('nodebuffer')).equals(bytes), 'and is the same file as a single download');

  console.log('\n== web reading page ==');
  const web = await fetch(`http://127.0.0.1:${APP_PORT}/read/${ok.id}`);
  const webHtml = await web.text();
  assert(web.ok && /text\/html/.test(web.headers.get('content-type')), 'an unsent item has a web reading page');
  assert(/<h1>Framing the News<\/h1>/.test(webHtml), 'the page is titled with the book');
  assert(/id="ch-1"/.test(webHtml) && /id="ch-2"/.test(webHtml), 'every chapter is on the one page');
  assert(/href="#ch-2"/.test(webHtml), 'a contents list links to each chapter');
  assert(webHtml.includes(`/?epub=${ok.id}`), 'it links to the ePub view');
  const policy = web.headers.get('content-security-policy') || '';
  assert(
    /script-src 'self'(;|$)/.test(policy) && !/unsafe-inline|unsafe-eval/.test(policy.split('script-src')[1].split(';')[0]),
    "only the app's own script may run on the reading page, never inline or the book's"
  );
  assert(/role="switch"/.test(webHtml) && /id="reader-state"/.test(webHtml), 'the reading page has the On reader switch and its note');
  assert(/Return to Library/.test(webHtml) && /aria-current="page">Library</.test(webHtml), 'a reading page leads back to the Library');
  assert(
    /id="type-toggle"/.test(webHtml) && /id="type-family"/.test(webHtml) && /id="type-smaller"/.test(webHtml) && /id="type-bigger"/.test(webHtml),
    'a reading page has font and size controls'
  );
  assert(/<script src="\/web-read\.js"><\/script>/.test(webHtml), 'its script runs before the text is drawn, so the saved type applies at once');
  assert(/href="\/themes\.css"/.test(webHtml) && /<script src="\/theme\.js"><\/script>/.test(webHtml) && /data-theme-choices/.test(webHtml), 'a reading page offers the color themes');
  const home = await (await fetch(`http://127.0.0.1:${APP_PORT}/`)).text();
  assert(/href="\/themes\.css"/.test(home) && /<script src="\/theme\.js"><\/script>/.test(home) && /data-theme-toggle/.test(home), 'the app has the color theme picker');
  assert(/id="read-docs-section"[\s\S]*Documents[\s\S]*id="read-books-section"/.test(home), 'the Library keeps converted documents apart from books');
  // Hosted hides .device-only; the files waiting to convert must not be in it.
  const queueColumnStart = home.lastIndexOf('<div class="column', home.indexOf('id="queue-section"'));
  const queueColumnTag = home.slice(queueColumnStart, home.indexOf('>', queueColumnStart) + 1);
  assert(!/device-only/.test(queueColumnTag) && /id="results-section" class="device-only"/.test(home), 'when hosted, the waiting files and Convert stay visible; only syncing is hidden');
  assert(/id="site-dialog"[\s\S]*Article not fetched from feed yet[\s\S]*id="site-cancel"[\s\S]*id="site-ok"/.test(home), 'opening a not-yet-fetched article asks first');
  const agreeJs = await (await fetch(`http://127.0.0.1:${APP_PORT}/agree.js`)).text();
  assert(/<script src="\/agree\.js" defer><\/script>/.test(home) && /<script src="\/agree\.js" defer><\/script>/.test(webHtml), 'the app and every reading page ask for agreement before a download');
  assert(agreeJs.includes('I agree to use this ePub file solely for my personal, non-commercial use.') && /\\\/out\\\/\[0-9a-f-\]\{36\}\$/.test(agreeJs) && /ebooks\\\.zip/.test(agreeJs), 'with that wording, for a single eBook and for the whole library');
  const appJs = await (await fetch(`http://127.0.0.1:${APP_PORT}/app.js`)).text();
  assert(appJs.includes('I agree to consume this content only for my personal use, as if I had printed it out.') && /apubAgree\(PAGE_AGREEMENT\)/.test(appJs) && /window\.apubAgree = ask/.test(agreeJs), 'adding a pasted page first asks to agree to personal use, as if printed');
  assert(/id="type-turn"[\s\S]*value="curl"[\s\S]*value="swing"[\s\S]*value="none"/.test(home), 'the eBook view offers corner curl, swing or no page turn');
  const themeCss = await (await fetch(`http://127.0.0.1:${APP_PORT}/themes.css`)).text();
  const themeJs = await (await fetch(`http://127.0.0.1:${APP_PORT}/theme.js`)).text();
  const themeIds = [...themeJs.matchAll(/id: '([a-z-]+)', name:/g)].map((m) => m[1]).filter((id) => id !== 'auto');
  assert(themeIds.length >= 5, `at least five color themes to choose from (${themeIds.length})`);
  assert(themeIds.every((id) => themeCss.includes(`:root[data-theme="${id}"] {`)), 'every theme in the picker has its colors');

  const reading = await api('/api/reading');
  const savedEntry = JSON.parse(await fs.readFile(path.join(sandbox, 'out', 'outbox.json'), 'utf8')).items.find((i) => i.id === ok.id);
  assert(savedEntry?.summary?.v >= 1 && savedEntry.summary.data.excerpt, 'a summary, once worked out, is saved with its item (so a restart need not redo it)');
  assert(!(await api('/api/outbox')).body.items.some((i) => i.summary), 'the queue list leaves saved summaries out');
  const summarized = reading.body.items?.find((i) => i.id === ok.id);
  assert(summarized && summarized.excerpt.length > 40, `the Library gets a summary with an opening: "${summarized?.excerpt.slice(0, 40)}…"`);
  assert(summarized?.author === 'Sam Ito', `and the book's author: ${summarized?.author}`);

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
  // is — a converted file goes to A-pub Documents, a note or a feed to its own.
  assert(send.body.folder === '/A-pub Documents', `send ignored the requested folder: ${send.body.folder}`);
  assert(sd.has('/A-pub Documents'), 'the documents folder was created on the device');
  assert(sd.has('/A-pub Documents/Framing the News.epub'), 'EPUB present on the device');

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

  console.log('\n== forgetting takes the reader\'s copy too ==');
  // The bug this covers: the Library tab and the device disagreed. Forgetting
  // dropped the app's record and left the file sitting on the reader, with
  // nothing in the interface saying so.
  await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ host: DEVICE_HOST, folder: '/A-pub Books', includeImages: false }),
  });

  const keepEntry = (await api('/api/outbox')).body.items.find((i) => i.deliveredAt);
  assert(Boolean(keepEntry), 'there is a delivered entry to forget');
  assert(sd.has(`/A-pub Documents/${keepEntry.filename}`), 'its file is on the device to begin with');

  // Forgetting without asking for the device leaves the reader's copy alone.
  const forgetLocal = await api('/api/outbox/remove', {
    method: 'POST',
    body: JSON.stringify({ id: keepEntry.id, fromDevice: false }),
  });
  assert(forgetLocal.body.ok === true, 'forgetting locally succeeds');
  assert(forgetLocal.body.pending === 0, 'nothing was queued for removal');
  assert(sd.has(`/A-pub Documents/${keepEntry.filename}`), "the reader's copy was left alone");

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
  assert(sd.has(`/A-pub Documents/${doomed.filename}`), 'the doomed file reached the device');

  const forgetBoth = await api('/api/outbox/remove', {
    method: 'POST',
    body: JSON.stringify({ id: doomed.id, fromDevice: true }),
  });
  assert(forgetBoth.body.pending === 1, `the removal was queued: ${forgetBoth.body.pending}`);
  // Queued, not done: the reader may not be connected when you tidy up.
  assert(sd.has(`/A-pub Documents/${doomed.filename}`), 'the file is still there until a sync');

  const queued = await api('/api/removals');
  assert(
    queued.body.removals[0]?.filename === doomed.filename,
    'the queue names the file and its folder'
  );

  // A sync with nothing to upload still carries out the removal — switching
  // an item off in the Library and syncing is exactly this.
  const sweep = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ ids: [], host: DEVICE_HOST }),
  });
  assert(sweep.status === 200, `a removal-only sync is accepted: ${sweep.status}`);
  assert(
    !sd.has(`/A-pub Documents/${doomed.filename}`),
    'the sync deleted the forgotten file from the device'
  );
  assert(
    sweep.body.removed?.some((r) => r.ok && r.filename === doomed.filename),
    'the sync reports what it removed'
  );
  assert((await api('/api/removals')).body.removals.length === 0, 'the removal queue is now empty');

  const idle = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ ids: [], host: DEVICE_HOST }),
  });
  assert(idle.status === 400, 'a send with no ids and no removals is still rejected');

  console.log('\n== on reader switch ==');
  const switched = (
    await api('/api/convert', {
      method: 'POST',
      body: JSON.stringify({
        includeImages: false,
        items: [
          {
            name: 'switch.html',
            text: `<html lang="en"><head><title>Switch Me</title></head><body><article><h1>Switch Me</h1><p>${paragraph.repeat(3)}</p></article></body></html>`,
          },
        ],
      }),
    })
  ).body.results.find((r) => r.ok);
  const onDevice = () => sd.has(`/A-pub Documents/${switched.filename}`);
  const record = async () => (await api('/api/outbox')).body.items.find((i) => i.id === switched.id);
  const setSwitch = (on) =>
    api('/api/outbox/on-reader', { method: 'POST', body: JSON.stringify({ id: switched.id, on }) });

  await setSwitch(false);
  const skipped = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ ids: [switched.id], host: DEVICE_HOST }),
  });
  assert(!onDevice() && skipped.body.results[0]?.ok === false, 'an item switched off before sending is not sent');
  assert((await record()).onReader === false, 'the switch is remembered on the item');

  await setSwitch(true);
  await api('/api/send', { method: 'POST', body: JSON.stringify({ ids: [switched.id], host: DEVICE_HOST }) });
  assert(onDevice(), 'switched on, it goes over at the next sync');

  const off = await setSwitch(false);
  assert(off.body.pending === 1 && onDevice(), 'switching off a sent item queues it to come off, without removing it yet');
  const backOn = await setSwitch(true);
  assert(backOn.body.pending === 0, 'switching back on before a sync cancels the removal');

  await setSwitch(false);
  await api('/api/send', { method: 'POST', body: JSON.stringify({ ids: [], host: DEVICE_HOST }) });
  const afterOff = await record();
  assert(!onDevice(), 'the next sync takes it off the reader');
  assert(Boolean(afterOff) && afterOff.deliveredAt === null, 'it stays in the Library, no longer marked as sent');

  await setSwitch(true);
  assert((await api('/api/removals')).body.removals.length === 0, 'switching on again queues no removal');
  await api('/api/send', { method: 'POST', body: JSON.stringify({ ids: [switched.id], host: DEVICE_HOST }) });
  assert(onDevice() && Boolean((await record()).deliveredAt), 'and the next sync puts it back');

  // A feed switches as a whole: the edition on the reader and the newer one
  // waiting to replace it. Two editions are written straight into the queue,
  // since a live feed cannot be fetched here.
  const outboxFile = path.join(sandbox, 'out', 'outbox.json');
  const stored = JSON.parse(await fs.readFile(outboxFile, 'utf8'));
  const base = stored.items.find((i) => i.id === switched.id);
  const feedSource = { kind: 'feed', label: 'Test Feed', feedId: 'feed-under-test' };
  // Each edition needs a file of its own: forgetting one deletes its file.
  const copyOf = async (name) => {
    const target = path.join(sandbox, 'out', name);
    await fs.copyFile(path.join(sandbox, 'out', base.file), target);
    return target;
  };
  // The older edition is written the way entries were before 2.0, with an
  // absolute path instead of a storage key, which must still work.
  const { file: _file, ...legacyBase } = base;
  stored.items.push(
    { ...legacyBase, id: '11111111-1111-1111-1111-111111111111', diskPath: await copyOf('feed-old.epub'), filename: 'Test Feed - old.epub', folder: '/A-pub Feeds', source: feedSource, onReader: true, deliveredAt: new Date().toISOString(), builtAt: '2026-01-01T00:00:00.000Z' },
    { ...base, id: '22222222-2222-2222-2222-222222222222', file: path.basename(await copyOf('feed-new.epub')), filename: 'Test Feed - new.epub', folder: '/A-pub Feeds', source: feedSource, onReader: true, deliveredAt: null, builtAt: '2026-01-02T00:00:00.000Z' }
  );
  await fs.writeFile(outboxFile, JSON.stringify(stored));
  const feedOff = await api('/api/outbox/on-reader', {
    method: 'POST',
    body: JSON.stringify({ id: '22222222-2222-2222-2222-222222222222', on: false }),
  });
  const editions = (await api('/api/outbox')).body.items.filter((i) => i.source?.feedId === 'feed-under-test');
  assert(editions.length === 2 && editions.every((i) => i.onReader === false), 'switching a feed off switches off every edition');
  assert(
    (await api('/api/removals')).body.removals.some((r) => r.filename === 'Test Feed - old.epub'),
    'and the edition already on the reader is queued to come off'
  );
  await api('/api/outbox/on-reader', {
    method: 'POST',
    body: JSON.stringify({ id: '22222222-2222-2222-2222-222222222222', on: true }),
  });
  assert(
    !(await api('/api/removals')).body.removals.some((r) => r.filename === 'Test Feed - old.epub'),
    'switching the feed back on cancels that removal'
  );
  for (const id of ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']) {
    await api('/api/outbox/remove', { method: 'POST', body: JSON.stringify({ id, fromDevice: false }) });
  }

  const unknownSwitch = await api('/api/outbox/on-reader', { method: 'POST', body: JSON.stringify({ id: 'nope', on: true }) });
  assert(unknownSwitch.status === 404, 'switching an unknown item is a 404');

  console.log('\n== new articles in feeds ==');
  // A stand-in feed: refresh it, then publish another article and see it
  // counted as new — without anything being rebuilt.
  const feedItems = [
    { title: 'First story from the stand-in feed', date: new Date(Date.now() - 3600e3) },
    { title: 'Second story from the stand-in feed', date: new Date(Date.now() - 1800e3) },
  ];
  const { createCanvas } = await import('@napi-rs/canvas');
  const pictureCanvas = createCanvas(400, 300);
  const pictureCtx = pictureCanvas.getContext('2d');
  pictureCtx.fillStyle = '#3366aa';
  pictureCtx.fillRect(0, 0, 400, 300);
  const picturePng = pictureCanvas.toBuffer('image/png');
  const rss = () =>
    `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Stand-in Feed</title><link>http://127.0.0.1/</link>` +
    feedItems
      .map((i, n) => `<item><title>${i.title}</title><link>http://127.0.0.1:${feedServer.address().port}/story/${encodeURIComponent(i.title)}</link><pubDate>${i.date.toUTCString()}</pubDate>${n === 0 ? `<media:content url="http://127.0.0.1:${feedServer.address().port}/picture.png" medium="image" width="400"/>` : ''}<description>&lt;p&gt;${paragraph.repeat(2)}&lt;/p&gt;</description></item>`)
      .join('') +
    `</channel></rss>`;
  const standInRequests = [];
  const feedServer = http.createServer((req, res) => {
    standInRequests.push(req.url);
    if (req.url.startsWith('/story/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<html><body><article><h1>Story</h1><p>${paragraph.repeat(6)}</p></article></body></html>`);
    }
    if (req.url === '/picture.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(picturePng);
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(rss());
  });
  await new Promise((r) => feedServer.listen(0, '127.0.0.1', r));
  const feedUrl = `http://127.0.0.1:${feedServer.address().port}/feed.xml`;
  try {
    const added = await api('/api/feeds/add', { method: 'POST', body: JSON.stringify({ url: feedUrl, limit: 5 }) });
    const standIn = added.body.feed;
    const notBuilt = (await api('/api/feeds/check')).body.feeds.find((f) => f.feedId === standIn.id);
    assert(notBuilt?.newCount === 2 && notBuilt.hasEdition === false, `before any refresh, all its articles are new: ${notBuilt?.newCount}`);

    const refreshed = await api('/api/feeds/refresh', { method: 'POST', body: JSON.stringify({ id: standIn.id }) });
    assert(!standInRequests.some((u) => u.startsWith('/story/')), 'a refresh never fetches the articles’ own pages, only the feed (and pictures it names)');
    assert(refreshed.body.results[0].steps.some((step) => /Kept 1 picture/.test(step)), 'a refresh keeps the pictures the feed gives, for the web view');
    const edition = (await api('/api/reading')).body.items.find((i) => i.feedId === standIn.id);
    const pictured = edition?.articles?.find((a) => a.image);
    assert(pictured && /^\/out\/[0-9a-f-]{36}\/image\/\d+\.jpg$/.test(pictured.image), 'the Library gets the article’s picture, served by the app');
    assert(edition.articles.filter((a) => a.image).length === 1, 'only articles with a picture have one');
    const pictureRes = await fetch(`http://127.0.0.1:${APP_PORT}${pictured.image}`);
    const pictureBytes = Buffer.from(await pictureRes.arrayBuffer());
    assert(pictureRes.ok && pictureRes.headers.get('content-type') === 'image/jpeg' && pictureBytes[0] === 0xff && pictureBytes[1] === 0xd8, 'and serves it as a JPEG');
    const readHtml = await (await fetch(`http://127.0.0.1:${APP_PORT}/read/${edition.id}`)).text();
    assert(readHtml.includes(`<figure class="lead-image"><img src="${pictured.image}"`), 'the reading page shows it inline in the article');
    const fresh = (await api('/api/feeds/check')).body.feeds.find((f) => f.feedId === standIn.id);
    assert(fresh?.newCount === 0, `right after a refresh, nothing is new: ${fresh?.newCount}`);

    feedItems.push({ title: 'Third story, published since the refresh', date: new Date(Date.now() + 60e3) });
    const outboxBefore = (await api('/api/outbox')).body.items.length;
    const later = await api('/api/feeds/check');
    const counted = later.body.feeds.find((f) => f.feedId === standIn.id);
    assert(counted?.newCount === 1, `an article published since then counts as new: ${counted?.newCount}`);
    assert(
      counted?.articles?.[0]?.title === 'Third story, published since the refresh' && /^http:\/\/127\.0\.0\.1[:/]/.test(counted.articles[0].link || ''),
      'and the check names it, with its link, for the Library to list'
    );
    assert(later.body.newCount >= 1, 'and in the total');
    assert((await api('/api/outbox')).body.items.length === outboxBefore, 'checking builds nothing');

    feedItems.push({ title: 'An older story that never made the edition', date: new Date(Date.now() - 7200e3) });
    const older = (await api('/api/feeds/check')).body.feeds.find((f) => f.feedId === standIn.id);
    assert(older?.newCount === 1, `an older article missing from the edition is not counted as new: ${older?.newCount}`);

    // Removing a feed keeps its editions, so forget those too.
    for (const item of (await api('/api/outbox')).body.items.filter((i) => i.source?.feedId === standIn.id)) {
      await api('/api/outbox/remove', { method: 'POST', body: JSON.stringify({ id: item.id, fromDevice: false }) });
    }
    await api('/api/feeds/remove', { method: 'POST', body: JSON.stringify({ id: standIn.id }) });
  } finally {
    feedServer.close();
  }

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
  assert(sd.has('/A-pub Documents/Wipe Me.epub'), 'two files staged on the device to wipe');

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
  // Two sent above, one never sent, and the item from the switch tests (sent).
  assert(wiped.body.items === 4, `sent and unsent items are both removed: ${wiped.body.items}`);
  assert(wiped.body.pending === 3, `only what reached the reader is queued for it: ${wiped.body.pending}`);
  const wipeLog = appLog.join('').split('\n').find((line) => line.includes('Remove everything:')) || '';
  assert(/4 items, .*reader copies queued for removal\. Browser: \S/.test(wipeLog), `the wipe is logged with its browser: "${wipeLog.trim()}"`);
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
