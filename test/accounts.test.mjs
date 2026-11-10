// Accounts (Phase 2a): password hashing and rules, the encrypted lookup copy,
// and the whole server with accounts on: the sign-in gate, sessions and their
// cookie, a private library per person, the admin area and its rules, and
// changing, resetting and looking up passwords.
//
// The server runs for real on an embedded PostgreSQL (PGlite, via a
// pglite:<folder> DATABASE_URL), on its own port, in a sandbox.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword, passwordProblem, readablePassword, verifyPassword } from '../lib/accounts/passwords.mjs';
import { lookupKey, openPassword, sealPassword } from '../lib/accounts/lookup.mjs';
import { emailProblem, usernameProblem } from '../lib/accounts/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`PASS  ${msg}`);
  } else {
    fail++;
    console.log(`FAIL  ${msg}`);
  }
};

console.log('== passwords ==');
const hash = await hashPassword('correct horse battery staple');
assert(/^scrypt\$15\$8\$3\$/.test(hash), 'passwords are hashed with scrypt at the chosen cost');
assert(hash !== (await hashPassword('correct horse battery staple')), 'each hash has its own salt');
assert(await verifyPassword('correct horse battery staple', hash), 'the right password matches');
assert(!(await verifyPassword('correct horse battery stapl', hash)), 'a wrong one does not');
assert(!(await verifyPassword('anything', null)) && !(await verifyPassword('anything', 'not-a-hash')), 'no hash, or a broken one, never matches');
assert(passwordProblem('short') && passwordProblem('password1234') && passwordProblem('aaaaaaaaaaaa'), 'short, common and repeated passwords are refused');
assert(passwordProblem('reader1-is-my-name', { username: 'reader1' }), 'a password containing the username is refused');
assert(passwordProblem('a long enough passphrase') === null, 'a long passphrase is fine');
const generated = readablePassword();
assert(/^[a-z]+(-[a-z]+){3}-\d\d$/.test(generated) && passwordProblem(generated) === null, `a generated password is readable and acceptable (${generated})`);
assert(usernameProblem('ab') && usernameProblem('-dash') && usernameProblem('has space') && usernameProblem('dan.p') === null, 'usernames are checked');
assert(emailProblem('nope') && emailProblem('') === null && emailProblem('a@b.co') === null, 'emails are checked, and optional');

console.log('\n== password lookup ==');
const key = lookupKey({ PASSWORD_LOOKUP_KEY: '0123456789abcdef'.repeat(4) });
assert(key?.length === 32 && lookupKey({}) === null, 'the lookup key is 32 bytes, and lookup is off without one');
assert(Boolean(await Promise.resolve().then(() => { try { lookupKey({ PASSWORD_LOOKUP_KEY: 'short' }); return false; } catch { return true; } })), 'a malformed key is refused');
const sealed = sealPassword(key, 'maple-river-stone-lantern-07');
assert(!sealed.includes('maple') && openPassword(key, sealed) === 'maple-river-stone-lantern-07', 'a sealed password is unreadable without the key, and opens with it');
assert(openPassword(Buffer.alloc(32, 1), sealed) === null, 'the wrong key opens nothing');
assert(openPassword(key, sealed.slice(0, -4) + 'AAAA') === null, 'a tampered copy opens nothing');

// ------------------------------------------------------------ the server

console.log('\n== server with accounts ==');
const PORT = 4391;
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'apub-accounts-'));
const ADMIN_PASSWORD = 'admin river lantern 42';
const env = {
  ...process.env,
  PORT: String(PORT),
  HOSTED: '1',
  // As on Render: one proxy in front, which says whether the visit was HTTPS.
  TRUST_PROXY_HOPS: '1',
  DATABASE_URL: `pglite:${path.join(sandbox, 'db')}`,
  ADMIN_USERNAME: 'boss',
  ADMIN_EMAIL: 'boss@example.com',
  ADMIN_PASSWORD,
  PASSWORD_LOOKUP_KEY: '0123456789abcdef'.repeat(4),
  EPUB_DROP_STATE: sandbox,
  EPUB_DROP_OUT_DIR: path.join(sandbox, 'out'),
  EPUB_DROP_CONFIG: path.join(sandbox, 'config.json'),
};
delete env.APP_PASSWORD;

// Without an admin to create, accounts refuse to start.
{
  const noAdmin = { ...env, ADMIN_USERNAME: '', ADMIN_PASSWORD: '', DATABASE_URL: `pglite:${path.join(sandbox, 'db-empty')}` };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...noAdmin, PORT: '4390' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert(code === 1 && /no admin yet/i.test(err), 'with accounts on and no admin, the server refuses to start and says how to make one');
}

