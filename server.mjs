// A-pub reader — local web app: drop HTML or PDF files, paste URLs, follow RSS
// feeds, browse book catalogues or write your own, then send the results to an
// Xteink reader running CrossPoint firmware.
//
// Binds to 127.0.0.1 by default. Set HOST (for example 0.0.0.0 on Render) to
// listen publicly; that requires APP_PASSWORD and turns on hosted mode, a
// library-and-reading app with the device features off. The browser reads
// dropped files itself — HTML as text, PDFs as base64 — and POSTs JSON, so there
// is no multipart parsing on the way in.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import JSZip from 'jszip';

import { extractArticle } from './lib/extract.mjs';
import { runPdfJob } from './lib/pdfjob.mjs';
import { buildEpub, buildImageEpub, safeFilename } from './lib/epub.mjs';
import { PANEL, htmlToBlocks, renderBlocksToPages } from './lib/render.mjs';
import { normalizeForDevice } from './lib/assets.mjs';
import { feedFilename, normalizeUrl } from './lib/feeds.mjs';
import { checkLimits, resolveLimits } from './lib/limits.mjs';
import { ARTICLE_TTL_MS, FEED_TTL_MS, MemoryFetchCache, PgFetchCache, sharedFetcher } from './lib/store/fetchcache.mjs';
import { BOOKS_FOLDER, DOCS_FOLDER, FEED_FOLDER, NOTES_FOLDER, moveDocumentsToTheirFolder } from './lib/folders.mjs';
import { DiskBlobs, S3Blobs } from './lib/store/blobs.mjs';
import { LOCAL_OWNER, SHARED_OWNER, databaseBackend, fileBackend } from './lib/store/backend.mjs';
import { migrate, openDatabase } from './lib/store/db.mjs';
import { AccountStore, SESSION_DAYS } from './lib/accounts/store.mjs';
import { hashPassword, passwordProblem, readablePassword, verifyPassword } from './lib/accounts/passwords.mjs';
import { lookupKey, openPassword, sealPassword } from './lib/accounts/lookup.mjs';
import { mediaTypeFor, readChapter, readEpub, readEpubFile } from './lib/epubread.mjs';
import { renderWebPage } from './lib/webread.mjs';
import { SUMMARY_VERSION, pruneSummaries, savedSummary, summarize } from './lib/summary.mjs';
import { discoverFeeds } from './lib/discover.mjs';
import { explainHttpFailure } from './lib/httperror.mjs';
import { blockedReason, configureNetGuard, safeFetch } from './lib/netguard.mjs';
import {
  RateLimiter,
  appCsp,
  baseHeaders,
  clientIp,
  localHostAllowed,
  sameOrigin,
  secretProblems,
} from './lib/security.mjs';
import { composeFeedHtml, fetchFeed, hydrateItems, siteLabel, siteOf, withDates } from './lib/rss.mjs';
import { CATALOGUES, bookFilename, downloadBook, fetchCatalogue } from './lib/books.mjs';
import {
  copyToVolume,
  deleteFromVolume,
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
// Where to listen. The default keeps the app on this computer only.
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(HOST);
// A password for every page and request, as an HTTP Basic sign-in. Required
// whenever the app listens beyond this computer.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
// Hosted mode: running on a server (such as Render) rather than the computer
// next to the reader. A server cannot reach a reader on your home Wi-Fi, a card
// in your Mac or a synced folder on it, so those features are switched off and
// the app is a library and reader. On whenever it listens publicly.
const HOSTED = process.env.HOSTED === '1' || !LOOPBACK;
// Accounts: everyone signs in as themselves and has their own library. On
// whenever the app is hosted with a database; on your own computer only when
// asked (ACCOUNTS=1, with DATABASE_URL), to try them. Without accounts, a
// hosted install is one shared library behind APP_PASSWORD.
const ACCOUNTS = Boolean(process.env.DATABASE_URL) && (HOSTED || process.env.ACCOUNTS === '1');
if (!LOOPBACK && !APP_PASSWORD && !ACCOUNTS) {
  console.error(
    `\n  Refusing to listen on ${HOST} without a password. Set DATABASE_URL for accounts,\n` +
      '  or APP_PASSWORD for one shared password, or leave HOST unset to keep the app\n' +
      '  on this computer.\n'
  );
  process.exit(1);
}
// Listening publicly, or told it is production: refuse weak secrets rather
// than run with them.
const secretIssues = secretProblems(process.env, {
  required: !LOOPBACK || process.env.NODE_ENV === 'production',
  accounts: ACCOUNTS,
});
if (secretIssues.length) {
  console.error(
    `\n  Refusing to start with weak secrets:\n${secretIssues.map((p) => `    - ${p}`).join('\n')}\n` +
      '  Set them in the host\'s environment settings (on Render: Environment), never in the repository.\n'
  );
  process.exit(1);
}

// Hosted, addresses that users give the app may not point into the server's
// own network. On your own computer they may (a page on your home network).
configureNetGuard({ allowPrivate: !HOSTED });

// How many proxies in front of the app add to X-Forwarded-For. Render has one.
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? (LOOPBACK ? 0 : 1)) || 0;

// Request bodies: small by default; larger only where files arrive. PDFs and
// images arrive base64-encoded, which inflates them by a third.
const DEFAULT_BODY_BYTES = 1024 * 1024;
const BODY_LIMITS = {
  'POST /api/convert': 96 * 1024 * 1024,
  'POST /api/assets': 32 * 1024 * 1024,
  'POST /api/drafts/save': 8 * 1024 * 1024,
  'POST /api/drafts/preview': 8 * 1024 * 1024,
};

// Rate limits, per client address. Wrong passwords always; when hosted, also
// the routes that make the server fetch and convert things.
const authFailures = new RateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const heavyWork = new RateLimiter({ windowMs: 10 * 60 * 1000, max: 60 });
const HEAVY_ROUTES = new Set([
  'POST /api/convert',
  'POST /api/books/queue',
  'GET /api/books/browse',
  'POST /api/feeds/add',
  'POST /api/feeds/refresh',
  'GET /api/feeds/check',
  'GET /api/feeds/discover',
  'GET /download/ebooks.zip',
]);
const APP_CSP = appCsp();
const FETCH_TIMEOUT_MS = 30000;

