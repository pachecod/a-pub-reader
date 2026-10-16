// Offline transfer: copying to the reader's SD card as a mounted volume.
//
// EPUB_DROP_VOLUMES_ROOT points the module at a fixture directory, so the whole
// path is exercised without a real card — including the refusals, which are the
// part that matters: this code writes to and deletes from removable media.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

// Must be set before the module is imported — it reads the root at load time.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epub-drop-vols-'));
process.env.EPUB_DROP_VOLUMES_ROOT = root;

const {
  listVolumes,
  resolveVolume,
  copyToVolume,
  listVolumeFiles,
  deleteFromVolume,
  targetDir,
} = await import('../lib/volume.mjs');

const CARD = path.join(root, 'XTEINK SD');
const OTHER = path.join(root, 'Backup Drive');
await fs.mkdir(path.join(CARD, '.crosspoint'), { recursive: true });
await fs.mkdir(path.join(CARD, 'Pushed Books'), { recursive: true });
await fs.writeFile(path.join(CARD, 'Orlando.epub'), 'existing book at the root');
await fs.mkdir(path.join(OTHER, 'Photos'), { recursive: true });
// A dotfile mount point should be ignored entirely.
await fs.mkdir(path.join(root, '.hidden'), { recursive: true });

console.log('== detection ==');
const volumes = await listVolumes();
const names = volumes.map((v) => v.name);
assert(names.includes('XTEINK SD') && names.includes('Backup Drive'), `both drives listed: ${names.join(', ')}`);
assert(!names.includes('.hidden'), 'dotfile mount points are ignored');

const card = volumes.find((v) => v.name === 'XTEINK SD');
const other = volumes.find((v) => v.name === 'Backup Drive');
assert(card.likely === true, `a drive with firmware folders is flagged likely: markers ${card.markers.join(', ')}`);
assert(other.likely === false, 'an unrelated drive is not flagged likely');
assert(names[0] === 'XTEINK SD', 'likely drives sort first so the picker defaults correctly');
assert(card.writable === true, 'writability is reported');
assert(typeof card.freeBytes === 'number' || card.freeBytes === null, 'free space is reported when available');

console.log('\n== path resolution ==');
assert((await resolveVolume(card.path))?.name === 'XTEINK SD', 'a mounted path resolves');
assert((await resolveVolume(path.join(root, 'Nope'))) === null, 'an unmounted path is refused');
assert((await resolveVolume(`${card.path}/../../etc`)) === null, 'a traversal path is refused');
assert((await resolveVolume('/')) === null, 'the filesystem root is refused');
assert((await resolveVolume('')) === null, 'an empty path is refused');

console.log('\n== target folder ==');
assert(
  targetDir(card, '/A-pub Books') === path.join(card.path, 'A-pub Books'),
  'the configured folder maps to a folder on the card'
);
assert(
  targetDir(card, '/../../etc') === path.join(card.path, 'etc'),
  'traversal segments in the folder setting are stripped rather than escaping'
);
assert(targetDir(card, '/') === card.path, 'a root folder setting means the card root');

console.log('\n== copy ==');
const written = await copyToVolume(card, '/A-pub Books', 'Week 3 Notes.epub', Buffer.from('PK pretend epub'));
assert(written === path.join(card.path, 'A-pub Books', 'Week 3 Notes.epub'), 'file lands in the managed folder');
assert((await fs.readFile(written, 'utf8')).includes('pretend epub'), 'contents are written intact');

const listed = await listVolumeFiles(card, '/A-pub Books');
assert(listed.length === 1 && listed[0].name === 'Week 3 Notes.epub' && listed[0].isEpub, 'listing sees the copy');
assert(listed[0].size > 0, 'listing reports a size');

// No half-written books left behind if the card is pulled mid-copy.
const leftovers = (await fs.readdir(path.join(card.path, 'A-pub Books'))).filter((n) => n.endsWith('.part'));
assert(leftovers.length === 0, 'the temp file is renamed away, not left behind');

// Overwriting an existing book is how re-sending a fix has to work.
await copyToVolume(card, '/A-pub Books', 'Week 3 Notes.epub', Buffer.from('second version'));
assert((await fs.readFile(written, 'utf8')) === 'second version', 're-copying replaces the earlier file');

let badName = false;
try {
  await copyToVolume(card, '/A-pub Books', '../escaped.epub', Buffer.from('x'));
} catch {
  badName = true;
}
assert(badName, 'a filename containing .. is rejected outright');
const escapedOutside = await fs.access(path.join(card.path, 'escaped.epub')).then(() => true).catch(() => false);
const escapedInside = await fs
  .access(path.join(card.path, 'A-pub Books', 'escaped.epub'))
  .then(() => true)
  .catch(() => false);
assert(!escapedOutside && !escapedInside, 'and nothing is written under a renamed filename either');

console.log('\n== delete scope ==');
const refusals = await deleteFromVolume(card, '/A-pub Books', [
  '../Pushed Books',
  '../Orlando.epub',
  '../../etc/passwd',
  '/etc/hosts',
  'Pushed Books',
  'not-there.epub',
]);
assert(refusals.every((r) => !r.ok), 'every out-of-folder name is refused');
assert(refusals.every((r) => /refusing to delete/i.test(r.error)), 'refusals explain themselves');
assert(
  await fs.access(path.join(card.path, 'Pushed Books')).then(() => true).catch(() => false),
  "the firmware's own folder survives"
);
assert(
  await fs.access(path.join(card.path, 'Orlando.epub')).then(() => true).catch(() => false),
  'a book outside the managed folder survives'
);

const removed = await deleteFromVolume(card, '/A-pub Books', ['Week 3 Notes.epub']);
assert(removed[0].ok === true, 'a file inside the managed folder is deleted');
assert((await listVolumeFiles(card, '/A-pub Books')).length === 0, 'it is gone from the listing');

console.log('\n== read-only media ==');
const locked = { ...card, writable: false };
let readOnlyRefused = false;
try {
  await copyToVolume(locked, '/A-pub Books', 'x.epub', Buffer.from('x'));
} catch (err) {
  readOnlyRefused = /read-only/i.test(err.message);
}
assert(readOnlyRefused, 'copying to a read-only drive fails with a clear reason');

console.log('\n== missing folder ==');
assert((await listVolumeFiles(card, '/Never-Created')).length === 0, 'listing a folder that does not exist is empty, not an error');

await fs.rm(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
