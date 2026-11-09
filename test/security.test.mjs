// Security regressions: the network guard for user-supplied addresses, request
// checks (headers, same-origin, Host, size and type limits, rate limits),
// startup refusal of weak secrets, chapter sanitizing, and the PDF engine's
// no-eval setting. The server is spawned for real in a sandbox on its own port.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  blockedReason,
  checkUrl,
  configureNetGuard,
  guardedLookup,
  isBlockedAddress,
  safeFetch,
} from '../lib/netguard.mjs';
import { RateLimiter, clientIp, sameOrigin, secretProblems } from '../lib/security.mjs';
import { sanitizeChapter } from '../lib/epubread.mjs';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Not 4399 (server tests) or 4397 (hosted tests).
const PORT = 4395;

console.log('== blocked addresses ==');
for (const ip of [
  '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
  '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
  '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
  '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe',
  '2002:7f00:1::', '2002:c0a8:101::1', '2001:0:4136:e378:8000:63bf:80ff:fffe',
]) {
  assert(isBlockedAddress(ip), `${ip} is blocked`);
}
for (const ip of ['8.8.8.8', '1.1.1.1', '151.101.1.69', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '172.32.0.1']) {
  assert(!isBlockedAddress(ip), `${ip} is allowed`);
}
assert(isBlockedAddress('not-an-ip'), 'something that is not an address is refused');

console.log('\n== URL checks when hosted ==');
configureNetGuard({ allowPrivate: false });
const refused = [
  'http://127.0.0.1/',
  'http://localhost:4321/api/config',
  'http://app.localhost/',
  'http://metadata.google.internal/computeMetadata/v1/',
  'http://169.254.169.254/latest/meta-data/',
  'http://[::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://0x7f.1/', // hex
  'http://2130706433/', // one decimal number
  'http://0177.0.0.1/', // octal
  'http://１２７.０.０.１/', // fullwidth digits
  'http://127.1/',
  'http://intranet/',
  'http://printer.local/',
  'file:///etc/passwd',
  'ftp://example.com/x',
  'javascript:alert(1)',
  'http://user:pass@example.com/',
];
for (const address of refused) {
  const err = throws(() => checkUrl(address));
  assert(err && blockedReason(err), `refuses ${address}${err ? ` — "${err.message.slice(0, 70)}"` : ''}`);
}
for (const address of ['https://www.npr.org/rss/', 'http://example.com:8080/feed', 'https://8.8.8.8/']) {
  assert(!throws(() => checkUrl(address)), `allows ${address}`);
}

console.log('\n== names that resolve to private addresses ==');
const lookup = (name) => new Promise((resolve) => guardedLookup(name, { all: true }, (err, list) => resolve({ err, list })));
const local = await lookup('localhost');
assert(local.err && blockedReason(local.err), 'a name answering 127.0.0.1 is refused at connect time');
// A public name that points at 127.0.0.1 — the DNS-rebinding shape. Needs DNS.
const rebind = await lookup('localtest.me');
if (rebind.err?.code === 'ENOTFOUND' || rebind.err?.code === 'EAI_AGAIN') {
  console.log('SKIP  localtest.me did not resolve (no DNS here)');
} else {
  assert(rebind.err && blockedReason(rebind.err), 'a public name that resolves to loopback is refused');
}

// A local server to fetch from; private addresses allowed again, as on your computer.
configureNetGuard({ allowPrivate: true });
let hops = 0;
const target = http.createServer((req, res) => {
  if (req.url === '/to-file') return res.writeHead(302, { location: 'file:///etc/passwd' }).end();
  if (req.url === '/to-creds') return res.writeHead(302, { location: 'http://user:pw@example.com/' }).end();
  if (req.url === '/loop') {
    hops++;
    return res.writeHead(302, { location: '/loop' }).end();
  }
  if (req.url === '/hop') return res.writeHead(301, { location: '/ok' }).end();
  if (req.url === '/big') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    for (let i = 0; i < 64; i++) res.write(Buffer.alloc(16 * 1024, 97));
    return res.end();
  }
  if (req.url === '/declared') {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(10 * 1024 * 1024) });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end('<p>ok</p>');
});
await new Promise((r) => target.listen(0, '127.0.0.1', r));
const t = `http://127.0.0.1:${target.address().port}`;

