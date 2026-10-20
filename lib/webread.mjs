// A built EPUB as an ordinary web page, for reading in the browser.
//
// The ePub previewer imitates the device — a portrait frame, one page at a
// time — which is what you want when checking how a book will behave on the
// reader, and not what you want when you just want to read it. This renders the
// same archive as one long, responsive page: a contents list, then every
// chapter in order, with images served back out of the zip.
//
// It is built from the EPUB rather than the source it came from for the same
// reason the previewer is: the archive is the thing that exists for every kind
// of input, and it is what the reader gets.

import { readChapter, readEpub } from './epubread.mjs';

const escape = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Where an image inside the archive is served from. */
export const epubFileUrl = (id, internal) =>
  `/out/${id}/epub/${internal.split('/').map(encodeURIComponent).join('/')}`;

/**
 * The whole page for one queue entry.
 *
 * Fixed-layout books are a stack of page images; anything else is its chapters.
 */
export async function renderWebPage(entry) {
  if (entry.mode === 'images') {
    const pages = Array.from(
      { length: entry.pageCount || 0 },
      (_, i) => `<img class="page-image" loading="lazy" src="/out/${entry.id}/pages/${i + 1}.png" alt="Page ${i + 1}">`
    ).join('\n');
    return page({ entry, title: entry.title, author: entry.author, toc: '', content: pages });
  }

  const book = await readEpub(entry.diskPath);
  const chapters = [];
  for (let i = 0; i < book.spine.length; i++) {
    chapters.push(await readChapter(book, i, { imageUrl: (internal) => epubFileUrl(entry.id, internal) }));
  }

  // A contents list for one chapter is just its own title again.
  const toc =
    chapters.length > 1
      ? `<nav class="toc" aria-label="Contents">${RETURN_LINK}<h2>Contents</h2><ol>${chapters
          .map((c) => `<li><a href="#ch-${c.index + 1}">${escape(c.title)}</a></li>`)
          .join('')}</ol></nav>`
      : '';

  const content = chapters
    .map((c) => `<section class="chapter" id="ch-${c.index + 1}">${c.html}</section>`)
    .join('\n');

  return page({
    entry,
    title: book.title || entry.title,
    author: book.author || entry.author,
    toc,
    content,
  });
}

// Every reading page is opened from the Library tab, so the way back sits at the
// top of the contents column, or above the title when there is no contents.
const RETURN_LINK = '<a href="/" class="return-link">← Return to Library</a>';

function page({ entry, title, author, toc, content }) {
  const sent = entry.deliveredAt ? `Sent to ${escape(entry.deliveredTo || 'the reader')}` : 'Not sent to a reader';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · A-Pub Reader</title>
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="/web-read.css">
</head>
<body id="top">
<!-- The app's own menu bar, so the sections stay one click away while
     reading; Library is current, since that is where reading starts. -->
<header class="bar">
  <a href="/" class="brand" aria-label="A-Pub Reader, home">
    <img src="/logo.svg" alt="" width="28" height="28">
    <span>A-Pub Reader</span>
  </a>
  <nav class="menu" aria-label="Sections">
    <a href="/" aria-current="page">Library</a>
    <a href="/?tab=add">Add/Remove</a>
    <a href="/?tab=write">Write</a>
  </nav>
  <span class="bar-actions">
    <a class="bar-button" href="/?epub=${encodeURIComponent(entry.id)}" aria-label="Read as eBook">
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5.2C8.2 4 5.8 3.6 3 4.2v11.3c2.8-.6 5.2-.2 7 1 1.8-1.2 4.2-1.6 7-1V4.2c-2.8-.6-5.2-.2-7 1z"/><path d="M10 5.2v11.3"/></svg><span>Read as eBook</span>
    </a>
    <a class="bar-button" href="/out/${encodeURIComponent(entry.id)}" aria-label="Download eBook">
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v9.5"/><path d="M6 8.8l4 4 4-4"/><path d="M4 15.5v1.5h12v-1.5"/></svg><span>Download eBook</span>
    </a>
  </span>
</header>
<!-- On a wide screen the contents sit in a column of their own on the left,
     beside the text; on a narrow one they come between the title and the text. -->
<div class="page${toc ? ' has-toc' : ''}">
  <header class="book-head">
    ${toc ? '' : RETURN_LINK}
    <h1>${escape(title)}</h1>
    ${author && !/^unknown$/i.test(author) ? `<p class="byline">${escape(author)}</p>` : ''}
    <p class="note">${sent}</p>
  </header>
  ${toc}
  <main class="reading">
    ${content}
    <footer class="book-foot">
      <a href="#top">Back to top</a> ·
      <a href="/?epub=${encodeURIComponent(entry.id)}">Read as eBook</a>
    </footer>
  </main>
</div>
</body>
</html>
`;
}
