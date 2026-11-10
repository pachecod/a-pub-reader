// Where each kind of thing lands on the reader.
//
// They all share an "A-pub" prefix so they sort together at the top of the
// device's file list, and they are separate so each can be tidied without
// touching the others — a feed refresh deletes its own previous edition, and
// nothing it does can reach a book or a note.

/** Books downloaded from Find books (and, before 2.0, everything one-off). */
export const BOOKS_FOLDER = '/A-pub Books';

/** What you convert yourself: dropped PDFs and web pages, pasted links. */
export const DOCS_FOLDER = '/A-pub Documents';

/** RSS editions, replaced on every refresh. */
export const FEED_FOLDER = '/A-pub Feeds';

/** Things written in the app's own editor. */
export const NOTES_FOLDER = '/A-pub Notes';

/**
 * Every folder this app writes to, in the order they are shown.
 *
 * The names are fixed rather than configurable. Each one carries a meaning the
 * app relies on — a feed refresh deletes the previous edition in its folder,
 * and the delete controls are scoped to one of these — so a renamed or
 * hand-typed folder would either strand content where nothing looks for it or
 * point a bulk delete at a folder the app never filled.
 */
export const FOLDERS = [
  { path: BOOKS_FOLDER, label: 'Books' },
  { path: DOCS_FOLDER, label: 'Documents' },
  { path: NOTES_FOLDER, label: 'Notes' },
  { path: FEED_FOLDER, label: 'Feed editions' },
];

/**
 * Documents converted before they had their own folder have none recorded and
 * went to A-pub Books. Give each its folder, once per library: ones not yet on
 * the reader simply go to A-pub Documents when synced; ones already there are
 * marked to go over again into A-pub Documents, and their copy in A-pub Books
 * is queued to come off, so the next sync moves them. One switched off (and
 * so already queued to come off A-pub Books) stays recorded where it is.
 * Books downloaded from Find books are pinned to A-pub Books.
 *
 * @param {{list: Function, update: Function}} outbox
 * @param {{add: Function}} removals
 * @returns {Promise<number>} How many documents were given the new folder.
 */
export async function moveDocumentsToTheirFolder(outbox, removals) {
  let moved = 0;
  for (const entry of await outbox.list()) {
    if (entry.folder) continue;
    const kind = entry.source?.kind;
    if (kind === 'feed' || kind === 'draft') continue;
    if (kind === 'book') {
      await outbox.update(entry.id, { folder: BOOKS_FOLDER });
      continue;
    }
    if (!entry.deliveredAt) {
      await outbox.update(entry.id, { folder: DOCS_FOLDER });
    } else if (entry.onReader === false) {
      await outbox.update(entry.id, { folder: BOOKS_FOLDER });
      continue;
    } else {
      await removals.add({ folder: BOOKS_FOLDER, filename: entry.filename, title: entry.title || entry.filename });
      await outbox.update(entry.id, { folder: DOCS_FOLDER, deliveredAt: null, deliveredTo: null });
    }
    moved++;
  }
  return moved;
}

/** True if `value` is one of the folders this app manages. */
export function isManagedFolder(value) {
  return FOLDERS.some((f) => f.path === value);
}
