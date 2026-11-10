'use strict';

// Readable blocks for the Library: what each item is, drawn for reading.
//
// A feed's newest edition is laid out like a front page — its articles'
// headlines, bylines and openings, each linking straight to that article on
// its reading page, the first few at once with "Show all" for the rest. A book
// shows its cover, author and description; a note its opening. The summaries
// come from /api/reading; read.js adds a forget control to books and notes.

(function () {
  /** How many of an edition's articles show before "Show all". */
  const FIRST_ARTICLES = 5;
  // Editions opened with "Show all", kept while the page is open.
  const expanded = new Set();

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

    const list = node('ol', 'reading-articles');
    const showAll = expanded.has(item.id);
    item.articles.forEach((article, i) => {
      const li = node('li', 'reading-article');
      if (!showAll && i >= FIRST_ARTICLES) li.hidden = true;
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
