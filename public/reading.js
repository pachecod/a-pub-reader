'use strict';

// Readable blocks for the Library: what each item is, drawn for reading.
//
// A feed's newest edition is laid out like a front page — its articles'
// headlines, bylines and openings, each linking straight to that article on
// its reading page, five at a time with Previous / Next, so every feed's box
// is the same height. A book
// shows its cover, author and description; a note its opening. The summaries
// come from /api/reading; read.js adds a forget control to books and notes.

(function () {
  /** How many articles a feed's box shows at a time. */
  const PER_PAGE = 5;
  // The page each feed's box is on, kept while the page is open (the Library
  // redraws when it refreshes).
  const pageOf = new Map();

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  /** A reading page, at a chapter if one is given. */
  const readUrl = (id, chapter) => `/read/${id}${chapter ? `#ch-${chapter}` : ''}`;

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
    // The feed's name, and beside it a link to its website: reading from the
    // feed should still send people to the publisher.
    const name = node('span', 'reading-feed-title');
    name.appendChild(link(readUrl(item.id), 'reading-feed-name', item.title));
    if (item.site && /^https?:\/\//i.test(item.site)) {
      const site = link(item.site, 'reading-feed-site', item.siteLabel || 'Website');
      site.target = '_blank';
      site.rel = 'noopener';
      site.title = `Visit ${item.siteLabel || 'the website'}`;
      name.appendChild(site);
    }
    head.append(
      name,
      node('span', 'reading-feed-meta', `${plural(item.articles.length, 'article')} · ${when(item.builtAt)}`)
    );
    block.appendChild(head);

    // The articles, in a box tall enough for five, so boxes line up. read.js
    // may put not-yet-fetched articles above them; those page along too.
    const pages = node('div', 'reading-pages');
    const list = node('ol', 'reading-articles');
    item.articles.forEach((article) => {
      const li = node('li', 'reading-article');
      // The article's picture from the feed, styled like a book's cover.
      if (article.image) {
        li.classList.add('has-thumb');
        const thumbLink = link(readUrl(item.id, article.n), 'reading-thumb-link');
        thumbLink.setAttribute('aria-hidden', 'true');
        thumbLink.tabIndex = -1;
        const thumb = node('img', 'reading-thumb');
        thumb.src = article.image;
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.decoding = 'async';
        thumbLink.appendChild(thumb);
        li.appendChild(thumbLink);
      }
      const body = node('div', 'reading-article-body');
      body.appendChild(link(readUrl(item.id, article.n), 'reading-article-title', article.title));
      if (article.byline) body.appendChild(node('p', 'reading-byline', article.byline));
      if (article.excerpt) body.appendChild(node('p', 'reading-excerpt', article.excerpt));
      li.appendChild(body);
      list.appendChild(li);
    });
    pages.appendChild(list);
    block.appendChild(pages);

    // Previous / Next. The bar is always there (empty with one page), so a
    // short feed's box is as tall as a long one's.
    const pager = node('nav', 'reading-pager');
    pager.setAttribute('aria-label', `${item.title} articles`);
    const prev = node('button', 'reading-page-btn', '‹ Previous');
    const next = node('button', 'reading-page-btn', 'Next ›');
    const where = node('span', 'reading-page-where');
    where.setAttribute('aria-live', 'polite');
    prev.type = next.type = 'button';
    pager.append(prev, where, next);
    block.appendChild(pager);

    /** Show one page (by default the one this box was on). */
    block.paginate = (page = pageOf.get(item.id) || 0) => {
      const rows = [...pages.querySelectorAll('.reading-article')];
      const count = Math.max(1, Math.ceil(rows.length / PER_PAGE));
      page = Math.min(Math.max(0, page), count - 1);
      pageOf.set(item.id, page);
      rows.forEach((li, i) => (li.hidden = Math.floor(i / PER_PAGE) !== page));
      // A list whose rows are all on other pages takes no room.
      pages.querySelectorAll('ol').forEach((ol) => (ol.hidden = ![...ol.children].some((li) => !li.hidden)));
      pager.classList.toggle('is-single', count === 1);
      prev.disabled = page === 0;
      next.disabled = page === count - 1;
      where.textContent = count > 1 ? `${page + 1} of ${count}` : '';
    };
    prev.addEventListener('click', () => block.paginate((pageOf.get(item.id) || 0) - 1));
    next.addEventListener('click', () => block.paginate((pageOf.get(item.id) || 0) + 1));
    block.paginate();
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

  /** One line summing up the library: "200 articles from 16 feeds · 2 books · 1 document". */
  function summaryLine(items) {
    const feeds = items.filter((i) => i.kind === 'feed');
    const notes = items.filter((i) => i.kind === 'draft');
    const books = items.filter((i) => i.kind === 'book').length;
    const docs = items.length - feeds.length - notes.length - books;
    const articles = feeds.reduce((n, f) => n + (f.articles?.length || 0), 0);
    const parts = [];
    if (articles) parts.push(`${plural(articles, 'article')} from ${plural(feeds.length, 'feed')}`);
    else if (feeds.length) parts.push(plural(feeds.length, 'feed edition'));
    if (books) parts.push(plural(books, 'book'));
    if (docs) parts.push(plural(docs, 'document'));
    if (notes.length) parts.push(plural(notes.length, 'note'));
    return parts.join(' · ');
  }

  window.epubDropReading = { feedBlock, itemBlock, summaryLine };
})();
