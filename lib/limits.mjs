// Per-library limits for hosted installs, so one account cannot fill the
// storage or keep the server busy for everyone else.
//
// The admin sets them for the whole install (the Settings page arrives in
// Phase 3; until then they are the defaults below, or whatever the `limits`
// install setting holds). The app on your Mac has no limits.

export const DEFAULT_LIMITS = {
  /** Built EPUBs and page images, in megabytes. */
  storageMB: 250,
  /** Items in the library. */
  items: 500,
  /** Feeds followed. */
  feeds: 50,
  /** Things built per day: conversions, book downloads and feed editions. */
  buildsPerDay: 200,
};

/** Limits with any admin-set values applied, each a positive whole number. */
export function resolveLimits(saved = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const n = Math.floor(Number(saved?.[key]));
    if (Number.isFinite(n) && n > 0) limits[key] = n;
  }
  return limits;
}

/** A limit was reached. Its message is meant for the person using the app. */
export class LimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LimitError';
    this.status = 403;
  }
}

/** Today's date, as the key for daily counts. */
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * Daily build counts for one library, kept in a collection as one record per
 * day. Old days are dropped as new ones are written.
 */
export class UsageCounter {
  constructor(records) {
    this.records = records;
  }

  async builds(day = today()) {
    return (await this.records.get(day))?.builds || 0;
  }

  async addBuilds(n, day = today()) {
    if (!n) return;
    const updated = await this.records.update(day, (r) => ({ ...r, builds: (r.builds || 0) + n }));
    if (!updated) await this.records.put({ id: day, builds: n });
    const stale = (await this.records.all()).map((r) => r.id).filter((id) => id < day);
    if (stale.length) await this.records.deleteMany(stale);
  }
}

/**
 * Check a library against its limits before adding to it. Throws LimitError
 * naming what was reached; returns quietly when there is room.
 *
 * @param {{outbox, feeds, usage}} library  One owner's stores.
 * @param {object} limits  From resolveLimits().
 * @param {{items?: number, feeds?: number, builds?: number}} adding  What is about to be added.
 */
export async function checkLimits(library, limits, adding = {}) {
  if (adding.items || adding.builds) {
    const used = await library.outbox.storageUsed();
    if (used >= limits.storageMB * 1024 * 1024) {
      throw new LimitError(
        `Your library is using its full ${limits.storageMB} MB. Remove some books or editions to make room.`
      );
    }
  }
  if (adding.items) {
    const count = (await library.outbox.list()).length;
    if (count + adding.items > limits.items) {
      throw new LimitError(`Your library can hold ${limits.items} items, and it has ${count}. Remove some to add more.`);
    }
  }
  if (adding.feeds) {
    const count = (await library.feeds.list()).length;
    if (count + adding.feeds > limits.feeds) {
      throw new LimitError(`You can follow up to ${limits.feeds} feed${limits.feeds === 1 ? '' : 's'}. Remove one to add another.`);
    }
  }
  if (adding.builds) {
    const done = await library.usage.builds();
    if (done + adding.builds > limits.buildsPerDay) {
      throw new LimitError(
        `You have built ${done} things today, and the daily limit is ${limits.buildsPerDay}. Try again tomorrow.`
      );
    }
  }
}
