// Built EPUBs waiting to go to the reader.
//
// Everything converted lands here first, whatever produced it — a dropped PDF, a
// pasted URL, a draft, or an RSS refresh — and it stays here until it has been
// delivered. That matters because the reader usually isn't connected at the
// moment you build something: you refresh feeds on your normal Wi-Fi, then join
// the reader's hotspot (which has no internet) and push. Holding the queue on
// disk rather than in the page means it survives a reload, a network switch and
// a restart of the app.
//
// Each entry carries its own destination folder and, for feeds, the filename of
// the edition it replaces — so a send that happens hours later still puts the
// file in the right place and cleans up the previous one.

import fs from 'node:fs/promises';
import path from 'node:path';

export class Outbox {
  /**
   * @param {string} dir   Where the EPUB files live (also holds the index).
   * @param {string} [file] Index path; defaults to outbox.json inside `dir`.
   */
  constructor(dir, file) {
    this.dir = dir;
    this.file = file || path.join(dir, 'outbox.json');
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

  /**
   * Entries whose EPUB is still on disk.
   *
   * The index and the files can drift — `out/` is documented as safe to delete —
   * so a listing drops entries whose file has gone rather than offering to send
   * something that no longer exists.
   */
  async list({ includeDelivered = true } = {}) {
    const items = await this.#read();
    const alive = [];
    let dropped = false;

    for (const item of items) {
      try {
        await fs.access(item.diskPath);
        alive.push(item);
      } catch {
        dropped = true;
      }
    }
    if (dropped) await this.#write(alive);

    const visible = includeDelivered ? alive : alive.filter((i) => !i.deliveredAt);
    // Newest first: the thing you just built is the thing you want to see.
    return visible.sort((a, b) => String(b.builtAt).localeCompare(String(a.builtAt)));
  }

  async get(id) {
    const item = (await this.#read()).find((i) => i.id === id);
    if (!item) return null;
    try {
      await fs.access(item.diskPath);
    } catch {
      return null;
    }
    return item;
  }

  async add(entry) {
    const items = await this.#read();
    const record = {
      deliveredAt: null,
      deliveredTo: null,
      replaces: null,
      builtAt: new Date().toISOString(),
      ...entry,
    };
    items.push(record);
    await this.#write(items);
    return record;
  }

  async update(id, patch) {
    const items = await this.#read();
    const index = items.findIndex((i) => i.id === id);
    if (index === -1) return null;
    items[index] = { ...items[index], ...patch, id: items[index].id };
    await this.#write(items);
    return items[index];
  }

  /**
   * Record a successful delivery.
   *
   * The entry is kept rather than dropped: seeing what went over, and being able
   * to send it again after a failed transfer or to a second device, is more
   * useful than an empty list.
   */
  async markDelivered(id, deliveredTo) {
    return this.update(id, { deliveredAt: new Date().toISOString(), deliveredTo });
  }

  /** Forget an entry and delete its files. */
  async remove(id) {
    const items = await this.#read();
    const item = items.find((i) => i.id === id);
    if (!item) return false;

    await this.#write(items.filter((i) => i.id !== id));
    await fs.rm(item.diskPath, { force: true }).catch(() => {});
    if (item.pageDir) await fs.rm(item.pageDir, { recursive: true, force: true }).catch(() => {});
    return true;
  }
}
