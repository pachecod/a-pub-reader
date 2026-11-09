// Shared fetching for hosted installs.
//
// Many people follow the same feeds (NPR, BBC…). Rather than every library
// fetching the same feed and every article page on it, a fetched feed is kept
// for a few minutes and an article's extracted text for a few hours, shared by
// everyone; each library still builds its own edition from them. That saves
// time and keeps the app polite to publishers.
//
// The app on your Mac does not use this: with one library there is nothing to
// share, and Refresh should always mean "fetch it now".

/** How long a fetched feed is reused. */
export const FEED_TTL_MS = 10 * 60 * 1000;
/** How long an article's extracted text is reused. */
export const ARTICLE_TTL_MS = 6 * 60 * 60 * 1000;
const MEMORY_MAX = 2000;

/** In memory, for a hosted install without a database. */
export class MemoryFetchCache {
  constructor() {
    this.entries = new Map();
  }

  async get(key, maxAgeMs) {
    const entry = this.entries.get(key);
    if (!entry || Date.now() - entry.at > maxAgeMs) return null;
    return entry.value;
  }

  async set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { value, at: Date.now() });
    // Oldest first in a Map, so trimming the front drops the stalest.
    while (this.entries.size > MEMORY_MAX) this.entries.delete(this.entries.keys().next().value);
  }

  async prune(olderThanMs) {
    const cutoff = Date.now() - olderThanMs;
    for (const [key, entry] of this.entries) if (entry.at < cutoff) this.entries.delete(key);
  }
}

/** In the database, shared by every instance of the app. */
export class PgFetchCache {
  constructor(db) {
    this.db = db;
  }

  async get(key, maxAgeMs) {
    const { rows } = await this.db.query(
      `SELECT value FROM fetch_cache WHERE key = $1 AND fetched_at > now() - ($2::double precision * interval '1 millisecond')`,
      [key, maxAgeMs]
    );
    return rows[0]?.value ?? null;
  }

  async set(key, value) {
    await this.db.query(
      `INSERT INTO fetch_cache (key, value, fetched_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()`,
      [key, JSON.stringify(value)]
    );
  }

  async prune(olderThanMs) {
    await this.db.query(
      `DELETE FROM fetch_cache WHERE fetched_at < now() - ($1::double precision * interval '1 millisecond')`,
      [olderThanMs]
    );
  }
}

/**
 * Fetch through a cache: a fresh enough copy is returned as is; otherwise
 * `load()` runs, and its result is kept. Concurrent requests for the same key
 * in this process share one load. Failures are not cached.
 */
export function sharedFetcher(cache) {
  const inFlight = new Map();
  return async function shared(key, maxAgeMs, load) {
    if (!cache) return load();
    const hit = await cache.get(key, maxAgeMs).catch(() => null);
    if (hit !== null) return hit;
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = (async () => {
      const value = await load();
      await cache.set(key, value).catch(() => {});
      return value;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  };
}
