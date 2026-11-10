// Where each owner's library lives.
//
// A backend hands out one bundle of stores per owner: the queue (outbox),
// pending removals, feeds, drafts, editor images and settings. Two backends:
//
// - files: JSON files and folders on disk. The app on your Mac uses this, with
//   the one owner "local" kept at exactly the paths it has always used, so an
//   existing library carries on untouched. Other owners (only if accounts are
//   switched on for testing) get their own folder under users/.
// - database: PostgreSQL for records and blob storage (a bucket, or a folder)
//   for files, every key prefixed by the owner. Hosted installs use this.
//
// Until accounts arrive (Phase 2), a hosted install has one owner, "shared",
// behind its APP_PASSWORD.

import fs from 'node:fs/promises';
import path from 'node:path';

import { AssetStore } from '../assets.mjs';
import { DraftStore } from '../drafts.mjs';
import { FeedStore } from '../feeds.mjs';
import { Outbox } from '../outbox.mjs';
import { Removals, removalId } from '../removals.mjs';
import { UsageCounter } from '../limits.mjs';
import { DiskBlobs, ScopedBlobs } from './blobs.mjs';
import { JsonDirCollection, JsonListCollection, PgCollection } from './collections.mjs';
import { AppSettings } from './db.mjs';

export const LOCAL_OWNER = 'local';
export const SHARED_OWNER = 'shared';

/** Owner ids become folder names and key prefixes, so keep them plain. */
export function checkOwner(owner) {
  const id = String(owner || '');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) throw new Error('Invalid owner.');
  return id;
}

/** One settings object (config.json on your Mac, a record hosted). */
class SettingsDocument {
  constructor({ file, collection }) {
    this.file = file;
    this.collection = collection;
  }

  async get() {
    if (this.collection) return (await this.collection.get('settings'))?.value || {};
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  async set(value) {
    if (this.collection) {
      await this.collection.put({ id: 'settings', value });
      return value;
    }
    // A fresh host (Render) starts without the data folder.
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(temp, this.file);
    return value;
  }
}

/**
 * The files backend.
 * @param {{outDir: string, stateDir: string, configPath: string}} paths
 */
export function fileBackend({ outDir, stateDir, configPath }) {
  const bundles = new Map();

  function build(owner) {
    // The local owner keeps the pre-2.0 layout; anyone else gets a folder.
    const local = owner === LOCAL_OWNER;
    const base = local ? null : path.join(stateDir, 'users', owner);
    const out = local ? outDir : path.join(base, 'out');
    const state = local ? stateDir : base;
    const assetsDir = path.join(state, 'assets');
    const outBlobs = new DiskBlobs(out);

    return {
      owner,
      outbox: new Outbox({ records: new JsonListCollection(path.join(out, 'outbox.json'), 'items'), blobs: outBlobs }),
      removals: new Removals(new JsonListCollection(path.join(out, 'removals.json'), 'items', removalId)),
      feeds: new FeedStore(new JsonListCollection(path.join(state, 'feeds.json'), 'feeds')),
      drafts: new DraftStore(new JsonDirCollection(path.join(state, 'drafts'))),
      assets: new AssetStore(new DiskBlobs(assetsDir)),
      settings: new SettingsDocument({ file: local ? configPath : path.join(base, 'config.json') }),
      usage: new UsageCounter(new JsonListCollection(path.join(state, 'usage.json'), 'days')),
      folders: { out, drafts: path.join(state, 'drafts') },

      /**
       * After everything has been removed: delete editor images, and built
       * files the queue no longer knew about (older runs, interrupted builds).
       * Only names this app writes are touched. Returns the stray count.
       */
      async clearFiles() {
        await fs.rm(assetsDir, { recursive: true, force: true });
        let stray = 0;
        for (const name of await fs.readdir(out).catch(() => [])) {
          if (!/^[0-9a-f-]{36}-(?:.+\.epub|pages)$|\.tmp$/i.test(name)) continue;
          await fs.rm(path.join(out, name), { recursive: true, force: true });
          stray++;
        }
        return stray;
      },
    };
  }

  return {
    kind: 'files',
    // Install settings without a database: none saved, so defaults apply.
    settings: { get: async (key, fallback = null) => fallback, set: async (key, value) => value },
    forOwner(owner) {
      const id = checkOwner(owner);
      if (!bundles.has(id)) bundles.set(id, build(id));
      return bundles.get(id);
    },
    async close() {},
  };
}

/**
 * The database backend.
 * @param {{db: object, blobs: object}} options  A database (see db.mjs) and a
 *   blob store (S3Blobs, or DiskBlobs for a single server with a disk).
 */
export function databaseBackend({ db, blobs }) {
  const bundles = new Map();

  function build(owner) {
    const prefix = `users/${owner}`;
    const collection = (kind, idOf) => new PgCollection(db, owner, kind, idOf);
    return {
      owner,
      outbox: new Outbox({ records: collection('outbox'), blobs: new ScopedBlobs(blobs, `${prefix}/out`) }),
      removals: new Removals(collection('removals', removalId)),
      feeds: new FeedStore(collection('feeds')),
      drafts: new DraftStore(collection('drafts')),
      assets: new AssetStore(new ScopedBlobs(blobs, `${prefix}/assets`)),
      settings: new SettingsDocument({ collection: collection('settings') }),
      usage: new UsageCounter(collection('usage')),
      folders: null,

      /** Delete every file this owner still has (the records are already gone). */
      async clearFiles() {
        await blobs.deletePrefix(prefix).catch(() => {});
        return 0;
      },
    };
  }

  return {
    kind: 'database',
    db,
    blobs,
    settings: new AppSettings(db),
    forOwner(owner) {
      const id = checkOwner(owner);
      if (!bundles.has(id)) bundles.set(id, build(id));
      return bundles.get(id);
    },
    /** Delete a whole library: every record and every file (a deleted account). */
    async deleteOwner(owner) {
      const id = checkOwner(owner);
      await db.query('DELETE FROM records WHERE owner = $1', [id]);
      await blobs.deletePrefix(`users/${id}`).catch(() => {});
      bundles.delete(id);
    },
    close: () => db.close(),
  };
}
