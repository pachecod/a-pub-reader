'use strict';

// The reading page's one piece of script: its On reader switch, and the quiet
// Sync Reader link that appears beside the note while a change is waiting.
//
// The page is otherwise script-free — its text comes from wherever the book
// came from — and its security policy allows only this file from the app
// itself, never anything inline or from the book. The switch works exactly as
// on the Library card: on sends it at the next sync, off keeps it off the
// reader or takes it off at the next sync.

(function () {
  const toggle = document.querySelector('.bar .switch');
  const state = document.getElementById('reader-state');
  const syncLink = document.getElementById('reader-sync');
  if (!toggle) return;
  const id = toggle.dataset.id;

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const describe = (item) => {
    const on = item.onReader !== false;
    if (on) return item.deliveredAt ? 'On the reader' : 'Goes over at the next sync';
    return item.deliveredAt ? 'Comes off at the next sync' : 'Not on the reader';
  };

  /** Show where the item stands, and offer to sync while a change waits. */
  const render = (item, message) => {
    const words = describe(item);
    state.textContent = message ? `${words} — ${message}` : words;
    if (syncLink) syncLink.hidden = !words.includes('next sync');
  };

  const show = (on) => {
    toggle.setAttribute('aria-checked', String(on));
    toggle.title = on ? 'Switch off to keep it off the reader' : 'Switch on to put it on the reader';
  };

  toggle.addEventListener('click', async () => {
    const on = toggle.getAttribute('aria-checked') !== 'true';
    toggle.disabled = true;
    show(on);
    try {
      const { item } = await api('/api/outbox/on-reader', {
        method: 'POST',
        body: JSON.stringify({ id, on }),
      });
      if (item) render(item);
    } catch (err) {
      show(!on);
      state.textContent = `Could not change it: ${err.message}`;
    } finally {
      toggle.disabled = false;
    }
  });

  // The same sync as Sync Reader in the app, over Wi-Fi to the saved reader
  // address: everything switched on that is not there yet goes over, and
  // everything switched off comes off.
  syncLink?.addEventListener('click', async () => {
    syncLink.disabled = true;
    syncLink.textContent = 'Syncing…';
    let message = '';
    try {
      const { items } = await api('/api/outbox');
      const ids = items.filter((i) => i.onReader !== false && !i.deliveredAt).map((i) => i.id);
      const result = await api('/api/send', { method: 'POST', body: JSON.stringify({ ids }) });
      const mine = result.results?.find((r) => r.id === id);
      if (result.error && !result.results?.length) message = result.error;
      else if (mine && !mine.ok) message = mine.error;
      else message = 'synced';
    } catch (err) {
      message = err.message;
    }
    try {
      const { items } = await api('/api/outbox');
      const item = items.find((i) => i.id === id);
      if (item) render(item, message);
      else state.textContent = message;
    } catch {
      state.textContent = message;
    }
    syncLink.disabled = false;
    syncLink.textContent = 'Sync Reader';
  });
})();
