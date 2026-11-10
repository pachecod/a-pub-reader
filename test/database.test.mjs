// The hosted storage layer: migrations, the records table, every store on the
// database backend with each owner kept apart, S3-compatible file storage
// (against a small stand-in for a bucket), and the files backend's owner
// folders. Runs on an embedded PostgreSQL (PGlite), so no server is needed.
//
// With TEST_DATABASE_URL set (a real, empty PostgreSQL database), the server
// itself is also spawned on the database backend and exercised end to end.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import { DiskBlobs, S3Blobs, ScopedBlobs, checkKey } from '../lib/store/blobs.mjs';
import { PgCollection } from '../lib/store/collections.mjs';
import { AppSettings, MIGRATIONS, fromPGlite, migrate } from '../lib/store/db.mjs';
import { LOCAL_OWNER, checkOwner, databaseBackend, fileBackend } from '../lib/store/backend.mjs';
import { MemoryFetchCache, PgFetchCache, sharedFetcher } from '../lib/store/fetchcache.mjs';
import { composeFeedHtml, withDates } from '../lib/rss.mjs';
import { DEFAULT_LIMITS, LimitError, checkLimits, resolveLimits } from '../lib/limits.mjs';
import { hydrateItems } from '../lib/rss.mjs';
import pg from 'pg';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};
const rejects = async (promise) => promise.then(() => null, (err) => err);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'apub-db-test-'));

console.log('== migrations ==');
const db = fromPGlite(new PGlite());
const first = await migrate(db);
assert(first.length === MIGRATIONS.length, `a fresh database gets every migration (${first.join(', ')})`);
assert((await migrate(db)).length === 0, 'running them again applies nothing');
const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r) => r.tablename);
assert(['records', 'app_settings', 'fetch_cache', 'schema_migrations'].every((t) => tables.includes(t)), `tables exist: ${tables.sort().join(', ')}`);

console.log('\n== records ==');
const things = new PgCollection(db, 'alice', 'things');
await things.put({ id: 'b', n: 1 });
await things.put({ id: 'a', n: 2 });
await things.put({ id: 'b', n: 3 });
const all = await things.all();
assert(all.map((r) => `${r.id}${r.n}`).join() === 'b3,a2', 'insertion order is kept and a replace stays in place');
assert((await things.get('a')).n === 2 && (await things.get('zzz')) === null, 'get finds one record, or null');
const bumped = await things.update('a', (r) => ({ ...r, n: r.n + 10 }));
assert(bumped.n === 12 && (await things.get('a')).n === 12, 'update changes a record in a transaction');
assert((await things.update('missing', (r) => r)) === null, 'updating a missing record returns null');
assert((await new PgCollection(db, 'bob', 'things').all()).length === 0, 'another owner sees none of them');
assert((await things.deleteMany(['a', 'b', 'nope'])) === 2 && (await things.all()).length === 0, 'deleteMany removes what exists');

const settings = new AppSettings(db);
assert((await settings.get('limits', { x: 1 })).x === 1, 'a missing setting gives the fallback');
await settings.set('limits', { maxFeeds: 5 });
assert((await settings.get('limits')).maxFeeds === 5, 'install settings are saved');

console.log('\n== storage keys ==');
for (const bad of ['', '/abs', '../up', 'a/../b', 'a//b', 'a\\b', 'x\0y', './a']) {
  assert(throwsSync(() => checkKey(bad)), `refuses key ${JSON.stringify(bad)}`);
}
assert(!throwsSync(() => checkKey('users/alice/out/1-Book.epub')), 'accepts a normal key');
for (const bad of ['', '../x', 'a/b', 'A'.repeat(65), '-lead']) assert(throwsSync(() => checkOwner(bad)), `refuses owner ${JSON.stringify(bad)}`);

console.log('\n== database backend, owners kept apart ==');
const blobs = new DiskBlobs(path.join(sandbox, 'files'));
const hosted = databaseBackend({ db, blobs });
const alice = hosted.forOwner('alice');
const bob = hosted.forOwner('bob');
assert(hosted.forOwner('alice') === alice, 'one bundle per owner');

