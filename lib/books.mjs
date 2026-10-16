// Browsing book catalogues and pulling finished EPUBs straight into the queue.
//
// This is deliberately not the RSS-to-EPUB path. A catalogue entry links to a
// real, properly produced EPUB — Standard Ebooks put more care into theirs than
// any converter could — so the file is downloaded and queued untouched. Nothing
// is re-extracted, re-typeset or re-encoded.

import JSZip from 'jszip';
import { fetchFeed } from './rss.mjs';

const MAX_BOOK_BYTES = 80 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120000;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Catalogues that work without an account. Standard Ebooks gates its subject
// and complete feeds behind a (free) patron key, so only new releases is here;
// any other feed URL with EPUB enclosures can be pasted in.
export const CATALOGUES = [
  {
    id: 'standardebooks-new',
    label: 'Standard Ebooks — new releases',
    url: 'https://standardebooks.org/rss/new-releases',
    note: 'Public-domain classics, carefully typeset. Around 15 recent titles.',
  },
];

/**
 * Choose which attached file to download.
 *
 * Standard Ebooks offers several builds per title. The "compatible" one targets
 * older e-readers, which is exactly this device; the "advanced" one uses newer
 * EPUB3 features an ESP32 reader is less likely to handle. Kobo's `.kepub` is a
 * different format wearing an epub extension, so it is excluded outright.
 */
export function pickEpub(enclosures = []) {
  const candidates = enclosures.filter(
    (e) => e.type === 'application/epub+zip' && !/\.kepub\.epub($|\?)/i.test(e.href)
  );
  if (!candidates.length) return null;

  const score = (e) => {
    const label = `${e.title} ${e.href}`.toLowerCase();
    if (/compatible/.test(label)) return 0; // explicitly recommended for older readers
    if (/advanced/.test(label)) return 2;
    return 1;
  };

  return [...candidates].sort((a, b) => score(a) - score(b) || (a.bytes || 0) - (b.bytes || 0))[0];
}

const stripTags = (html) =>
  String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Read a catalogue feed into a list of downloadable books.
 *
 * @returns {Promise<{title, url, books: Array, skipped: number}>}
 */
export async function fetchCatalogue(url) {
  const feed = await fetchFeed(url);

  const books = [];
  let skipped = 0;

  for (const item of feed.items) {
    const epub = pickEpub(item.enclosures);
    if (!epub) {
      // An article feed, or an entry offering only formats this device can't read.
      skipped++;
      continue;
    }

    const summary = stripTags(item.html);
    books.push({
      // The entry's own page URL is stable, so it survives a re-browse and can
      // be used to spot a title that is already queued.
      id: item.link || epub.href,
      title: item.title,
      author: item.author || '',
      summary: summary.length > 400 ? `${summary.slice(0, 399)}…` : summary,
      pageUrl: item.link || '',
      epubUrl: epub.href,
      bytes: epub.bytes || 0,
      format: epub.title || 'epub',
      published: item.date ? item.date.toISOString() : null,
    });
  }

  return { title: feed.title, url: feed.url, books, skipped };
}

/**
 * Download one book and check it really is an EPUB before queueing it.
 *
 * A catalogue can hand back an HTML error page with a 200, and queueing that
 * would put a file on the reader that fails to open with no explanation.
 */
export async function downloadBook(epubUrl) {
  let res;
  try {
    res = await fetch(epubUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/epub+zip,*/*' },
    });
  } catch (err) {
    throw new Error(
      `Could not download the book. If this Mac is on the reader's hotspot there is no internet. ` +
        `(${err.cause?.code || err.message})`
    );
  }
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length')) || 0;
  if (declared > MAX_BOOK_BYTES) throw new Error(`That book is ${Math.round(declared / 1048576)} MB, which is too large.`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('The download was empty.');
  if (buffer.length > MAX_BOOK_BYTES) throw new Error('That book is too large.');

  // A zip starts "PK"; an EPUB additionally stores "mimetype" first.
  if (buffer.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new Error('That download is not an EPUB (probably an error page).');
  }
  try {
    const zip = await JSZip.loadAsync(buffer);
    const mimetype = (await zip.file('mimetype')?.async('string'))?.trim();
    if (mimetype && mimetype !== 'application/epub+zip') {
      throw new Error(`That file claims to be ${mimetype}, not an EPUB.`);
    }
    if (!zip.file('META-INF/container.xml')) throw new Error('That EPUB has no container.xml.');
  } catch (err) {
    throw new Error(`That download is not a readable EPUB: ${err.message}`);
  }

  return buffer;
}

/** Filename for a downloaded book: "Author - Title.epub" reads well on-device. */
export function bookFilename(book, safeFilename) {
  const stem = book.author ? `${book.author} - ${book.title}` : book.title;
  return `${safeFilename(stem) || 'Book'}.epub`;
}
