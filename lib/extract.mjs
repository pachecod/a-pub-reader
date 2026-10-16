// Turn raw HTML (a saved file or a fetched URL) into clean, EPUB-ready chapters.
//
// Two stages:
//   1. Readability strips nav/ads/boilerplate and hands back article HTML.
//   2. We whitelist the surviving markup down to what an e-ink reader renders
//      well, embed images we can actually fetch, and serialize to valid XHTML.

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

// Elements dropped entirely, with their subtree.
const DROP = new Set([
  'script', 'style', 'link', 'meta', 'noscript', 'template',
  'iframe', 'object', 'embed', 'canvas', 'svg', 'math',
  'video', 'audio', 'source', 'track', 'picture',
  'form', 'input', 'button', 'select', 'textarea', 'label', 'fieldset',
]);

// Elements unwrapped: children are kept, the wrapper itself is discarded.
const UNWRAP = new Set(['div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'span', 'font', 'center']);

// The only attributes that survive, per tag. '*' applies to every tag.
const KEEP_ATTRS = {
  '*': ['id', 'lang', 'dir'],
  a: ['href'],
  img: ['src', 'alt'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  ol: ['start', 'type'],
  blockquote: ['cite'],
};

const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
};

// Chrome that Readability scores generously but nobody wants in a book.
// Matched against class and id as whole hyphen/underscore-delimited words, so
// "read-more" is caught but "broadcast" is not.
const BOILERPLATE_WORDS =
  /(^|[-_\s])(ad|ads|adbox|advert|advertisement|promo|promotion|newsletter|subscribe|subscription|paywall|social|share|sharing|comments?|disqus|cookie|consent|banner|popup|modal|overlay|related|recirc|recommended|sidebar|breadcrumbs?|pagination|skip-link)([-_\s]|$)/i;

const MAX_IMAGES = 40;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * @param {object} opts
 * @param {string} opts.html      Raw source HTML.
 * @param {string} [opts.url]     Original URL, used to resolve relative links.
 * @param {boolean} [opts.includeImages]
 * @returns {Promise<{title, byline, lang, source, siteName, chapters, images, warnings, textLength}>}
 */
export async function extractArticle({
  html,
  url,
  includeImages = true,
  fragment = false,
  // Resolves an app-local image URL ("/assets/…") to {data, mediaType}.
  // Supplied when converting drafts, whose images live on this machine.
  resolveAsset = null,
  // Re-encodes fetched/loaded image bytes into a format the reader decodes.
  normalizeImage = null,
  // Leave <img src> exactly as authored instead of embedding into the EPUB.
  // Fixed-layout output needs the original locations so the page renderer can
  // load and draw each image itself.
  keepImageSources = false,
}) {
  const warnings = [];
  // jsdom never runs scripts here (runScripts is left unset), so hostile
  // markup in a dropped file cannot execute.
  const dom = new JSDOM(html, { url: url || 'https://localhost/' });
  const doc = dom.window.document;

  const docLang = doc.documentElement.getAttribute('lang');
  const docTitle = (doc.title || '').trim();
  // Readability often drops the article's own <h1>, and it is usually a
  // cleaner title than <title> — grab it before the document is mutated.
  const docHeading = (
    doc.querySelector('article h1, main h1, [role="main"] h1, h1')?.textContent || ''
  )
    .replace(/\s+/g, ' ')
    .trim();

  let article = null;
  let contentHtml;

  if (fragment) {
    // Content authored in the app's editor: there is no boilerplate to strip
    // and no article to find. Running Readability here would be actively
    // harmful — it discards anything under its character threshold, so short
    // drafts would come back empty.
    contentHtml = doc.body?.innerHTML || html;
  } else {
    precleanBoilerplate(doc);

    // Readability mutates the document it is given, so read metadata first.
    try {
      article = new Readability(doc, { charThreshold: 200, keepClasses: false }).parse();
    } catch (err) {
      warnings.push(`Readability failed (${err.message}); falling back to raw <body>.`);
    }

    contentHtml = article?.content;
    if (!contentHtml || contentHtml.replace(/<[^>]*>/g, '').trim().length < 40) {
      // Short or unparseable pages (a bare fragment, a table-only page) still
      // deserve an EPUB — just use everything we were given.
      if (!warnings.length) warnings.push('No clear article body found; converted the whole page.');
      const fresh = new JSDOM(html, { url: url || 'https://localhost/' });
      contentHtml = fresh.window.document.body?.innerHTML || html;
    }
  }

  const siteName = (article?.siteName || '').trim();
  const title = refineTitle(article?.title || docTitle, docHeading, siteName);
  const byline = cleanByline(article?.byline);
  const lang = normalizeLang(article?.lang || docLang);

  // Re-parse the cleaned fragment against the source URL so img/a URLs come
  // back absolute, then walk it under our own whitelist.
  const frag = new JSDOM(`<!DOCTYPE html><body><div id="cp-root">${contentHtml}</div></body>`, {
    url: url || 'https://localhost/',
  });
  const win = frag.window;
  const root = win.document.getElementById('cp-root');

  sanitize(root, win, warnings);

  const images = keepImageSources
    ? []
    : includeImages
      ? await embedImages(root, warnings, resolveAsset, normalizeImage)
      : (stripImages(root), []);

  flattenEmptyFigures(root, win);
  collapse(root, win);

  const chapters = splitIntoChapters(root, win, title);
  const textLength = root.textContent.replace(/\s+/g, ' ').trim().length;

  if (!textLength) warnings.push('Converted document has no text content.');

  return {
    title,
    byline,
    lang,
    siteName,
    source: url || '',
    chapters,
    images,
    warnings,
    textLength,
  };
}

/**
 * Remove obvious furniture before Readability scores the page. Readability
 * already discards most nav and footers, but promo boxes sitting inside the
 * article body score as content and come through.
 */
function precleanBoilerplate(doc) {
  const body = doc.body;
  if (!body) return;
  const totalText = body.textContent.replace(/\s+/g, ' ').trim().length;

  const candidates = [
    ...body.querySelectorAll(
      'nav, dialog, [role="navigation"], [role="banner"], [role="dialog"], [role="complementary"], [aria-hidden="true"]'
    ),
  ];
  for (const el of body.querySelectorAll('[class], [id]')) {
    const label = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;
    if (BOILERPLATE_WORDS.test(label)) candidates.push(el);
  }

  for (const el of candidates) {
    if (!el.isConnected) continue;
    // An unlucky class name on the article wrapper shouldn't delete the article.
    const share = el.textContent.replace(/\s+/g, ' ').trim().length;
    if (totalText > 0 && share / totalText > 0.25) continue;
    el.remove();
  }
}

/**
 * Prefer the article's own <h1> when <title> is the same headline wearing a
 * site name. Readability only splits on `| - / > »`, so "Site — Headline"
 * arrives intact.
 */
function refineTitle(rawTitle, heading, siteName) {
  const title = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!title) return heading || 'Untitled';
  if (!heading || heading.length < 8 || heading.length > 200) return title;

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const nTitle = norm(title);
  const nHeading = norm(heading);

  // The heading is the headline and the title just wraps it in site branding.
  if (nHeading !== nTitle && nTitle.includes(nHeading)) return heading;

  // Otherwise strip a leading or trailing site name if one is known.
  if (siteName) {
    const escaped = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const trimmed = title
      .replace(new RegExp(`^\\s*${escaped}\\s*[—–\\-|:·»]\\s*`, 'i'), '')
      .replace(new RegExp(`\\s*[—–\\-|:·»]\\s*${escaped}\\s*$`, 'i'), '')
      .trim();
    if (trimmed.length >= 8) return trimmed;
  }
  return title;
}

function cleanByline(byline) {
  return String(byline || '')
    .replace(/\s+/g, ' ')
    .replace(/^\s*(by|written by|author)\s*[:\-]?\s*/i, '')
    .replace(/\s*[|·]\s*.*$/, '') // drop trailing "· 5 min read" style cruft
    .trim();
}

/** Depth-first whitelist pass: drop, unwrap, and scrub attributes. */
function sanitize(root, win, warnings) {
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === win.Node.COMMENT_NODE) {
        child.remove();
        continue;
      }
      if (child.nodeType !== win.Node.ELEMENT_NODE) continue;

      const tag = child.tagName.toLowerCase();

      if (DROP.has(tag)) {
        child.remove();
        continue;
      }

      // Scrub attributes before recursing so nothing survives on unwrapped nodes.
      const allowed = new Set([...(KEEP_ATTRS['*'] || []), ...(KEEP_ATTRS[tag] || [])]);
      for (const attr of [...child.attributes]) {
        if (!allowed.has(attr.name.toLowerCase())) child.removeAttribute(attr.name);
      }

      // Only http(s) links are meaningful once the page is offline.
      if (tag === 'a') {
        const href = child.getAttribute('href') || '';
        if (!/^(https?:|#)/i.test(href)) child.removeAttribute('href');
      }

      walk(child);

      if (UNWRAP.has(tag)) unwrap(child, win);
    }
  };
  walk(root);
  if (root.querySelector('table')) {
    warnings.push('Contains a table — CrossPoint lays out simple tables as columns; complex ones may reflow oddly.');
  }
}