const DEFAULT_CONFIG = {
  host: DEFAULT_HOST,
  // Where Sync Reader goes: 'wifi', or the path of a mounted card or synced
  // cloud folder from /api/volumes. Remembered so a reading page syncs the
  // same way the app last did.
  destination: 'wifi',
  includeImages: true,
  // Fixed-layout ("comic book") output: each page becomes an image.
  imageMode: false,
  imageScale: 2,
  imageSplit: 'whole',
  imageFontSize: 21,
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const STATE_DIR = process.env.EPUB_DROP_STATE || ROOT;

// ---------------------------------------------------------------- storage
//
// Where libraries live: files on disk (your Mac, or a simple hosted install),
// or PostgreSQL plus file storage when DATABASE_URL is set (hosted for many
// users). Each request runs as one owner, and the stores below always mean
// that owner's: `outbox` inside a request is the requester's queue. Until
// accounts arrive, there is one owner: "local" on your Mac, "shared" hosted.

const backend = await openBackend();
const DEFAULT_OWNER = HOSTED ? SHARED_OWNER : LOCAL_OWNER;

// ---------------------------------------------------------------- accounts
//
// See lib/accounts. The first admin comes from ADMIN_USERNAME and
// ADMIN_PASSWORD (and ADMIN_EMAIL, optionally) on the first start with no
// admin; those variables do nothing after that. That admin's library is the
// one the install had before accounts ("shared"), so nothing is lost.

const accounts = ACCOUNTS ? new AccountStore(backend.db) : null;
let LOOKUP_KEY = null;
if (accounts) {
  LOOKUP_KEY = lookupKey();
  if (!(await accounts.count({ role: 'admin' }))) {
    const username = String(process.env.ADMIN_USERNAME || '').trim();
    const password = process.env.ADMIN_PASSWORD || '';
    if (!username || !password) {
      console.error(
        '\n  Accounts are on, and there is no admin yet. Set ADMIN_USERNAME and ADMIN_PASSWORD\n' +
          '  (and ADMIN_EMAIL, if you like) in the host\'s environment settings to create the\n' +
          '  first one; they are used once, on this start, and never again.\n'
      );
      process.exit(1);
    }
    const sharedTaken = (await accounts.list()).some((u) => u.library === SHARED_OWNER);
    const admin = await accounts.create({
      username,
      email: process.env.ADMIN_EMAIL || '',
      role: 'admin',
      passwordHash: await hashPassword(password),
      library: sharedTaken ? undefined : SHARED_OWNER,
    });
    console.log(`  accounts: created the first admin, "${admin.username}".`);
  }
  setInterval(() => accounts.pruneSessions().catch(() => {}), 6 * 60 * 60 * 1000).unref();
}

// The session cookie. Over HTTPS it gets the __Host- prefix, which browsers
// only accept when it is Secure, for this exact host and the whole site.
const COOKIE_PLAIN = 'apub_session';
const COOKIE_SECURE = '__Host-apub_session';
const loginFailures = new RateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return '';
}

const sessionToken = (req) => readCookie(req, COOKIE_SECURE) || readCookie(req, COOKIE_PLAIN);

function sessionCookie(req, token) {
  const name = req.secure ? COOKIE_SECURE : COOKIE_PLAIN;
  const life = token ? `Max-Age=${SESSION_DAYS * 24 * 60 * 60}` : 'Max-Age=0';
  return `${name}=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Lax; ${life}${req.secure ? '; Secure' : ''}`;
}

/** Pages and calls open to someone not signed in (when accounts are on). */
const PUBLIC_PATHS = new Set([
  'GET /signin',
  'GET /signin.js',
  'GET /style.css',
  'GET /themes.css',
  'GET /theme.js',
  'GET /logo.svg',
  'GET /api/auth/me',
  'POST /api/auth/signin',
]);

/** A user as their own page and the admin page see them. */
const userView = (user) =>
  user && { id: user.id, username: user.username, email: user.email, role: user.role, adminSetPassword: user.adminSetPassword };
