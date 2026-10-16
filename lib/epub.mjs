// Minimal EPUB 3.0 writer.
//
// Ships an EPUB2 toc.ncx alongside the EPUB3 nav document: CrossPoint reads
// the TOC either way, and the NCX keeps the file usable in older software.

import JSZip from 'jszip';
import { randomUUID } from 'node:crypto';
import { escapeXml } from './extract.mjs';

const CSS = `/* Tuned for a 480x800 grayscale e-ink panel. */
html, body { margin: 0; padding: 0; }
body { line-height: 1.4; text-align: justify; }
h1, h2, h3, h4 { line-height: 1.25; text-align: left; page-break-after: avoid; }
h1 { font-size: 1.5em; margin: 0 0 0.6em; }
h2 { font-size: 1.25em; margin: 1.2em 0 0.5em; }
h3 { font-size: 1.1em; margin: 1em 0 0.4em; }
p { margin: 0 0 0.7em; text-indent: 0; }
.cp-meta { font-size: 0.85em; margin: 0 0 1.4em; }
.cp-meta em { font-style: italic; }
blockquote { margin: 0.8em 1.2em; font-style: italic; }
pre { white-space: pre-wrap; font-size: 0.85em; margin: 0.8em 0; }
code { font-size: 0.9em; }
figure { margin: 1em 0; text-align: center; }
figcaption { font-size: 0.85em; text-align: center; margin-top: 0.3em; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
th, td { border: 1px solid #888; padding: 0.25em 0.4em; text-align: left; }
hr { border: 0; border-top: 1px solid #999; margin: 1.2em 0; }
ul, ol { margin: 0 0 0.7em 1.3em; padding: 0; }
li { margin-bottom: 0.3em; }
`;

/**
 * @param {object} article  Output of extractArticle(), plus optional overrides.
 * @param {object} [opts]
 * @param {string} [opts.modified] ISO timestamp for dcterms:modified.
 * @returns {Promise<{filename: string, buffer: Buffer, chapters: number}>}
 */
export async function buildEpub(article, opts = {}) {
  const {
    title = 'Untitled',
    byline = '',
    lang = 'en',
    source = '',
    siteName = '',
    chapters = [],
    images = [],
  } = article;

  const uuid = `urn:uuid:${randomUUID()}`;
  const modified = (opts.modified || new Date().toISOString()).replace(/\.\d{3}Z$/, 'Z');
  const author = byline || siteName || 'Unknown';

  const chapterFiles = (chapters.length ? chapters : [{ title, isFirst: true, body: '<p></p>' }]).map(
    (ch, i) => ({
      id: `ch${i + 1}`,
      href: `text/ch${String(i + 1).padStart(3, '0')}.xhtml`,
      title: ch.title || `Section ${i + 1}`,
      xhtml: chapterXhtml({ chapter: ch, article: { title, author, source, siteName }, lang }),
    })
  );

  const zip = new JSZip();

  // The spec requires "mimetype" to be the first entry and stored uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER_XML);
  zip.file('OEBPS/style.css', CSS);
  zip.file('OEBPS/content.opf', opf({ uuid, title, author, lang, source, modified, chapterFiles, images }));
  zip.file('OEBPS/nav.xhtml', nav({ title, lang, chapterFiles }));
  zip.file('OEBPS/toc.ncx', ncx({ uuid, title, author, chapterFiles }));
  for (const ch of chapterFiles) zip.file(`OEBPS/${ch.href}`, ch.xhtml);
  for (const img of images) zip.file(`OEBPS/${img.path}`, img.data);

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    mimeType: 'application/epub+zip',
  });

  return { filename: `${safeFilename(title)}.epub`, buffer, chapters: chapterFiles.length };
}

/**
 * Fixed-layout EPUB: one full-bleed image per page, the structure comic and
 * manga EPUBs use.
 *
 * The parts that make a reader treat it as pre-paginated rather than reflowable
 * text are `rendition:layout = pre-paginated` in the package metadata plus a
 * per-page `<meta name="viewport">` giving each image's pixel size.
 *
 * @param {object} book
 * @param {Array<{data: Buffer, width: number, height: number, label: string}>} book.pages
 */
