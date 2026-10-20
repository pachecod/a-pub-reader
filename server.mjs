// A-pub reader — local web app: drop HTML or PDF files, paste URLs, follow RSS
// feeds, browse book catalogues or write your own, then send the results to an
// Xteink reader running CrossPoint firmware.
//
// Binds to 127.0.0.1 only. The browser reads dropped files itself — HTML as
// text, PDFs as base64 — and POSTs JSON, so there is no multipart parsing on
// the way in.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { extractArticle } from './lib/extract.mjs';
import { extractPdf } from './lib/pdf.mjs';
import { buildEpub, buildImageEpub, safeFilename } from './lib/epub.mjs';
import { PANEL, htmlToBlocks, renderBlocksToPages, renderPdfPages } from './lib/render.mjs';
import { DraftStore } from './lib/drafts.mjs';
import { AssetStore, normalizeForDevice } from './lib/assets.mjs';
import { FeedStore, feedFilename } from './lib/feeds.mjs';
import { BOOKS_FOLDER, FEED_FOLDER, FOLDERS, NOTES_FOLDER, isManagedFolder } from './lib/folders.mjs';
import { Outbox } from './lib/outbox.mjs';
import { Removals } from './lib/removals.mjs';
import { mediaTypeFor, readChapter, readEpub, readEpubFile } from './lib/epubread.mjs';
import { renderWebPage } from './lib/webread.mjs';
import { discoverFeeds } from './lib/discover.mjs';
import { explainHttpFailure } from './lib/httperror.mjs';
import { composeFeedHtml, fetchFeed, hydrateItems } from './lib/rss.mjs';
import { CATALOGUES, bookFilename, downloadBook, fetchCatalogue } from './lib/books.mjs';
import {
  copyToVolume,
  deleteFromVolume,
  listVolumeFiles,
  listVolumes,
  resolveVolume,
  targetDir,
} from './lib/volume.mjs';
import { markdownText, renderMarkdown } from './lib/markdown.mjs';
import {
  DEFAULT_HOST,
  deletableNames,
  deleteFiles,
  discover,
  ensureDir,
  getStatus,
  joinPath,
  listFiles,
  normalizeHost,
  normalizePath,
  resolveHost,
  replaceOnDevice,
  uploadEpub,
  verifyUploaded,
} from './lib/device.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
// Overridable so the server tests get their own directory. They spawn this
// file for real, and were writing test books into the live queue.
const OUT_DIR = process.env.EPUB_DROP_OUT_DIR || path.join(ROOT, 'out');
const CONFIG_PATH = process.env.EPUB_DROP_CONFIG || path.join(ROOT, 'config.json');

const PORT = Number(process.env.PORT || 4321);
// PDFs arrive base64-encoded, which inflates them by a third.
const MAX_BODY_BYTES = 96 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;

const DEFAULT_CONFIG = {
  host: DEFAULT_HOST,
  folder: BOOKS_FOLDER,
  includeImages: true,
  // Fixed-layout ("comic book") output: each page becomes an image.
  imageMode: false,
  imageScale: 2,
  imageSplit: 'whole',
  imageFontSize: 21,
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// Built EPUBs waiting to be sent. Persistent, because the reader is usually
// connected later than the moment something was converted.
const outbox = new Outbox(OUT_DIR);
// Deletions asked for while the reader was away, carried out on the next sync.
const removals = new Removals(path.join(OUT_DIR, 'removals.json'));

const STATE_DIR = process.env.EPUB_DROP_STATE || ROOT;
const drafts = new DraftStore(path.join(STATE_DIR, 'drafts'));
const assets = new AssetStore(path.join(STATE_DIR, 'assets'));
const feeds = new FeedStore(path.join(STATE_DIR, 'feeds.json'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.epub': 'application/epub+zip',
};

// ---------------------------------------------------------------- config

async function readConfig() {
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    const config = { ...DEFAULT_CONFIG, ...raw };
    // Clamp on the way in as well as on the way out: a file written by an older
    // version, or edited by hand, would otherwise still aim the library view and
    // its delete controls at a folder this app does not manage.
    if (!isManagedFolder(normalizePath(config.folder))) config.folder = BOOKS_FOLDER;
    else config.folder = normalizePath(config.folder);
    return config;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function writeConfig(patch) {
  const next = { ...(await readConfig()), ...patch };
  next.host = normalizeHost(next.host);
  // Only ever one of the app's own folders: it selects what the library view
  // browses and what the delete controls are scoped to, and a hand-typed value
  // could point either at a folder the app never wrote.
  const asked = normalizePath(next.folder);
  next.folder = isManagedFolder(asked) ? asked : BOOKS_FOLDER;
  next.includeImages = Boolean(next.includeImages);
  next.imageMode = Boolean(next.imageMode);
  next.imageScale = clamp(Number(next.imageScale) || 1, 1, 3);
  next.imageSplit = ['whole', 'halves', 'thirds'].includes(next.imageSplit) ? next.imageSplit : 'whole';
  next.imageFontSize = clamp(Number(next.imageFontSize) || 21, 12, 40);
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// ---------------------------------------------------------------- conversion

/**
 * Convert one dropped file or URL into an EPUB on disk.
 * @param {{name?, text?, pdfBase64?, url?, title?, author?}} item
 */
async function convertItem(item, options) {
  const { includeImages, imageMode } = options;
  let html = item.text;
  let url = item.url ? item.url.trim() : '';
  const warnings = [];

  // A draft written in the app's editor: load it from disk so the saved
  // version is the one that gets converted, and skip Readability.
  if (item.draftId) {
    const draft = await drafts.get(item.draftId);
    if (!draft) throw new Error('That draft no longer exists.');

    // Markdown is canonical; `html` only appears on drafts saved before that.
    const hasMarkdown = typeof draft.markdown === 'string';
    const bodyHtml = hasMarkdown ? renderMarkdown(draft.markdown) : String(draft.html || '');
    const plain = hasMarkdown ? markdownText(draft.markdown) : bodyHtml.replace(/<[^>]*>/g, '').trim();
    if (!plain) throw new Error('This draft is empty — write something first.');

    const article = await extractArticle({
      html: `<!DOCTYPE html><body>${bodyHtml}</body>`,
      includeImages,
      fragment: true,
      resolveAsset: (src) => assets.resolve(src),
      normalizeImage: normalizeForDevice,
      keepImageSources: imageMode,
    });
    const withMeta = {
      ...item,
      title: item.title || draft.title,
      author: item.author || draft.author,
      // Written in the app, so it belongs with the notes rather than among
      // books and readings.
      folder: NOTES_FOLDER,
    };
    return imageMode
      ? finishImages(article, withMeta, options, article.warnings)
      : finish(article, withMeta, article.warnings);
  }

  // PDFs take an entirely different path: geometry -> paragraphs, no HTML.
  if (item.pdfBase64) {
    const data = Buffer.from(item.pdfBase64, 'base64');
    if (!data.length) throw new Error('Empty PDF — nothing to convert.');
    if (data.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('That file is not a PDF (missing the %PDF- header).');
    }

    // In image mode the original page layout is what we want to keep, so the
    // PDF is rasterized directly instead of having its text pulled out.
    if (imageMode) {
      const rendered = await renderPdfPages({
        data,
        width: PANEL.width,
        scale: options.imageScale,
        split: options.imageSplit,
      });
      const label = String(item.name || '').replace(/\.pdf$/i, '') || 'Untitled';
      return finishImagePages(
        { title: item.title?.trim() || label, byline: item.author?.trim() || '', pages: rendered.pages },
        rendered.warnings
      );
    }

    const article = await extractPdf({ data, name: item.name, includeImages, normalizeImage: normalizeForDevice });
    return finish(article, item, article.warnings);
  }

  if (url) {
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
        headers: {
          // Some sites serve a stub to unknown clients; a normal UA gets the article.
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml',
        },
      });
    } catch (err) {
      // The most likely reason a fetch fails here is that this Mac is joined to
      // the reader's own hotspot, which has no route to the internet.
      throw new Error(
        `Could not load ${url}. If this Mac is joined to the reader's "CrossPoint-Reader" hotspot ` +
          'there is no internet — rejoin your normal Wi-Fi to convert, then switch back to send. ' +
          `(${err.cause?.code || err.message})`
      );
    }
    if (!res.ok) throw await explainHttpFailure(res, { what: 'page' });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type && !/text\/html|application\/xhtml/.test(type)) {
      throw new Error(`That URL is ${type.split(';')[0]}, not an HTML page.`);
    }
    html = await res.text();
    url = res.url || url;
  }

  if (!html || !html.trim()) throw new Error('Empty document — nothing to convert.');

  const article = await extractArticle({
    html,
    url,
    includeImages,
    normalizeImage: normalizeForDevice,
    keepImageSources: imageMode,
  });
  warnings.push(...article.warnings);
  return imageMode
    ? finishImages(article, item, options, warnings)
    : finish(article, item, warnings);
}

