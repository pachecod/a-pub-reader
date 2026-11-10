// The library as an OPDS catalog (OPDS 1.2, Atom), for e-readers that browse
// and download books themselves: the Xteink's CrossPoint firmware, KOReader on
// a Boox, and others. A navigation feed lists the sections; each section is an
// acquisition feed whose entries link straight to the EPUB.

export const OPDS_NAVIGATION = 'application/atom+xml;profile=opds-catalog;kind=navigation';
export const OPDS_ACQUISITION = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
const ACQUIRE = 'http://opds-spec.org/acquisition';

const xml = (text) =>
  String(text ?? '')
    // Characters XML 1.0 cannot hold at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

const iso = (value) => {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};

function head({ id, title, updated, selfHref, startHref, upHref, kind }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">',
    `  <id>${xml(id)}</id>`,
    `  <title>${xml(title)}</title>`,
    `  <updated>${iso(updated)}</updated>`,
    '  <author><name>A-Pub Reader</name></author>',
    `  <link rel="self" href="${xml(selfHref)}" type="${kind}"/>`,
    `  <link rel="start" href="${xml(startHref)}" type="${OPDS_NAVIGATION}"/>`,
    upHref ? `  <link rel="up" href="${xml(upHref)}" type="${OPDS_NAVIGATION}"/>` : '',
  ].filter(Boolean);
}

/**
 * The catalog's front page: one entry per section.
 * @param {{id, title, updated, selfHref, sections: Array<{id, title, href, content}>}} feed
 */
export function navigationFeed({ id, title, updated, selfHref, sections }) {
  const lines = head({ id, title, updated, selfHref, startHref: selfHref, kind: OPDS_NAVIGATION });
  for (const section of sections) {
    lines.push(
      '  <entry>',
      `    <id>${xml(section.id)}</id>`,
      `    <title>${xml(section.title)}</title>`,
      `    <updated>${iso(section.updated || updated)}</updated>`,
      `    <content type="text">${xml(section.content || '')}</content>`,
      `    <link rel="subsection" href="${xml(section.href)}" type="${OPDS_ACQUISITION}"/>`,
      '  </entry>'
    );
  }
  lines.push('</feed>', '');
  return lines.join('\n');
}

/**
 * One section: books to download.
 * @param {{id, title, updated, selfHref, startHref, entries: Array<{id, title, author, updated, summary, href, size}>}} feed
 */
export function acquisitionFeed({ id, title, updated, selfHref, startHref, entries }) {
  const lines = head({ id, title, updated, selfHref, startHref, upHref: startHref, kind: OPDS_ACQUISITION });
  for (const entry of entries) {
    lines.push(
      '  <entry>',
      `    <id>${xml(entry.id)}</id>`,
      `    <title>${xml(entry.title)}</title>`,
      entry.author ? `    <author><name>${xml(entry.author)}</name></author>` : '',
      `    <updated>${iso(entry.updated)}</updated>`,
      entry.updated ? `    <dc:issued>${iso(entry.updated).slice(0, 10)}</dc:issued>` : '',
      entry.summary ? `    <summary type="text">${xml(entry.summary)}</summary>` : '',
      `    <link rel="${ACQUIRE}" href="${xml(entry.href)}" type="application/epub+zip"${entry.size ? ` length="${Number(entry.size) || 0}"` : ''}/>`,
      '  </entry>'
    );
  }
  lines.push('</feed>', '');
  return lines.filter((l) => l !== '').join('\n');
}
