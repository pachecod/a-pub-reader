// What the Read tab shows about each item: a summary built from the EPUB.
//
// For a feed edition that is its articles — headline, byline and date, and the
// opening of the story — so the edition can be browsed like a front page. For a
// book it is the description the publisher put in the package (Standard Ebooks
// writes a good one) and its cover; for anything else, its opening lines.
//
// Built EPUBs never change once written, so each summary is worked out once and
// kept in memory, keyed by the item's id.

import { JSDOM } from 'jsdom';
import { readChapter, readEpub } from './epubread.mjs';

const EXCERPT_CHARS = 220;
const cache = new Map();

const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** Cut at a word boundary, with an ellipsis when something was left off. */
export function excerpt(text, limit = EXCERPT_CHARS) {
  const value = clean(text);
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), limit - 30)).replace(/[,;:.\s—-]+$/, '')}…`;
}

// Photo credits and captions that come before the story in many feeds.
const CAPTION = /hide caption|toggle caption|^(photo|image|illustration)( by|:)|getty images|\bAP Photo\b/i;

/**
 * The byline and the opening of one article's HTML.
 *
 * Feed articles open with an "Author · Date" line in italics, sometimes a
 * standfirst or photo caption (marked cp-meta), then the story; the first real
 * paragraph of the story is the preview.
 */
export function summarizeArticle(html, headline = '') {
  const doc = new JSDOM(`<!DOCTYPE html><body>${html}</body>`).window.document;
  let byline = '';
  let opening = '';
  const author = () => clean(byline.split(' · ')[0]);

  for (const p of doc.querySelectorAll('p')) {
    const text = clean(p.textContent);
    if (!text) continue;
    // The byline: a paragraph that is only an <em>, with a "·" between parts.
    if (!byline && !opening && p.children.length === 1 && p.firstElementChild?.tagName === 'EM' && text.includes(' · ')) {
      byline = text.replace(/\s*·\s*summary only\s*$/i, '');
      continue;
    }
    if (p.classList.contains('cp-meta') || p.classList.contains('cp-source') || p.closest('figure, figcaption')) continue;
    if (CAPTION.test(text) || text.length < 60) continue;
    // Some sites open with the writer's bio ("Jess Weatherbed is a news writer…").
    if (author() && author().length > 3 && text.startsWith(author())) continue;
    opening = text;
    break;
  }
  // Some feeds repeat the headline as the story's first words.
  const head = clean(headline);
  if (head && opening.startsWith(head)) opening = clean(opening.slice(head.length));
  return { byline, excerpt: excerpt(opening) };
}

/**
 * The Read tab's view of one queue entry.
 *
 * @param {object} entry  An outbox entry (id, title, mode, source…).
 * @param {() => Promise<Buffer>} load  Reads the entry's EPUB, if needed.
 */
export async function summarize(entry, load) {
  if (cache.has(entry.id)) return cache.get(entry.id);

  const kind = entry.source?.kind || 'file';
  const base = {
    id: entry.id,
    kind,
    // For a feed edition, which feed it is, so new-article counts can find it.
    feedId: entry.source?.feedId || null,
    title: entry.title,
    builtAt: entry.builtAt || null,
    chapters: entry.chapters || 0,
  };

  // Page-image books have no text to summarize.
  if (entry.mode === 'images') {
    const result = { ...base, pages: entry.pageCount || 0, excerpt: '', articles: [] };
    cache.set(entry.id, result);
    return result;
  }

  const book = await readEpub(await load());
  const fileUrl = (internal) => `/out/${entry.id}/epub/${internal.split('/').map(encodeURIComponent).join('/')}`;
  const author = /^unknown$/i.test(book.author || '') ? '' : clean(book.author);

  const chapterHtml = async (index) =>
    (await readChapter(book, index, { imageUrl: fileUrl })).html;

  let result;
  if (kind === 'feed') {
    const articles = [];
    let firstLink = '';
    for (let i = 0; i < book.spine.length; i++) {
      const headline = clean(book.spine[i].title) || `Article ${i + 1}`;
      const html = await chapterHtml(i);
      const { byline, excerpt: opening } = summarizeArticle(html, headline);
      articles.push({ n: i + 1, title: headline, byline, excerpt: opening });
      // The first story link, so an older edition can still name its website.
      firstLink ||= html.match(/href="(https?:\/\/[^"]+)"/)?.[1]?.replace(/&amp;/g, '&') || '';
    }
    result = { ...base, articles, excerpt: '', firstLink };
  } else {
    // A book's own description wins; otherwise the opening of the first chapter
    // that has a real paragraph (skipping title pages and the like).
    let opening = excerpt(clean(book.description).replace(/<[^>]+>/g, ''), 320);
    for (let i = 0; !opening && i < Math.min(book.spine.length, 8); i++) {
      opening = summarizeArticle(await chapterHtml(i)).excerpt;
    }
    result = {
      ...base,
      author: kind === 'draft' ? '' : author,
      cover: book.cover ? fileUrl(book.cover) : null,
      excerpt: opening,
      articles: [],
    };
  }

  cache.set(entry.id, result);
  return result;
}

/** Drop summaries of items that no longer exist, so the cache cannot grow without end. */
export function pruneSummaries(liveIds) {
  const keep = new Set(liveIds);
  for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);
}
