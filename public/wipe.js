'use strict';

// Remove everything, at the foot of Add/Remove.
//
// One button that starts the app over: every built item, sent or not, every
// followed feed, every draft and its images. Typing the phrase is the point —
// this cannot be undone — and the server checks it too. Settings are kept.

(function () {
  const $ = (id) => document.getElementById(id);
  const el = {
    open: $('wipe-open'),
    status: $('wipe-status'),
    dialog: $('wipe-dialog'),
    body: $('wipe-body'),
    phrase: $('wipe-phrase'),
    device: $('wipe-device'),
    cancel: $('wipe-cancel'),
    confirm: $('wipe-confirm'),
  };

  const PHRASE = 'I Agree';
  const DONE_KEY = 'apub-wipe-result';

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  el.open.addEventListener('click', async () => {
    const [outbox, feeds, drafts] = await Promise.all([
      api('/api/outbox').catch(() => ({ items: [] })),
      api('/api/feeds').catch(() => ({ feeds: [] })),
      api('/api/drafts').catch(() => ({ drafts: [] })),
    ]);
    el.body.textContent =
      `This removes ${plural(outbox.items.length, 'built item')} (sent or not), ` +
      `${plural(feeds.feeds.length, 'followed feed')} and ${plural(drafts.drafts.length, 'draft')}, ` +
      'along with their images and any leftover files. Your settings are kept. This cannot be undone.';
    el.phrase.value = '';
    el.confirm.disabled = true;
    el.status.textContent = '';
    el.dialog.showModal();
    el.phrase.focus();
  });

  const checkPhrase = () => {
    el.confirm.disabled = el.phrase.value.trim().toLowerCase() !== PHRASE.toLowerCase();
  };
  el.phrase.addEventListener('input', checkPhrase);
  el.phrase.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    checkPhrase();
    if (!el.confirm.disabled) el.confirm.click();
  });

  el.cancel.addEventListener('click', () => el.dialog.close());

  el.confirm.addEventListener('click', async () => {
    const fromDevice = el.device.checked;
    el.confirm.disabled = true;
    try {
      const result = await api('/api/remove-everything', {
        method: 'POST',
        body: JSON.stringify({ confirm: el.phrase.value.trim(), fromDevice }),
      });
      const summary =
        `Removed ${plural(result.items, 'item')}, ${plural(result.feeds, 'feed')} and ${plural(result.drafts, 'draft')}. ` +
        (fromDevice
          ? `${plural(result.pending, 'file')} will come off the reader on the next sync.`
          : "The reader's copies were left alone.");

      // Every tab holds some of what was just deleted, so start the page over
      // rather than patching each one. The open draft must not be saved back.
      window.epubDropEditor?.discard?.();
      try {
        sessionStorage.setItem(DONE_KEY, summary);
      } catch {}
      const url = new URL(location.href);
      url.searchParams.set('tab', 'add');
      location.replace(url);
    } catch (err) {
      el.status.textContent = err.message;
      el.status.className = 'status bad';
      el.confirm.disabled = false;
      el.dialog.close();
    }
  });

  // Report the result of a wipe that just reloaded the page.
  try {
    const done = sessionStorage.getItem(DONE_KEY);
    if (done) {
      sessionStorage.removeItem(DONE_KEY);
      el.status.textContent = done;
      el.status.className = 'status ok';
      requestAnimationFrame(() => el.status.scrollIntoView({ block: 'center' }));
    }
  } catch {}
})();
