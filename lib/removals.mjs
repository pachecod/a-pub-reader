// Files the app has been told to take off the reader.
//
// Forgetting something on the Read tab drops the app's record of it and the
// local EPUB, but the copy on the reader is a separate thing in a separate
// place — and the reader usually isn't connected at the moment you tidy up. So a
// removal is recorded here and carried out on the next sync, the same way a
// build waits in the outbox until there is a device to send it to.
//
// The alternative — deleting only when connected — meant the Read tab and the
// device quietly disagreed about what was on the reader, which is the problem
// this store exists to fix.

import fs from 'node:fs/promises';
import path from 'node:path';

export class Removals {
  /** @param {string} file Index path, normally removals.json beside the queue. */
  constructor(file) {
    this.file = file;
  }

  async #read() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return Array.isArray(raw?.items) ? raw.items : [];
    } catch {
      return [];
    }
  }

  async #write(items) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify({ items }, null, 2)}\n`);
    await fs.rename(temp, this.file);
  }

  /** Oldest first: removals are carried out in the order they were asked for. */
  async list() {
    return this.#read();
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

    const items = await this.#read();
    if (items.some((i) => i.folder === folder && i.filename === filename)) return null;

    const record = { folder, filename, title, requestedAt: new Date().toISOString() };
    items.push(record);
    await this.#write(items);
    return record;
  }

  /** Drop one queued removal, whether it was carried out or cancelled. */
  async remove(folder, filename) {
    const items = await this.#read();
    const left = items.filter((i) => !(i.folder === folder && i.filename === filename));
    if (left.length === items.length) return false;
    await this.#write(left);
    return true;
  }

  /** Cancel every queued removal, leaving those files on the reader. */
  async clear() {
    const items = await this.#read();
    await this.#write([]);
    return items.length;
  }
}