function unwrap(el, win) {
  const parent = el.parentNode;
  if (!parent) return;
  // A bare unwrapped block can leave inline text as a direct child of the
  // root; the chapter splitter wraps those back into <p> later.
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function stripImages(root) {
  for (const img of [...root.querySelectorAll('img')]) img.remove();
}

/** Fetch or load each image and rewrite src to an in-EPUB path. */
async function embedImages(root, warnings, resolveAsset, normalizeImage) {
  const imgs = [...root.querySelectorAll('img')];
  const images = [];
  const seen = new Map(); // source src -> epub path, so repeats are stored once
  let total = 0;
  let skipped = 0;

  for (const img of imgs) {
    const src = img.getAttribute('src') || '';

    if (seen.has(src)) {
      img.setAttribute('src', seen.get(src));
      continue;
    }

    // Images added in the app's own editor live on this machine, not the web.
    if (resolveAsset && src.startsWith('/assets/')) {
      const asset = await resolveAsset(src);
      if (!asset) {
        img.remove();
        skipped++;
        warnings.push(`An image in this draft is missing from the assets folder.`);
        continue;
      }
      const usable = normalizeImage ? await normalizeImage(asset.data) : asset;
      if (!usable) {
        img.remove();
        skipped++;
        warnings.push('An image in this draft could not be re-encoded for the reader.');
        continue;
      }
      const name = `img-${images.length + 1}.${usable.extension || (usable.mediaType === 'image/png' ? 'png' : 'jpg')}`;
      const epubPath = `images/${name}`;
      images.push({ path: epubPath, mediaType: usable.mediaType, data: usable.data });
      total += usable.data.length;
      seen.set(src, `../${epubPath}`);
      img.setAttribute('src', `../${epubPath}`);
      if (!img.getAttribute('alt')) img.setAttribute('alt', '');
      continue;
    }

    if (!/^https?:/i.test(src)) {
      // Relative path from a dropped local file: the image isn't on disk here.
      img.remove();
      skipped++;
      continue;
    }
    if (images.length >= MAX_IMAGES || total >= MAX_TOTAL_IMAGE_BYTES) {
      img.remove();
      skipped++;
      continue;
    }

    try {
      const res = await fetch(src, {
        signal: AbortSignal.timeout(15000),
        headers: { accept: 'image/jpeg,image/png,image/gif,image/webp,image/*' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      // SVG is vector XML with no raster decoder here or on the device.
      if (type === 'image/svg+xml') throw new Error('SVG is not supported');
      if (type && !type.startsWith('image/')) throw new Error(`not an image (${type})`);

      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error(`size ${buf.length} bytes`);

      // Re-encode when a normalizer is available: the firmware only decodes
      // JPEG and PNG, and its PNG path can be refused for want of heap. Without
      // a normalizer, fall back to passing through the formats it might handle.
      const usable = normalizeImage
        ? await normalizeImage(buf)
        : IMAGE_TYPES[type]
          ? { data: buf, mediaType: type === 'image/jpg' ? 'image/jpeg' : type, extension: IMAGE_TYPES[type].slice(1) }
          : null;
      if (!usable) throw new Error(`could not convert ${type || 'unknown type'}`);

      const name = `img-${images.length + 1}.${usable.extension}`;
      const epubPath = `images/${name}`;
      images.push({ path: epubPath, mediaType: usable.mediaType, data: usable.data });
      total += usable.data.length;
      seen.set(src, `../${epubPath}`);
      img.setAttribute('src', `../${epubPath}`);
      if (!img.getAttribute('alt')) img.setAttribute('alt', '');
    } catch (err) {
      img.remove();
      skipped++;
      warnings.push(`Skipped image (${err.message}): ${truncate(src, 70)}`);
    }
  }

  if (skipped) warnings.push(`${skipped} image(s) omitted.`);
  return images;
}

/**
 * A <figure> whose image was dropped is left holding only a caption. Keep the
 * caption's information but shed the now-meaningless wrapper.
 */
function flattenEmptyFigures(root, win) {
  for (const figure of [...root.querySelectorAll('figure')]) {
    if (figure.querySelector('img')) continue;
    const caption = figure.textContent.replace(/\s+/g, ' ').trim();
    if (!caption) {
      figure.remove();
      continue;
    }
    const p = win.document.createElement('p');
    p.setAttribute('class', 'cp-meta');
    const em = win.document.createElement('em');
    em.textContent = caption;
    p.appendChild(em);
    figure.replaceWith(p);
  }
}

/** Remove empties and stray whitespace left behind by unwrapping. */
function collapse(root, win) {
  const VOID_OK = new Set(['img', 'br', 'hr', 'td', 'th']);
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of [...root.querySelectorAll('*')]) {
      if (VOID_OK.has(el.tagName.toLowerCase())) continue;
      if (el.querySelector('img, hr, table')) continue;
      if (el.textContent.trim() === '') {
        el.remove();
        changed = true;
      }
    }
  }
  for (const node of [...root.childNodes]) {
    if (node.nodeType === win.Node.TEXT_NODE && !node.textContent.trim()) node.remove();
  }
}

/**
 * Split at top-level h1/h2 so the reader gets a real TOC and the firmware
 * caches smaller spine sections. Falls back to one chapter when the article
 * has no useful heading structure.
 */
function splitIntoChapters(root, win, articleTitle) {
  const serializer = new win.XMLSerializer();
  const groups = [{ title: null, nodes: [] }];

  for (const node of [...root.childNodes]) {
    if (node.nodeType === win.Node.ELEMENT_NODE && /^h[12]$/i.test(node.tagName)) {
      const heading = node.textContent.trim();
      // An h1/h2 arriving before any body text is a title for the first group,
      // not a reason to open an empty one.
      const current = groups[groups.length - 1];
      if (current.nodes.length === 0 && current.title === null) current.title = heading;
      else groups.push({ title: heading, nodes: [] });
    }
    groups[groups.length - 1].nodes.push(node);
  }

  // groups grows only when a heading follows existing content, so more than
  // one group means there is a genuine section boundary to split on.
  const useSplit = groups.length >= 2;
  const chapters = useSplit ? groups : [{ title: null, nodes: [...root.childNodes] }];

  return chapters
    .map((group, i) => {
      const body = group.nodes
        .map((node) => serializeNode(node, serializer, win))
        .filter((chunk) => chunk.trim())
        .join('\n')
        .trim();
      return {
        title: group.title || articleTitle,
        // The first chapter carries the article title/byline header.
        isFirst: i === 0,
        body,
      };
    })
    .filter((c) => c.body);
}

function serializeNode(node, serializer, win) {
  if (node.nodeType === win.Node.TEXT_NODE) {
    const text = node.textContent.trim();
    return text ? `<p>${escapeXml(text)}</p>` : '';
  }
  if (node.nodeType !== win.Node.ELEMENT_NODE) return '';
  // XMLSerializer gives well-formed XHTML: void elements self-close and
  // entities are escaped, both of which EPUB requires. It also re-declares the
  // XHTML namespace on every node it serializes; the wrapping <html> already
  // declares it, so drop the repeats.
  return serializer
    .serializeToString(node)
    .replaceAll(' xmlns="http://www.w3.org/1999/xhtml"', '');
}

function normalizeLang(lang) {
  if (!lang) return 'en';
  const clean = String(lang).trim().toLowerCase().replace(/_/g, '-');
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(clean) ? clean : 'en';
}

export function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(str, n) {
  return str.length > n ? `${str.slice(0, n)}…` : str;
}
