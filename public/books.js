'use strict';

// Find books: browse a catalogue feed, tick the ones you want, queue them.
//
// Unlike the RSS feature, nothing here is converted. A catalogue entry links to
// a finished EPUB — Standard Ebooks typeset theirs with far more care than any
// converter could manage — so the file is downloaded and queued untouched.

(function () {
  const $ = (id) => document.getElementById(id);

  const el = {
    source: $('books-source'),
    url: $('books-url'),
    filter: $('books-filter'),
    browse: $('books-browse'),
    list: $('books'),
    count: $('books-count'),
    actions: $('books-actions'),
    all: $('books-all'),
    add: $('books-add'),
    status: $('books-status'),
  };

  const CUSTOM = '__custom__';
  let books = [];
  let working = false;

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const setStatus = (text, kind = '') => {
    el.status.textContent = text;
    el.status.className = `status ${kind}`;
  };

  const sourceUrl = () => (el.source.value === CUSTOM ? el.url.value.trim() : el.source.value);

  function visible() {
    const needle = el.filter.value.trim().toLowerCase();
    if (!needle) return books;
    return books.filter((b) => `${b.title} ${b.author}`.toLowerCase().includes(needle));
  }

  function render() {
    const shown = visible();
    el.count.textContent = books.length ? `· ${shown.length}${shown.length === books.length ? '' : ` of ${books.length}`}` : '';
    el.actions.hidden = books.length === 0;
    el.filter.hidden = books.length < 6;

    const selected = shown.filter((b) => b.selected);
    el.add.disabled = working || !selected.length;
    el.add.textContent = selected.length
      ? `Add ${selected.length} to queue`
      : 'Add to queue';
    el.all.checked = shown.length > 0 && shown.every((b) => b.selected);

    el.list.replaceChildren(
      ...shown.map((book) => {
        const li = document.createElement('li');
        li.className = 'item';

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = Boolean(book.selected);
        check.disabled = working;
        check.addEventListener('change', () => {
          book.selected = check.checked;
          render();
        });

        const body = document.createElement('div');
        body.className = 'item-body';

        const title = document.createElement('div');
        title.className = 'item-title';
        title.textContent = book.author ? `${book.title} — ${book.author}` : book.title;
        body.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'item-meta';
        const bits = [];
        if (book.bytes) bits.push(formatBytes(book.bytes));
        if (book.published) bits.push(new Date(book.published).toLocaleDateString());
        meta.textContent = bits.join(' · ');
        body.appendChild(meta);

        if (book.summary) {
          const summary = document.createElement('div');
          summary.className = 'book-summary';
          summary.textContent = book.summary;
          body.appendChild(summary);
        }

        // Already downloaded once: say so rather than letting it be queued twice.
        if (book.queued) {
          const note = document.createElement('div');
          note.className = 'book-queued';
          note.textContent = '✓ Already in the queue';
          body.appendChild(note);
        }
        if (book.error) {
          const err = document.createElement('div');
          err.className = 'item-err';
          err.textContent = book.error;
          body.appendChild(err);
        }

        li.append(check, body);
        return li;
      })
    );
  }

  function formatBytes(n) {
    if (!n) return '';
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  }

  async function loadCatalogues() {
    try {
      const { catalogues } = await api('/api/books/catalogues');
      el.source.replaceChildren(
        ...catalogues.map((c) => new Option(c.label, c.url)),
        new Option('Other feed…', CUSTOM)
      );
      el.source.value = catalogues[0]?.url || CUSTOM;
      syncSource();
    } catch (err) {
      setStatus(err.message, 'bad');
    }
  }

  function syncSource() {
    el.url.hidden = el.source.value !== CUSTOM;
    if (!el.url.hidden) el.url.focus();
  }

  async function browse() {
    const url = sourceUrl();
    if (!url) {
      setStatus('Enter a catalogue feed URL.', 'bad');
      return;
    }

    working = true;
    el.browse.disabled = true;
    setStatus('Fetching the catalogue…');
    try {
      const data = await api(`/api/books/browse?url=${encodeURIComponent(url)}`);
      if (data.ok === false) throw new Error(data.error);

      books = data.books.map((b) => ({ ...b, selected: false }));
      render();

      if (!books.length) {
        setStatus(
          data.skipped
            ? `That feed has ${data.skipped} entries but none offer an EPUB — it looks like an article feed. Add it under Feeds instead.`
            : 'That feed has no entries.',
          'bad'
        );
      } else {
        setStatus(
          `${data.title}: ${books.length} book${books.length === 1 ? '' : 's'}` +
            (data.skipped ? ` (${data.skipped} entries had no EPUB)` : ''),
          'ok'
        );
      }
    } catch (err) {
      books = [];
      render();
      setStatus(err.message, 'bad');
    } finally {
      working = false;
      el.browse.disabled = false;
      render();
    }
  }

  async function addSelected() {
    const chosen = visible().filter((b) => b.selected);
    if (!chosen.length || working) return;

    working = true;
    render();
    setStatus(`Downloading ${chosen.length} book${chosen.length === 1 ? '' : 's'}…`);

    try {
      const data = await api('/api/books/queue', {
        method: 'POST',
        body: JSON.stringify({
          books: chosen.map((b) => ({
            id: b.id,
            title: b.title,
            author: b.author,
            epubUrl: b.epubUrl,
            pageUrl: b.pageUrl,
          })),
        }),
      });

      const ok = data.results.filter((r) => r.ok);
      const failed = data.results.filter((r) => !r.ok);

      for (const book of chosen) {
        const result = data.results.find((r) => r.title === book.title);
        book.error = result && !result.ok ? result.error : undefined;
        if (result?.ok) {
          book.queued = true;
          book.selected = false;
        }
      }
      render();

      setStatus(
        failed.length
          ? `Queued ${ok.length}, ${failed.length} failed.`
          : `Queued ${ok.length} book${ok.length === 1 ? '' : 's'} — hit Send to reader when connected.`,
        failed.length ? 'bad' : 'ok'
      );

      // Books share the queue with everything else.
      window.epubDrop?.reloadQueue?.();
    } catch (err) {
      setStatus(err.message, 'bad');
    } finally {
      working = false;
      render();
    }
  }

  el.browse.addEventListener('click', browse);
  el.source.addEventListener('change', () => {
    syncSource();
    if (el.source.value !== CUSTOM) browse();
  });
  el.url.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') browse();
  });
  el.filter.addEventListener('input', render);
  el.all.addEventListener('change', () => {
    for (const book of visible()) book.selected = el.all.checked;
    render();
  });
  el.add.addEventListener('click', addSelected);

  loadCatalogues();
})();
