// RSS and Atom parsing, and composing a feed into one HTML document.
//
// Parsing walks the tree by localName rather than using CSS selectors, so the
// same code handles RSS 2.0, RDF/RSS 1.0 and Atom, and namespace prefixes come
// out for free: `content:encoded` has localName `encoded`, `dc:creator` has
// `creator`. Selector-based parsing trips over both of those.

import { userAgent } from './useragent.mjs';
import { JSDOM } from 'jsdom';
import { explainHttpFailure } from './httperror.mjs';
import { blockedReason, safeFetch } from './netguard.mjs';

const FETCH_TIMEOUT_MS = 30000;

// The app names itself honestly (see useragent.mjs).
const UA = userAgent;

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
/**
 * The picture a feed gives for an item, as an absolute http(s) address, or ''.
 * In order: media:content or media:thumbnail (the largest, also inside a
 * media:group), an image enclosure, itunes:image, then the first <img> in the
 * item's own text. Tiny images (tracking pixels) are skipped.
 */
function imageOf(item, base) {
  const absolute = (value) => {
    try {
      const url = new URL(String(value || '').trim(), base || undefined);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  };
  const media = [];
  const collect = (node) => {
    for (const el of childList(node, 'content', 'thumbnail')) {
      const url = el.getAttribute?.('url');
      if (!url) continue;
      const type = (el.getAttribute('type') || '').toLowerCase();
      const medium = (el.getAttribute('medium') || '').toLowerCase();
      if (el.localName.toLowerCase() === 'content' && medium !== 'image' && !type.startsWith('image/') && !/\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) continue;
      const width = Number(el.getAttribute('width')) || 0;
      if (width && width < 80) continue;
      media.push({ url, width });
    }
  };
  collect(item);
  for (const group of childList(item, 'group')) collect(group);
  media.sort((a, b) => b.width - a.width);
  for (const candidate of media) {
    const url = absolute(candidate.url);
    if (url) return url;
  }
  for (const enclosure of childList(item, 'enclosure')) {
    if ((enclosure.getAttribute?.('type') || '').toLowerCase().startsWith('image/')) {
      const url = absolute(enclosure.getAttribute('url'));
      if (url) return url;
    }
  }
  const itunes = child(item, 'image');
  if (itunes?.getAttribute?.('href')) {
    const url = absolute(itunes.getAttribute('href'));
    if (url) return url;
  }
  for (const match of bodyOf(item).matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const width = Number(/\bwidth\s*=\s*["']?(\d+)/i.exec(tag)?.[1]) || 0;
    const height = Number(/\bheight\s*=\s*["']?(\d+)/i.exec(tag)?.[1]) || 0;
    if (!src || (width && width < 80) || (height && height < 60)) continue;
    const url = absolute(decodeEntities(src));
    if (url) return url;
  }
  return '';
}

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
  // A feed that declares its own entities is refused before parsing: nested
  // entities can expand a few hundred bytes into gigabytes ("billion laughs"),
  // and real feeds do not need them. (External entities are never resolved.)
  if (/<!ENTITY/i.test(cleaned)) throw new Error('That feed declares XML entities, which are not accepted.');
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

    const link = linkOf(node);
    items.push({
      title,
      link,
      // The item's picture, from the feed, for the web view's thumbnails.
      image: imageOf(node, link),
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

/**
 * A parsed feed with each item's date as a Date again. A feed kept in the
 * shared fetch cache (Postgres, when hosted) comes back from JSON with its
 * dates as text, and building an edition needs real dates.
 */
export function withDates(feed) {
  if (!feed || !Array.isArray(feed.items)) return feed;
  return {
    ...feed,
    items: feed.items.map((item) => {
      if (!item.date || item.date instanceof Date) return item;
      const date = new Date(item.date);
      return { ...item, date: Number.isNaN(date.getTime()) ? null : date };
    }),
  };
}

/**
 * Fetch and parse a feed URL.
 *
 * With `etag` / `lastModified` from the last fetch, it asks the publisher only
 * for something newer (If-None-Match / If-Modified-Since): an unchanged feed
 * answers 304, costing both sides almost nothing, and this returns
 * { notModified: true }. Otherwise the feed, with the new validators.
 */
export async function fetchFeed(url, { etag = '', lastModified = '' } = {}) {
  let target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;

  let res;
  try {
    res = await safeFetch(target, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      maxBytes: 10 * 1024 * 1024,
      redirect: 'follow',
      headers: {
        'user-agent': UA(),
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        ...(etag ? { 'if-none-match': etag } : {}),
        ...(lastModified ? { 'if-modified-since': lastModified } : {}),
      },
    });
  } catch (err) {
    const blocked = blockedReason(err);
    if (blocked) throw new Error(blocked);
    throw new Error(
      `Could not reach ${target}. If this Mac is on the reader's hotspot there is no internet. ` +
        `(${err.cause?.code || err.message})`
    );
  }
  if (res.status === 304 && (etag || lastModified)) return { notModified: true };
  if (!res.ok) throw await explainHttpFailure(res, { what: 'feed' });

  const xml = await res.text();
  const feed = parseFeed(xml);
  return {
    ...feed,
    url: res.url || target,
    etag: res.headers.get('etag') || '',
    lastModified: res.headers.get('last-modified') || '',
  };
}

// Editions are built only from what the feed itself contains: its full text
// where the publisher includes it (content:encoded and the like), otherwise
// its summary. The app never follows an item's link to take the article from
// the publisher's web page.

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

const webUrl = (value) => {
  try {
    const url = new URL(String(value || '').trim());
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
};

/**
 * The website a feed belongs to, for sending readers back to it.
 *
 * Every RSS feed names it: the channel's own <link> (Atom: <link
 * rel="alternate">) is the site's address — https://www.bbc.co.uk/news/world,
 * https://www.cjr.org. If a feed leaves it out, the site of its first story
 * stands in, then the site the feed itself is served from.
 */
export function siteOf(feed) {
  const named = webUrl(feed?.link);
  if (named) return named.href;
  for (const candidate of [feed?.items?.find((i) => webUrl(i.link))?.link, feed?.url]) {
    const url = webUrl(candidate);
    if (url) return `${url.origin}/`;
  }
  return '';
}

/** A site address as people say it: "bbc.co.uk", "pbs.org". */
export function siteLabel(address) {
  const url = webUrl(address);
  return url ? url.hostname.replace(/^www\./i, '') : '';
}

/**
 * One edition's HTML: each item as a chapter. Every article opens and closes
 * with links to where it came from: the story on its own site, and the site
 * itself, so reading from the feed still sends readers to the publisher.
 *
 * @param {{title, link}} feed  The feed's name and website (see siteOf).
 */
export function composeFeedHtml(feed, items) {
  const escape = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const name = String(feed?.title || '').trim();
  const site = webUrl(feed?.link)?.href || '';
  const siteLink = (text) => (site ? `<a href="${escape(site)}">${escape(text)}</a>` : escape(text));

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
    if (meta.length) parts.push(`<p><em>${meta.join(' · ')}</em></p>`);

    // Where the story came from, before it and after it.
    const story = webUrl(item.link);
    const host = siteLabel(story?.href || site);
    const storyLink = (text) => `<a href="${escape(story.href)}">${escape(text)}</a>`;
    const top = [];
    const bottom = [];
    if (name || site) top.push(`From ${siteLink(name || host)}`);
    if (story) {
      top.push(storyLink(`Read on ${host}`));
      bottom.push(storyLink(`Read the original on ${host}`));
    }
    if (site) bottom.push(siteLink(`More from ${name || host}`));
    if (top.length) parts.push(`<p class="cp-source">${top.join(' · ')}</p>`);

    parts.push(demoteHeadings(item.html) || '<p>(no content)</p>');

    if (bottom.length) parts.push(`<p class="cp-source">${bottom.join(' · ')}</p>`);
    parts.push('<hr/>');
  }

  return parts.join('\n');
}