const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
app.stdout.on('data', (d) => (log += d));
app.stderr.on('data', (d) => (log += d));
const base = `http://127.0.0.1:${PORT}`;

try {
  for (let i = 0; i < 150; i++) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(/created the first admin, "boss"/.test(log), 'the first admin is created from the environment');

  /** A browser: keeps its own cookie. */
  function browser() {
    let cookie = '';
    const call = async (route, { method = 'GET', body, headers = {}, redirect = 'manual' } = {}) => {
      const res = await fetch(base + route, {
        method,
        redirect,
        headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {}
      return { status: res.status, data, text, headers: res.headers, setCookie: set };
    };
    return {
      call,
      get cookie() {
        return cookie;
      },
      signIn: (login, password) => call('/api/auth/signin', { method: 'POST', body: { login, password } }),
    };
  }

  console.log('\n== the sign-in gate ==');
  const stranger = browser();
  const home = await stranger.call('/');
  assert(home.status === 302 && home.headers.get('location') === '/signin', 'the app sends someone not signed in to the sign-in page');
  const deep = await stranger.call('/read/00000000-0000-0000-0000-000000000000');
  assert(deep.status === 302 && deep.headers.get('location') === '/signin?next=%2Fread%2F00000000-0000-0000-0000-000000000000', 'and remembers where they were going');
  const apiCall = await stranger.call('/api/outbox');
  assert(apiCall.status === 401 && apiCall.data?.signin === true, 'calls answer "sign in first"');
  const page = await stranger.call('/signin');
  assert(page.status === 200 && /id="signin-form"/.test(page.text), 'the sign-in page is open to everyone');
  assert((await stranger.call('/style.css')).status === 200 && (await stranger.call('/signin.js')).status === 200, 'with its stylesheet and script');
  assert((await stranger.call('/app.js')).status === 302, "but not the app's own files");
  assert((await stranger.call('/admin')).status === 302 && (await stranger.call('/admin/admin.js')).status === 302, 'nor the admin page or its script');
  const me = await stranger.call('/api/auth/me');
  assert(me.data?.accounts === true && me.data.user === null, 'who-am-I says accounts are on and no one is signed in');

  console.log('\n== signing in ==');
  const wrong = await stranger.signIn('boss', 'not the password');
  assert(wrong.status === 401 && /not right/.test(wrong.data.error) && !wrong.setCookie, 'a wrong password is refused, with no session');
  const nobody = await stranger.signIn('nobody-here', 'whatever it is');
  assert(nobody.status === 401 && nobody.data.error === wrong.data.error, 'an unknown username gets exactly the same answer');
  const crossSite = await stranger.call('/api/auth/signin', { method: 'POST', body: { login: 'boss', password: ADMIN_PASSWORD }, headers: { origin: 'https://evil.example' } });
  assert(crossSite.status === 403, 'signing in from another site is refused');

  const boss = browser();
  const signedIn = await boss.signIn('BOSS@example.com', ADMIN_PASSWORD);
  assert(signedIn.status === 200 && signedIn.data.user.role === 'admin', 'the admin signs in by email, any capitalization');
  const cookie = signedIn.setCookie || '';
  assert(/HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie) && /Path=\//.test(cookie) && /Max-Age=\d+/.test(cookie), `the session cookie is HttpOnly, SameSite=Lax, site-wide and lasting (${cookie.split(';').slice(1).join(';').trim()})`);
  assert(/^apub_session=/.test(cookie) && !/Secure/.test(cookie), 'over plain HTTP the cookie is not marked Secure (over HTTPS it is __Host- and Secure)');
  assert((await boss.call('/')).status === 200, 'signed in, the app opens');
  const bossMe = await boss.call('/api/auth/me');
  assert(bossMe.data.user.username === 'boss' && !('library' in bossMe.data.user) && bossMe.data.sessions === 1, 'who-am-I names the user, without internals');
  const overHttps = await browser().call('/api/auth/signin', {
    method: 'POST',
    body: { login: 'boss', password: ADMIN_PASSWORD },
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' },
  });
  assert(/^__Host-apub_session=/.test(overHttps.setCookie || '') && /;\s*Secure/.test(overHttps.setCookie || ''), 'over HTTPS the cookie is __Host- prefixed and Secure');
  const again = await boss.call('/signin?next=/account');
  assert(again.status === 302 && again.headers.get('location') === '/account', 'the sign-in page sends someone signed in on');
  const offsite = await boss.call('/signin?next=//evil.example/');
  assert(offsite.headers.get('location') === '/', 'but never to another site');

  console.log('\n== the admin area ==');
  const made = await boss.call('/api/admin/users', { method: 'POST', body: { username: 'reader1', email: 'reader1@example.com' } });
  assert(made.status === 200 && /^[a-z]+(-[a-z]+){3}-\d\d$/.test(made.data.password) && made.data.user.adminSetPassword, 'an admin adds a user with a readable password');
  const readerPassword = made.data.password;
  const typed = await boss.call('/api/admin/users', { method: 'POST', body: { username: 'reader2', password: 'second reader passphrase' } });
  assert(typed.status === 200 && typed.data.password === 'second reader passphrase', 'or with a password they type');
  const weak = await boss.call('/api/admin/users', { method: 'POST', body: { username: 'reader3', password: 'short' } });
  assert(weak.status === 400, 'a weak typed password is refused');
  const dupe = await boss.call('/api/admin/users', { method: 'POST', body: { username: 'READER1' } });
  assert(dupe.status === 409 && /username is already taken/.test(dupe.data.error), 'usernames are unique ignoring case');
  const dupeMail = await boss.call('/api/admin/users', { method: 'POST', body: { username: 'reader4', email: 'Reader1@Example.com' } });
  assert(dupeMail.status === 409 && /email is already taken/.test(dupeMail.data.error), 'emails too');
  const listed = await boss.call('/api/admin/users');
  assert(listed.data.users.length === 3 && listed.data.lookup === true, 'the users are listed');
  assert(!JSON.stringify(listed.data).includes('scrypt$') && !JSON.stringify(listed.data).includes('v1.'), 'hashes and sealed copies never leave the server');
  const reader1Id = made.data.user.id;
  const looked = await boss.call('/api/admin/users/lookup', { method: 'POST', body: { id: reader1Id } });
  assert(looked.data.password === readerPassword, 'an admin-set password can be looked up');

  console.log('\n== one library each ==');
  const reader = browser();
  assert((await reader.signIn('reader1', readerPassword)).status === 200, 'the new user signs in');
  assert((await reader.call('/admin')).status === 403 && (await reader.call('/api/admin/users')).status === 403, 'a user cannot open the admin area');
  const paragraph = 'A sentence long enough for Readability to treat the element as the body of the article, repeated. ';
  const convert = (who, title) =>
    who.call('/api/convert', { method: 'POST', body: { items: [{ name: `${title}.html`, text: `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${paragraph.repeat(5)}</p></article></body></html>` }] } });
  const bossItem = (await convert(boss, 'Boss Reading')).data.results[0];
  const readerItem = (await convert(reader, 'Reader Reading')).data.results[0];
  assert(bossItem.ok && readerItem.ok, 'both build something');
  const bossList = (await boss.call('/api/outbox')).data.items.map((i) => i.title);
  const readerList = (await reader.call('/api/outbox')).data.items.map((i) => i.title);
  assert(bossList.join() === 'Boss Reading' && readerList.join() === 'Reader Reading', 'each sees only their own library');
  assert((await reader.call(`/read/${bossItem.id}`)).status === 404 && (await reader.call(`/out/${bossItem.id}`)).status === 404, "and cannot open someone else's item, even knowing its id");
  assert((await boss.call(`/read/${bossItem.id}`)).status === 200, 'while its owner can');

  console.log('\n== the browser keeps what it fetched ==');
  const style = await boss.call('/style.css');
  const styleTag = style.headers.get('etag');
  assert(styleTag && /no-cache/.test(style.headers.get('cache-control')), `app files carry a version and are checked on each visit (${style.headers.get('cache-control')})`);
  const style304 = await boss.call('/style.css', { headers: { 'if-none-match': styleTag } });
  assert(style304.status === 304 && style304.text === '', 'an unchanged file answers 304, with nothing to download');
  const list = await boss.call('/api/outbox');
  const listTag = list.headers.get('etag');
  assert(listTag && /private/.test(list.headers.get('cache-control')) && /Cookie/i.test(list.headers.get('vary') || ''), 'library data is versioned, private, and kept per signed-in person');
  assert((await boss.call('/api/outbox', { headers: { 'if-none-match': listTag } })).status === 304, 'unchanged library data answers 304');
  const theirs = await reader.call('/api/outbox', { headers: { 'if-none-match': listTag } });
  assert(theirs.status === 200 && theirs.data.items[0]?.title === 'Reader Reading', "someone else's copy is never accepted for another person's library");
  await convert(boss, 'Another Boss Reading');
  const changedList = await boss.call('/api/outbox', { headers: { 'if-none-match': listTag } });
  assert(changedList.status === 200 && changedList.data.items.length === 2 && changedList.headers.get('etag') !== listTag, 'after something is added, the new list comes down');
  const readPage = await boss.call(`/read/${bossItem.id}`);
  const readTag = readPage.headers.get('etag');
  assert(readTag && /private/.test(readPage.headers.get('cache-control')), 'a read page is versioned and private');
  const read304 = await boss.call(`/read/${bossItem.id}`, { headers: { 'if-none-match': readTag } });
  assert(read304.status === 304 && /script-src 'self'/.test(read304.headers.get('content-security-policy') || ''), 'an unchanged read page answers 304 (without rebuilding it), keeping its security policy');
  assert((await reader.call(`/read/${bossItem.id}`, { headers: { 'if-none-match': readTag } })).status === 404, "a cached copy does not let someone else open the page");

  console.log('\n== changing a password ==');
  const otherTab = browser();
  await otherTab.signIn('reader1', readerPassword);
  const badCurrent = await reader.call('/api/auth/password', { method: 'POST', body: { current: 'wrong one entirely', next: 'my own reading phrase' } });
  assert(badCurrent.status === 400, 'the current password must be right');
  const changed = await reader.call('/api/auth/password', { method: 'POST', body: { current: readerPassword, next: 'my own reading phrase' } });
  assert(changed.status === 200 && changed.data.signedOut === 1, 'the user chooses their own password; their other browser is signed out');
  assert((await otherTab.call('/api/outbox')).status === 401, 'that other browser now has to sign in again');
  assert((await reader.call('/api/outbox')).status === 200, 'this one stays signed in');
  const lookedAfter = await boss.call('/api/admin/users/lookup', { method: 'POST', body: { id: reader1Id } });
  assert(lookedAfter.data.password === null && /chose their own/.test(lookedAfter.data.reason), 'a password the user chose can never be looked up');
  assert((await browser().signIn('reader1', readerPassword)).status === 401, 'the old password no longer works');

  console.log('\n== admin actions ==');
  const reset = await boss.call('/api/admin/users/reset', { method: 'POST', body: { id: reader1Id } });
  assert(reset.status === 200 && reset.data.user.adminSetPassword, 'an admin resets a password');
  assert((await reader.call('/api/outbox')).status === 401, 'which signs the user out everywhere');
  const back = browser();
  assert((await back.signIn('reader1', reset.data.password)).status === 200, 'and the new one works');
  const off = await boss.call('/api/admin/users/update', { method: 'POST', body: { id: reader1Id, status: 'disabled' } });
  assert(off.status === 200 && (await back.call('/api/outbox')).status === 401, 'switching an account off ends its sessions');
  const offSignIn = await browser().signIn('reader1', reset.data.password);
  assert(offSignIn.status === 403 && /switched off/.test(offSignIn.data.error), 'and it cannot sign in');
  await boss.call('/api/admin/users/update', { method: 'POST', body: { id: reader1Id, status: 'active' } });
  const bossId = bossMe.data.user.id;
  assert((await boss.call('/api/admin/users/update', { method: 'POST', body: { id: bossId, role: 'user' } })).status === 400, 'an admin cannot demote themselves');
  assert((await boss.call('/api/admin/users/delete', { method: 'POST', body: { id: bossId, confirm: 'boss' } })).status === 400, 'or delete themselves');
  const noConfirm = await boss.call('/api/admin/users/delete', { method: 'POST', body: { id: reader1Id, confirm: 'nope' } });
  assert(noConfirm.status === 400, 'deleting needs the username typed');
  const deleted = await boss.call('/api/admin/users/delete', { method: 'POST', body: { id: reader1Id, confirm: 'reader1' } });
  assert(deleted.status === 200, 'an admin deletes an account');
  assert((await browser().signIn('reader1', reset.data.password)).status === 401, 'which can no longer sign in');
  assert((await boss.call('/api/outbox')).data.items.length === 2, "and the admin's own library is untouched");

  console.log('\n== signing out ==');
  const out = await boss.call('/api/auth/signout', { method: 'POST', body: {} });
  assert(out.status === 200 && /Max-Age=0/.test(out.setCookie || ''), 'signing out clears the cookie');
  assert(out.headers.get('clear-site-data') === '"cache"', "and tells the browser to drop what it kept of the site");
  assert((await boss.call('/api/outbox')).status === 401, 'and the session is gone');

  console.log('\n== too many tries ==');
  const guesser = browser();
  let last;
  for (let i = 0; i < 11; i++) last = await guesser.signIn('reader2', `guess number ${i} here`);
  assert(last.status === 429, 'after ten wrong passwords for one account, signing in to it waits');
  const realOwner = await browser().signIn('reader2', 'second reader passphrase');
  assert(realOwner.status === 429, 'for a while, even with the right password');
} finally {
  app.kill();
  await new Promise((r) => setTimeout(r, 200));
  await fs.rm(sandbox, { recursive: true, force: true });
}

if (fail) console.log(`\nserver output:\n${log}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