/**
 * Load an image for the page renderer: editor assets come off disk, and
 * anything remote is fetched. Returns null when it can't be had, and the
 * renderer falls back to alt text.
 */
async function loadRenderImage(src) {
  const local = await assets.resolve(src);
  if (local) return local.data;
  if (!/^https?:/i.test(src)) return null;
  try {
    const res = await fetch(src, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Rasterize an already-extracted article's text into fixed-layout pages. */
async function finishImages(article, item, options, warnings) {
  if (item.title?.trim()) article.title = item.title.trim();
  if (item.author?.trim()) article.byline = item.author.trim();
  if (!article.title || article.title === 'Untitled') {
    const fallback = item.name ? item.name.replace(/\.[^.]+$/, '') : '';
    if (fallback) article.title = fallback;
  }

  const blocks = htmlToBlocks(article.chapters.map((c) => c.body).join('\n'));
  if (!blocks.length) throw new Error('Nothing to render as pages.');

  // Give the book a title page so the first image isn't a mid-sentence page.
  blocks.unshift(
    { type: 'h1', text: article.title },
    ...(article.byline ? [{ type: 'quote', text: article.byline }] : [])
  );

  const rendered = await renderBlocksToPages({
    blocks,
    scale: options.imageScale,
    fontSize: options.imageFontSize,
    title: article.title,
    // Draft images are on this machine; page rendering draws them for real
    // rather than falling back to alt text.
    loadAsset: loadRenderImage,
  });

  return finishImagePages(
    {
      title: article.title,
      byline: article.byline,
      lang: article.lang,
      source: article.source,
      pages: rendered.pages,
      folder: item.folder || null,
    },
    [...warnings, ...rendered.warnings]
  );
}

/** Shared tail for both image paths: package, store pages, register the job. */
async function finishImagePages({ title, byline, lang, source, pages, folder = null }, warnings) {
  const { filename, buffer } = await buildImageEpub({ title, byline, lang, source, pages });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const id = randomUUID();
  const diskPath = path.join(OUT_DIR, `${id}-${filename}`);
  await fs.writeFile(diskPath, buffer);

  // Keep the PNGs on disk too, so the UI can show what the reader will show
  // without unzipping the EPUB on every preview request.
  const pageDir = path.join(OUT_DIR, `${id}-pages`);
  await fs.mkdir(pageDir, { recursive: true });
  await Promise.all(
    pages.map((page, i) => fs.writeFile(path.join(pageDir, `${String(i + 1).padStart(4, '0')}.png`), page.data))
  );

  await outbox.add({
    id,
    filename,
    title,
    diskPath,
    size: buffer.length,
    pageDir,
    pageCount: pages.length,
    folder,
    mode: 'images',
    chapters: pages.length,
    source: source || { kind: 'images', label: title },
  });

  return {
    id,
    filename,
    title,
    author: byline || '',
    source: source || '',
    size: buffer.length,
    chapters: pages.length,
    images: pages.length,
    pageCount: pages.length,
    mode: 'images',
    pageSize: `${pages[0].width}×${pages[0].height}`,
    textLength: 0,
    warnings,
  };
}

/** Shared tail: apply UI overrides, build the EPUB, stash it for sending. */
async function finish(article, item, warnings) {
  // Explicit overrides from the UI win over what was scraped.
  if (item.title?.trim()) article.title = item.title.trim();
  if (item.author?.trim()) article.byline = item.author.trim();
  if (!article.title || article.title === 'Untitled') {
    const fallback = item.name ? item.name.replace(/\.[^.]+$/, '') : '';
    if (fallback) article.title = fallback;
  }

  const { filename, buffer, chapters } = await buildEpub(article);

  await fs.mkdir(OUT_DIR, { recursive: true });
  const id = randomUUID();
  const diskPath = path.join(OUT_DIR, `${id}-${filename}`);
  await fs.writeFile(diskPath, buffer);

  await outbox.add({
    id,
    filename,
    title: article.title,
    diskPath,
    size: buffer.length,
    // null means "whatever the Send controls are set to"; a note or a feed
    // carries its own destination instead.
    folder: item.folder || null,
    mode: 'text',
    chapters,
    source: item.source || { kind: item.draftId ? 'draft' : item.pdfBase64 ? 'pdf' : item.url ? 'url' : 'html', label: item.name || item.url || article.title },
  });

  return {
    id,
    filename,
    title: article.title,
    author: article.byline || article.siteName || '',
    source: article.source,
    size: buffer.length,
    chapters,
    images: article.images.length,
    textLength: article.textLength,
    warnings,
  };
}



/**
 * Fold a delivered entry back into the app's state: mark it sent, replace the
 * edition it supersedes, and tell the feed which filename is now on the device.
 *
 * The "replaces" step lives here rather than in the refresh because delivery
 * can happen long after the build — you refresh on your own Wi-Fi and push once
 * you're next to the reader.
 */
async function afterDelivery(entry, { label, removeOld }) {
  const feedId = entry.source?.feedId;

  // Which edition to replace. `entry.replaces` is a snapshot from build time;
  // the feed's own record is fresher, and can differ when something was
  // delivered between building this file and sending it.
  let superseded = entry.replaces;
  if (feedId) {
    const feed = await feeds.get(feedId).catch(() => null);
    if (feed?.lastFilename) superseded = feed.lastFilename;
  }

  let removedOld = null;
  if (superseded && superseded !== entry.filename) {
    try {
      removedOld = (await removeOld(superseded)) ? superseded : null;
    } catch {
      // Failing to tidy up the old edition must not fail the send itself.
    }
  }

  await outbox.markDelivered(entry.id, label);

  if (feedId) {
    await feeds.update(feedId, { lastFilename: entry.filename, lastError: null }).catch(() => {});

    // Only one edition of a feed can be on the device at a time — each refresh
    // replaces the last. Keeping the superseded records would make the Library tab
    // claim a dozen editions are on the reader when there is one.
    for (const other of await outbox.list()) {
      if (other.id === entry.id) continue;
      if (other.source?.feedId !== feedId) continue;
      if (!other.deliveredAt) continue;
      await outbox.remove(other.id);
    }
  }

  return removedOld;
}

// ---------------------------------------------------------------- feeds

let refreshAllRun = null;

async function refreshTargets(targets) {
  const results = [];
  for (const feed of targets) {
    try {
      results.push(await refreshFeed(feed));
    } catch (err) {
      await feeds.update(feed.id, { lastError: err.message, lastRefreshedAt: new Date().toISOString() });
      results.push({ ok: false, id: feed.id, title: feed.title || feed.url, error: err.message });
    }
  }
  return results;
}

/**
 * Refresh one feed: fetch it, build a fresh EPUB, put it on the device, and
 * remove the edition this feed put there last time.
 *
 * Delivery reuses whichever destination the UI is set to, and a failure to
 * deliver is not a failure to refresh — the EPUB is still built and downloadable,
 * so a refresh done away from the reader isn't wasted.
 */
async function refreshFeed(feed) {
  const steps = [];
  const fetched = await fetchFeed(feed.url);
  const title = feed.title?.trim() || fetched.title;

  if (!fetched.items.length) throw new Error('That feed currently has no items.');
  steps.push(`Fetched ${fetched.items.length} item(s)`);

  const items = feed.fullText
    ? await hydrateItems(fetched.items, {
        limit: feed.limit,
        extractArticle: (opts) => extractArticle({ ...opts, includeImages: false }),
      })
    : fetched.items.slice(0, feed.limit);

  if (feed.fullText) {
    const full = items.filter((i) => i.hydrated).length;
    steps.push(`Fetched full text for ${full} of ${items.length}`);
  }

  // One pass over the whole feed: the chapter splitter breaks on the per-item
  // <h2>, so each article becomes a chapter with a working table of contents.
  const article = await extractArticle({
    html: `<!DOCTYPE html><body>${composeFeedHtml(fetched, items)}</body>`,
    fragment: true,
    includeImages: false,
    normalizeImage: normalizeForDevice,
  });
  article.title = title;
  article.source = fetched.url;

  const built = await buildEpub(article);
  const filename = feedFilename(title);

  await fs.mkdir(OUT_DIR, { recursive: true });
  const id = randomUUID();
  const diskPath = path.join(OUT_DIR, `${id}-${filename}`);
  await fs.writeFile(diskPath, built.buffer);

  // Drop any earlier un-sent edition of this feed: two pending copies of the
  // same feed in the queue would both try to go over, and only the newer one is
  // wanted.
  for (const pending of await outbox.list({ includeDelivered: false })) {
    if (pending.source?.feedId === feed.id) await outbox.remove(pending.id);
  }

  await outbox.add({
    id,
    filename,
    title,
    diskPath,
    size: built.buffer.length,
    // Feeds have their own folder, whatever the Send controls point at.
    folder: FEED_FOLDER,
    mode: 'text',
    chapters: built.chapters,
    // Carried so a send that happens hours later still knows which edition to
    // remove and which feed to update.
    replaces: feed.lastFilename || null,
    source: { kind: 'feed', label: title, feedId: feed.id, items: items.length },
  });

  steps.push(`Built ${filename} (${built.chapters} chapter(s), ${Math.round(built.buffer.length / 1024)} KB)`);
  steps.push('Queued for the reader');

  await feeds.update(feed.id, {
    title,
    lastRefreshedAt: new Date().toISOString(),
    lastItemCount: items.length,
    lastError: null,
  });

  return {
    ok: true,
    id,
    title,
    filename,
    items: items.length,
    chapters: built.chapters,
    size: built.buffer.length,
    folder: FEED_FOLDER,
    steps,
  };
}

// ---------------------------------------------------------------- routes

const routes = {
  'GET /api/config': async () => json(200, await readConfig()),

  'POST /api/config': async (req) => json(200, await writeConfig(await body(req))),

  'GET /api/folders': async () => json(200, { folders: FOLDERS }),

  'GET /api/device': async (req, url) => {
    const host = normalizeHost(url.searchParams.get('host') || (await readConfig()).host);
    try {
      return json(200, { ok: true, host, status: await getStatus(host) });
    } catch (err) {
      return json(200, { ok: false, host, error: friendlyDeviceError(err, host) });
    }
  },

  'POST /api/discover': async () => {
    const devices = await discover();
    // Discovery only proves something answered UDP; confirm HTTP is up too.
    const checked = await Promise.all(
      devices.map(async (d) => {
        try {
          return { ...d, status: await getStatus(d.address), ok: true };
        } catch {
          return { ...d, ok: false };
        }
      })
    );
    return json(200, { devices: checked });
  },

  'GET /api/device/files': async (req, url) => {
    const config = await readConfig();
    const host = normalizeHost(url.searchParams.get('host') || config.host);
    const dir = normalizePath(url.searchParams.get('path') || config.folder);
    try {
      return json(200, { ok: true, path: dir, entries: await listFiles(host, dir) });
    } catch (err) {
      return json(200, { ok: false, path: dir, error: friendlyDeviceError(err, host) });
    }
  },

  // The pending queue, so the page can show it after a reload or a restart.
  'GET /api/outbox': async (req, url) => {
    // Delivered entries stay visible by default: the UI dims them and shows
    // where they went, which is more useful than silently emptying the list,
    // and "Clear" is what removes them.
    const includeDelivered = url.searchParams.get('pending') !== '1';
    return json(200, { items: await outbox.list({ includeDelivered }) });
  },

  /**
   * Structure of a queued EPUB, for previewing it before it is sent.
   *
   * Read from the built file rather than from whatever produced it, so the
   * preview reflects the chapters, titles and images that actually ended up
   * inside — not the intermediate markdown or article HTML.
   */
  'GET /api/outbox/preview': async (req, url) => {
    const entry = await outbox.get(url.searchParams.get('id'));
    if (!entry) return json(404, { error: 'That file is no longer in the queue.' });

    // Fixed-layout books are previewed as page images, which are already on disk.
    if (entry.mode === 'images') {
      return json(200, {
        id: entry.id,
        kind: 'images',
        title: entry.title,
        pageCount: entry.pageCount,
      });
    }

    try {
      const book = await readEpub(entry.diskPath);
      return json(200, {
        id: entry.id,
        kind: 'text',
        title: book.title || entry.title,
        author: book.author,
        layout: book.layout,
        chapters: book.spine.map((c, i) => ({ index: i, title: c.title || `Section ${i + 1}` })),
      });
    } catch (err) {
      return json(200, { id: entry.id, kind: 'error', error: err.message });
    }
  },

  'GET /api/outbox/chapter': async (req, url) => {
    const entry = await outbox.get(url.searchParams.get('id'));
    if (!entry) return json(404, { error: 'That file is no longer in the queue.' });

    const index = Number(url.searchParams.get('n') || 0);
    try {
      const book = await readEpub(entry.diskPath);
      const chapter = await readChapter(book, index, {
        imageUrl: (internal) => `/out/${entry.id}/epub/${internal.split('/').map(encodeURIComponent).join('/')}`,
      });
      return json(200, chapter);
    } catch (err) {
      return json(400, { error: err.message });
    }
  },

  'POST /api/outbox/remove': async (req) => {
    const { id, fromDevice = false } = await body(req);

    // Read the entry before dropping it: once it is gone, the folder and
    // filename it occupies on the reader are no longer knowable.
    if (fromDevice) {
      const entry = await outbox.get(id);
      if (entry?.deliveredAt) {
        await removals.add({
          folder: normalizePath(entry.folder || BOOKS_FOLDER),
          filename: entry.filename,
          title: entry.title || entry.filename,
        });
      }
    }

    return json(200, { ok: await outbox.remove(id), pending: (await removals.list()).length });
  },

  /**
   * Remove everything: every built item (sent or not), every followed feed,
   * every draft and its images, and any stray files left in the output folder.
   * Settings — the reader's address and the image options — are kept.
   *
   * With `fromDevice`, everything this app put on the reader is queued for
   * deletion on the next sync, including a feed edition whose record is gone.
   *
   * The typed phrase is checked here as well as in the page: this is not
   * undoable, and an endpoint that wipes the library on an empty POST is one
   * stray request away from doing it by accident.
   */
  'POST /api/remove-everything': async (req) => {
    const { confirm = '', fromDevice = false } = await body(req);
    if (String(confirm).trim().toLowerCase() !== 'i agree') {
      return json(400, { error: 'Type “I Agree” to confirm removing everything.' });
    }

    const queued = new Set();
    const queueRemoval = async (folder, filename, title) => {
      const key = `${folder}/${filename}`;
      if (!fromDevice || !filename || queued.has(key)) return;
      queued.add(key);
      await removals.add({ folder, filename, title: title || filename });
    };

    const items = await outbox.list();
    for (const entry of items) {
      if (entry.deliveredAt) {
        await queueRemoval(normalizePath(entry.folder || BOOKS_FOLDER), entry.filename, entry.title);
      }
      await outbox.remove(entry.id);
    }

    const followed = await feeds.list();
    for (const feed of followed) {
      await queueRemoval(FEED_FOLDER, feed.lastFilename, feed.title);
      await feeds.remove(feed.id);
    }

    const written = await drafts.list();
    for (const draft of written) await drafts.remove(draft.id);

    // Images pasted into drafts; nothing else refers to them once drafts go.
    await fs.rm(path.join(STATE_DIR, 'assets'), { recursive: true, force: true });

    // Built files the queue no longer knew about — older runs, interrupted
    // builds. Only names this app writes are touched.
    let stray = 0;
    for (const name of await fs.readdir(OUT_DIR).catch(() => [])) {
      if (!/^[0-9a-f-]{36}-(?:.+\.epub|pages)$|\.tmp$/i.test(name)) continue;
      await fs.rm(path.join(OUT_DIR, name), { recursive: true, force: true });
      stray++;
    }

    return json(200, {
      ok: true,
      items: items.length,
      feeds: followed.length,
      drafts: written.length,
      stray,
      pending: (await removals.list()).length,
    });
  },

  'GET /api/removals': async () => json(200, { removals: await removals.list() }),

  // Changed your mind: leave those files on the reader after all.
  'POST /api/removals/clear': async () => json(200, { cancelled: await removals.clear() }),

  'POST /api/outbox/clear-delivered': async () => json(200, { removed: await outbox.clearDelivered() }),

  // ------------------------------------------------------------ find books

  'GET /api/books/catalogues': async () => json(200, { catalogues: CATALOGUES }),

  /**
   * Browse a catalogue feed.
   *
   * Entries that offer no EPUB are reported as skipped rather than silently
   * dropped, so pointing this at an article feed says so instead of looking
   * broken.
   */
  'GET /api/books/browse': async (req, url) => {
    const requested = url.searchParams.get('url') || CATALOGUES[0].url;
    try {
      const catalogue = await fetchCatalogue(requested);

      // Mark anything already built, so re-browsing doesn't invite duplicates.
      const queued = new Set((await outbox.list()).map((i) => i.source?.bookId).filter(Boolean));
      return json(200, {
        ...catalogue,
        books: catalogue.books.map((b) => ({ ...b, queued: queued.has(b.id) })),
      });
    } catch (err) {
      return json(200, { ok: false, error: err.message, books: [] });
    }
  },

  /**
   * Download the chosen books and queue them.
   *
   * These are finished EPUBs from a publisher that typesets them properly, so
   * they are queued byte-for-byte — no extraction, no re-encoding. Each book is
   * independent: one failure does not stop the rest.
   */
  'POST /api/books/queue': async (req) => {
    const payload = await body(req);
    const wanted = Array.isArray(payload.books) ? payload.books : [];
    if (!wanted.length) return json(400, { error: 'No books selected.' });

    await fs.mkdir(OUT_DIR, { recursive: true });
    const results = [];

    for (const book of wanted) {
      const label = book.title || book.epubUrl;
      try {
        if (!/^https?:\/\//i.test(String(book.epubUrl || ''))) throw new Error('Missing a download URL.');

        const buffer = await downloadBook(book.epubUrl);
        const filename = bookFilename(book, safeFilename);

        const id = randomUUID();
        const diskPath = path.join(OUT_DIR, `${id}-${filename}`);
        await fs.writeFile(diskPath, buffer);

        // Read the real spine length so the queue shows a chapter count rather
        // than a blank, and so the preview label is accurate.
        let chapters = null;
        try {
          chapters = (await readEpub(diskPath)).spine.length;
        } catch {
          /* it validated as an EPUB above; a odd package just means no count */
        }

        await outbox.add({
          id,
          filename,
          title: book.title || filename.replace(/\.epub$/, ''),
          author: book.author || '',
          diskPath,
          size: buffer.length,
          // Books follow the Send controls like any other queued file.
          folder: null,
          mode: 'text',
          chapters,
          source: { kind: 'book', label, bookId: book.id || book.pageUrl || book.epubUrl, from: book.pageUrl || '' },
        });

        results.push({ ok: true, id, title: label, filename, size: buffer.length });
      } catch (err) {
        results.push({ ok: false, title: label, error: err.message });
      }
    }

    return json(200, { ok: results.every((r) => r.ok), results });
  },

  'GET /api/feeds': async () => json(200, { feeds: await feeds.list(), folder: FEED_FOLDER }),

  // Find feeds: the hand-picked directory, each one checked live.
  'GET /api/feeds/discover': async (req, url) => {
    const following = (await feeds.list()).map((f) => f.url);
    const groups = await discoverFeeds({ following, fresh: url.searchParams.get('fresh') === '1' });
    return json(200, { groups });
  },

  'POST /api/feeds/add': async (req) => {
    const payload = await body(req);
    try {
      const { feed, added } = await feeds.add(payload);
      // Probe the feed straight away so a typo surfaces now, not on refresh.
      if (added) {
        try {
          const fetched = await fetchFeed(feed.url);
          const updated = await feeds.update(feed.id, {
            title: feed.title || fetched.title,
            lastItemCount: fetched.items.length,
            lastError: null,
          });
          return json(200, { feed: updated, added, itemsAvailable: fetched.items.length });
        } catch (err) {
          // Keep it, but say what's wrong — the URL may just be temporarily down.
          const updated = await feeds.update(feed.id, { lastError: err.message });
          return json(200, { feed: updated, added, warning: err.message });
        }
      }
      return json(200, { feed, added: false });
    } catch (err) {
      return json(400, { error: err.message });
    }
  },

  'POST /api/feeds/update': async (req) => {
    const { id, ...patch } = await body(req);
    try {
      return json(200, { feed: await feeds.update(id, patch) });
    } catch (err) {
      return json(400, { error: err.message });
    }
  },

  'POST /api/feeds/remove': async (req) => {
    const { id } = await body(req);
    return json(200, { ok: await feeds.remove(id) });
  },

  /**
   * Refresh one feed or all of them. Each is independent, so one broken feed
   * doesn't stop the rest.
   */
  'POST /api/feeds/refresh': async (req) => {
    const payload = await body(req);
    const all = await feeds.list();
    const targets = payload.id ? all.filter((f) => f.id === payload.id) : all;

    if (!targets.length) return json(400, { error: 'No feeds to refresh.' });

    // The page refreshes everything when it loads, so a reload — or a second
    // tab — mid-refresh would otherwise start another run alongside it and
    // build every edition twice. Later callers wait for the run in progress.
    if (!payload.id) {
      refreshAllRun ??= refreshTargets(targets).finally(() => {
        refreshAllRun = null;
      });
      const results = await refreshAllRun;
      return json(200, { folder: FEED_FOLDER, results, feeds: await feeds.list() });
    }

    const results = await refreshTargets(targets);
    return json(200, { folder: FEED_FOLDER, results, feeds: await feeds.list() });
  },

  'GET /api/drafts': async () => json(200, { drafts: await drafts.list() }),

  'GET /api/drafts/get': async (req, url) => {
    try {
      const draft = await drafts.get(url.searchParams.get('id'));
      return draft ? json(200, draft) : json(404, { error: 'Draft not found.' });
    } catch {
      // A malformed id is a bad request, not a server fault.
      return json(404, { error: 'Draft not found.' });
    }
  },

  'POST /api/drafts/save': async (req) => {
    const payload = await body(req);
    try {
      return json(200, await drafts.save(payload));
    } catch (err) {
      return json(400, { error: err.message });
    }
  },

  /**
   * Store an image dropped, pasted, or picked in the editor.
   *
   * The browser sends base64 rather than multipart, matching how PDFs arrive.
   * The response URL is what gets written into the draft, so the same bytes
   * back the editor preview and the eventual EPUB.
   */
  'POST /api/assets': async (req) => {
    const { data, mime, name } = await body(req);
    if (!data) return json(400, { error: 'No image data.' });
    try {
      const saved = await assets.save(Buffer.from(String(data), 'base64'), mime);
      return json(200, { ...saved, name: saved.name, originalName: name || '' });
    } catch (err) {
      return json(400, { error: err.message });
    }
  },

  // Server-side markdown render, so the EPUB preview is the real pipeline
  // output rather than the browser's approximation of it.
  'POST /api/drafts/preview': async (req) => {
    const { markdown } = await body(req);
    return json(200, { html: renderMarkdown(markdown), chars: markdownText(markdown).length });
  },

  // Borrowed from faculty-materials-builder's /api/reveal: jumping straight to
  // the files on disk saves hunting for them in Finder.
  'POST /api/reveal': async (req) => {
    const { what } = await body(req);
    const targets = { drafts: path.join(ROOT, 'drafts'), out: OUT_DIR };
    const target = targets[what];
    if (!target) return json(400, { error: 'Unknown folder.' });
    await fs.mkdir(target, { recursive: true });
    try {
      await new Promise((resolve, reject) => {
        execFile('open', [target], (err) => (err ? reject(err) : resolve()));
      });
      return json(200, { ok: true, path: target });
    } catch (err) {
      return json(200, { ok: false, error: err.message, path: target });
    }
  },

  'POST /api/drafts/delete': async (req) => {
    const { id } = await body(req);
    try {
      return json(200, { ok: await drafts.remove(id) });
    } catch (err) {
      return json(400, { error: err.message });
    }
  },

  // Mounted volumes that might be the reader's SD card, for offline transfer.
  'GET /api/volumes': async () => json(200, { volumes: await listVolumes() }),

  /**
   * Copy converted EPUBs onto a mounted card instead of over Wi-Fi.
   *
   * The same folder setting is used, so a book lands in the same place either
   * way and the reader's library looks identical however it got there.
   */
  'POST /api/send-volume': async (req) => {
    const payload = await body(req);
    const ids = Array.isArray(payload.ids) ? payload.ids : [];
    if (!ids.length) return json(400, { error: 'Nothing selected to send.' });

    const folder = BOOKS_FOLDER;
    const volume = await resolveVolume(payload.volume);
    if (!volume) {
      return json(200, { ok: false, error: 'That drive is no longer mounted. Re-check the list and try again.', results: [] });
    }

    const results = [];

    for (const id of ids) {
      const entry = await outbox.get(id);
      if (!entry) {
        results.push({ id, ok: false, error: 'That file is no longer in the queue.' });
        continue;
      }

      const targetFolder = entry.folder ? normalizePath(entry.folder) : folder;
      try {
        await copyToVolume(volume, targetFolder, entry.filename, await fs.readFile(entry.diskPath));

        const removedOld = await afterDelivery(entry, {
          label: volume.name,
          removeOld: async (name) => {
            const [result] = await deleteFromVolume(volume, targetFolder, [name]);
            return Boolean(result?.ok);
          },
        });

        results.push({
          id,
          ok: true,
          filename: entry.filename,
          folder: targetFolder,
          message: `Copied to ${volume.name}`,
          removedOld,
        });
      } catch (err) {
        results.push({ id, ok: false, filename: entry.filename, error: err.message });
      }
    }

    const removed = await runRemovals({
      delete: async (folder, filename) => {
        const [result] = await deleteFromVolume(volume, folder, [filename]);
        if (!result?.ok) throw new Error(result?.error || 'Could not delete that file.');
        return true;
      },
    });

    return json(200, {
      ok: results.every((r) => r.ok) && removed.every((r) => r.ok),
      host: volume.name,
      folder,
      path: targetDir(volume, folder),
      results,
      removed,
    });
  },

  // Browse the managed folder only. Listing elsewhere is what /api/device/files
  // is for; this is the view the delete UI acts on.
  'GET /api/library': async (req, url) => {
    const config = await readConfig();
    const folder = normalizePath(config.folder);

    // Offline destination: read the card directly instead of over Wi-Fi.
    const volumePath = url.searchParams.get('volume');
    if (volumePath) {
      const volume = await resolveVolume(volumePath);
      if (!volume) return json(200, { ok: false, folder, error: 'That drive is no longer mounted.' });
      try {
        return json(200, {
          ok: true,
          host: volume.name,
          folder,
          canDelete: folder !== '/' && volume.writable,
          entries: await listVolumeFiles(volume, folder),
        });
      } catch (err) {
        return json(200, { ok: false, folder, error: err.message });
      }
    }

    try {
      const { host } = await resolveHost(url.searchParams.get('host') || config.host);
      const entries = await listFiles(host, folder);
      return json(200, {
        ok: true,
        host,
        folder,
        canDelete: folder !== '/',
        entries: entries
          .filter((e) => !e.isDirectory)
          .map((e) => ({ name: e.name, size: e.size, isEpub: e.isEpub })),
      });
    } catch (err) {
      return json(200, { ok: false, folder, error: friendlyDeviceError(err, config.host) });
    }
  },

  /**
   * Delete files from the managed folder.
   *
   * Scope is enforced here, not in the browser: the request carries bare
   * filenames, the folder comes from saved config, and each name must appear in
   * a fresh device listing of that folder as a plain file. So nothing outside
   * the folder is reachable, directories are never removed, and pointing the
   * folder at the SD-card root disables deletion entirely rather than exposing
   * the whole library.
   */
  'POST /api/library/delete': async (req) => {
    const payload = await body(req);
    const names = (Array.isArray(payload.names) ? payload.names : []).map(String);
    if (!names.length) return json(400, { error: 'No files selected.' });

    const config = await readConfig();
    // Guaranteed to be one of the app's folders by writeConfig, so a delete can
    // never be aimed at the SD-card root or at anything the app did not write.
    const folder = normalizePath(config.folder);
    if (!isManagedFolder(folder)) {
      return json(400, { error: 'That is not a folder this app manages.' });
    }

    if (payload.volume) {
      const volume = await resolveVolume(payload.volume);
      if (!volume) return json(200, { ok: false, error: 'That drive is no longer mounted.', results: [] });
      if (!volume.writable) {
        return json(200, { ok: false, error: `${volume.name} is mounted read-only.`, results: [] });
      }
      const results = await deleteFromVolume(volume, folder, names);
      return json(200, { ok: results.every((r) => r.ok), host: volume.name, folder, results });
    }

    let host;
    try {
      ({ host } = await resolveHost(payload.host || config.host));
    } catch (err) {
      return json(200, { ok: false, error: err.message, results: [] });
    }

    let allowed;
    try {
      allowed = await deletableNames(host, folder);
    } catch (err) {
      return json(200, { ok: false, error: `Could not read ${folder}: ${friendlyDeviceError(err, host)}`, results: [] });
    }

    const results = [];
    const paths = [];
    for (const name of names) {
      if (!allowed.has(name)) {
        results.push({
          name,
          ok: false,
          error: `Not a file in ${folder} — refusing to delete.`,
        });
        continue;
      }
      paths.push(joinPath(folder, name));
    }

    if (paths.length) {
      try {
        await deleteFiles(host, paths);
        // Confirm against the device rather than trusting the response text.
        const remaining = await deletableNames(host, folder);
        for (const path of paths) {
          const name = path.slice(folder.length + 1);
          results.push(
            remaining.has(name)
              ? { name, ok: false, error: 'Device still lists this file.' }
              : { name, ok: true }
          );
        }
      } catch (err) {
        for (const path of paths) {
          results.push({ name: path.slice(folder.length + 1), ok: false, error: err.message });
        }
      }
    }

    return json(200, { ok: results.every((r) => r.ok), host, folder, results });
  },

  'POST /api/convert': async (req) => {
    const payload = await body(req);
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) return json(400, { error: 'No items to convert.' });

    const config = await readConfig();
    const options = {
      includeImages:
        typeof payload.includeImages === 'boolean' ? payload.includeImages : config.includeImages,
      imageMode: typeof payload.imageMode === 'boolean' ? payload.imageMode : config.imageMode,
      imageScale: clamp(Number(payload.imageScale ?? config.imageScale) || 1, 1, 3),
      imageSplit: ['whole', 'halves', 'thirds'].includes(payload.imageSplit)
        ? payload.imageSplit
        : config.imageSplit,
      imageFontSize: clamp(Number(payload.imageFontSize ?? config.imageFontSize) || 21, 12, 40),
    };

    // Sequential: rasterizing and image fetches are both heavy, and this keeps
    // per-item errors and progress easy to attribute.
    const results = [];
    for (const item of items) {
      const label = item.name || item.url || 'item';
      try {
        results.push({ ok: true, label, ...(await convertItem(item, options)) });
      } catch (err) {
        results.push({ ok: false, label, error: err.message });
      }
    }
    return json(200, { results });
  },

  'POST /api/send': async (req) => {
    const payload = await body(req);
    const ids = Array.isArray(payload.ids) ? payload.ids : [];
    if (!ids.length) return json(400, { error: 'Nothing selected to send.' });

    const config = await readConfig();
    // Where a queued item goes is decided by what it is, not by a form field:
    // notes and feeds carry their own folder, and everything else is a book.
    const folder = BOOKS_FOLDER;

    let host;
    try {
      ({ host } = await resolveHost(payload.host || config.host));
    } catch (err) {
      return json(200, { ok: false, error: err.message, results: [] });
    }

    const results = [];
    // Names already on the device, per folder, so a batch of uploads does not
    // re-list the folder for every file.
    const knownNames = new Map();
    for (const id of ids) {
      const entry = await outbox.get(id);
      if (!entry) {
        results.push({ id, ok: false, error: 'That file is no longer in the queue.' });
        continue;
      }

      // Feeds and notes carry their own folder; everything else uses the
      // folder chosen in the Send controls.
      const targetFolder = entry.folder ? normalizePath(entry.folder) : folder;
      try {
        if (targetFolder !== '/') await ensureDir(host, targetFolder);
        const buffer = await fs.readFile(entry.diskPath);

        if (!knownNames.has(targetFolder)) {
          knownNames.set(targetFolder, new Set((await deletableNames(host, targetFolder)).keys()));
        }
        const { message } = await replaceOnDevice(
          host,
          targetFolder,
          entry.filename,
          buffer,
          knownNames.get(targetFolder)
        );

        const removedOld = await afterDelivery(entry, {
          label: host,
          // Only a differently-named previous edition reaches here; an
          // identical name was already replaced during the upload.
          removeOld: async (name) => {
            const present = knownNames.get(targetFolder) || new Set((await deletableNames(host, targetFolder)).keys());
            if (!present.has(name)) return false;
            await deleteFiles(host, [joinPath(targetFolder, name)]);
            present.delete(name);
            return true;
          },
        });

        results.push({ id, ok: true, filename: entry.filename, folder: targetFolder, message, removedOld });
      } catch (err) {
        results.push({ id, ok: false, filename: entry.filename, error: friendlyDeviceError(err, host) });
      }
    }

    const removed = await runRemovals({
      delete: (folder, filename) => deleteFiles(host, [joinPath(folder, filename)]).then(() => true),
    });

    return json(200, {
      ok: results.every((r) => r.ok) && removed.every((r) => r.ok),
      host,
      folder,
      results,
      removed,
    });
  },
};

/**
 * Carry out the queued device deletions.
 *
 * A file that is already gone counts as done — the point is that the reader ends
 * up without it, not that this app was the one to delete it. Anything that fails
 * for another reason stays queued for the next sync rather than being lost.
 *
 * @param {{delete: (folder: string, filename: string) => Promise<boolean>}} how
 */
async function runRemovals(how) {
  const queued = await removals.list();
  const done = [];

  for (const item of queued) {
    try {
      await how.delete(item.folder, item.filename);
      await removals.remove(item.folder, item.filename);
      done.push({ ok: true, folder: item.folder, filename: item.filename, title: item.title });
    } catch (err) {
      const gone = /not found|no such file|404/i.test(err.message || '');
      if (gone) await removals.remove(item.folder, item.filename);
      done.push({
        ok: gone,
        folder: item.folder,
        filename: item.filename,
        title: item.title,
        error: gone ? undefined : err.message,
      });
    }
  }
  return done;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;

  // Editor images, referenced from draft markdown as /assets/<name>.
  const assetMatch = /^\/assets\/([0-9a-f]{16}\.(?:png|jpg))$/i.exec(url.pathname);
  if (req.method === 'GET' && assetMatch) {
    const data = await assets.read(assetMatch[1]);
    if (!data) return send(res, 404, 'text/plain', 'Not found');
    res.writeHead(200, {
      'content-type': assetMatch[1].toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png',
      'content-length': data.length,
      // Content-addressed names never change contents, so this is safe to cache.
      'cache-control': 'public, max-age=31536000, immutable',
    });
    return res.end(data);
  }

  // Images inside a queued EPUB, so a text preview shows real pictures:
  // /out/<id>/epub/<path inside the archive>
  const epubFileMatch = /^\/out\/([0-9a-f-]{36})\/epub\/(.+)$/i.exec(url.pathname);
  if (req.method === 'GET' && epubFileMatch) {
    const entry = await outbox.get(epubFileMatch[1]);
    if (!entry) return send(res, 404, 'text/plain', 'Not found');

    const internal = decodeURIComponent(epubFileMatch[2]);
    try {
      const book = await readEpub(entry.diskPath);
      // Looked up as an exact archive entry, so a traversal path simply misses.
      const data = await readEpubFile(book, internal);
      if (!data) return send(res, 404, 'text/plain', 'Not found');
      res.writeHead(200, {
        'content-type': mediaTypeFor(internal),
        'content-length': data.length,
        'cache-control': 'no-store',
      });
      return res.end(data);
    } catch {
      return send(res, 404, 'text/plain', 'Not found');
    }
  }

  // A built item as a plain web page, for reading without a device: /read/<id>
  const readMatch = /^\/read\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (req.method === 'GET' && readMatch) {
    const entry = await outbox.get(readMatch[1]);
    if (!entry) return send(res, 404, 'text/plain', 'That item is no longer here.');
    try {
      const html = await renderWebPage(entry);
      res.writeHead(200, {
        'content-type': MIME['.html'],
        'cache-control': 'no-store',
        // Chapters are HTML from wherever the item came from. They are served as
        // a page of their own, so forbid scripts outright rather than trusting
        // that conversion stripped every one.
        'content-security-policy':
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'none'; frame-src 'none'; object-src 'none'",
      });
      return res.end(html);
    } catch (err) {
      return send(res, 500, 'text/plain', `Could not read that EPUB: ${err.message}`);
    }
  }

  // Rendered page images, for the fixed-layout preview: /out/<id>/pages/<n>.png
  const pageMatch = /^\/out\/([0-9a-f-]{36})\/pages\/(\d+)\.png$/i.exec(url.pathname);
  if (req.method === 'GET' && pageMatch) {
    const job = await outbox.get(pageMatch[1]);
    const index = Number(pageMatch[2]);
    if (!job?.pageDir || index < 1 || index > job.pageCount) {
      return send(res, 404, 'text/plain', 'Not found');
    }
    try {
      const data = await fs.readFile(path.join(job.pageDir, `${String(index).padStart(4, '0')}.png`));
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': data.length, 'cache-control': 'no-store' });
      return res.end(data);
    } catch {
      return send(res, 404, 'text/plain', 'Not found');
    }
  }

  // Local EPUB download (also the "keep a copy" path).
  if (req.method === 'GET' && url.pathname.startsWith('/out/')) {
    const job = await outbox.get(url.pathname.slice('/out/'.length));
    if (!job) return send(res, 404, 'text/plain', 'Not found');
    const data = await fs.readFile(job.diskPath);
    res.writeHead(200, {
      'content-type': MIME['.epub'],
      'content-disposition': `attachment; filename="${job.filename.replace(/"/g, '')}"`,
      'content-length': data.length,
    });
    return res.end(data);
  }

  const route = routes[key];
  if (route) {
    try {
      const { status, type, payload } = await route(req, url);
      return send(res, status, type, payload);
    } catch (err) {
      return send(res, 500, 'application/json', JSON.stringify({ error: err.message }));
    }
  }

  if (req.method === 'GET') return serveStatic(res, url.pathname);
  return send(res, 404, 'text/plain', 'Not found');
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  // Refuse anything that escapes public/.
  if (!target.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'text/plain', 'Forbidden');
  try {
    const data = await fs.readFile(target);
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    return res.end(data);
  } catch {
    return send(res, 404, 'text/plain', 'Not found');
  }
}

// ---------------------------------------------------------------- helpers

function json(status, payload) {
  return { status, type: 'application/json', payload: JSON.stringify(payload) };
}

function send(res, status, type, payload) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Node's fetch reports every transport failure as "fetch failed" and buries
 * the real reason in .cause — sometimes an AggregateError holding one error
 * per address family. Collect every code in the chain.
 */
function errorCodes(err, depth = 0) {
  if (!err || depth > 4) return [];
  const codes = [];
  if (err.code) codes.push(String(err.code));
  if (err.name) codes.push(String(err.name));
  if (err.message) codes.push(String(err.message));
  if (Array.isArray(err.errors)) for (const inner of err.errors) codes.push(...errorCodes(inner, depth + 1));
  if (err.cause) codes.push(...errorCodes(err.cause, depth + 1));
  return codes;
}

/**
 * Turn socket-level noise into something actionable.
 *
 * Node's fetch surfaces almost everything as a bare "fetch failed", which tells
 * the user nothing about what to do next — and "the reader went to sleep" is by
 * far the most common cause here.
 */
function friendlyDeviceError(err, host) {
  const detail = errorCodes(err).join(' ');
  const advice = "On the reader, open File Transfer and check the address it shows.";

  if (/ENOTFOUND|EAI_AGAIN/.test(detail)) {
    return `Can't resolve "${host}". Use the IP address shown on the reader's File Transfer screen.`;
  }
  if (/ECONNREFUSED/.test(detail)) {
    return `${host} refused the connection — it's on the network but not serving files. ${advice}`;
  }
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENETDOWN/.test(detail)) {
    return `${host} is unreachable — the reader is probably asleep or on another network. ${advice}`;
  }
  if (/timed out|timeout|TimeoutError|ETIMEDOUT|AbortError|ECONNRESET/i.test(detail)) {
    return `${host} did not respond in time. The reader may have gone to sleep. ${advice}`;
  }
  if (/fetch failed/i.test(detail)) {
    // Nothing more specific survived the fetch wrapper.
    return `Could not reach ${host}. ${advice}`;
  }
  return String(err?.message || err);
}

// ---------------------------------------------------------------- boot

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) send(res, 500, 'text/plain', err.message);
  });
});

server.listen(PORT, '127.0.0.1', async () => {
  const config = await readConfig();
  console.log(`\n  A-pub reader  →  http://localhost:${PORT}`);
  console.log(`  reader: ${config.host}   folder: ${config.folder}`);
  console.log('  On the reader: open File Transfer and join Wi-Fi.\n');
});