const id = '0b6cf5a8-1111-4c3e-9a51-000000000001';
const stored = await alice.outbox.saveEpub(id, 'Book.epub', Buffer.from('PK epub bytes'));
await alice.outbox.add({ id, filename: 'Book.epub', title: 'Book', ...stored, size: 13 });
assert(stored.file === `${id}-Book.epub`, 'an EPUB is stored under a key');
assert(await fs.access(path.join(sandbox, 'files', 'users', 'alice', 'out', stored.file)).then(() => true, () => false), "and the file sits under the owner's prefix");
assert((await alice.outbox.list()).length === 1 && (await bob.outbox.list()).length === 0, "bob does not see alice's queue");
assert((await bob.outbox.get(id)) === null, "bob cannot open alice's item by id");
assert((await alice.outbox.readEpub(await alice.outbox.get(id))).toString() === 'PK epub bytes', 'the EPUB reads back');
const pages = await alice.outbox.savePages(id, [{ data: Buffer.from('p1') }, { data: Buffer.from('p2') }]);
await alice.outbox.update(id, { ...pages, pageCount: 2 });
assert(String(await alice.outbox.readPage(await alice.outbox.get(id), 2)) === 'p2', 'page images read back');
assert((await alice.outbox.markDelivered(id, 'wifi')).deliveredAt, 'delivery is recorded');
assert((await alice.outbox.storageUsed()) === 13, 'storage used adds up the files');
assert(await alice.outbox.remove(id), 'removing an item works');
assert(!(await fs.access(path.join(sandbox, 'files', 'users', 'alice', 'out', stored.file)).then(() => true, () => false)), 'and deletes its file');
assert((await alice.outbox.readPage({ id, pages: pages.pages }, 1)) === null, 'and its page images');

const added = await alice.feeds.add({ url: 'example.com/feed/', title: 'Example' });
const again = await alice.feeds.add({ url: 'https://example.com/feed' });
assert(added.added && !again.added && again.feed.id === added.feed.id, 'the same feed is not added twice');
assert((await bob.feeds.list()).length === 0, "bob does not see alice's feeds");
const renamed = await alice.feeds.update(added.feed.id, { title: 'Renamed', limit: 999 });
assert(renamed.title === 'Renamed' && renamed.limit === 50, 'feed updates are saved and clamped');
assert(Boolean(await rejects(alice.feeds.update('nope', { title: 'x' }))), 'updating a missing feed is an error');

const draft = await alice.drafts.save({ title: 'Note', markdown: 'Hello world' });
await alice.drafts.save({ id: draft.id, title: 'Note 2', markdown: 'Hello again world' });
const listed = await alice.drafts.list();
assert(listed.length === 1 && listed[0].title === 'Note 2' && listed[0].words === 3, 'drafts save and list');
assert((await bob.drafts.list()).length === 0 && (await bob.drafts.get(draft.id)) === null, "bob cannot read alice's draft");
assert(Boolean(await rejects(alice.drafts.get('../../etc'))), 'a bad draft id is refused');

await alice.removals.add({ folder: '/A-pub Books', filename: 'Old.epub' });
assert((await alice.removals.add({ folder: '/A-pub Books', filename: 'Old.epub' })) === null, 'a removal is queued once');
assert((await alice.removals.list()).length === 1 && (await bob.removals.list()).length === 0, 'removals are per owner');
assert(await alice.removals.remove('/A-pub Books', 'Old.epub'), 'a removal can be dropped');