console.log('\n== redirects and size limits ==');
const hop = await safeFetch(`${t}/hop`);
assert(hop.ok && hop.url === `${t}/ok` && hop.redirected && (await hop.text()) === '<p>ok</p>', 'follows an ordinary redirect and reports the final address');
assert(!blockedReason(new Error('fetch failed')), 'an ordinary failure is not reported as a refusal');
const toFile = await safeFetch(`${t}/to-file`).catch((e) => e);
assert(blockedReason(toFile), 'a redirect to file: is refused');
const toCreds = await safeFetch(`${t}/to-creds`).catch((e) => e);
assert(blockedReason(toCreds), 'a redirect to an address with credentials is refused');
const loop = await safeFetch(`${t}/loop`).catch((e) => e);
assert(loop instanceof Error && /too many/i.test(loop.message) && hops <= 6, 'a redirect loop stops');
const big = await safeFetch(`${t}/big`, { maxBytes: 256 * 1024 });
const bigBody = await big.text().catch((e) => e);
assert(bigBody instanceof Error && /too large/.test(bigBody.message), 'a body past the size limit is cut off');
const declared = await safeFetch(`${t}/declared`, { maxBytes: 1024 * 1024 }).catch((e) => e);
assert(declared instanceof Error && /too large/.test(declared.message), 'a declared size past the limit is refused before reading');
target.close();

console.log('\n== same-origin and proxy address ==');
const req = (headers) => ({ headers: { host: 'app.example.com', ...headers }, socket: { remoteAddress: '10.0.0.5' } });
assert(sameOrigin(req({ origin: 'https://app.example.com' })), 'the app’s own origin is accepted');
assert(!sameOrigin(req({ origin: 'https://evil.example' })), 'another origin is refused');
assert(!sameOrigin(req({ origin: 'null' })), 'an opaque (null) origin is refused');
assert(!sameOrigin(req({ referer: 'https://evil.example/page' })), 'another site’s referer is refused');
assert(!sameOrigin(req({ origin: 'https://evil.example', 'x-requested-with': 'XMLHttpRequest' })), 'a custom header is no way around it');
assert(sameOrigin(req({})), 'a request from no web page at all is allowed');
assert(clientIp(req({ 'x-forwarded-for': '1.2.3.4' }), 0) === '10.0.0.5', 'without a proxy, X-Forwarded-For is ignored');
assert(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }), 1) === '1.2.3.4', 'behind one proxy, the address it added is used, not one the client wrote');

console.log('\n== secrets and rate limits ==');
assert(secretProblems({}, { required: true }).length === 1, 'a missing password is a problem when one is required');
assert(secretProblems({ APP_PASSWORD: 'short' }, { required: true }).some((p) => /shorter/.test(p)), 'a short password is refused');
assert(secretProblems({ APP_PASSWORD: 'aaaaaaaaaaaaaaaa' }, { required: true }).length === 1, 'a repeated-character password is refused');
assert(secretProblems({ APP_PASSWORD: 'correct horse battery staple' }, { required: true }).length === 0, 'a long passphrase is fine');
assert(secretProblems({}, { required: false }).length === 0, 'nothing is required on your own computer');
const pw = { APP_PASSWORD: 'correct horse battery staple' };
assert(secretProblems({ ...pw, STORAGE_BUCKET: 'b' }, { required: true }).some((p) => /half set up/.test(p)), 'half-configured file storage is refused');
assert(secretProblems({ ...pw, STORAGE_ENDPOINT: 'https://s3', STORAGE_BUCKET: 'b', STORAGE_ACCESS_KEY_ID: 'k', STORAGE_SECRET_ACCESS_KEY: 'short' }, { required: true }).some((p) => /too short/.test(p)), 'a placeholder storage secret is refused');
assert(secretProblems({ ...pw, STORAGE_ENDPOINT: 'https://s3', STORAGE_BUCKET: 'b', STORAGE_ACCESS_KEY_ID: 'k', STORAGE_SECRET_ACCESS_KEY: 'x'.repeat(31) + 'y' }, { required: true }).length === 0, 'complete file storage settings pass');
const limiter = new RateLimiter({ windowMs: 1000, max: 3 });
const results = [1, 2, 3, 4].map(() => limiter.hit('a', 0).ok);
assert(results.join() === 'true,true,true,false', 'the fourth hit in a window is refused');
assert(limiter.hit('a', 1001).ok, 'the window resets');

