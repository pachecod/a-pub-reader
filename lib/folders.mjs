// Where each kind of thing lands on the reader.
//
// All three share an "A-pub" prefix so they sort together at the top of the
// device's file list, and they are separate so each can be tidied without
// touching the others — a feed refresh deletes its own previous edition, and
// nothing it does can reach a book or a note.

/** One-off documents: dropped files, pasted URLs, catalogue books. */
export const BOOKS_FOLDER = '/A-pub Books';

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
  { path: NOTES_FOLDER, label: 'Notes' },
  { path: FEED_FOLDER, label: 'Feed editions' },
];

/** True if `value` is one of the folders this app manages. */
export function isManagedFolder(value) {
  return FOLDERS.some((f) => f.path === value);
}