console.log('\n== documents get their own reader folder ==');
{
  const { moveDocumentsToTheirFolder, BOOKS_FOLDER, DOCS_FOLDER } = await import('../lib/folders.mjs');
  const lib = hosted.forOwner('movers');
  // Each with a file, as real entries have (a listing drops entries whose file is gone).
  const put = async (entry) =>
    lib.outbox.add({ mode: 'text', builtAt: new Date().toISOString(), ...entry, ...(await lib.outbox.saveEpub(entry.id, entry.filename, Buffer.from('epub'))) });
  await put({ id: 'doc-unsent', filename: 'Unsent.epub', folder: null, source: { kind: 'pdf' } });
  await put({ id: 'doc-sent', filename: 'Sent.epub', folder: null, deliveredAt: '2026-11-01T00:00:00Z', deliveredTo: 'reader', source: { kind: 'url' } });
  await put({ id: 'doc-off', filename: 'Off.epub', folder: null, deliveredAt: '2026-11-01T00:00:00Z', onReader: false, source: { kind: 'html' } });
  await put({ id: 'book', filename: 'Book.epub', folder: null, deliveredAt: '2026-11-01T00:00:00Z', source: { kind: 'book' } });
  await put({ id: 'note', filename: 'Note.epub', folder: '/A-pub Notes', source: { kind: 'draft' } });
  const moved = await moveDocumentsToTheirFolder(lib.outbox, lib.removals);
  const get = (id) => lib.outbox.get(id);
  assert(moved === 2, `two documents move to the new folder (${moved})`);
  assert((await get('doc-unsent')).folder === DOCS_FOLDER, 'an unsent document will go to A-pub Documents');
  const sent = await get('doc-sent');
  assert(sent.folder === DOCS_FOLDER && !sent.deliveredAt, 'a sent document goes over again, into A-pub Documents');
  const queued = await lib.removals.list();
  assert(queued.length === 1 && queued[0].folder === BOOKS_FOLDER && queued[0].filename === 'Sent.epub', 'and its old copy in A-pub Books is queued to come off');
  assert((await get('doc-off')).folder === BOOKS_FOLDER, 'one switched off stays recorded in A-pub Books, where its removal looks');
  const book = await get('book');
  assert(book.folder === BOOKS_FOLDER && book.deliveredAt, 'a downloaded book stays in A-pub Books, untouched');
  assert((await get('note')).folder === '/A-pub Notes', 'notes keep their folder');
  assert((await moveDocumentsToTheirFolder(lib.outbox, lib.removals)) === 0 && (await lib.removals.list()).length === 1, 'running it again changes nothing');
}

await alice.settings.set({ includeImages: false });
assert((await alice.settings.get()).includeImages === false && Object.keys(await bob.settings.get()).length === 0, 'settings are per owner');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const asset = await alice.assets.save(png, 'image/png');
assert((await alice.assets.read(asset.name))?.length > 0, 'an editor image is saved and read');
assert((await bob.assets.read(asset.name)) === null, "bob cannot read alice's image");

console.log('\n== limits ==');
const limits = resolveLimits({ items: 2, feeds: '1', storageMB: -5, junk: 9 });
assert(limits.items === 2 && limits.feeds === 1 && limits.storageMB === DEFAULT_LIMITS.storageMB && !('junk' in limits), 'admin limits apply; invalid ones fall back to defaults');
assert(!(await rejects(checkLimits(bob, limits, { items: 2 }))), 'an empty library has room');
const fullFeeds = await rejects(checkLimits(alice, limits, { feeds: 1 }));
assert(fullFeeds instanceof LimitError && fullFeeds.status === 403 && /up to 1 feed\./.test(fullFeeds.message), `the feed limit is named: "${fullFeeds?.message}"`);
for (const n of [1, 2]) {
  const key = `0b6cf5a8-2222-4c3e-9a51-00000000000${n}`;
  await bob.outbox.add({ id: key, filename: `${n}.epub`, title: `${n}`, ...(await bob.outbox.saveEpub(key, `${n}.epub`, Buffer.alloc(10))), size: 600 * 1024 });
}
const fullItems = await rejects(checkLimits(bob, limits, { items: 1 }));
assert(fullItems && /hold 2 items/.test(fullItems.message), 'the item limit is named');
const fullStorage = await rejects(checkLimits(bob, resolveLimits({ storageMB: 1 }), { items: 1 }));
assert(fullStorage && /full 1 MB/.test(fullStorage.message), 'the storage limit is named');
await bob.usage.addBuilds(3, '2026-01-01');
await bob.usage.addBuilds(2);
await bob.usage.addBuilds(1);
assert((await bob.usage.builds()) === 3 && (await bob.usage.builds('2026-01-01')) === 0, "today's builds are counted and old days dropped");
const fullBuilds = await rejects(checkLimits(bob, resolveLimits({ buildsPerDay: 4 }), { builds: 2 }));
assert(fullBuilds && /daily limit is 4/.test(fullBuilds.message), 'the daily build limit is named');
assert((await alice.usage.builds()) === 0, 'build counts are per library');