export async function buildImageEpub(book) {
  const {
    title = 'Untitled',
    byline = '',
    lang = 'en',
    source = '',
    siteName = '',
    pages = [],
  } = book;

  if (!pages.length) throw new Error('No pages were rendered.');

  const uuid = `urn:uuid:${randomUUID()}`;
  const modified = (book.modified || new Date().toISOString()).replace(/\.\d{3}Z$/, 'Z');
  const author = byline || siteName || 'Unknown';

  const entries = pages.map((page, i) => {
    const n = String(i + 1).padStart(4, '0');
    // The renderer picks the encoding, so the extension and media type have to
    // follow the actual bytes rather than being assumed to be PNG.
    const extension = page.extension || 'png';
    return {
      id: `pg${i + 1}`,
      imageId: `im${i + 1}`,
      href: `text/p${n}.xhtml`,
      image: `images/p${n}.${extension}`,
      mediaType: page.mediaType || (extension === 'jpg' ? 'image/jpeg' : 'image/png'),
      label: page.label || `Page ${i + 1}`,
      width: page.width,
      height: page.height,
      data: page.data,
    };
  });

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER_XML);
  zip.file('OEBPS/style.css', FIXED_CSS);

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeXml(lang)}" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(uuid)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${escapeXml(lang)}</dc:language>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:date>${escapeXml(modified)}</dc:date>${source ? `\n    <dc:source>${escapeXml(source)}</dc:source>` : ''}
    <meta property="dcterms:modified">${escapeXml(modified)}</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">portrait</meta>
    <meta property="rendition:spread">none</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover-image" href="${escapeXml(entries[0].image)}" media-type="${entries[0].mediaType}" properties="cover-image"/>
    ${entries
      .map(
        (e, i) =>
          `<item id="${e.id}" href="${escapeXml(e.href)}" media-type="application/xhtml+xml"/>` +
          (i === 0 ? '' : `\n    <item id="${e.imageId}" href="${escapeXml(e.image)}" media-type="${e.mediaType}"/>`)
      )
      .join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${entries.map((e) => `<itemref idref="${e.id}" properties="rendition:layout-pre-paginated"/>`).join('\n    ')}
  </spine>
</package>
`
  );

  for (const entry of entries) {
    zip.file(
      `OEBPS/${entry.href}`,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(entry.label)}</title>
  <meta name="viewport" content="width=${entry.width}, height=${entry.height}"/>
  <link rel="stylesheet" type="text/css" href="../style.css"/>
</head>
<body>
  <div class="page"><img src="../${escapeXml(entry.image)}" alt="${escapeXml(entry.label)}" width="${entry.width}" height="${entry.height}"/></div>
</body>
</html>
`
    );
    zip.file(`OEBPS/${entry.image}`, entry.data);
  }

  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>Contents</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Pages</h1>
    <ol>
      ${entries
        .map((e) => `<li><a href="${escapeXml(e.href)}">${escapeXml(e.label)}</a></li>`)
        .join('\n      ')}
    </ol>
  </nav>
</body>
</html>
`
  );

  zip.file(
    'OEBPS/toc.ncx',
    ncx({ uuid, title, author, chapterFiles: entries.map((e) => ({ href: e.href, title: e.label })) })
  );

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    // The pages are already PNG; deflating them again buys almost nothing.
    compression: 'DEFLATE',
    compressionOptions: { level: 3 },
    mimeType: 'application/epub+zip',
  });

  return { filename: `${safeFilename(title)}.epub`, buffer, pages: entries.length };
}

const FIXED_CSS = `html, body { margin: 0; padding: 0; height: 100%; background: #ffffff; }
.page { margin: 0; padding: 0; text-align: center; }
.page img { display: block; margin: 0 auto; max-width: 100%; height: auto; }
`;

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

function chapterXhtml({ chapter, article, lang }) {
  let header = '';
  if (chapter.isFirst) {
    const bits = [];
    if (article.author && article.author !== 'Unknown') bits.push(escapeXml(article.author));
    if (article.siteName && article.siteName !== article.author) bits.push(escapeXml(article.siteName));
    const meta = bits.length ? `<p class="cp-meta"><em>${bits.join(' · ')}</em></p>` : '';
    header = `<h1>${escapeXml(article.title)}</h1>\n${meta}`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(chapter.title || article.title)}</title>
  <link rel="stylesheet" type="text/css" href="../style.css"/>
</head>
<body>
${header}
${chapter.body}
</body>
</html>
`;
}

function opf({ uuid, title, author, lang, source, modified, chapterFiles, images }) {
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...chapterFiles.map(
      (c) => `<item id="${c.id}" href="${escapeXml(c.href)}" media-type="application/xhtml+xml"/>`
    ),
    ...images.map(
      (img, i) => `<item id="img${i + 1}" href="${escapeXml(img.path)}" media-type="${img.mediaType}"/>`
    ),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeXml(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(uuid)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${escapeXml(lang)}</dc:language>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:date>${escapeXml(modified)}</dc:date>${source ? `\n    <dc:source>${escapeXml(source)}</dc:source>` : ''}
    <meta property="dcterms:modified">${escapeXml(modified)}</meta>
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${chapterFiles.map((c) => `<itemref idref="${c.id}"/>`).join('\n    ')}
  </spine>
</package>
`;
}

function nav({ title, lang, chapterFiles }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>Contents</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      ${chapterFiles
        .map((c) => `<li><a href="${escapeXml(c.href)}">${escapeXml(c.title)}</a></li>`)
        .join('\n      ')}
    </ol>
  </nav>
</body>
</html>
`;
}

function ncx({ uuid, title, author, chapterFiles }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(uuid)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <docAuthor><text>${escapeXml(author)}</text></docAuthor>
  <navMap>
    ${chapterFiles
      .map(
        (c, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(c.title)}</text></navLabel>
      <content src="${escapeXml(c.href)}"/>
    </navPoint>`
      )
      .join('\n    ')}
  </navMap>
</ncx>
`;
}

/** FAT32-safe, reasonably short, still readable on the device's file list. */
export function safeFilename(title) {
  const base = String(title)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return base || 'Untitled';
}
