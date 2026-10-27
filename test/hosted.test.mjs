// Hosted mode: the app as it runs on Render, behind a password with the device
// features off. The server is spawned for real, on its own port and in a
// sandbox, as the server tests do.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4397;
const PASSWORD = 'correct horse battery staple';
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'apub-hosted-test-'));

const env = (extra) => ({
  ...process.env,
  PORT: String(PORT),
  EPUB_DROP_OUT_DIR: path.join(sandbox, 'out'),
  EPUB_DROP_CONFIG: path.join(sandbox, 'data', 'config.json'),
  EPUB_DROP_STATE: sandbox,
  EPUB_DROP_CLOUD_ROOT: path.join(sandbox, 'cloud'),
  ...extra,
});

console.log('== refusing to listen publicly without a password ==');
const open = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: env({ HOST: '0.0.0.0', APP_PASSWORD: '' }),
  stdio: ['ignore', 'ignore', 'pipe'],
});
let refusal = '';
open.stderr.on('data', (d) => (refusal += d));
const code = await new Promise((resolve) => open.on('exit', resolve));
assert(code !== 0 && /without a password/i.test(refusal), 'it will not listen on 0.0.0.0 without APP_PASSWORD');

console.log('\n== hosted, behind a password ==');
// Hosted mode switched on directly, so the test never listens beyond this computer.
const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: env({ HOSTED: '1', APP_PASSWORD: PASSWORD }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
app.stdout.on('data', (d) => log.push(String(d)));
app.stderr.on('data', (d) => log.push(String(d)));

const base = `http://127.0.0.1:${PORT}`;
const auth = { authorization: `Basic ${Buffer.from(`reader:${PASSWORD}`).toString('base64')}` };
const wrong = { authorization: `Basic ${Buffer.from('reader:guess').toString('base64')}` };

try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const health = await fetch(`${base}/healthz`);
  assert(health.status === 200, 'the health check answers without the password');

  const anonymous = await fetch(`${base}/`);
  assert(anonymous.status === 401, 'the app itself needs the password');
  assert(/Basic/.test(anonymous.headers.get('www-authenticate') || ''), 'and asks for it with a browser sign-in');
  assert((await fetch(`${base}/api/outbox`)).status === 401, 'so do the API routes');
  assert((await fetch(`${base}/`, { headers: wrong })).status === 401, 'a wrong password is refused');

  const page = await fetch(`${base}/`, { headers: auth });
  assert(page.status === 200 && /A-Pub Reader/.test(await page.text()), 'the right password opens the app');

  const config = await (await fetch(`${base}/api/config`, { headers: auth })).json();
  assert(config.hosted === true, 'the page is told it is hosted');

  for (const [method, route] of [
    ['POST', '/api/discover'],
    ['GET', '/api/device'],
    ['POST', '/api/send'],
    ['POST', '/api/send-volume'],
    ['GET', '/api/volumes'],
    ['POST', '/api/reveal'],
  ]) {
    const res = await fetch(`${base}${route}`, { method, headers: { ...auth, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert(res.status === 403, `${method} ${route} is off when hosted`);
  }

  const saved = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ includeImages: false }),
  });
  assert(saved.ok, 'settings save on a fresh host, creating the data folder');

  const paragraph = 'Readability needs a decent run of prose before it will treat an element as the article body, so this sentence is padding with enough length to qualify. ';
  const built = await (
    await fetch(`${base}/api/convert`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        includeImages: false,
        items: [{ name: 'hosted.html', text: `<html lang="en"><head><title>Hosted Reading</title></head><body><article><h1>Hosted Reading</h1><p>${paragraph.repeat(3)}</p></article></body></html>` }],
      }),
    })
  ).json();
  const item = built.results?.find((r) => r.ok);
  assert(Boolean(item), 'converting works when hosted');

  const reading = await (await fetch(`${base}/read/${item?.id}`, { headers: auth })).text();
  assert(/<h1>Hosted Reading<\/h1>/.test(reading), 'and the reading page shows it');
  assert(!/role="switch"/.test(reading) && !/id="reader-sync"/.test(reading), 'without the On reader switch or Sync Reader');
} finally {
  app.kill();
  await new Promise((r) => app.on('exit', r));
  await fs.rm(sandbox, { recursive: true, force: true });
}

if (fail) console.log('\napp output:\n' + log.join(''));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