const ownerContext = new AsyncLocalStorage();
/** The current owner's stores. */
const stores = () => backend.forOwner(ownerContext.getStore() || DEFAULT_OWNER);
/** A stand-in that forwards to the current owner's store of that name. */
function scoped(name) {
  return new Proxy(
    {},
    {
      get(_, prop) {
        const target = stores()[name];
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }
  );
}

// Built EPUBs waiting to be sent. Persistent, because the reader is usually
// connected later than the moment something was converted.
const outbox = scoped('outbox');
// Deletions asked for while the reader was away, carried out on the next sync.
const removals = scoped('removals');
const drafts = scoped('drafts');
const assets = scoped('assets');
const feeds = scoped('feeds');

// Hosted, feeds and articles that several libraries follow are fetched once
// and shared (in the database when there is one). Not on your Mac.
const fetchCache = backend.kind === 'database' ? new PgFetchCache(backend.db) : HOSTED ? new MemoryFetchCache() : null;
const shared = sharedFetcher(fetchCache);
/** fetchFeed, through the shared cache when hosted. */
// From the cache, a feed's dates are text again; withDates restores them.
const fetchFeedShared = async (url) =>
  withDates(await shared(`feed:${normalizeUrl(url) || url}`, FEED_TTL_MS, () => fetchFeed(url)));
const articleCache = fetchCache && {
  get: (link) => fetchCache.get(`article:${link}`, ARTICLE_TTL_MS),
  set: (link, value) => fetchCache.set(`article:${link}`, value),
};
if (fetchCache) setInterval(() => fetchCache.prune(ARTICLE_TTL_MS).catch(() => {}), 60 * 60 * 1000).unref();

/**
 * Hosted, check the current library has room before adding to it; throws a
 * LimitError (403) naming the limit. No limits on your Mac.
 */
async function ensureRoom(adding) {
  if (!HOSTED) return;
  const limits = resolveLimits(await backend.settings.get('limits', {}));
  await checkLimits(stores(), limits, adding);
}
/** Count things built today, for the daily limit. */
async function countBuilds(n) {
  if (HOSTED && n > 0) await stores().usage.addBuilds(n);
}

async function openBackend() {
  const url = process.env.DATABASE_URL;
  if (!url) return fileBackend({ outDir: OUT_DIR, stateDir: STATE_DIR, configPath: CONFIG_PATH });

  const db = await openDatabase(url, { ssl: process.env.DATABASE_SSL ? process.env.DATABASE_SSL !== '0' : undefined });
  const applied = await migrate(db);
  if (applied.length) console.log(`  database: applied ${applied.join(', ')}`);

  let blobs;
  if (process.env.STORAGE_BUCKET) {
    blobs = new S3Blobs({
      endpoint: process.env.STORAGE_ENDPOINT,
      bucket: process.env.STORAGE_BUCKET,
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
      region: process.env.STORAGE_REGION || 'auto',
      prefix: process.env.STORAGE_PREFIX || '',
    });
  } else {
    // No bucket: files on this server's disk. Fine for trying the database
    // locally, or on a Render plan with a disk; files vanish on a free plan.
    const dir = path.join(STATE_DIR, 'files');
    if (HOSTED) console.warn(`  storage: no STORAGE_BUCKET set, so files are kept on this server's disk (${dir}).`);
    blobs = new DiskBlobs(dir);
  }
  return databaseBackend({ db, blobs });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.epub': 'application/epub+zip',
};

// ---------------------------------------------------------------- config

async function readConfig() {
  const raw = await stores().settings.get();
  // Earlier versions saved a folder for a device-browsing view that is gone;
  // where each item goes is decided by what it is, so the value is dropped.
  const { folder, ...config } = { ...DEFAULT_CONFIG, ...raw };
  return config;
}

async function writeConfig(patch) {
  const { folder, ...rest } = patch || {};
  const next = { ...(await readConfig()), ...rest };
  next.host = normalizeHost(next.host);
  next.destination = typeof next.destination === 'string' && next.destination ? next.destination : 'wifi';
  next.includeImages = Boolean(next.includeImages);
  next.imageMode = Boolean(next.imageMode);
  next.imageScale = clamp(Number(next.imageScale) || 1, 1, 3);
  next.imageSplit = ['whole', 'halves', 'thirds'].includes(next.imageSplit) ? next.imageSplit : 'whole';
  next.imageFontSize = clamp(Number(next.imageFontSize) || 21, 12, 40);
  return stores().settings.set(next);
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
      const rendered = await runPdfJob({
        kind: 'pages',
        data,
        options: { width: PANEL.width, scale: options.imageScale, split: options.imageSplit },
      });
      const label = String(item.name || '').replace(/\.pdf$/i, '') || 'Untitled';
      return finishImagePages(
        { title: item.title?.trim() || label, byline: item.author?.trim() || '', pages: rendered.pages },
        rendered.warnings
      );
    }

    // In its own process: see lib/pdfjob.mjs.
    const article = await runPdfJob({ kind: 'text', data, name: item.name, includeImages });
    return finish(article, item, article.warnings);
  }

  if (url) {
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    let res;
    try {
      res = await safeFetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        maxBytes: 15 * 1024 * 1024,
        redirect: 'follow',
        headers: {
          // Some sites serve a stub to unknown clients; a normal UA gets the article.
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml',
        },
      });
    } catch (err) {
      const blocked = blockedReason(err);
      if (blocked) throw new Error(blocked);
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
    const res = await safeFetch(src, { signal: AbortSignal.timeout(15000), maxBytes: 4 * 1024 * 1024 });
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
      folder: item.folder || DOCS_FOLDER,
    },
    [...warnings, ...rendered.warnings]
  );
}

