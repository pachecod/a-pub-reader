'use strict';

// The reading page's one piece of script: the font and size panel, its On
// reader switch, and the quiet Sync Reader link that appears beside the note
// while a change is waiting.
//
// The page is otherwise script-free — its text comes from wherever the book
// came from — and its security policy allows only this file from the app
// itself, never anything inline or from the book. The switch works exactly as
// on the Library card: on sends it at the next sync, off keeps it off the
// reader or takes it off at the next sync.

// ---- font and size
//
// The same choices as the eBook viewer, kept per browser. They are applied the
// moment this file runs (it loads in <head>, not deferred), before the text is
// drawn; the panel is wired once the page is there.
(function () {
  const FONTS = [
    { id: 'charter', label: 'Charter', stack: 'Charter, "Iowan Old Style", Georgia, "Times New Roman", serif' },
    { id: 'georgia', label: 'Georgia', stack: 'Georgia, "Times New Roman", Times, serif' },
    { id: 'palatino', label: 'Palatino', stack: 'Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif' },
    { id: 'iowan', label: 'Iowan Old Style', stack: '"Iowan Old Style", "Sitka Text", Charter, Georgia, serif' },
    { id: 'system', label: 'System sans', stack: 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif' },
    { id: 'verdana', label: 'Verdana', stack: 'Verdana, Tahoma, "DejaVu Sans", sans-serif' },
    { id: 'mono', label: 'Monospace', stack: 'ui-monospace, Menlo, Consolas, "Courier New", monospace' },
  ];
  const SIZE_MIN = 14;
  const SIZE_MAX = 30;
  const DEFAULTS = { font: 'charter', size: 19 };
  const KEY = 'apub.webReadType';
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  let type = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    type = {
      font: FONTS.some((f) => f.id === saved.font) ? saved.font : DEFAULTS.font,
      size: clamp(Math.round(Number(saved.size)) || DEFAULTS.size, SIZE_MIN, SIZE_MAX),
    };
  } catch {
    /* private window, or nothing saved yet: the defaults are fine */
  }

  const apply = () => {
    const font = FONTS.find((f) => f.id === type.font) || FONTS[0];
    document.documentElement.style.setProperty('--read-font', font.stack);
    document.documentElement.style.setProperty('--read-size', `${type.size}px`);
  };
  apply();

  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('type-toggle');
    const panel = document.getElementById('type-panel');
    const family = document.getElementById('type-family');
    const smaller = document.getElementById('type-smaller');
    const bigger = document.getElementById('type-bigger');
    const sizeLabel = document.getElementById('type-size');
    const reset = document.getElementById('type-reset');
    if (!toggle || !panel) return;

    family.replaceChildren(...FONTS.map((f) => new Option(f.label, f.id)));

    const show = () => {
      family.value = type.font;
      sizeLabel.textContent = `${type.size} px`;
      smaller.disabled = type.size <= SIZE_MIN;
      bigger.disabled = type.size >= SIZE_MAX;
    };
    const set = (change) => {
      type = { ...type, ...change };
      apply();
      show();
      try {
        localStorage.setItem(KEY, JSON.stringify(type));
      } catch {
        /* not keeping it is not a failure */
      }
    };
    show();

    const open = (yes) => {
      panel.hidden = !yes;
      toggle.setAttribute('aria-expanded', String(yes));
    };
    toggle.addEventListener('click', () => open(panel.hidden));
    family.addEventListener('change', () => set({ font: family.value }));
    smaller.addEventListener('click', () => set({ size: clamp(type.size - 1, SIZE_MIN, SIZE_MAX) }));
    bigger.addEventListener('click', () => set({ size: clamp(type.size + 1, SIZE_MIN, SIZE_MAX) }));
    reset.addEventListener('click', () => set({ ...DEFAULTS }));

    // Close on a click elsewhere or Escape, as a menu does.
    document.addEventListener('click', (event) => {
      if (!panel.hidden && !event.target.closest('.type-menu')) open(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) {
        open(false);
        toggle.focus();
      }
    });
  });
})();

// ---- On reader switch and Sync Reader
document.addEventListener('DOMContentLoaded', () => {
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

  // The same sync as Sync Reader in the app, the way the app last synced —
  // over Wi-Fi to the saved reader address, or into the saved card or synced
  // cloud folder: everything switched on that is not there yet goes over, and
  // everything switched off comes off.
  syncLink?.addEventListener('click', async () => {
    syncLink.disabled = true;
    syncLink.textContent = 'Syncing…';
    let message = '';
    try {
      const [{ items }, config] = await Promise.all([api('/api/outbox'), api('/api/config')]);
      const ids = items.filter((i) => i.onReader !== false && !i.deliveredAt).map((i) => i.id);
      const viaFolder = config.destination && config.destination !== 'wifi';
      const result = await api(viaFolder ? '/api/send-volume' : '/api/send', {
        method: 'POST',
        body: JSON.stringify(viaFolder ? { ids, volume: config.destination } : { ids }),
      });
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
});
