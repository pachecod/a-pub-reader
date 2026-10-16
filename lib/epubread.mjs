// Read a built EPUB back out again, for previewing before it is sent.
//
// The point is to preview the actual artefact rather than the intermediate
// state it came from: a draft's Preview tab shows rendered markdown, which is
// not quite the same thing as the chapters, table of contents and images that
// ended up inside the file. Reading the EPUB proves what the reader will get.

import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';

/** Open the EPUB and return its spine in reading order. */
export async function readEpub(diskPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(diskPath));

  // The container points at the package document; its location is not fixed.
  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  if (!containerXml) throw new Error('Not an EPUB: no container.xml.');
  const container = new JSDOM(containerXml, { contentType: 'text/xml' }).window.document;
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('Not an EPUB: no package document.');

  const opfXml = await zip.file(opfPath)?.async('string');
  if (!opfXml) throw new Error(`Package document missing: ${opfPath}`);
  const opf = new JSDOM(opfXml, { contentType: 'text/xml' }).window.document;

  // Everything inside the package is relative to the package document.
  const base = path.posix.dirname(opfPath) === '.' ? '' : `${path.posix.dirname(opfPath)}/`;

  const manifest = new Map();
  for (const item of opf.querySelectorAll('manifest > item')) {
    manifest.set(item.getAttribute('id'), {
      href: item.getAttribute('href'),
      mediaType: item.getAttribute('media-type'),
      properties: item.getAttribute('properties') || '',
    });
  }

  const titleOf = await navTitles(zip, base, manifest, opf);

  const spine = [];
  for (const ref of opf.querySelectorAll('spine > itemref')) {
    const entry = manifest.get(ref.getAttribute('idref'));
    if (!entry?.href) continue;
    const full = path.posix.normalize(base + entry.href);
    spine.push({
      href: full,
      title: titleOf.get(full) || titleOf.get(entry.href) || '',
      mediaType: entry.mediaType,
    });
  }

  const layout =
    [...opf.querySelectorAll('metadata > *')].find(
      (m) => m.getAttribute?.('property') === 'rendition:layout'
    )?.textContent === 'pre-paginated'
      ? 'pre-paginated'
      : 'reflowable';

  return {
    zip,
    base,
    spine,
    layout,
    title: firstText(opf, 'title'),
    author: firstText(opf, 'creator'),
  };
}

function firstText(opf, localName) {
  for (const node of opf.querySelectorAll('metadata > *')) {
    if (node.localName?.toLowerCase() === localName) return (node.textContent || '').trim();
  }
  return '';
}

/** Chapter titles from the EPUB3 nav document, falling back to the NCX. */
async function navTitles(zip, base, manifest, opf) {
  const titles = new Map();

  const navItem = [...manifest.values()].find((i) => /\bnav\b/.test(i.properties));
  if (navItem?.href) {
    const xhtml = await zip.file(path.posix.normalize(base + navItem.href))?.async('string');
    if (xhtml) {
      const doc = new JSDOM(xhtml, { contentType: 'text/xml' }).window.document;
      const navBase = path.posix.dirname(path.posix.normalize(base + navItem.href));
      for (const link of doc.querySelectorAll('a')) {
        const href = (link.getAttribute('href') || '').split('#')[0];
        if (!href) continue;
        titles.set(path.posix.normalize(`${navBase}/${href}`), (link.textContent || '').trim());
      }
    }
  }

  if (titles.size) return titles;

  const ncxItem = [...manifest.values()].find((i) => i.mediaType === 'application/x-dtbncx+xml');
  if (ncxItem?.href) {
    const xml = await zip.file(path.posix.normalize(base + ncxItem.href))?.async('string');
    if (xml) {
      const doc = new JSDOM(xml, { contentType: 'text/xml' }).window.document;
      const ncxBase = path.posix.dirname(path.posix.normalize(base + ncxItem.href));
      for (const point of doc.querySelectorAll('navPoint')) {
        const href = (point.querySelector('content')?.getAttribute('src') || '').split('#')[0];
        if (!href) continue;
        titles.set(
          path.posix.normalize(`${ncxBase}/${href}`),
          (point.querySelector('navLabel text')?.textContent || '').trim()
        );
      }
    }
  }

  return titles;
}

/**
 * One chapter's body, ready to drop into the preview pane.
 *
 * Image references are rewritten to an endpoint that serves them back out of
 * the zip, so the preview shows the pictures that are actually in the file
 * rather than broken placeholders. Scripts and styles are dropped: this is
 * being injected into the app's own page.
 */
export async function readChapter(book, index, { imageUrl }) {
  const entry = book.spine[index];
  if (!entry) throw new Error('No such chapter.');

  const xhtml = await book.zip.file(entry.href)?.async('string');
  if (!xhtml) throw new Error(`Chapter missing from the EPUB: ${entry.href}`);

  const dom = new JSDOM(xhtml, { contentType: 'application/xhtml+xml' });
  const doc = dom.window.document;
  const chapterDir = path.posix.dirname(entry.href);

  for (const node of doc.querySelectorAll('script, style, link')) node.remove();

  // <source> offers alternates we cannot serve, and a leftover srcset makes the
  // browser resolve "../images/x-2x.png" against the app's own origin and 404.
  for (const node of doc.querySelectorAll('source')) node.remove();
  for (const node of doc.querySelectorAll('[srcset]')) node.removeAttribute('srcset');

  /** Point one attribute at the archive, or drop it if the file isn't there. */
  const rewriteRef = (node, attribute) => {
    const value = node.getAttribute(attribute) || '';
    if (!value || /^(https?:|data:|#)/i.test(value)) return;
    const resolved = path.posix.normalize(`${chapterDir}/${value}`);
    if (book.zip.file(resolved)) node.setAttribute(attribute, imageUrl(resolved));
    else node.removeAttribute(attribute);
  };

  for (const img of doc.querySelectorAll('img')) rewriteRef(img, 'src');

  // Standard Ebooks wraps cover and title-page art in SVG, whose <image>
  // element carries href (or the older xlink:href) rather than src.
  for (const image of doc.querySelectorAll('image')) {
    rewriteRef(image, 'href');
    const xlink = image.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href');
    if (xlink) {
      const resolved = path.posix.normalize(`${chapterDir}/${xlink}`);
      if (book.zip.file(resolved)) {
        image.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', imageUrl(resolved));
      } else {
        image.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
      }
    }
  }

  // Internal links would navigate the app away; keep the text, drop the jump.
  for (const link of doc.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (!/^https?:/i.test(href)) link.removeAttribute('href');
    else {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noreferrer noopener');
    }
  }

  // Parsing as XHTML makes the serializer re-declare the namespace on every
  // element. Harmless once injected into the page, but it triples the payload.
  const html = (doc.body?.innerHTML || '').replaceAll(' xmlns="http://www.w3.org/1999/xhtml"', '');

  return {
    index,
    title: entry.title || `Section ${index + 1}`,
    html,
    total: book.spine.length,
  };
}

/** Raw bytes of one file inside the EPUB, looked up by exact entry name. */
export async function readEpubFile(book, internalPath) {
  const file = book.zip.file(internalPath);
  if (!file) return null;
  return file.async('nodebuffer');
}

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

export const mediaTypeFor = (name) => IMAGE_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
