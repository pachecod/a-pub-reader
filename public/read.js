'use strict';

// The Library tab: everything this app has built, whether or not it has reached
// the reader yet, drawn readably — each section as the Read tab draws it (a
// feed's articles, a book's cover and description, a note's opening), with a
// forget control on books and notes. The On reader switches live on
// Add/Remove.
//
// Built from the queue's entries, split into books, notes and feed editions,
// matching the three folders they live in on the device. They are used
// differently — a book is read once and kept, a feed edition is replaced every
// refresh, a note is something you wrote. Every entry keeps its EPUB on disk,
// which is what makes it readable here without a device at all: an item shows
// up the moment it is converted, and sending it later only changes its label.

(function () {
  const $ = (id) => document.getElementById(id);

  const el = {
    books: $('read-books'),
    booksCount: $('read-books-count'),
    docs: $('read-docs'),
    docsCount: $('read-docs-count'),
    docsEmpty: $('read-docs-empty'),
    docsMore: $('read-docs-more'),
    docsSection: $('read-docs-section'),
    booksEmpty: $('read-books-empty'),
    notes: $('read-notes'),
    notesCount: $('read-notes-count'),
    notesEmpty: $('read-notes-empty'),
    notesSection: $('read-notes-section'),
    feeds: $('read-feeds'),
    feedsCount: $('read-feeds-count'),
    feedsEmpty: $('read-feeds-empty'),
    refresh: $('read-refresh'),
    onboarding: $('read-onboarding'),
    forgetDialog: $('forget-dialog'),
    siteDialog: $('site-dialog'),
    siteBody: $('site-body'),
    siteCancel: $('site-cancel'),
    siteOk: $('site-ok'),
    forgetBody: $('forget-body'),
    forgetCancel: $('forget-cancel'),
    forgetKeep: $('forget-keep'),
    forgetDevice: $('forget-device'),
    booksSection: $('read-books-section'),
    summary: $('library-summary'),
    download: $('library-download'),
    feedsNew: $('feeds-new'),
    feedsNewWrap: $('feeds-new-wrap'),
    feedsNewList: $('feeds-new-list'),
    addLinks: $('library-add'),
    layout: $('read-layout'),
    side: $('read-side'),
    feedsSection: $('read-feeds-section'),
    feedsMore: $('read-feeds-more'),
    booksMore: $('read-books-more'),
    notesMore: $('read-notes-more'),
  };

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const formatBytes = (n) => {
    if (!n) return '';
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  };

  function when(iso) {
    if (!iso) return '';
    const then = new Date(iso);
    const days = Math.floor((Date.now() - then.getTime()) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return then.toLocaleDateString();
  }

  /** The Library's forget control: a quiet × in the corner, asking before it acts. */
  function forgetButton(entry) {
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'card-forget';
    forget.textContent = '×';
    forget.title = 'Forget — remove it here, and optionally from the reader as well';
    forget.setAttribute('aria-label', `Forget ${entry.title}`);
    forget.addEventListener('click', () => askForget(entry));
    return forget;
  }

  /**
   * An item drawn for reading — a feed's articles, a book's cover and
   * description, a note's opening — with a × to forget books and notes. What
   * goes on the reader is set on Add/Remove. Without a summary (an unreadable
   * file) it falls back to row().
   */
  function readableRow(entry, summary) {
    const blocks = window.epubDropReading;
    if (!summary || !blocks) return row(entry);
    const block =
      summary.kind === 'feed'
        ? blocks.feedBlock(summary)
        : blocks.itemBlock(summary);

    const li = document.createElement('li');
    li.className = 'library-block';
    if (summary.feedId) li.dataset.feedId = summary.feedId;
    li.appendChild(block);
    // A feed is dropped under Add/Remove → Feeds and kept off the reader with
    // its switch, so its edition gets no forget control of its own.
    if (summary.kind !== 'feed') li.appendChild(forgetButton(entry));
    return li;
  }

  function row(entry) {
    const li = document.createElement('li');
    li.className = 'item';

    const body = document.createElement('div');
    body.className = 'item-body';

    const title = document.createElement('div');
    title.className = 'item-title';
    // The title is the way in: it opens the reading page, which links on to
    // the device-shaped eBook view and the download.
    const link = document.createElement('a');
    link.href = `/read/${entry.id}`;
    link.className = 'card-title-link';
    link.textContent = entry.author ? `${entry.title} — ${entry.author}` : entry.title;
    title.append(link);
    body.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    const kind = entry.source?.kind;
    if (kind && kind !== 'feed' && kind !== 'draft') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = kind.toUpperCase();
      meta.appendChild(badge);
    }
    const bits = [formatBytes(entry.size)];
    if (entry.mode === 'images') bits.push(`${entry.pageCount} page images`);
    else if (entry.chapters) bits.push(`${entry.chapters} chapters`);
    bits.push(entry.deliveredAt ? `sent ${when(entry.deliveredAt)}` : `added ${when(entry.builtAt)}`);
    if (entry.deliveredTo) bits.push(entry.deliveredTo);
    meta.append(bits.filter(Boolean).join(' · '));
    body.appendChild(meta);

    li.appendChild(body);

    // Downloading lives on the reading page; the card itself only reads or
    // forgets (except a feed edition, which its feed and switch look after).
    if (entry.source?.kind !== 'feed') li.appendChild(forgetButton(entry));
    return li;
  }

  function openEpub(entry) {
    window.epubDrop?.preview?.({
      id: entry.id,
      title: entry.title,
      mode: entry.mode,
      pageCount: entry.pageCount,
      chapters: entry.chapters,
    });
  }

  // The web reading page links back here with ?epub=<id> to open the ePub view.
  let pendingEpub = new URLSearchParams(location.search).get('epub');

  // The summaries last shown, so a reload redraws them at once rather than
  // flashing the compact cards while new ones arrive.
  let lastReading = { items: [] };
  // The last items and followed feeds drawn, for redrawing when a feed's
  // first edition starts or finishes building.
  let lastItems = [];
  let followedFeeds = [];

  async function load() {
    el.refresh.disabled = true;
    try {
      // The list of items comes back at once; the summaries can take longer
      // (a hosted server waking up may need to read some EPUBs). So draw
      // straight away with the summaries already known, then again when the
      // new ones arrive. Without summaries, the compact cards still work.
      const reading = api('/api/reading').catch(() => null);
      const [{ items }, followed] = await Promise.all([api('/api/outbox'), api('/api/feeds').catch(() => ({ feeds: [] }))]);
      lastItems = items;
      followedFeeds = followed.feeds || [];
      draw(items, lastReading);

      if (pendingEpub) {
        const wanted = items.find((i) => i.id === pendingEpub);
        pendingEpub = null;
        history.replaceState(null, '', location.pathname);
        if (wanted) openEpub(wanted);
      }

      const fresh = await reading;
      if (fresh) {
        lastReading = fresh;
        draw(items, fresh);
      }
    } catch (err) {
      el.booksEmpty.hidden = false;
      el.booksEmpty.querySelector('p').textContent = err.message;
    } finally {
      el.refresh.disabled = false;
    }
  }

  /** A followed feed with no edition yet: its first one is on the way, or it needs a refresh. */
  function waitingBlock(feed, buildingNow) {
    const li = document.createElement('li');
    li.className = 'library-block feed-waiting';
    li.dataset.feedId = feed.id;
    const block = document.createElement('article');
    block.className = 'reading-feed';
    const head = document.createElement('header');
    head.className = 'reading-feed-head';
    const name = document.createElement('span');
    name.className = 'reading-feed-name';
    name.textContent = feed.title || feed.url;
    head.appendChild(name);
    const note = document.createElement('p');
    note.className = 'feed-waiting-note';
    if (buildingNow) {
      const spin = document.createElement('span');
      spin.className = 'spinner';
      spin.setAttribute('aria-hidden', 'true');
      note.append(spin, 'Getting its first edition…');
      note.setAttribute('role', 'status');
    } else {
      note.textContent = feed.lastError ? `No edition yet: ${feed.lastError} ` : 'No edition yet. ';
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'link';
      again.textContent = 'Refresh feeds';
      again.addEventListener('click', () => el.refresh.click());
      note.appendChild(again);
    }
    block.append(head, note);
    li.appendChild(block);
    return li;
  }

  // A feed's first edition started or finished building: redraw the Library.
  window.addEventListener('apub:feeds-building', () => {
    api('/api/feeds')
      .then((data) => {
        followedFeeds = data.feeds || followedFeeds;
        draw(lastItems, lastReading);
      })
      .catch(() => draw(lastItems, lastReading));
  });

  /** Draw every section of the Library from the items and their summaries. */
  function draw(items, reading) {
    {
      // Newest first, so for a feed the first edition seen is the current one.
      const summaries = new Map(reading.items.map((s) => [s.id, s]));
      const draw = (entry) => readableRow(entry, summaries.get(entry.id));

      // A refreshed feed can briefly hold two editions: the one on the reader
      // and its queued replacement. Only the newest is worth reading.
      const seenFeeds = new Set();
      const feeds = items.filter((i) => {
        if (i.source?.kind !== 'feed') return false;
        const key = i.source.feedId || i.id;
        if (seenFeeds.has(key)) return false;
        seenFeeds.add(key);
        return true;
      });
      // Followed feeds with no edition yet: being built now, or waiting.
      const buildingNow = new Set(window.epubDropFeeds?.building?.() || []);
      const waiting = followedFeeds.filter((f) => !seenFeeds.has(f.id));
      const notes = items.filter((i) => i.source?.kind === 'draft');
      // Books come from Find books; documents are what you converted yourself.
      const books = items.filter((i) => i.source?.kind === 'book');
      const docs = items.filter((i) => !['feed', 'draft', 'book'].includes(i.source?.kind));

      // With nothing built at all, the small "nothing here" notes are useless.
      // Replace the lists with one panel that says how to get content instead.
      const nothingYet = books.length === 0 && docs.length === 0 && feeds.length === 0 && notes.length === 0 && waiting.length === 0;
      el.onboarding.hidden = !nothingYet;
      el.booksSection.hidden = nothingYet;
      el.docsSection.hidden = nothingYet;
      el.docsCount.textContent = docs.length ? `· ${docs.length}` : '';
      el.docsEmpty.hidden = docs.length > 0;
      el.docsMore.hidden = docs.length === 0;
      el.notesSection.hidden = nothingYet;
      el.feedsSection.hidden = nothingYet;

      el.booksCount.textContent = books.length ? `· ${books.length}` : '';
      el.feedsCount.textContent = feeds.length + waiting.length ? `· ${feeds.length + waiting.length}` : '';
      el.booksEmpty.hidden = books.length > 0;
      el.feedsEmpty.hidden = feeds.length + waiting.length > 0;
      // An empty section has its own buttons; a filled one gets a link below it.
      el.booksMore.hidden = books.length === 0;
      el.feedsMore.hidden = feeds.length === 0;
      el.notesMore.hidden = notes.length === 0;
      el.notesCount.textContent = notes.length ? `· ${notes.length}` : '';
      el.notesEmpty.hidden = notes.length > 0;

      // A line summing up what there is to read. With no books or notes, the
      // articles take the full width and the ways to add those become links
      // beside it, rather than a sidebar of empty boxes.
      el.summary.textContent = nothingYet ? '' : window.epubDropReading?.summaryLine(reading.items) || '';
      // Every eBook in one zip, in the same folders they use on the reader.
      el.download.hidden = nothingYet;
      const sideEmpty = !nothingYet && !books.length && !docs.length && !notes.length;
      el.side.hidden = sideEmpty;
      el.layout.classList.toggle('read-wide', sideEmpty);
      el.addLinks.hidden = !sideEmpty;

      el.books.replaceChildren(...books.map(draw));
      el.docs.replaceChildren(...docs.map(draw));
      el.notes.replaceChildren(...notes.map(draw));
      el.feeds.replaceChildren(...waiting.map((f) => waitingBlock(f, buildingNow.has(f.id))), ...feeds.map(draw));
      showNewCounts();
    }
  }

  // The empty states' buttons — the first-run panel, and each section that has
  // nothing in it yet — jump to the tab and control that does the job.
  document.getElementById('tab-read').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-goto]');
    if (!button) return;
    window.epubDropTabs?.show(button.dataset.goto, button.dataset.focus);
    // Some jobs start with a click, like opening the Find feeds list — but a
    // toggle that is already open would be closed by it, so leave that alone.
    const target = button.dataset.click && document.getElementById(button.dataset.click);
    if (target) {
      if (target.getAttribute('aria-expanded') !== 'true') target.click();
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  // ------------------------------------------------------------- forgetting
  //
  // Two separate places hold a copy: this app's record, which is what makes a
  // book readable in the browser, and the file on the reader. They used to come
  // apart — forgetting here left the reader's copy behind with nothing in the
  // interface admitting it — so the reader's copy is now part of the question,
  // and a removal is queued if the device is not connected at the time.

  let forgetting = null;

  function askForget(entry) {
    forgetting = entry;
    el.forgetBody.textContent = entry.deliveredAt
      ? `"${entry.title}" was sent to ${entry.folder || 'the reader'}. Forgetting drops this ` +
        `app's copy so it can no longer be read here. Should the reader's copy go too?`
      : `Forget "${entry.title}"? This removes the app's copy.`;
    // Nothing was ever sent, so there is nothing on the reader to offer.
    el.forgetDevice.hidden = !entry.deliveredAt;
    el.forgetKeep.textContent = entry.deliveredAt ? 'Leave on reader' : 'Forget';
    el.forgetDialog.showModal();
  }

  async function doForget(fromDevice) {
    const entry = forgetting;
    el.forgetDialog.close();
    forgetting = null;
    if (!entry) return;

    try {
      const { pending } = await api('/api/outbox/remove', {
        method: 'POST',
        body: JSON.stringify({ id: entry.id, fromDevice }),
      });
      load();
      window.epubDrop?.reloadQueue?.();
      if (fromDevice) window.epubDrop?.reloadRemovals?.(pending);
    } catch (err) {
      alert(err.message);
    }
  }

  el.forgetCancel.addEventListener('click', () => {
    el.forgetDialog.close();
    forgetting = null;
  });
  el.forgetKeep.addEventListener('click', () => doForget(false));
  el.forgetDevice.addEventListener('click', () => doForget(true));

  // Refresh feeds fetches the latest feed editions; the list reloads itself
  // when that finishes. With no feeds to fetch (or a refresh already running)
  // it just reloads the list. Feeds never refresh on their own.
  el.refresh.title = 'Fetch the latest editions of every feed';
  el.refresh.addEventListener('click', () => {
    if (!window.epubDropFeeds?.refreshAll()) load();
  });

  // ------------------------------------------------------------- new articles
  //
  // A quiet check, when the Library opens and every so often after: how many
  // articles each feed has that its edition here does not. It only reads the
  // feeds — nothing is rebuilt or sent — and shows a count beside Refresh feeds
  // and on each feed with something new.

  const CHECK_EVERY_MS = 15 * 60 * 1000;
  let newCounts = new Map();
  // Feed titles from the last check, for the list behind the total.
  let newTitles = new Map();
  // The new articles themselves, per feed: listed at the top of its box, tagged
  // New, until a refresh brings them into the edition.
  let newArticles = new Map();
  let checking = null;

  const shortDate = (iso) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

  // Asking before leaving for a publisher's site.
  let siteLink = '';
  function askOpenSite(link) {
    siteLink = link;
    let host = '';
    try {
      host = new URL(link).hostname.replace(/^www\./, '');
    } catch {}
    el.siteBody.textContent = host ? `Open the news site (${host}) in a new tab?` : 'Open the news site in a new tab?';
    el.siteDialog.showModal();
    el.siteOk.focus();
  }
  el.siteCancel.addEventListener('click', () => el.siteDialog.close());
  el.siteOk.addEventListener('click', () => {
    el.siteDialog.close();
    if (/^https?:\/\//i.test(siteLink)) window.open(siteLink, '_blank', 'noopener,noreferrer');
  });

  /** The not-yet-fetched articles at the top of a feed's box. */
  function newList(articles) {
    const list = document.createElement('ol');
    list.className = 'reading-articles reading-new';
    list.setAttribute('aria-label', 'New articles, not in this edition yet');
    for (const article of articles) {
      const li = document.createElement('li');
      li.className = 'reading-article is-new';
      const title = document.createElement(article.link ? 'a' : 'span');
      title.className = 'reading-article-title';
      title.textContent = article.title;
      if (article.link) {
        // Not in an edition yet, so it opens on the publisher's site, after
        // asking. Cmd/Ctrl-click and middle-click still open it straight away.
        title.href = article.link;
        title.target = '_blank';
        title.rel = 'noreferrer noopener';
        title.addEventListener('click', (event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          askOpenSite(article.link);
        });
      }
      const tag = document.createElement('span');
      tag.className = 'new-tag';
      tag.textContent = 'New';
      li.append(tag, title);
      const meta = document.createElement('p');
      meta.className = 'reading-byline';
      meta.textContent = [article.author, shortDate(article.date), 'not in this edition yet — Refresh feeds to add it']
        .filter(Boolean)
        .join(' · ');
      li.appendChild(meta);
      list.appendChild(li);
    }
    return list;
  }

  function showNewCounts() {
    const total = [...newCounts.values()].reduce((n, c) => n + c, 0);
    el.feedsNewWrap.hidden = total === 0;
    el.feedsNew.textContent = `${total} new`;
    el.feedsNew.setAttribute('aria-label', `${total} new article${total === 1 ? '' : 's'} in your feeds; show which`);
    showNewList();

    for (const li of el.feeds.querySelectorAll('.library-block[data-feed-id]')) {
      const count = newCounts.get(li.dataset.feedId) || 0;
      const head = li.querySelector('.reading-feed-head');
      let chip = head?.querySelector('.new-count');
      // The new headlines themselves, above the edition's articles.
      li.querySelector('.reading-new')?.remove();
      const fresh = newArticles.get(li.dataset.feedId) || [];
      if (fresh.length) li.querySelector('.reading-articles')?.before(newList(fresh));

      if (!count) {
        chip?.remove();
        continue;
      }
      if (!chip && head) {
        chip = document.createElement('span');
        chip.className = 'new-count';
        head.querySelector('.reading-feed-meta')?.before(chip);
      }
      if (chip) {
        chip.textContent = `${count} new`;
        chip.title = `${count} newer article${count === 1 ? '' : 's'} than this edition`;
      }
    }
  }

  /** The list behind the total: each feed with something new, most first. */
  function showNewList() {
    const rows = [...newCounts]
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
    const head = document.createElement('p');
    head.className = 'new-popover-head';
    head.textContent = 'New since your editions';
    const list = document.createElement('ul');
    for (const [feedId, count] of rows) {
      const li = document.createElement('li');
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'new-popover-feed';
      const name = document.createElement('span');
      name.textContent = newTitles.get(feedId) || 'A feed';
      const n = document.createElement('span');
      n.className = 'new-popover-count';
      n.textContent = `${count} new`;
      go.append(name, n);
      // Jump to that feed's box, where the new headlines are listed.
      go.addEventListener('click', () => {
        closeNewList();
        const block = el.feeds.querySelector(`.library-block[data-feed-id="${CSS.escape(feedId)}"]`);
        block?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      li.appendChild(go);
      list.appendChild(li);
    }
    const foot = document.createElement('p');
    foot.className = 'new-popover-foot';
    foot.textContent = 'Refresh feeds to add them to your editions.';
    el.feedsNewList.replaceChildren(head, list, foot);
  }

  // Hover shows the list (CSS); a click or tap pins it open, for touch screens
  // and keyboards, and a click elsewhere or Escape closes it.
  const closeNewList = () => {
    el.feedsNewWrap.classList.remove('is-open');
    el.feedsNew.setAttribute('aria-expanded', 'false');
  };
  // The list hangs from the right of the pill; on a narrow screen that can
  // push it off the left edge, so slide it back into view.
  const placeNewList = () => {
    el.feedsNewList.style.right = '0px';
    const left = el.feedsNewList.getBoundingClientRect().left;
    if (left < 8) el.feedsNewList.style.right = `${left - 8}px`;
  };
  el.feedsNewWrap.addEventListener('mouseenter', placeNewList);
  el.feedsNewWrap.addEventListener('focusin', placeNewList);
  el.feedsNew.addEventListener('click', () => {
    placeNewList();
    const open = !el.feedsNewWrap.classList.contains('is-open');
    el.feedsNewWrap.classList.toggle('is-open', open);
    el.feedsNew.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#feeds-new-wrap')) closeNewList();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && el.feedsNewWrap.classList.contains('is-open')) {
      closeNewList();
      el.feedsNew.focus();
    }
  });

  async function checkForNew() {
    if (checking) return checking;
    checking = (async () => {
      try {
        const { feeds } = await api('/api/feeds/check');
        newCounts = new Map(feeds.map((f) => [f.feedId, f.newCount]));
        newTitles = new Map(feeds.map((f) => [f.feedId, f.title]));
        newArticles = new Map(feeds.map((f) => [f.feedId, f.articles || []]));
      } catch {
        // Offline (the reader's hotspot, say): keep whatever was known.
      } finally {
        checking = null;
        showNewCounts();
      }
    })();
    return checking;
  }

  window.epubDropRead = { load, askForget, checkForNew };
  load().then(checkForNew);
  setInterval(checkForNew, CHECK_EVERY_MS);
})();
