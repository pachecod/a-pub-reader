'use strict';

// The Read tab: what there is to read, as a summary.
//
// The Library manages items; this is for choosing what to read. Each feed's
// newest edition is laid out like a front page — its articles' headlines,
// bylines and openings, each linking straight to that article on its reading
// page — beside the books (cover, author, description) and notes (opening).
// Links carry ?from=read so the reading page leads back here.

(function () {
  const $ = (id) => document.getElementById(id);
  const el = {
    panel: $('tab-reading'),
    summary: $('reading-summary'),
    feeds: $('reading-feeds'),
    books: $('reading-books'),
    notes: $('reading-notes'),
    layout: $('reading-layout'),
    side: $('reading-side'),
    add: $('reading-add'),
  };

  el.add.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-goto]');
    if (button) window.epubDropTabs?.show(button.dataset.goto, button.dataset.focus);
  });

  /** How many of an edition's articles show before "Show all". */
  const FIRST_ARTICLES = 5;
  // Editions opened with "Show all", kept while the page is open.
  const expanded = new Set();
  let loading = null;

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const readUrl = (id, chapter) => `/read/${id}?from=read${chapter ? `#ch-${chapter}` : ''}`;

  function when(iso) {
    if (!iso) return '';
    const then = new Date(iso);
    const days = Math.floor((Date.now() - then.getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function link(href, className, text) {
    const a = node('a', className, text);
    a.href = href;
    return a;
  }

  /** One feed edition: its name, then its articles, the first few at once. */
  function feedBlock(item) {
    const block = node('article', 'reading-feed');
    const head = node('header', 'reading-feed-head');
    head.append(
      link(readUrl(item.id), 'reading-feed-name', item.title),
      node('span', 'reading-feed-meta', `${plural(item.articles.length, 'article')} · ${when(item.builtAt)}`)
    );
    block.appendChild(head);

    const list = node('ol', 'reading-articles');
    const showAll = expanded.has(item.id);
    item.articles.forEach((article, i) => {
      const li = node('li', 'reading-article');
      if (!showAll && i >= FIRST_ARTICLES) li.hidden = true;
      li.appendChild(link(readUrl(item.id, article.n), 'reading-article-title', article.title));
      if (article.byline) li.appendChild(node('p', 'reading-byline', article.byline));
      if (article.excerpt) li.appendChild(node('p', 'reading-excerpt', article.excerpt));
      list.appendChild(li);
    });
    block.appendChild(list);

    const rest = item.articles.length - FIRST_ARTICLES;
    if (rest > 0) {
      const more = node('button', 'link reading-more', showAll ? 'Show fewer' : `Show all ${item.articles.length}`);
      more.type = 'button';
      more.setAttribute('aria-expanded', String(showAll));
      more.addEventListener('click', () => {
        const open = !expanded.has(item.id);
        if (open) expanded.add(item.id);
        else expanded.delete(item.id);
        [...list.children].forEach((li, i) => (li.hidden = !open && i >= FIRST_ARTICLES));
        more.textContent = open ? 'Show fewer' : `Show all ${item.articles.length}`;
        more.setAttribute('aria-expanded', String(open));
        if (!open) block.scrollIntoView({ block: 'nearest' });
      });
      block.appendChild(more);
    }
    return block;
  }

  /** A book or a note: cover if there is one, title, author, opening. */
  function itemBlock(item) {
    const block = node('article', 'reading-item');
    if (item.cover) {
      const cover = node('img', 'reading-cover');
      cover.src = item.cover;
      cover.alt = '';
      cover.loading = 'lazy';
      const coverLink = link(readUrl(item.id), 'reading-cover-link');
      coverLink.setAttribute('aria-hidden', 'true');
      coverLink.tabIndex = -1;
      coverLink.appendChild(cover);
      block.appendChild(coverLink);
    }
    const body = node('div', 'reading-item-body');
    body.appendChild(link(readUrl(item.id), 'reading-item-title', item.title));
    const meta = [item.author, item.pages ? plural(item.pages, 'page') : item.chapters > 1 ? plural(item.chapters, 'chapter') : '', when(item.builtAt)]
      .filter(Boolean)
      .join(' · ');
    if (meta) body.appendChild(node('p', 'reading-byline', meta));
    if (item.excerpt) body.appendChild(node('p', 'reading-excerpt reading-excerpt-long', item.excerpt));
    block.appendChild(body);
    return block;
  }

  function emptyNote(text, action) {
    const p = node('div', 'muted empty-note');
    p.appendChild(node('p', '', text));
    if (action) {
      const button = node('button', 'secondary', action.label);
      button.type = 'button';
      button.addEventListener('click', () => window.epubDropTabs?.show(action.tab, action.focus));
      const row = node('div', 'empty-actions');
      row.appendChild(button);
      p.appendChild(row);
    }
    return p;
  }

  async function load() {
    // One request at a time; a second call while one is out reuses it.
    if (loading) return loading;
    loading = (async () => {
      try {
        const res = await fetch('/api/reading');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { items } = await res.json();

        const feeds = items.filter((i) => i.kind === 'feed');
        const notes = items.filter((i) => i.kind === 'draft');
        const books = items.filter((i) => i.kind !== 'feed' && i.kind !== 'draft');
        const articles = feeds.reduce((n, f) => n + f.articles.length, 0);

        const parts = [];
        if (articles) parts.push(`${plural(articles, 'article')} from ${plural(feeds.length, 'feed')}`);
        if (books.length) parts.push(plural(books.length, 'book'));
        if (notes.length) parts.push(plural(notes.length, 'note'));
        el.summary.textContent = parts.length ? parts.join(' · ') : 'Nothing to read yet.';

        // With no books or notes, the articles take the full width and the
        // ways to add them shrink to two links beside the summary.
        const sideEmpty = !books.length && !notes.length;
        el.side.hidden = sideEmpty;
        el.layout.classList.toggle('reading-wide', sideEmpty);
        el.add.hidden = !sideEmpty;

        el.feeds.replaceChildren(
          ...(feeds.length
            ? feeds.map(feedBlock)
            : [emptyNote('No feed editions yet. Add a feed and refresh it to read the latest articles here.', { label: 'Add a feed', tab: 'add', focus: 'feed-url' })])
        );
        el.books.replaceChildren(
          ...(books.length
            ? books.map(itemBlock)
            : [emptyNote('No books yet.', { label: 'Find books', tab: 'add', focus: 'books-browse' })])
        );
        el.notes.replaceChildren(
          ...(notes.length
            ? notes.map(itemBlock)
            : [emptyNote('Nothing written yet.', { label: 'Start writing', tab: 'write', focus: 'draft-title' })])
        );
      } catch (err) {
        el.summary.textContent = `Could not load what there is to read: ${err.message}`;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  window.epubDropReading = {
    load,
    // The queue changed (a refresh, a forget, a new item): redraw if on screen.
    reloadIfShown: () => {
      if (!el.panel.hidden) load();
    },
  };
})();
