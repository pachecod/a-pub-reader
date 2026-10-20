'use strict';

// The reading page's one piece of script: its On reader switch.
//
// The page is otherwise script-free — its text comes from wherever the book
// came from — and its security policy allows only this file from the app
// itself, never anything inline or from the book. The switch works exactly as
// on the Library card: on sends it at the next sync, off keeps it off the
// reader or takes it off at the next sync.

(function () {
  const toggle = document.querySelector('.bar .switch');
  const state = document.getElementById('reader-state');
  if (!toggle) return;

  const describe = (item) => {
    const on = item.onReader !== false;
    if (on) return item.deliveredAt ? 'On the reader' : 'Goes over at the next sync';
    return item.deliveredAt ? 'Comes off at the next sync' : 'Not on the reader';
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
      const res = await fetch('/api/outbox/on-reader', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: toggle.dataset.id, on }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (state && data.item) state.textContent = describe(data.item);
    } catch (err) {
      show(!on);
      if (state) state.textContent = `Could not change it: ${err.message}`;
    } finally {
      toggle.disabled = false;
    }
  });
})();