/** Shared tail for both image paths: package, store pages, register the job. */
async function finishImagePages({ title, byline, lang, source, pages, folder = DOCS_FOLDER }, warnings) {
  const { filename, buffer } = await buildImageEpub({ title, byline, lang, source, pages });

  const id = randomUUID();
  const stored = await outbox.saveEpub(id, filename, buffer);

  // Keep the PNGs too, so the UI can show what the reader will show without
  // unzipping the EPUB on every preview request.
  const storedPages = await outbox.savePages(id, pages);

  await outbox.add({
    id,
    filename,
    title,
    ...stored,
    size: buffer.length,
    ...storedPages,
    pagesSize: pages.reduce((n, page) => n + page.data.length, 0),
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

  const id = randomUUID();
  const stored = await outbox.saveEpub(id, filename, buffer);

  await outbox.add({
    id,
    filename,
    title: article.title,
    ...stored,
    size: buffer.length,
    // What you convert goes to A-pub Documents; a note carries its own folder.
    folder: item.folder || DOCS_FOLDER,
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

/** A headline reduced to its letters and digits, so small differences in quotes or spacing still match. */
const headlineKey = (title) => String(title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * How many articles each feed has that its current edition does not.
 *
 * Only reads the feeds — nothing is built, sent or saved. A refresh takes a
 * feed's newest `limit` items, so those are compared, by headline, with the
 * articles in the newest edition the app holds for that feed. An article
 * counts as new only if it was also published after that edition was built:
 * feeds drop old items and some never make it into an edition, which would
 * otherwise surface older articles as "new". Undated ones go by headline.
 */
async function checkFeedsForNew() {
  const followed = await feeds.list();
  const editions = await outbox.list();
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < followed.length) {
      const feed = followed[next++];
      const edition = editions.find((e) => e.source?.feedId === feed.id);
      try {
        const fetched = await fetchFeedShared(feed.url);
        const latest = fetched.items.slice(0, feed.limit || 15);
        let have = new Set();
        if (edition) {
          const summary = await summarize(edition, () => outbox.readEpub(edition)).catch(() => null);
          have = new Set((summary?.articles || []).map((a) => headlineKey(a.title)));
        }
        const builtAt = edition?.builtAt ? Date.parse(edition.builtAt) : 0;
        const fresh = latest.filter(
          (item) => !have.has(headlineKey(item.title)) && (!builtAt || !item.date || item.date.getTime() > builtAt)
        );
        results.push({
          feedId: feed.id,
          title: feed.title || fetched.title,
          newCount: fresh.length,
          hasEdition: Boolean(edition),
          // The new articles themselves, for the Library to list as not yet in
          // the edition. Only http(s) links are passed on.
          articles: fresh.map((item) => ({
            title: String(item.title || '').trim(),
            link: /^https?:\/\//i.test(item.link || '') ? item.link : null,
            date: item.date ? item.date.toISOString() : null,
            author: item.author || '',
          })),
        });
      } catch (err) {
        results.push({ feedId: feed.id, title: feed.title || feed.url, newCount: 0, error: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, followed.length) }, worker));
  return results;
}

// A refresh-all in progress, per library.
const refreshAllRuns = new Map();

async function refreshTargets(targets) {
  const results = [];
  for (const feed of targets) {
    try {
      results.push(await refreshFeed(feed));
      await countBuilds(1);
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
  const fetched = await fetchFeedShared(feed.url);
  const title = feed.title?.trim() || fetched.title;
  // The feed's own website, linked from every article and from the Library.
  const site = siteOf(fetched);

  if (!fetched.items.length) throw new Error('That feed currently has no items.');
  steps.push(`Fetched ${fetched.items.length} item(s)`);

  const items = feed.fullText
    ? await hydrateItems(fetched.items, {
        limit: feed.limit,
        articleCache,
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
    html: `<!DOCTYPE html><body>${composeFeedHtml({ title, link: site }, items)}</body>`,
    fragment: true,
    includeImages: false,
    normalizeImage: normalizeForDevice,
  });
  article.title = title;
  article.source = fetched.url;

  const built = await buildEpub(article);
  const filename = feedFilename(title);

  const id = randomUUID();
  const stored = await outbox.saveEpub(id, filename, built.buffer);

  // A feed switched off in the Library stays off: its new edition inherits the
  // switch from the newest one before it.
  const previous = (await outbox.list()).find((i) => i.source?.feedId === feed.id);
  const onReader = previous ? previous.onReader !== false : true;

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
    ...stored,
    size: built.buffer.length,
    // Feeds have their own folder, whatever the Send controls point at.
    folder: FEED_FOLDER,
    mode: 'text',
    chapters: built.chapters,
    // Carried so a send that happens hours later still knows which edition to
    // remove and which feed to update.
    replaces: feed.lastFilename || null,
    source: { kind: 'feed', label: title, feedId: feed.id, items: items.length, site },
    onReader,
  });

  // Summarize it now, while its bytes are in hand, so the Library shows it
  // without reading the EPUB back (slow on a small hosted server).
  try {
    const added = await outbox.get(id);
    if (added) await outbox.update(id, { summary: savedSummary(await summarize(added, async () => built.buffer)) });
  } catch {
    /* the Library works it out on first view instead */
  }

  steps.push(`Built ${filename} (${built.chapters} chapter(s), ${Math.round(built.buffer.length / 1024)} KB)`);
  steps.push('Queued for the reader');

  await feeds.update(feed.id, {
    title,
    site,
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

const ADMIN_DIR = path.join(ROOT, 'admin');

/** A page or script from disk, as a route result. */
async function fileResult(file, type) {
  return { status: 200, type, payload: await fs.readFile(file) };
}

const redirect = (location) => ({ status: 302, type: 'text/plain', payload: '', headers: { location } });

/** Only a path on this site, so ?next= cannot send someone elsewhere after signing in. */
const safeNext = (value) => (/^\/(?!\/)[^\\]*$/.test(String(value || '')) ? String(value) : '/');

/** Is this the last active admin? Then they may not be removed, demoted or switched off. */
async function lastAdmin(user) {
  return user.role === 'admin' && user.status !== 'disabled' && (await accounts.count({ role: 'admin' })) <= 1;
}

/** The user an admin call is about, or a 404. */
async function targetUser(id) {
  const user = await accounts.get(id);
  if (!user) throw httpError(404, 'That account no longer exists.');
  return user;
}

/** A password for an admin to set: the one typed, checked, or a readable new one. */
function adminPassword(typed, user) {
  if (typed) {
    const problem = passwordProblem(typed, user);
    if (problem) throw httpError(400, problem);
    return typed;
  }
  return readablePassword();
}

const routes = {
  // ---- signing in and out (accounts)

  'GET /signin': async (req, url) => {
    if (!accounts) return redirect('/');
    if (req.user) return redirect(safeNext(url.searchParams.get('next')));
    return fileResult(path.join(PUBLIC_DIR, 'signin.html'), MIME['.html']);
  },

  'POST /api/auth/signin': async (req) => {
    if (!accounts) throw httpError(404, 'Accounts are not switched on here.');
    const ip = clientIp(req, TRUST_PROXY_HOPS);
    const { login = '', password = '' } = await body(req);
    const who = String(login).trim().toLowerCase().slice(0, 254);
    const limited = [loginFailures.blocked(`ip:${ip}`), loginFailures.blocked(`login:${who}`)].find((l) => l.blocked);
    if (limited) {
      return { ...json(429, { error: 'Too many tries. Wait a few minutes and try again.' }), headers: { 'retry-after': String(limited.retryAfter) } };
    }
    const found = await accounts.credentials(who);
    // Checked even when there is no such account, so both take as long.
    const ok = await verifyPassword(String(password), found?.hash);
    if (!found || !ok) {
      loginFailures.hit(`ip:${ip}`);
      if (who) loginFailures.hit(`login:${who}`);
      return json(401, { error: 'That username or password is not right.' });
    }
    if (found.user.status === 'disabled') return json(403, { error: 'This account is switched off. Ask an administrator.' });
    if (found.user.status === 'pending') return json(403, { error: 'This account is waiting for an administrator to approve it.' });

    // A fresh session at every sign-in; any earlier one in this browser ends.
    await accounts.deleteSession(sessionToken(req)).catch(() => {});
    const token = await accounts.createSession(found.user.id, { userAgent: req.headers['user-agent'], ip });
    await accounts.recordSignIn(found.user.id);
    return { ...json(200, { ok: true, user: userView(found.user) }), headers: { 'set-cookie': sessionCookie(req, token) } };
  },

  'POST /api/auth/signout': async (req) => {
    if (accounts) await accounts.deleteSession(sessionToken(req)).catch(() => {});
    return { ...json(200, { ok: true }), headers: { 'set-cookie': sessionCookie(req, '') } };
  },

  'POST /api/auth/signout-everywhere': async (req) => {
    if (!req.user) throw httpError(401, 'Sign in first.');
    const count = await accounts.deleteUserSessions(req.user.id);
    return { ...json(200, { ok: true, count }), headers: { 'set-cookie': sessionCookie(req, '') } };
  },

  'GET /api/auth/me': async (req) =>
    json(200, {
      accounts: Boolean(accounts),
      user: userView(req.user || null),
      sessions: req.user ? await accounts.countSessions(req.user.id) : 0,
    }),

  'POST /api/auth/password': async (req) => {
    if (!req.user) throw httpError(401, 'Sign in first.');
    const { current = '', next = '' } = await body(req);
    const found = await accounts.credentialsById(req.user.id);
    if (!(await verifyPassword(String(current), found?.hash))) throw httpError(400, 'Your current password is not right.');
    const problem = passwordProblem(String(next), req.user);
    if (problem) throw httpError(400, problem);
    // A password the user chose: only its hash is kept, and any admin-kept copy goes.
    await accounts.setPassword(req.user.id, await hashPassword(String(next)));
    // Other browsers signed in with the old password are signed out.
    const signedOut = await accounts.deleteUserSessions(req.user.id, { keep: req.sessionId });
    return json(200, { ok: true, signedOut });
  },

  'GET /account': async () => {
    if (!accounts) return redirect('/');
    return fileResult(path.join(PUBLIC_DIR, 'account.html'), MIME['.html']);
  },

  // ---- the admin area (role checked before any of these run)

  'GET /admin': async () => fileResult(path.join(ADMIN_DIR, 'admin.html'), MIME['.html']),
  'GET /admin/admin.js': async () => fileResult(path.join(ADMIN_DIR, 'admin.js'), MIME['.js']),

  'GET /api/admin/users': async (req) =>
    json(200, { users: await accounts.list(), me: req.user.id, lookup: Boolean(LOOKUP_KEY) }),

  'POST /api/admin/users': async (req) => {
    const { username = '', email = '', role = 'user', password = '' } = await body(req);
    const chosen = adminPassword(String(password), { username, email });
    const user = await accounts.create({
      username,
      email,
      role,
      passwordHash: await hashPassword(chosen),
      adminSet: true,
      sealed: LOOKUP_KEY ? sealPassword(LOOKUP_KEY, chosen) : null,
      createdBy: req.user.id,
    });
    // The password is shown once, here; afterwards only lookup (if on) can show it.
    return json(200, { user, password: chosen });
  },

  'POST /api/admin/users/update': async (req) => {
    const { id, role, status, email } = await body(req);
    const user = await targetUser(id);
    if (user.id === req.user.id && (role !== undefined || status !== undefined)) {
      throw httpError(400, 'You cannot change your own role or switch yourself off.');
    }
    if ((role === 'user' || status === 'disabled') && (await lastAdmin(user))) {
      throw httpError(400, 'This is the only administrator. Make someone else an administrator first.');
    }
    const updated = await accounts.update(user.id, { role, status, email });
    if (status === 'disabled') await accounts.deleteUserSessions(user.id);
    return json(200, { user: updated });
  },

  'POST /api/admin/users/reset': async (req) => {
    const { id, password = '' } = await body(req);
    const user = await targetUser(id);
    const chosen = adminPassword(String(password), user);
    await accounts.setPassword(user.id, await hashPassword(chosen), {
      adminSet: true,
      sealed: LOOKUP_KEY ? sealPassword(LOOKUP_KEY, chosen) : null,
    });
    // Signed out everywhere: the old password no longer gets anyone in.
    await accounts.deleteUserSessions(user.id);
    return json(200, { user: await accounts.get(user.id), password: chosen });
  },

  'POST /api/admin/users/lookup': async (req) => {
    const { id } = await body(req);
    await targetUser(id);
    if (!LOOKUP_KEY) throw httpError(400, 'Password lookup is off: PASSWORD_LOOKUP_KEY is not set.');
    const found = await accounts.credentialsById(id);
    if (!found.sealed) {
      return json(200, {
        password: null,
        reason: found.user.adminSetPassword ? 'This password was set before lookup was switched on.' : 'This person chose their own password, which no one can look up.',
      });
    }
    const password = openPassword(LOOKUP_KEY, found.sealed);
    return json(200, password ? { password } : { password: null, reason: 'It could not be decrypted; the lookup key may have changed.' });
  },

  'POST /api/admin/users/signout': async (req) => {
    const { id } = await body(req);
    const user = await targetUser(id);
    return json(200, { ok: true, count: await accounts.deleteUserSessions(user.id) });
  },

  'POST /api/admin/users/delete': async (req) => {
    const { id, confirm = '' } = await body(req);
    const user = await targetUser(id);
    if (user.id === req.user.id) throw httpError(400, 'You cannot delete your own account.');
    if (await lastAdmin(user)) throw httpError(400, 'This is the only administrator.');
    if (String(confirm).trim().toLowerCase() !== user.username.toLowerCase()) {
      throw httpError(400, `Type the username, ${user.username}, to confirm.`);
    }
    const library = await accounts.delete(user.id);
    if (library) await backend.deleteOwner(library);
    return json(200, { ok: true });
  },

  // `hosted` tells the page which features exist; it is not a saved setting.
  'GET /api/config': async () => json(200, { ...(await readConfig()), hosted: HOSTED }),

  'POST /api/config': async (req) => json(200, await writeConfig(await body(req))),

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

  /**
   * What there is to read, for the Read tab: every item, newest first, with
   * only a feed's newest edition (as in the Library), each with its summary —
   * a feed's articles, a book's description and cover, a note's opening.
   */
  'GET /api/reading': async () => {
    const items = await outbox.list();
    pruneSummaries(items.map((i) => i.id));
    const seenFeeds = new Set();
    const current = items.filter((i) => {
      const feedId = i.source?.feedId;
      if (!feedId) return true;
      if (seenFeeds.has(feedId)) return false;
      seenFeeds.add(feedId);
      return true;
    });
    // Each feed's website, for the link beside its name: saved on the feed or
    // its edition, or, for an edition built before sites were kept, the site
    // of the first story it links to.
    const followed = new Map((await feeds.list()).map((f) => [f.id, f]));
    const withSite = (summary, item) => {
      if (summary.kind !== 'feed') return summary;
      const site = [item.source?.site, followed.get(item.source?.feedId)?.site, siteOf({ items: [{ link: summary.firstLink }] })]
        .find((s) => siteLabel(s));
      return site ? { ...summary, site, siteLabel: siteLabel(site) } : summary;
    };
    const summaries = [];
    for (const item of current) {
      try {
        const summary = await summarize(item, () => outbox.readEpub(item));
        // Worked out now: save it with the item, so next time is instant.
        if (item.summary?.v !== SUMMARY_VERSION) await outbox.update(item.id, { summary: savedSummary(summary) }).catch(() => {});
        summaries.push(withSite(summary, item));
      } catch {
        // An unreadable file still shows up, just without a summary.
        summaries.push({ id: item.id, kind: item.source?.kind || 'file', title: item.title, builtAt: item.builtAt, articles: [], excerpt: '' });
      }
    }
    return json(200, { items: summaries });
  },

  // The pending queue, so the page can show it after a reload or a restart.
  'GET /api/outbox': async (req, url) => {
    // Delivered entries stay visible by default: the UI dims them and shows
    // where they went, which is more useful than silently emptying the list,
    // and "Clear" is what removes them.
    const includeDelivered = url.searchParams.get('pending') !== '1';
    // Saved summaries are for /api/reading; the queue does not need them.
    const items = (await outbox.list({ includeDelivered })).map(({ summary, ...item }) => item);
    return json(200, { items });
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
      const book = await readEpub(await outbox.readEpub(entry));
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
      const book = await readEpub(await outbox.readEpub(entry));
      const chapter = await readChapter(book, index, {
        imageUrl: (internal) => `/out/${entry.id}/epub/${internal.split('/').map(encodeURIComponent).join('/')}`,
      });
      return json(200, chapter);
    } catch (err) {
      return json(400, { error: err.message });
    }
  },

  /**
   * The On reader switch on a Library card.
   *
   * On: the item goes to the reader at the next sync — or, if it is there and
   * was about to be taken off, it now stays. Off: it is not sent, and if it is
   * on the reader it comes off at the next sync. Either way the app keeps its
   * copy, so the item can still be read here.
   */
  'POST /api/outbox/on-reader': async (req) => {
    const { id, on } = await body(req);
    const entry = await outbox.get(id);
    if (!entry) return json(404, { error: 'That item is no longer here.' });

    // A feed is switched as a whole: its edition on the reader and the newer
    // one waiting to replace it go on or off together.
    const feedId = entry.source?.feedId;
    const targets = feedId
      ? (await outbox.list()).filter((i) => i.source?.feedId === feedId)
      : [entry];

    const onReader = Boolean(on);
    for (const target of targets) {
      const folder = normalizePath(target.folder || BOOKS_FOLDER);
      await outbox.update(target.id, { onReader });
      if (!target.deliveredAt) continue;
      if (onReader) await removals.remove(folder, target.filename);
      else await removals.add({ folder, filename: target.filename, title: target.title || target.filename });
    }
    return json(200, { ok: true, item: await outbox.get(id), pending: (await removals.list()).length });
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

    // Images pasted into drafts (nothing else refers to them once drafts go),
    // and built files the queue no longer knew about.
    const stray = await stores().clearFiles();

    // A wipe cannot be undone, so the log says when it happened and which
    // browser asked for it.
    console.log(
      `  ${new Date().toLocaleString()}  Remove everything: ${plural(items.length, 'item')}, ` +
        `${plural(followed.length, 'feed')}, ${plural(written.length, 'draft')}` +
        `${fromDevice ? ', reader copies queued for removal' : ''}. ` +
        `Browser: ${String(req.headers['user-agent'] || 'none').slice(0, 200)}`
    );

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
    await ensureRoom({ items: wanted.length, builds: wanted.length });

    const results = [];

    for (const book of wanted) {
      const label = book.title || book.epubUrl;
      try {
        if (!/^https?:\/\//i.test(String(book.epubUrl || ''))) throw new Error('Missing a download URL.');

        const buffer = await downloadBook(book.epubUrl);
        const filename = bookFilename(book, safeFilename);

        const id = randomUUID();
        const stored = await outbox.saveEpub(id, filename, buffer);

        // Read the real spine length so the queue shows a chapter count rather
        // than a blank, and so the preview label is accurate.
        let chapters = null;
        try {
          chapters = (await readEpub(buffer)).spine.length;
        } catch {
          /* it validated as an EPUB above; a odd package just means no count */
        }

        await outbox.add({
          id,
          filename,
          title: book.title || filename.replace(/\.epub$/, ''),
          author: book.author || '',
          ...stored,
          size: buffer.length,
          folder: BOOKS_FOLDER,
          mode: 'text',
          chapters,
          source: { kind: 'book', label, bookId: book.id || book.pageUrl || book.epubUrl, from: book.pageUrl || '' },
        });

        results.push({ ok: true, id, title: label, filename, size: buffer.length });
        await countBuilds(1);
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
    await ensureRoom({ feeds: 1 });
    try {
      const { feed, added } = await feeds.add(payload);
      // Probe the feed straight away so a typo surfaces now, not on refresh.
      if (added) {
        try {
          const fetched = await fetchFeedShared(feed.url);
          const updated = await feeds.update(feed.id, {
            title: feed.title || fetched.title,
            site: siteOf(fetched),
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

  // New articles waiting in each feed, without refreshing anything.
  'GET /api/feeds/check': async () => {
    const results = await checkFeedsForNew();
    return json(200, { feeds: results, newCount: results.reduce((n, r) => n + r.newCount, 0) });
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
    await ensureRoom({ builds: targets.length });

    // The page refreshes everything when it loads, so a reload — or a second
    // tab — mid-refresh would otherwise start another run alongside it and
    // build every edition twice. Later callers wait for the run in progress.
    if (!payload.id) {
      const owner = stores().owner;
      if (!refreshAllRuns.has(owner)) {
        refreshAllRuns.set(owner, refreshTargets(targets).finally(() => refreshAllRuns.delete(owner)));
      }
      const results = await refreshAllRuns.get(owner);
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
    const targets = stores().folders || {};
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
    // A sync with nothing to upload still has work to do when files are queued
    // to come off the reader — switching an item off is exactly that.
    if (!ids.length && !(await removals.list()).length) {
      return json(400, { error: 'Nothing selected to send.' });
    }

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
      // Switched off in the Library: it stays here, and does not go over.
      if (entry.onReader === false) {
        results.push({ id, ok: false, filename: entry.filename, error: 'Switched off — not sent to the reader.' });
        continue;
      }

      const targetFolder = entry.folder ? normalizePath(entry.folder) : folder;
      try {
        await copyToVolume(volume, targetFolder, entry.filename, await outbox.readEpub(entry));

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

    // The folder the first file went to; each result names its own.
    const shownFolder = results.find((r) => r.ok)?.folder || folder;
    return json(200, {
      ok: results.every((r) => r.ok) && removed.every((r) => r.ok),
      host: volume.name,
      folder: shownFolder,
      path: targetDir(volume, shownFolder),
      results,
      removed,
    });
  },

  'POST /api/convert': async (req) => {
    const payload = await body(req);
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) return json(400, { error: 'No items to convert.' });
    await ensureRoom({ items: items.length, builds: items.length });

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
        await countBuilds(1);
      } catch (err) {
        results.push({ ok: false, label, error: err.message });
      }
    }
    return json(200, { results });
  },

  'POST /api/send': async (req) => {
    const payload = await body(req);
    const ids = Array.isArray(payload.ids) ? payload.ids : [];
    // A sync with nothing to upload still has work to do when files are queued
    // to come off the reader — switching an item off is exactly that.
    if (!ids.length && !(await removals.list()).length) {
      return json(400, { error: 'Nothing selected to send.' });
    }

    const config = await readConfig();
    // Where a queued item goes is decided by what it is, not by a form field:
    // every item carries its folder; only entries from before 2.0 may have
    // none, and those were books.
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
      // Switched off in the Library: it stays here, and does not go over.
      if (entry.onReader === false) {
        results.push({ id, ok: false, filename: entry.filename, error: 'Switched off — not sent to the reader.' });
        continue;
      }

      // Feeds and notes carry their own folder; everything else uses the
      // folder chosen in the Send controls.
      const targetFolder = entry.folder ? normalizePath(entry.folder) : folder;
      try {
        if (targetFolder !== '/') await ensureDir(host, targetFolder);
        const buffer = await outbox.readEpub(entry);

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
      // The folder the first file went to; each result names its own.
      folder: results.find((r) => r.ok)?.folder || folder,
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
/**
 * A file that came off the reader because its item was switched off: the item
 * stays in the Library, readable here, and is no longer recorded as sent — so
 * switching it back on queues it to go over again.
 */
async function markTakenOff(folder, filename) {
  for (const entry of await outbox.list()) {
    if (entry.onReader !== false || !entry.deliveredAt || entry.filename !== filename) continue;
    if (normalizePath(entry.folder || BOOKS_FOLDER) !== folder) continue;
    await outbox.update(entry.id, { deliveredAt: null, deliveredTo: null });
  }
}

async function runRemovals(how) {
  const queued = await removals.list();
  const done = [];
  const finished = async (item) => {
    await removals.remove(item.folder, item.filename);
    await markTakenOff(item.folder, item.filename);
  };

  for (const item of queued) {
    try {
      await how.delete(item.folder, item.filename);
      await finished(item);
      done.push({ ok: true, folder: item.folder, filename: item.filename, title: item.title });
    } catch (err) {
      const gone = /not found|no such file|404/i.test(err.message || '');
      if (gone) await finished(item);
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

/** Whether a request carries the app's password, as HTTP Basic credentials. */
function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const given = decoded.slice(decoded.indexOf(':') + 1);
  // Compare digests so the comparison takes the same time whatever was typed.
  const digest = (text) => createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(given), digest(APP_PASSWORD));
}

// Device features: talking to a reader on the local network, copying to a card
// or synced folder on this computer, scanning the network for a reader, and
// showing a file in Finder. None of these mean anything on a hosted server, and
// the network scan and device probes would point at the host's own network.
const DEVICE_ROUTES = new Set([
  'GET /api/device',
  'POST /api/discover',
  'POST /api/send',
  'POST /api/send-volume',
  'GET /api/volumes',
  'POST /api/reveal',
]);

/** Whose library a request works on. Accounts (Phase 2) decide this per user. */
// Documents converted before 2.0 get their own reader folder, once per library
// per run (see moveDocumentsToTheirFolder).
const documentsMoved = new Set();
async function moveDocumentsOnce() {
  const library = stores();
  if (documentsMoved.has(library.owner)) return;
  documentsMoved.add(library.owner);
  try {
    const moved = await moveDocumentsToTheirFolder(library.outbox, library.removals);
    if (moved) console.log(`  ${moved} document(s) now go to ${DOCS_FOLDER} on the reader.`);
  } catch (err) {
    documentsMoved.delete(library.owner);
    console.warn(`  Could not give documents their reader folder: ${err.message}`);
  }
}

/** Whose library a request works on: the signed-in user's, or the one library. */
function ownerFor(req) {
  return req.user?.library || DEFAULT_OWNER;
}

function handle(req, res) {
  return handleRequest(req, res);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  const ip = clientIp(req, TRUST_PROXY_HOPS);
  const https = TRUST_PROXY_HOPS > 0 && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  for (const [name, value] of Object.entries(baseHeaders({ https }))) res.setHeader(name, value);
  // Every page gets the app's policy; reading pages replace it with their own.
  res.setHeader('content-security-policy', APP_CSP);

  // On your own computer, only requests addressed to this computer: a web
  // page cannot point its own name at 127.0.0.1 and read the library.
  if (LOOPBACK && !localHostAllowed(req.headers.host)) {
    return send(res, 403, 'text/plain', 'A-Pub Reader only answers requests addressed to this computer.');
  }

  // For the host's health checks, which come without the password.
  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, 'text/plain', 'ok');

  req.secure = https || (HOSTED && !LOOPBACK);

  if (accounts) {
    // Signed in? Everything but the sign-in page and its files needs it.
    const signedIn = await accounts.sessionUser(sessionToken(req)).catch(() => null);
    if (signedIn?.user.status === 'active') {
      req.user = signedIn.user;
      req.sessionId = signedIn.sessionId;
    }
    if (!req.user && !PUBLIC_PATHS.has(key)) {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname + url.search)}`;
        res.writeHead(302, { location: `/signin${next}`, 'cache-control': 'no-store' });
        return res.end();
      }
      return send(res, 401, 'application/json', JSON.stringify({ error: 'Sign in first.', signin: true }));
    }
    // The admin area: its pages are served only after this check, never from public/.
    if ((url.pathname === '/admin' || url.pathname.startsWith('/admin/') || url.pathname.startsWith('/api/admin/')) && req.user?.role !== 'admin') {
      return send(res, 403, url.pathname.startsWith('/api/') ? 'application/json' : 'text/plain',
        url.pathname.startsWith('/api/') ? JSON.stringify({ error: 'Only administrators can do that.' }) : 'Only administrators can open this page.');
    }
  } else if (APP_PASSWORD) {
    if (authFailures.blocked(ip).blocked) {
      res.setHeader('retry-after', String(authFailures.blocked(ip).retryAfter));
      return send(res, 429, 'text/plain', 'Too many wrong passwords. Try again in a few minutes.');
    }
    if (!authorized(req)) {
      // A first visit asks without credentials; only a wrong password counts.
      if (req.headers.authorization) authFailures.hit(ip);
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="A-Pub Reader", charset="UTF-8"',
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end('A-Pub Reader needs its password.');
    }
  }

  // Without accounts there is no admin area and no account to manage.
  if (!accounts && (url.pathname === '/admin' || url.pathname.startsWith('/admin/') || url.pathname.startsWith('/api/admin/') ||
      ['POST /api/auth/password', 'POST /api/auth/signout-everywhere'].includes(key))) {
    return send(res, 404, 'text/plain', 'Not found');
  }

  // From here on, the request works on one library: the signed-in user's.
  return ownerContext.run(ownerFor(req), () => routeRequest(req, res, url, key, ip));
}

async function routeRequest(req, res, url, key, ip) {
  await moveDocumentsOnce();

  // Anything that changes something must come from the app's own pages, not
  // from another site the browser happens to have open.
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
    return send(res, 403, 'application/json', JSON.stringify({ error: 'That request came from another site and was refused.' }));
  }

  if (HOSTED && HEAVY_ROUTES.has(key)) {
    const limit = heavyWork.hit(ip);
    if (!limit.ok) {
      res.setHeader('retry-after', String(limit.retryAfter));
      return send(res, 429, 'application/json', JSON.stringify({ error: 'That is a lot of fetching and converting in a short time. Try again in a few minutes.' }));
    }
  }
  req.bodyLimit = BODY_LIMITS[key] || DEFAULT_BODY_BYTES;

  if (HOSTED && DEVICE_ROUTES.has(key)) {
    return send(
      res,
      403,
      'application/json',
      JSON.stringify({ error: 'Syncing with a reader works only when A-Pub Reader runs on your own computer.' })
    );
  }

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
      const book = await readEpub(await outbox.readEpub(entry));
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
      const html = await renderWebPage(entry, { hosted: HOSTED, load: () => outbox.readEpub(entry) });
      res.writeHead(200, {
        'content-type': MIME['.html'],
        'cache-control': 'no-store',
        // Chapters are HTML from wherever the item came from, served as a page
        // of their own. The only script allowed is the app's own file for the
        // On reader switch: nothing inline (so no handler attributes) and
        // nothing from the book or another site, rather than trusting that
        // conversion stripped every script.
        'content-security-policy':
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
    if (!(job?.pages || job?.pageDir) || index < 1 || index > job.pageCount) {
      return send(res, 404, 'text/plain', 'Not found');
    }
    try {
      const data = await outbox.readPage(job, index);
      if (!data) return send(res, 404, 'text/plain', 'Not found');
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': data.length, 'cache-control': 'no-store' });
      return res.end(data);
    } catch {
      return send(res, 404, 'text/plain', 'Not found');
    }
  }

  // Every eBook in the library as one zip, in the folders they use on the reader.
  if (req.method === 'GET' && url.pathname === '/download/ebooks.zip') {
    return sendLibraryZip(res);
  }

  // Local EPUB download (also the "keep a copy" path).
  if (req.method === 'GET' && url.pathname.startsWith('/out/')) {
    const job = await outbox.get(url.pathname.slice('/out/'.length));
    if (!job) return send(res, 404, 'text/plain', 'Not found');
    const data = await outbox.readEpub(job);
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
      const { status, type, payload, headers } = await route(req, url);
      for (const [name, value] of Object.entries(headers || {})) res.setHeader(name, value);
      return send(res, status, type, payload);
    } catch (err) {
      return send(res, err.status || 500, 'application/json', JSON.stringify({ error: err.message }));
    }
  }

  if (req.method === 'GET') return serveStatic(res, url.pathname);
  return send(res, 404, 'text/plain', 'Not found');
}

/**
 * Stream every EPUB in the library as one zip. EPUBs are already compressed,
 * so they are stored rather than squeezed again, and the zip is streamed so a
 * large library never sits in memory whole.
 */
async function sendLibraryZip(res) {
  const items = await outbox.list();
  if (!items.length) return send(res, 404, 'text/plain', 'There are no eBooks to download yet.');
  const zip = new JSZip();
  const used = new Set();
  for (const item of items) {
    const folder = normalizePath(item.folder || BOOKS_FOLDER).replace(/^\/+/, '');
    let name = `${folder}/${item.filename}`;
    // Two items may share a filename (a feed and its replacement); keep both.
    for (let n = 2; used.has(name); n++) name = `${folder}/${item.filename.replace(/\.epub$/i, '')} (${n}).epub`;
    used.add(name);
    zip.file(name, await outbox.readEpub(item));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="A-Pub Reader eBooks ${stamp}.zip"`,
    'cache-control': 'no-store',
  });
  zip
    .generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'STORE' })
    .on('error', () => res.destroy())
    .pipe(res);
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

/** An error that carries the HTTP status to answer with. */
const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * A request's JSON body, within the size allowed for its route. Bodies must be
 * sent as application/json: a plain form or text post from another site cannot
 * set that type without the browser asking this server first, and it doesn't
 * say yes.
 */
function body(req) {
  const limit = req.bodyLimit || DEFAULT_BODY_BYTES;
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(httpError(413, `That is too large to send (the limit here is ${Math.round(limit / 1048576)} MB).`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, `That is too large to send (the limit here is ${Math.round(limit / 1048576)} MB).`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        return reject(httpError(415, 'Requests must be sent as JSON.'));
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'Invalid JSON body.'));
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

server.listen(PORT, HOST, async () => {
  const config = await readConfig();
  if (HOSTED) {
    console.log(`\n  A-Pub Reader (hosted)  →  listening on ${HOST}:${PORT}`);
    console.log(`  sign-in: ${accounts ? 'accounts' : APP_PASSWORD ? 'shared password' : 'off'}   device features: off\n`);
    return;
  }
  console.log(`\n  A-Pub Reader  →  http://localhost:${PORT}`);
  console.log(`  reader: ${config.host}`);
  console.log('  On the reader: open File Transfer and join Wi-Fi.\n');
});
