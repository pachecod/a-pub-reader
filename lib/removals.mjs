// Files the app has been told to take off the reader.
//
// Forgetting something on the Library tab drops the app's record of it and the
// local EPUB, but the copy on the reader is a separate thing in a separate
// place — and the reader usually isn't connected at the moment you tidy up. So a
// removal is recorded here and carried out on the next sync, the same way a
// build waits in the outbox until there is a device to send it to.
//
// The alternative — deleting only when connected — meant the Library tab and the
// device quietly disagreed about what was on the reader, which is the problem
// this store exists to fix.

import { JsonListCollection } from './store/collections.mjs';

/** A removal is identified by where the file is on the reader. */
export const removalId = (r) => `${r.folder}\n${r.filename}`;

export class Removals {
  /**
   * @param {string | object} source Index path (normally removals.json beside
   *   the queue), or a collection whose records are identified by `removalId`.
   */
  constructor(source) {
    this.records = typeof source === 'string' ? new JsonListCollection(source, 'items', removalId) : source;
  }

  /** Oldest first: removals are carried out in the order they were asked for. */
  async list() {
    return this.records.all();
  }

  /**
   * Queue one file for removal.
   *
   * Keyed on folder + filename rather than the outbox id, because by the time
   * this runs the queue entry is gone and the file on the device is all that is
   * left to identify. Asking twice for the same file is not an error and does not
   * queue it twice.
   *
   * @param {{folder: string, filename: string, title?: string}} entry
   */
  async add({ folder, filename, title = '' }) {
    if (!folder || !filename) throw new Error('A removal needs a folder and a filename.');
    if (await this.records.get(removalId({ folder, filename }))) return null;
    const record = { folder, filename, title, requestedAt: new Date().toISOString() };
    await this.records.put(record);
    return record;
  }

  /** Drop one queued removal, whether it was carried out or cancelled. */
  async remove(folder, filename) {
    return this.records.delete(removalId({ folder, filename }));
  }
}