console.log('\n== shared fetching ==');
for (const [label, cache] of [['database', new PgFetchCache(db)], ['memory', new MemoryFetchCache()]]) {
  const shared = sharedFetcher(cache);
  let loads = 0;
  const load = async () => {
    loads++;
    await new Promise((r) => setTimeout(r, 20));
    return { title: 'Feed', items: [loads] };
  };
  const [a, b] = await Promise.all([shared('feed:x', 60000, load), shared('feed:x', 60000, load)]);
  const c = await shared('feed:x', 60000, load);
  assert(loads === 1 && a.items[0] === 1 && b.items[0] === 1 && c.items[0] === 1, `${label}: a feed fetched once serves everyone`);
  await new Promise((r) => setTimeout(r, 15));
  await shared('feed:x', 10, load);
  assert(loads === 2, `${label}: an expired copy is fetched again`);
  const failing = await rejects(shared('feed:bad', 60000, async () => { throw new Error('down'); }));
  assert(failing && (await cache.get('feed:bad', 60000)) === null, `${label}: a failure is not kept`);
}
// A feed read back from the database has its dates as text; an edition still
// builds once withDates restores them (Render's feeds failed without this).
{
  const shared = sharedFetcher(new PgFetchCache(db));
  const feed = () => ({ title: 'Dated', link: 'https://example.com/', items: [{ title: 'One', link: 'https://example.com/1', date: new Date('2026-11-09T12:00:00Z'), html: '<p>x</p>' }] });
  await shared('feed:dated', 60000, async () => feed());
  const cached = await shared('feed:dated', 60000, async () => feed());
  assert(typeof cached.items[0].date === 'string', 'a cached feed comes back with its dates as text');
  const revived = withDates(cached);
  assert(revived.items[0].date instanceof Date && revived.items[0].date.getUTCDate() === 9, 'withDates makes them dates again');
  assert(/Nov 9, 2026/.test(composeFeedHtml({ title: 'Dated', link: 'https://example.com/' }, revived.items)), 'and an edition builds from the cached feed');
  assert(withDates({ items: [{ date: 'not a date' }] }).items[0].date === null, 'an unreadable date is dropped, not passed on');
}

await new PgFetchCache(db).prune(0);
assert((await db.query('SELECT count(*)::int AS n FROM fetch_cache')).rows[0].n === 0, 'old cache entries are pruned');

const articleStore = new Map();
const articleCache = { get: async (k) => articleStore.get(k) ?? null, set: async (k, v) => articleStore.set(k, v) };
articleStore.set('https://news.example/1', { hydrated: true, html: '<p>Full text from the cache</p>', author: 'Cached Author' });
articleStore.set('https://news.example/2', { hydrated: false });
const hydrated = await hydrateItems(
  [
    { title: 'One', link: 'https://news.example/1', html: '<p>teaser</p>', author: '' },
    { title: 'Two', link: 'https://news.example/2', html: '<p>teaser two</p>', author: '' },
  ],
  { limit: 5, articleCache, extractArticle: () => { throw new Error('should not fetch'); } }
);
assert(hydrated[0].hydrated && /from the cache/.test(hydrated[0].html) && hydrated[0].author === 'Cached Author', 'an article in the cache is not fetched again');
assert(!hydrated[1].hydrated && hydrated[1].html === '<p>teaser two</p>', 'a cached "no better than the teaser" keeps the teaser');

await alice.clearFiles();
assert(!(await fs.access(path.join(sandbox, 'files', 'users', 'alice')).then(() => true, () => false)), "clearing files removes the owner's folder");

