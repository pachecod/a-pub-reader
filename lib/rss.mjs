// RSS and Atom parsing, and composing a feed into one HTML document.
//
// Parsing walks the tree by localName rather than using CSS selectors, so the
// same code handles RSS 2.0, RDF/RSS 1.0 and Atom, and namespace prefixes come
// out for free: `content:encoded` has localName `encoded`, `dc:creator` has
// `creator`. Selector-based parsing trips over both of those.

import { JSDOM } from 'jsdom';
import { explainHttpFailure } from './httperror.mjs';

const FETCH_TIMEOUT_MS = 30000;
const ARTICLE_TIMEOUT_MS = 25000;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** First child element with one of these localNames, case-insensitive. */
function child(parent, ...names) {
  if (!parent) return null;
  const wanted = names.map((n) => n.toLowerCase());
  for (const node of parent.children || []) {
    if (wanted.includes(node.localName?.toLowerCase())) return node;
  }
  return null;
}

function childList(parent, ...names) {
  if (!parent) return [];
  const wanted = names.map((n) => n.toLowerCase());
  return [...(parent.children || [])].filter((n) => wanted.includes(n.localName?.toLowerCase()));
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', middot: '·', bull: '•', deg: '°', trade: '™',
  copy: '©', reg: '®', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö',
};

/**
 * Decode entities left in text after XML parsing.
 *
 * Plenty of publishers double-encode, so a feed literally contains
 * `&amp;#8217;`. The XML parser correctly turns that into the text `&#8217;`,
 * which then has to be decoded again or it shows up verbatim in the book. Runs
 * a couple of passes to catch triple-encoding, which also happens.
 */
