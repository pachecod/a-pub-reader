// The pending-send queue.
//
// This is the piece that makes "build now, connect later" work, so the cases
// that matter are the awkward ones: the app restarting, the files being deleted
// underneath the index, and something being sent twice.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Outbox } from '../lib/outbox.mjs';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epub-drop-outbox-'));
const outbox = new Outbox(dir);

const makeEntry = async (id, filename, extra = {}) => {
  const diskPath = path.join(dir, `${id}-${filename}`);
  await fs.writeFile(diskPath, 'PK fake epub');
  return outbox.add({
    id,
    filename,
    title: filename.replace(/\.epub$/, ''),
    diskPath,
    size: 12,
    folder: null,
    mode: 'text',
    chapters: 1,
    source: { kind: 'html', label: filename },
    ...extra,
  });
};

console.log('== queueing ==');
assert((await outbox.list()).length === 0, 'a new queue is empty');

const a = await makeEntry('11111111-1111-1111-1111-111111111111', 'First.epub');
assert(a.deliveredAt === null, 'a new entry is not delivered');
assert(a.builtAt, 'build time recorded');
assert((await outbox.list()).length === 1, 'entry is listed');
assert((await outbox.get(a.id))?.filename === 'First.epub', 'entry can be fetched by id');
assert((await outbox.get('nope')) === null, 'an unknown id returns null');

// Small delay so the sort by build time is deterministic.
await new Promise((r) => setTimeout(r, 5));
const b = await makeEntry('22222222-2222-2222-2222-222222222222', 'Second.epub', {
  folder: '/A-pub Feeds',
  replaces: 'Second - 2020-01-01.epub',
  source: { kind: 'feed', label: 'A Feed', feedId: 'feed-1', items: 5 },
});
const listed = await outbox.list();
assert(listed[0].id === b.id, 'newest first, so what you just built is on top');
assert(listed[0].folder === '/A-pub Feeds', "a feed entry carries its own destination folder");
assert(listed[0].replaces === 'Second - 2020-01-01.epub', 'the edition it supersedes is remembered');
assert(listed[0].source.feedId === 'feed-1', 'the originating feed is remembered');

console.log('\n== survives a restart ==');
// A fresh instance over the same directory is what an app restart looks like.
const reopened = new Outbox(dir);
const afterRestart = await reopened.list();
assert(afterRestart.length === 2, `both entries survive a restart (${afterRestart.length})`);
assert(
  afterRestart.find((i) => i.id === b.id)?.replaces === 'Second - 2020-01-01.epub',
  'the replaces bookkeeping survives too, so a later send still tidies up'
);

console.log('\n== delivery ==');
const delivered = await outbox.markDelivered(a.id, 'crosspoint.local');
assert(delivered.deliveredAt && delivered.deliveredTo === 'crosspoint.local', 'delivery is recorded with a target');

const pending = await outbox.list({ includeDelivered: false });
assert(pending.length === 1 && pending[0].id === b.id, 'the pending view excludes what has been sent');
assert((await outbox.list()).length === 2, 'the default view keeps delivered entries visible');

// Re-sending is allowed: a transfer can fail halfway, or you may have a second device.
const again = await outbox.get(a.id);
assert(again !== null, 'a delivered entry is still retrievable, so it can be sent again');

console.log('\n== files deleted underneath the index ==');
const orphan = await makeEntry('33333333-3333-3333-3333-333333333333', 'Gone.epub');
await fs.rm(orphan.diskPath);
const afterOrphan = await outbox.list();
assert(!afterOrphan.some((i) => i.id === orphan.id), 'an entry whose file vanished is dropped from the listing');
assert((await outbox.get(orphan.id)) === null, 'and cannot be fetched');
// out/ is documented as safe to delete, so the index must self-heal rather than
// offering to send files that are not there.
const index = JSON.parse(await fs.readFile(path.join(dir, 'outbox.json'), 'utf8'));
assert(!index.items.some((i) => i.id === orphan.id), 'the index is rewritten without it');

console.log('\n== removal ==');
const pageDir = path.join(dir, 'pages-test');
await fs.mkdir(pageDir, { recursive: true });
await fs.writeFile(path.join(pageDir, '0001.jpg'), 'img');
const withPages = await makeEntry('44444444-4444-4444-4444-444444444444', 'Pages.epub', {
  mode: 'images',
  pageCount: 1,
  pageDir,
});

assert((await outbox.remove(withPages.id)) === true, 'remove reports success');
assert((await outbox.get(withPages.id)) === null, 'the entry is gone');
assert(
  !(await fs.access(withPages.diskPath).then(() => true).catch(() => false)),
  'the EPUB file is deleted too'
);
assert(
  !(await fs.access(pageDir).then(() => true).catch(() => false)),
  'the rendered page images are deleted with it'
);
assert((await outbox.remove(withPages.id)) === false, 'removing twice reports false');

console.log('\n== clearing what has been sent ==');
const beforeClear = await outbox.list();
const deliveredCount = beforeClear.filter((i) => i.deliveredAt).length;
const removed = await outbox.clearDelivered();
assert(removed === deliveredCount, `clear removed exactly the delivered entries (${removed})`);

const remaining = await outbox.list();
assert(remaining.every((i) => !i.deliveredAt), 'only unsent entries remain');
assert(remaining.some((i) => i.id === b.id), 'the unsent entry is untouched — clearing must not lose queued work');
assert(
  await fs.access(b.diskPath).then(() => true).catch(() => false),
  'and its file is still on disk'
);

console.log('\n== updates ==');
const patched = await outbox.update(b.id, { folder: '/Elsewhere' });
assert(patched.folder === '/Elsewhere', 'entries can be patched');
assert(patched.id === b.id, 'the id is never overwritten');
assert((await outbox.update('missing-id', { folder: '/x' })) === null, 'patching an unknown id returns null');

await fs.rm(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
