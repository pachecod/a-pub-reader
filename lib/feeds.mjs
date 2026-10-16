// Saved RSS feeds.
//
// One JSON file holding an ordered list, since feeds are few and the order in
// the UI matters. Each record remembers the filename it last put on the device,
// which is what makes a refresh able to remove the previous edition instead of
// leaving one EPUB per refresh piling up on the card.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { safeFilename } from './epub.mjs';

// Re-exported so callers that already import it from here keep working.
export { FEED_FOLDER } from './folders.mjs';
import { FEED_FOLDER } from './folders.mjs';

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;

export class FeedStore {
  constructor(file) {
    this.file = file;
  }

  async #read() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return Array.isArray(raw?.feeds) ? raw.feeds : [];
    } catch {
      return [];
    }
  }

  async #write(feeds) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify({ feeds }, null, 2)}\n`);
    await fs.rename(temp, this.file);
  }

  async list() {
    return this.#read();
  }

  async get(id) {
    return (await this.#read()).find((f) => f.id === id) || null;
  }

  /**
   * Add a feed. The URL is the identity — adding the same one twice returns the
   * existing record rather than creating a duplicate that would fight over the
   * same output file.
   */
  async add({ url, title = '', limit = DEFAULT_LIMIT, fullText = true }) {
    const feeds = await this.#read();
    const normalized = normalizeUrl(url);
    if (!normalized) throw new Error('Enter a feed URL.');

    const existing = feeds.find((f) => normalizeUrl(f.url) === normalized);
    if (existing) return { feed: existing, added: false };

    const feed = {
      id: randomUUID(),
      url: normalized,
      title: String(title || '').slice(0, 200),
      limit: clampLimit(limit),
      fullText: Boolean(fullText),
      addedAt: new Date().toISOString(),
      lastRefreshedAt: null,
      lastFilename: null,
      lastItemCount: 0,
      lastError: null,
    };

    feeds.push(feed);
    await this.#write(feeds);
    return { feed, added: true };
  }

  async update(id, patch) {
    const feeds = await this.#read();
    const index = feeds.findIndex((f) => f.id === id);
    if (index === -1) throw new Error('That feed is no longer saved.');

    const next = { ...feeds[index], ...patch, id: feeds[index].id };
    if (patch.limit !== undefined) next.limit = clampLimit(patch.limit);
    if (patch.url !== undefined) next.url = normalizeUrl(patch.url) || feeds[index].url;
    if (patch.fullText !== undefined) next.fullText = Boolean(patch.fullText);

    feeds[index] = next;
    await this.#write(feeds);
    return next;
  }

  async remove(id) {
    const feeds = await this.#read();
    const next = feeds.filter((f) => f.id !== id);
    if (next.length === feeds.length) return false;
    await this.#write(next);
    return true;
  }
}

export function normalizeUrl(url) {
  let value = String(url || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const parsed = new URL(value);
    // Drop a trailing slash on the path so "/feed" and "/feed/" are one feed.
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.round(n)));
}

/**
 * Filename for a refresh, dated so freshness is visible in the reader's file
 * list. Same feed refreshed twice in a day overwrites; a new day produces a new
 * name and the previous one gets deleted.
 */
export function feedFilename(title, when = new Date()) {
  const stamp = [
    when.getFullYear(),
    String(when.getMonth() + 1).padStart(2, '0'),
    String(when.getDate()).padStart(2, '0'),
  ].join('-');

  // safeFilename already handles control characters, FAT32-reserved
  // characters and trailing dots; trim again after shortening.
  const clean = safeFilename(title || 'Feed').slice(0, 60).replace(/[.\s]+$/, '');
  return `${clean || 'Feed'} - ${stamp}.epub`;
}