console.log('\n== chapter sanitizing ==');
const dirty = sanitizeChapter(
  '<p onclick="x()">Hi</p><a href="javascript:alert(1)">j</a><a href="//evil.example/">p</a><a href="https://ok.example/">ok</a>' +
    '<img src="/out/a/epub/i.png" onerror="alert(1)"><iframe src="https://x"></iframe><form action="https://x"><input></form><svg><script>alert(1)</script></svg>'
);
assert(!/onclick|onerror|javascript:|<iframe|<form|<input|<script/i.test(dirty), 'handlers, script URLs, frames, forms and scripts are removed');
assert(!/evil\.example/.test(dirty), 'protocol-relative links are removed');
assert(/href="https:\/\/ok\.example\/"[^>]*target="_blank"/.test(dirty) && /rel="noreferrer noopener"/.test(dirty), 'web links stay and open safely');
assert(/<img src="\/out\/a\/epub\/i\.png">/.test(dirty), 'the app’s own image addresses stay');

console.log('\n== PDF engine never evaluates code ==');
for (const file of ['lib/pdf.mjs', 'lib/render.mjs', 'lib/pdfimages.mjs']) {
  const source = await fs.readFile(path.join(ROOT, file), 'utf8');
  const loads = (source.match(/getDocument\(/g) || []).length;
  const off = (source.match(/isEvalSupported:\s*false/g) || []).length;
  assert(loads > 0 && off >= loads, `${file}: every getDocument() sets isEvalSupported: false`);
}

// ------------------------------------------------------------------ server

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'apub-security-test-'));
const PASSWORD = 'correct horse battery staple';
const env = (extra) => ({
  ...process.env,
  PORT: String(PORT),
  EPUB_DROP_OUT_DIR: path.join(sandbox, 'out'),
  EPUB_DROP_CONFIG: path.join(sandbox, 'data', 'config.json'),
  EPUB_DROP_STATE: sandbox,
  EPUB_DROP_CLOUD_ROOT: path.join(sandbox, 'cloud'),
  ...extra,
});

async function refusesToStart(extra) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: env(extra), stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const timer = setTimeout(() => child.kill(), 5000);
  const code = await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(timer);
  return { refused: code !== 0 && code !== null, err };
}

console.log('\n== startup refuses weak secrets ==');
// These exit before listening, so 0.0.0.0 is never actually opened.
const weak = await refusesToStart({ HOST: '0.0.0.0', APP_PASSWORD: 'changeme' });
assert(weak.refused && /weak secrets/i.test(weak.err) && /shorter/.test(weak.err), 'a short APP_PASSWORD stops a public server');
const placeholder = await refusesToStart({ HOST: '0.0.0.0', APP_PASSWORD: 'xxxxxxxxxxxxxxxx' });
assert(placeholder.refused && /common or placeholder/.test(placeholder.err), 'a placeholder APP_PASSWORD stops a public server');
const prod = await refusesToStart({ NODE_ENV: 'production', APP_PASSWORD: '' });
assert(prod.refused && /not set/.test(prod.err), 'NODE_ENV=production requires a password even on this computer');

