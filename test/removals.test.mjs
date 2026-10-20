// The queue of files to take off the reader.
//
// The store is the interesting part: a removal has to survive the app's record
// of the file being deleted (that is the whole point — you forget something
// while the reader is elsewhere), so it is keyed on where the file sits on the
// device rather than on the outbox id that no longer exists.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Removals } from '../lib/removals.mjs';

let pass = 0;
let fail = 0;
const assert = (cond, label) => {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
  }
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apub-removals-'));
const file = path.join(dir, 'removals.json');

console.log('== queueing ==');
const store = new Removals(file);
assert((await store.list()).length === 0, 'a store with no file lists nothing');

const first = await store.add({
  folder: '/A-pub Books',
  filename: 'Framing the News.epub',
  title: 'Framing the News',
});
assert(first?.filename === 'Framing the News.epub', 'queues a removal');
assert(typeof first.requestedAt === 'string', 'records when it was asked for');

await store.add({ folder: '/A-pub Notes', filename: 'A Note.epub', title: 'A Note' });
assert((await store.list()).length === 2, 'queues a second one');

// Forgetting the same thing twice is a double-click, not two removals.
const dupe = await store.add({ folder: '/A-pub Books', filename: 'Framing the News.epub' });
assert(dupe === null, 'the same file twice does not queue twice');
assert((await store.list()).length === 2, 'the list did not grow');

// The same name in a different folder is a different file.
await store.add({ folder: '/A-pub Notes', filename: 'Framing the News.epub' });
assert((await store.list()).length === 3, 'same name in another folder is separate');

let threw = '';
try {
  await store.add({ folder: '/A-pub Books' });
} catch (err) {
  threw = err.message;
}
assert(/folder and a filename/.test(threw), `a removal without a filename is refused: "${threw}"`);

console.log('\n== order ==');
const order = (await store.list()).map((r) => `${r.folder}/${r.filename}`);
assert(
  order[0] === '/A-pub Books/Framing the News.epub',
  `oldest first, so removals happen in the order asked: ${order[0]}`
);

console.log('\n== survives a restart ==');
const reopened = new Removals(file);
assert((await reopened.list()).length === 3, 'a fresh store reads what the last one wrote');

console.log('\n== carrying them out ==');
assert(await reopened.remove('/A-pub Books', 'Framing the News.epub'), 'drops one that was done');
assert((await reopened.list()).length === 2, 'the rest stay queued');
assert(
  (await reopened.remove('/A-pub Books', 'Framing the News.epub')) === false,
  'dropping it again reports nothing to do'
);
assert(
  (await reopened.remove('/A-pub Books', 'never-queued.epub')) === false,
  'a file that was never queued reports nothing to do'
);

console.log('\n== a damaged index ==');
await fs.writeFile(file, 'not json at all');
assert((await new Removals(file).list()).length === 0, 'unreadable index reads as empty');
// And it must still be writable afterwards rather than staying broken.
const recovered = new Removals(file);
await recovered.add({ folder: '/A-pub Feeds', filename: 'The Verge - 2026-09-03.epub' });
assert((await recovered.list()).length === 1, 'writing over a damaged index works');

await fs.rm(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
