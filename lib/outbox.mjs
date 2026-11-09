// Built EPUBs waiting to go to the reader.
//
// Everything converted lands here first, whatever produced it — a dropped PDF, a
// pasted URL, a draft, or an RSS refresh — and it stays here until it has been
// delivered. That matters because the reader usually isn't connected at the
// moment you build something: you refresh feeds on your normal Wi-Fi, then join
// the reader's hotspot (which has no internet) and push. Holding the queue in
// storage rather than in the page means it survives a reload, a network switch
// and a restart of the app.
//
// Each entry carries its own destination folder and, for feeds, the filename of
// the edition it replaces — so a send that happens hours later still puts the
// file in the right place and cleans up the previous one.
//
// Entries live in a collection (out/outbox.json on your Mac, the database
// hosted) and their files in blob storage (the out/ folder, or a bucket). An
// entry names its EPUB by `file` (a storage key) and fixed-layout page images
// by `pages` (a key prefix). Entries written before 2.0 name absolute paths
// instead (`diskPath`, `pageDir`); those are still read.

import fs from 'node:fs/promises';
import path from 'node:path';

import { DiskBlobs } from './store/blobs.mjs';
import { JsonListCollection } from './store/collections.mjs';

const pageName = (index) => `${String(index).padStart(4, '0')}.png`;

export class Outbox {
  /**
   * @param {string | {records: object, blobs: object}} source
   *   A folder (EPUBs and outbox.json on disk, as on your Mac), or a
   *   collection and blob store.
   * @param {string} [file] Index path when `source` is a folder; defaults to
   *   outbox.json inside it.
   */
  constructor(source, file) {
    if (typeof source === 'string') {
      this.records = new JsonListCollection(file || path.join(source, 'outbox.json'), 'items');
      this.blobs = new DiskBlobs(source);
    } else {
      this.records = source.records;
      this.blobs = source.blobs;
    }
  }

  /** Where an entry's EPUB is: a storage key, or a pre-2.0 absolute path. */
  #epubRef(item) {
    if (item.file) return { key: item.file };
    return this.#legacy(item.diskPath);
  }

  #pagesRef(item) {
    if (item.pages) return { key: item.pages };
    return item.pageDir ? this.#legacy(item.pageDir) : null;
  }

  /** A pre-2.0 path inside the store's folder becomes a key; outside, a path. */
  #legacy(absolute) {
    if (!absolute) return null;
    const root = this.blobs.root;
    if (root) {
      const relative = path.relative(root, absolute);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return { key: relative.split(path.sep).join('/') };
      }
    }
    return { path: absolute };
  }

  async #exists(item) {
    const ref = this.#epubRef(item);
    if (!ref) return false;
    if (ref.path) return fs.access(ref.path).then(() => true, () => false);
    return this.blobs.exists(ref.key);
  }

  /**
   * Entries, newest first.
   *
   * On disk, the index and the files can drift — `out/` is documented as safe
   * to delete — so a listing drops entries whose file has gone rather than
   * offering to send something that no longer exists. Hosted storage is not
   * checked file by file (that would be a request per item); there the
   * database is the record.
   */
  async list({ includeDelivered = true } = {}) {
    const items = await this.records.all();
    let alive = items;
    if (this.blobs.cheapExists) {
      alive = [];
      const gone = [];
      for (const item of items) {
        if (await this.#exists(item)) alive.push(item);
        else gone.push(item.id);
      }
      if (gone.length) await this.records.deleteMany(gone);
    }
    const visible = includeDelivered ? alive : alive.filter((i) => !i.deliveredAt);
    // Newest first: the thing you just built is the thing you want to see.
    return visible.sort((a, b) => String(b.builtAt).localeCompare(String(a.builtAt)));
  }

  async get(id) {
    if (!id) return null;
    const item = await this.records.get(String(id));
    if (!item) return null;
    if (this.blobs.cheapExists && !(await this.#exists(item))) return null;
    return item;
  }

  /** Store a built EPUB. Returns the fields that point an entry at it. */
  async saveEpub(id, filename, buffer) {
    const key = `${id}-${filename}`;
    await this.blobs.put(key, buffer, 'application/epub+zip');
    return { file: key };
  }

  /** Store fixed-layout page images (PNG). Returns the fields for the entry. */
  async savePages(id, pages) {
    const prefix = `${id}-pages`;
    for (const [i, page] of pages.entries()) await this.blobs.put(`${prefix}/${pageName(i + 1)}`, page.data, 'image/png');
    return { pages: prefix };
  }

  /** The EPUB file of an entry, as bytes. */
  async readEpub(entry) {
    const ref = this.#epubRef(entry);
    const data = ref?.path ? await fs.readFile(ref.path).catch(() => null) : ref ? await this.blobs.get(ref.key) : null;
    if (!data) throw new Error(`The file for "${entry.title || entry.filename}" is missing.`);
    return data;
  }

  /** One page image of a fixed-layout entry (1-based), or null. */
  async readPage(entry, index) {
    const ref = this.#pagesRef(entry);
    if (!ref) return null;
    if (ref.path) return fs.readFile(path.join(ref.path, pageName(index))).catch(() => null);
    return this.blobs.get(`${ref.key}/${pageName(index)}`);
  }

  async add(entry) {
    const record = {
      deliveredAt: null,
      deliveredTo: null,
      replaces: null,
      builtAt: new Date().toISOString(),
      ...entry,
    };
    await this.records.put(record);
    return record;
  }

  async update(id, patch) {
    return this.records.update(String(id), (current) => ({ ...current, ...patch, id: current.id }));
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
    const item = await this.records.get(String(id));
    if (!item) return false;
    await this.records.delete(item.id);

    const epub = this.#epubRef(item);
    if (epub?.path) await fs.rm(epub.path, { force: true }).catch(() => {});
    else if (epub) await this.blobs.delete(epub.key).catch(() => {});

    const pages = this.#pagesRef(item);
    if (pages?.path) await fs.rm(pages.path, { recursive: true, force: true }).catch(() => {});
    else if (pages) await this.blobs.deletePrefix(pages.key).catch(() => {});
    return true;
  }

  /** Bytes used by this library's files, for storage limits. */
  async storageUsed() {
    const items = await this.records.all();
    return items.reduce((n, i) => n + (Number(i.size) || 0) + (Number(i.pagesSize) || 0), 0);
  }
}