console.log('\n== files backend ==');
const files = fileBackend({ outDir: path.join(sandbox, 'local-out'), stateDir: path.join(sandbox, 'local-state'), configPath: path.join(sandbox, 'local-config.json') });
const me = files.forOwner(LOCAL_OWNER);
await me.feeds.add({ url: 'https://example.org/rss' });
await me.settings.set({ host: 'x' });
assert(await fs.access(path.join(sandbox, 'local-state', 'feeds.json')).then(() => true, () => false), 'the local owner keeps feeds.json where it always was');
assert(JSON.parse(await fs.readFile(path.join(sandbox, 'local-config.json'), 'utf8')).host === 'x', 'and config.json');
const other = files.forOwner('carol');
assert((await other.feeds.list()).length === 0, 'another owner starts empty');
await other.feeds.add({ url: 'https://example.net/rss' });
assert(await fs.access(path.join(sandbox, 'local-state', 'users', 'carol', 'feeds.json')).then(() => true, () => false), 'and gets a folder of its own');

console.log('\n== S3-compatible storage ==');
const bucket = new Map();
const seen = [];
const s3 = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url, 'http://x');
  seen.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '', sha: req.headers['x-amz-content-sha256'] });
  const [, bucketName, ...rest] = url.pathname.split('/');
  const key = rest.map(decodeURIComponent).join('/');
  if (bucketName !== 'books') return res.writeHead(404).end();
  if (req.method === 'PUT') {
    bucket.set(key, Buffer.concat(chunks));
    return res.writeHead(200).end();
  }
  if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
    const prefix = url.searchParams.get('prefix') || '';
    const keys = [...bucket.keys()].filter((k) => k.startsWith(prefix)).sort();
    // Two per page, so continuation is exercised.
    const start = Number(url.searchParams.get('continuation-token') || 0);
    const page = keys.slice(start, start + 2);
    const more = start + 2 < keys.length;
    const body = `<?xml version="1.0"?><ListBucketResult>${page
      .map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${bucket.get(k).length}</Size></Contents>`)
      .join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}</ListBucketResult>`;
    return res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!bucket.has(key)) return res.writeHead(404).end();
    return res.writeHead(200).end(req.method === 'HEAD' ? undefined : bucket.get(key));
  }
  if (req.method === 'DELETE') {
    bucket.delete(key);
    return res.writeHead(204).end();
  }
  res.writeHead(405).end();
});
await new Promise((r) => s3.listen(0, '127.0.0.1', r));
const remote = new S3Blobs({
  endpoint: `http://127.0.0.1:${s3.address().port}`,
  bucket: 'books',
  accessKeyId: 'test-key-id',
  secretAccessKey: 'test-secret',
  region: 'us-west-004',
  prefix: 'apub',
});
await remote.put('users/a/out/1-My Book.epub', Buffer.from('epub!'));
assert(bucket.has('apub/users/a/out/1-My Book.epub'), 'files go under the install prefix, path-style');
assert(/^AWS4-HMAC-SHA256 Credential=test-key-id\/\d{8}\/us-west-004\/s3\/aws4_request/.test(seen[0].auth), 'requests are signed with AWS Signature V4');
assert(String(await remote.get('users/a/out/1-My Book.epub')) === 'epub!', 'a file reads back');
assert((await remote.get('users/a/out/missing.epub')) === null, 'a missing file reads as null');
assert((await remote.exists('users/a/out/1-My Book.epub')) && !(await remote.exists('nope')), 'exists checks with HEAD');
for (const n of [2, 3, 4]) await remote.put(`users/a/out/${n}.epub`, Buffer.alloc(n));
await remote.put('users/b/out/9.epub', Buffer.alloc(9));
assert((await remote.size('users/a')) === 5 + 2 + 3 + 4, 'size adds up a prefix across pages of results');
const scoped = new ScopedBlobs(remote, 'users/a');
assert((await scoped.size()) === 14, 'an owner-scoped store sizes its own files');
await remote.deletePrefix('users/a');
assert([...bucket.keys()].join() === 'apub/users/b/out/9.epub', "deleting a prefix leaves other owners' files");
const noBucket = new S3Blobs({ endpoint: `http://127.0.0.1:${s3.address().port}`, bucket: 'other', accessKeyId: 'k', secretAccessKey: 's' });
const failure = await rejects(noBucket.put('x', Buffer.from('y')));
assert(failure && /File storage could not save a file \(HTTP 404/.test(failure.message), `storage errors are readable: "${failure?.message}"`);
s3.close();
await db.close();

// ------------------------------------------------------------ server on PostgreSQL

if (process.env.TEST_DATABASE_URL) {
  console.log('\n== server on PostgreSQL ==');
  const PORT = 4393;
  const PASSWORD = 'correct horse battery staple';
  const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOSTED: '1',
      // With a database, hosted means accounts: the first admin signs in.
      APP_PASSWORD: '',
      ADMIN_USERNAME: 'pgadmin',
      ADMIN_PASSWORD: PASSWORD,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      EPUB_DROP_STATE: path.join(sandbox, 'server-state'),
      EPUB_DROP_OUT_DIR: path.join(sandbox, 'server-out'),
      EPUB_DROP_CONFIG: path.join(sandbox, 'server-config.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  app.stdout.on('data', (d) => log.push(String(d)));
  app.stderr.on('data', (d) => log.push(String(d)));
  const base = `http://127.0.0.1:${PORT}`;
  const headers = { 'content-type': 'application/json' };
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const signIn = await fetch(`${base}/api/auth/signin`, { method: 'POST', headers, body: JSON.stringify({ login: 'pgadmin', password: PASSWORD }) });
    assert(signIn.ok, 'the first admin signs in on PostgreSQL');
    headers.cookie = String(signIn.headers.get('set-cookie') || '').split(';')[0];
    const paragraph = 'A sentence long enough for Readability to treat the element as the body of the article, repeated. ';
    const converted = await (
      await fetch(`${base}/api/convert`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ items: [{ name: 'db.html', text: `<html><head><title>Stored in Postgres</title></head><body><article><h1>Stored in Postgres</h1><p>${paragraph.repeat(6)}</p></article></body></html>` }] }),
      })
    ).json();
    const item = converted.results?.[0];
    assert(item?.ok, `converting works on the database backend${item?.error ? `: ${item.error}` : ''}`);
    const listedItems = (await (await fetch(`${base}/api/outbox`, { headers })).json()).items;
    assert(listedItems.some((i) => i.id === item?.id && i.file && !i.diskPath), 'the item is listed from the database, with a storage key');
    const download = await fetch(`${base}/out/${item?.id}`, { headers });
    assert(download.ok && (await download.arrayBuffer()).byteLength === item?.size, 'its EPUB downloads from file storage');
    const page = await (await fetch(`${base}/read/${item?.id}`, { headers })).text();
    assert(/Stored in Postgres/.test(page), 'its reading page renders');
    const saved = await (await fetch(`${base}/api/config`, { method: 'POST', headers, body: JSON.stringify({ includeImages: false }) })).json();
    assert(saved.includeImages === false, 'settings save to the database');
    const direct = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await direct.connect();
    await direct.query(`INSERT INTO app_settings (key, value) VALUES ('limits', '{"feeds": 1}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const addFeed = (url) => fetch(`${base}/api/feeds/add`, { method: 'POST', headers, body: JSON.stringify({ url }) });
    const firstFeed = await addFeed('https://feeds.example.com/one.xml');
    const secondFeed = await addFeed('https://feeds.example.com/two.xml');
    const secondBody = await secondFeed.json();
    assert(firstFeed.ok && secondFeed.status === 403 && /up to 1 feed\./.test(secondBody.error || ''), `the admin's feed limit is enforced: "${secondBody.error}"`);
    await direct.query("DELETE FROM app_settings WHERE key = 'limits'");
    await direct.end();

    const wiped = await (await fetch(`${base}/api/remove-everything`, { method: 'POST', headers, body: JSON.stringify({ confirm: 'I Agree' }) })).json();
    assert(wiped.ok && wiped.items >= 1, 'remove everything works');
    assert((await (await fetch(`${base}/api/outbox`, { headers })).json()).items.length === 0, 'and leaves the library empty');
  } finally {
    app.kill();
  }
  if (fail) console.log(log.join('').slice(-1500));
} else {
  console.log('\nSKIP  server on PostgreSQL (set TEST_DATABASE_URL to an empty database to run it)');
}

await fs.rm(sandbox, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

function throwsSync(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
