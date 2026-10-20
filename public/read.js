'use strict';

// The Library tab: everything this app has built, whether or not it has reached
// the reader yet.
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
    booksEmpty: $('read-books-empty'),
    notes: $('read-notes'),
    notesCount: $('read-notes-count'),
    notesEmpty: $('read-notes-empty'),
    notesFolder: $('read-notes-folder'),
    notesSection: $('read-notes-section'),
    feeds: $('read-feeds'),
    feedsCount: $('read-feeds-count'),
    feedsEmpty: $('read-feeds-empty'),
    feedsFolder: $('read-feeds-folder'),
    refresh: $('read-refresh'),
    onboarding: $('read-onboarding'),
    forgetDialog: $('forget-dialog'),
    forgetBody: $('forget-body'),
    forgetCancel: $('forget-cancel'),
    forgetKeep: $('forget-keep'),
    forgetDevice: $('forget-device'),
    booksSection: $('read-books-section'),
    feedsSection: $('read-feeds-section'),
    feedsMore: $('read-feeds-more'),
    booksMore: $('read-books-more'),
    sentKey: $('read-sent-key'),
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

  function row(entry) {
    const li = document.createElement('li');
    li.className = 'item';

    const body = document.createElement('div');
    body.className = 'item-body';

    const title = document.createElement('div');
    title.className = 'item-title';
    // Green once it is on the reader, red while it only exists here; the key
    // at the foot of the tab explains the colours.
    const dot = document.createElement('span');
    dot.className = entry.deliveredAt ? 'sent-dot sent' : 'sent-dot';
    const state = entry.deliveredAt ? 'Sent to the eReader' : 'Not sent yet';
    dot.title = state;
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', state);
    // The title is the way in: it opens the reading page, which links on to
    // the device-shaped eBook view and the download.
    const link = document.createElement('a');
    link.href = `/read/${entry.id}`;
    link.className = 'card-title-link';
    link.textContent = entry.author ? `${entry.title} — ${entry.author}` : entry.title;
    title.append(dot, link);
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
    // forgets. Forget is a quiet × in the corner, asking before it acts.
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'card-forget';
    forget.textContent = '×';
    forget.title = 'Forget — remove it here, and optionally from the reader as well';
    forget.setAttribute('aria-label', `Forget ${entry.title}`);
    forget.addEventListener('click', () => askForget(entry));
    li.appendChild(forget);
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

  async function load() {
    el.refresh.disabled = true;
    try {
      // Newest first, so for a feed the first edition seen is the current one.
      const { items } = await api('/api/outbox');

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
      const notes = items.filter((i) => i.source?.kind === 'draft');
      const books = items.filter((i) => !['feed', 'draft'].includes(i.source?.kind));

      // With nothing built at all, three small "nothing here" notes are useless.
      // Replace the lists with one panel that says how to get content instead.
      const nothingYet = books.length === 0 && feeds.length === 0 && notes.length === 0;
      el.onboarding.hidden = !nothingYet;
      el.booksSection.hidden = nothingYet;
      el.notesSection.hidden = nothingYet;
      el.feedsSection.hidden = nothingYet;
      el.sentKey.hidden = nothingYet;

      el.booksCount.textContent = books.length ? `· ${books.length}` : '';
      el.feedsCount.textContent = feeds.length ? `· ${feeds.length}` : '';
      el.booksEmpty.hidden = books.length > 0;
      el.feedsEmpty.hidden = feeds.length > 0;
      // An empty section has its own buttons; a filled one gets a link below it.
      el.booksMore.hidden = books.length === 0;
      el.feedsMore.hidden = feeds.length === 0;
      el.feedsFolder.textContent = feeds.length ? feeds[0].folder || '' : '';
      el.notesCount.textContent = notes.length ? `· ${notes.length}` : '';
      el.notesEmpty.hidden = notes.length > 0;
      el.notesFolder.textContent = notes.length ? notes[0].folder || '' : '';

      el.books.replaceChildren(...books.map(row));
      el.notes.replaceChildren(...notes.map(row));
      el.feeds.replaceChildren(...feeds.map(row));

      if (pendingEpub) {
        const wanted = items.find((i) => i.id === pendingEpub);
        pendingEpub = null;
        history.replaceState(null, '', location.pathname);
        if (wanted) openEpub(wanted);
      }
    } catch (err) {
      el.booksEmpty.hidden = false;
      el.booksEmpty.querySelector('p').textContent = err.message;
    } finally {
      el.refresh.disabled = false;
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

  el.refresh.addEventListener('click', load);
  window.epubDropRead = { load };
  load();
})();