export function decodeEntities(text) {
  let value = String(text || '');
  for (let pass = 0; pass < 3; pass++) {
    const before = value;
    value = value
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
      .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
    if (value === before) break;
  }
  return value;
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

const textOf = (el) => decodeEntities((el?.textContent || '').replace(/\s+/g, ' ').trim());

/** Atom puts the URL in an attribute; RSS puts it in the element's text. */
function linkOf(item) {
  for (const link of childList(item, 'link')) {
    const href = link.getAttribute?.('href');
    const rel = (link.getAttribute?.('rel') || 'alternate').toLowerCase();
    if (href && rel === 'alternate') return href.trim();
    const inner = textOf(link);
    if (inner) return inner;
  }
  // RSS 2.0 allows a permalink guid to stand in for a missing link.
  const guid = child(item, 'guid');
  const guidText = textOf(guid);
  if (guidText && /^https?:\/\//i.test(guidText)) return guidText;
  return '';
}

/**
 * Attached files. Atom uses <link rel="enclosure"> (and OPDS uses
 * rel="…/acquisition"); RSS 2.0 uses a single <enclosure> element.
 */
function enclosuresOf(item) {
  const found = [];

  for (const link of childList(item, 'link')) {
    const rel = (link.getAttribute?.('rel') || '').toLowerCase();
    const href = link.getAttribute?.('href');
    if (!href) continue;
    // OPDS acquisition rels are full URIs ending in /acquisition or a subtype.
    if (rel !== 'enclosure' && !rel.includes('acquisition')) continue;
    found.push({
      href: href.trim(),
      type: (link.getAttribute?.('type') || '').toLowerCase(),
      title: link.getAttribute?.('title') || '',
      bytes: Number(link.getAttribute?.('length')) || 0,
    });
  }

  for (const enclosure of childList(item, 'enclosure')) {
    const href = enclosure.getAttribute?.('url') || enclosure.getAttribute?.('href');
    if (!href) continue;
    found.push({
      href: href.trim(),
      type: (enclosure.getAttribute?.('type') || '').toLowerCase(),
      title: '',
      bytes: Number(enclosure.getAttribute?.('length')) || 0,
    });
  }

  return found;
}

function dateOf(item) {
  const raw =
    textOf(child(item, 'pubDate')) ||
    textOf(child(item, 'published')) ||
    textOf(child(item, 'updated')) ||
    textOf(child(item, 'date')); // dc:date on RSS 1.0
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Pick the richest body a feed offers.
 *
 * `content:encoded` is usually the full post; `description` is often a
 * truncated teaser. Atom's `content` beats its `summary` for the same reason.
 */
function bodyOf(item) {
  const candidates = [
    child(item, 'encoded'), // content:encoded
    child(item, 'content'),
    child(item, 'description'),
    child(item, 'summary'),
    child(item, 'subtitle'),
  ];
  let best = '';
  for (const node of candidates) {
    if (!node) continue;
    const value = (node.textContent || '').trim();
    if (value.length > best.length) best = value;
  }
  return best;
}

/**
 * Parse feed XML.
 *
 * @returns {{title, link, description, items: Array<{title, link, date, author, html}>}}
 */
export function parseFeed(xml) {
  // Strip a leading BOM or stray whitespace, which makes strict XML parsing fail.
  const cleaned = String(xml || '').replace(/^﻿/, '').trimStart();
  const dom = new JSDOM(cleaned, { contentType: 'text/xml' });
  const doc = dom.window.document;

  if (doc.querySelector('parsererror')) throw new Error('That URL did not return valid feed XML.');

  const root = doc.documentElement;
  if (!root) throw new Error('Empty feed.');

  const rootName = root.localName?.toLowerCase();
  // RSS 2.0 wraps everything in <channel>; Atom and RSS 1.0 do not.
  const channel = child(root, 'channel') || root;

  if (!['rss', 'feed', 'rdf'].includes(rootName)) {
    throw new Error(`Not an RSS or Atom feed (root element is <${root.localName}>).`);
  }

  // RSS 1.0 puts <item> as a sibling of <channel>, under the root.
  const itemNodes = [...childList(channel, 'item', 'entry'), ...childList(root, 'item', 'entry')];
  const seen = new Set();
  const items = [];

  for (const node of itemNodes) {
    if (seen.has(node)) continue;
    seen.add(node);

    const title = textOf(child(node, 'title')) || '(untitled)';
    const html = bodyOf(node);
    const author =
      textOf(child(node, 'creator')) || // dc:creator
      textOf(child(child(node, 'author'), 'name')) || // Atom
      textOf(child(node, 'author'));

    items.push({
      title,
      link: linkOf(node),
      date: dateOf(node),
      author,
      html,
      // Catalogue feeds attach the actual files. Kept here so a book feed can
      // be told apart from an article feed and downloaded rather than scraped.
      enclosures: enclosuresOf(node),
    });
  }

  // Newest first, with undated items kept in document order at the end.
  items.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));

  return {
    title: textOf(child(channel, 'title')) || 'Untitled feed',
    link: linkOf(channel),
    description: textOf(child(channel, 'description', 'subtitle')),
    items,
  };
}

/** Fetch and parse a feed URL. */
export async function fetchFeed(url) {
  let target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;

  let res;
  try {
    res = await fetch(target, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
  } catch (err) {
    throw new Error(
      `Could not reach ${target}. If this Mac is on the reader's hotspot there is no internet. ` +
        `(${err.cause?.code || err.message})`
    );
  }
  if (!res.ok) throw await explainHttpFailure(res, { what: 'feed' });

  const xml = await res.text();
  const feed = parseFeed(xml);
  return { ...feed, url: res.url || target };
}

/**
 * Optionally replace each item's teaser with the full article.
 *
 * Many feeds ship only a truncated `description`, which makes for a poor read on
 * a device you took somewhere to read offline. Fetching the linked page and
 * running it through the normal article extractor fixes that; failures fall back
 * to whatever the feed gave us rather than dropping the item.
 */
export async function hydrateItems(items, { extractArticle, limit, onProgress }) {
  const hydrated = [];

  for (const [index, item] of items.slice(0, limit).entries()) {
    onProgress?.(index + 1, Math.min(items.length, limit), item.title);

    if (!item.link) {
      hydrated.push({ ...item, hydrated: false });
      continue;
    }

    try {
      const res = await fetch(item.link, {
        signal: AbortSignal.timeout(ARTICLE_TIMEOUT_MS),
        redirect: 'follow',
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (type && !/text\/html|application\/xhtml/.test(type)) throw new Error('not HTML');

      const article = await extractArticle({ html: await res.text(), url: res.url || item.link });
      const body = article.chapters.map((c) => c.body).join('\n');
      // Only take the fetched version if it beats the teaser; a paywall or
      // consent wall often extracts to less than the feed already had.
      if (body.replace(/<[^>]*>/g, '').trim().length > item.html.replace(/<[^>]*>/g, '').trim().length) {
        hydrated.push({ ...item, html: body, author: item.author || article.byline, hydrated: true });
        continue;
      }
      hydrated.push({ ...item, hydrated: false });
    } catch {
      hydrated.push({ ...item, hydrated: false });
    }
  }

  return hydrated;
}

/**
 * Compose items into one HTML document, one `<h2>` per item.
 *
 * The chapter splitter already breaks on h2, so this gives one EPUB chapter per
 * article with a working table of contents, and lets the whole feed go through
 * a single sanitize/image-embed pass — which also keeps image filenames from
 * colliding between items.
 */
/**
 * Shift an item's own headings down one level.
 *
 * The chapter splitter breaks on h1/h2, and the per-item title is an h2. A post
 * containing its own h2 subheadings (a roundup, a review with sections) would
 * otherwise split into several chapters, so the table of contents would list
 * subheadings as if they were separate articles. Demoting keeps exactly one
 * chapter per item while preserving the internal structure.
 */
export function demoteHeadings(html) {
  return (
    String(html || '')
      // h6 first, before the shift can create new h6 tags: it has nowhere lower
      // to go, so it becomes a bold paragraph rather than being lost.
      .replace(/<h6\b[^>]*>/gi, '<p><strong>')
      .replace(/<\/h6>/gi, '</strong></p>')
      // Clamp to h3: the splitter breaks on h1 *and* h2, so demoting an item's
      // own h1 to h2 would still start a new chapter. Posts really do use h1
      // internally — a Verge roundup does exactly that.
      .replace(/<(\/?)h([1-5])\b/gi, (_, slash, level) => `<${slash}h${Math.max(3, Number(level) + 1)}`)
  );
}

export function composeFeedHtml(feed, items) {
  const escape = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const parts = [];
  for (const item of items) {
    parts.push(`<h2>${escape(item.title)}</h2>`);
    // Everything below this point in the item is its own content.

    const meta = [];
    if (item.author) meta.push(escape(item.author));
    if (item.date) {
      meta.push(
        item.date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      );
    }
    if (!item.hydrated && item.link) meta.push('summary only');
    if (meta.length) parts.push(`<p><em>${meta.join(' · ')}</em></p>`);

    parts.push(demoteHeadings(item.html) || '<p>(no content)</p>');

    // A link back to the source, so a truncated item can still be found later.
    if (item.link) parts.push(`<p><a href="${escape(item.link)}">${escape(item.link)}</a></p>`);
    parts.push('<hr/>');
  }

  return parts.join('\n');
}