console.log('\n== hosted server ==');
const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: env({ HOSTED: '1', APP_PASSWORD: PASSWORD }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
app.stdout.on('data', (d) => log.push(String(d)));
app.stderr.on('data', (d) => log.push(String(d)));
const base = `http://127.0.0.1:${PORT}`;
const auth = { authorization: `Basic ${Buffer.from(`reader:${PASSWORD}`).toString('base64')}` };
const jsonHeaders = { ...auth, 'content-type': 'application/json' };

/** A raw request, so Host can be set (fetch will not). */
function raw(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const page = await fetch(`${base}/`, { headers: auth });
  const csp = page.headers.get('content-security-policy') || '';
  assert(page.ok && /script-src 'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), `the main page has a CSP with no inline script: ${csp.slice(0, 60)}…`);
  assert(/frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp), 'and refuses framing, plugins and base changes');
  assert(page.headers.get('x-content-type-options') === 'nosniff', 'nosniff is set');
  assert(page.headers.get('referrer-policy') === 'no-referrer', 'no referrer is sent');
  assert(page.headers.get('x-frame-options') === 'DENY', 'framing is denied for old browsers too');
  const apiRes = await fetch(`${base}/api/config`, { headers: auth });
  assert(apiRes.headers.get('x-content-type-options') === 'nosniff', 'API responses get the same headers');
  const hsts = await raw('/', { headers: { ...auth, 'x-forwarded-proto': 'https' } });
  assert(!hsts.headers['strict-transport-security'], 'no HSTS when no trusted proxy says HTTPS');

  const rebinding = await raw('/api/config', { headers: { ...auth, host: 'evil.example:4395' } });
  assert(rebinding.status === 403, 'a request addressed to another name (DNS rebinding) is refused');

  const crossSite = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { ...jsonHeaders, origin: 'https://evil.example' },
    body: '{}',
  });
  assert(crossSite.status === 403, 'a POST from another site is refused');
  const sameSite = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { ...jsonHeaders, origin: base },
    body: '{"includeImages":true}',
  });
  assert(sameSite.ok, 'a POST from the app’s own page is accepted');

  const textBody = await fetch(`${base}/api/feeds/add`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'text/plain' },
    body: '{"url":"https://example.com/feed"}',
  });
  assert(textBody.status === 415, 'a body not sent as JSON is refused');

  const tooBig = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }),
  }).catch((e) => e);
  assert(tooBig.status === 413 || tooBig instanceof Error, 'a 2 MB body on a small route is refused');

  for (const pathname of ['/%2e%2e/server.mjs', '/..%2fserver.mjs', '/vendor/../../package.json', '/%2e%2e%2fconfig.json']) {
    const r = await raw(pathname, { headers: auth });
    assert(!/import http|"dependencies"/.test(r.body), `no file outside public/ via ${pathname}`);
  }

  for (const [address, why] of [
    [`http://127.0.0.1:${PORT}/api/config`, 'the server itself'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://0x7f.1/', 'a hex loopback'],
  ]) {
    const r = await fetch(`${base}/api/convert`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ items: [{ url: address }] }),
    });
    const text = await r.text();
    assert(/private or local address/.test(text), `converting ${why} is refused`);
  }
  const feed = await fetch(`${base}/api/feeds/add`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ url: 'http://localhost/feed.xml' }),
  });
  assert(/private or local address/.test(await feed.text()), 'adding a feed on localhost is refused');

  // Last: lock this address out with wrong passwords.
  const wrong = { authorization: `Basic ${Buffer.from('reader:guess').toString('base64')}` };
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await fetch(`${base}/api/config`, { headers: wrong })).status);
  assert(codes.slice(0, 10).every((c) => c === 401) && codes[10] === 429, `the 11th wrong password is rate limited (${codes.at(-1)})`);
  const locked = await fetch(`${base}/api/config`, { headers: auth });
  assert(locked.status === 429 && locked.headers.get('retry-after'), 'even the right password waits until the lockout ends');
} finally {
  app.kill();
  await fs.rm(sandbox, { recursive: true, force: true });
}

if (fail) console.log(log.join('').slice(-2000));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
