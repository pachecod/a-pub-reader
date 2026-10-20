'use strict';

// Tab switching, plus the pending-queue badge.
//
// Library is the default because that is the common case: you open the app to see
// what is on the reader, not to add something. Adding and writing are the less
// frequent, more deliberate acts.
//
// The badge exists because the send controls live on Add. Without it, something
// built on Write and left queued would be invisible from the other two tabs.

(function () {
  const $ = (id) => document.getElementById(id);

  const nav = document.querySelector('.tabs');
  const badge = $('pending-badge');
  const panels = {
    read: $('tab-read'),
    add: $('tab-add'),
    write: $('tab-write'),
  };

  let current = 'read';
  // Whether a tab has been shown yet, to skip the redundant first reload.
  let shown = false;

  function show(name, focusId) {
    if (!panels[name]) return;
    current = name;

    for (const [key, panel] of Object.entries(panels)) {
      panel.hidden = key !== name;
    }
    for (const tab of nav.querySelectorAll('.tab')) {
      const active = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(active));
      tab.classList.toggle('active', active);
    }

    // Opening Library should show current information, not whatever was cached
    // when the page loaded — but not on the very first show, since read.js
    // loads itself and app.js reloads it whenever the queue changes.
    if (name === 'read' && shown) window.epubDrop?.reloadRead?.();
    shown = true;
    // The editor takes focus when Write opens, but not when the caller asked
    // for something specific — otherwise the editor wins the race.
    if (name === 'write' && !focusId) window.epubDrop?.editorShown?.();

    // Sending someone to a tab is only helpful if they land on the thing they
    // were promised. Focus immediately — the panel is already visible by now,
    // and deferring to a frame callback did not reliably take effect.
    if (focusId) {
      const target = document.getElementById(focusId);
      if (target) {
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }

    // Keep the address bar in step so a reload lands on the same tab.
    const url = new URL(window.location.href);
    if (name === 'read') url.searchParams.delete('tab');
    else url.searchParams.set('tab', name);
    history.replaceState(null, '', url);
  }

  nav.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    show(tab.dataset.tab);
    // Clicking Library, even when already on it, brings in the latest feeds.
    if (tab.dataset.tab === 'read') window.epubDropFeeds?.refreshAll();
  });

  // Left/right arrows move between tabs when one has focus.
  nav.addEventListener('keydown', (event) => {
    if (!event.target.classList?.contains('tab')) return;
    const order = ['read', 'add', 'write'];
    const at = order.indexOf(current);
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      const next = order[(at + 1) % order.length];
      show(next);
      nav.querySelector(`[data-tab="${next}"]`).focus();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const prev = order[(at - 1 + order.length) % order.length];
      show(prev);
      nav.querySelector(`[data-tab="${prev}"]`).focus();
    }
  });

  badge.addEventListener('click', () => show('read'));

  /** Called by app.js with how many changes the next Sync Reader will make. */
  function setPending(count) {
    badge.hidden = count === 0;
    badge.textContent = `${count} to sync`;
    badge.title =
      count === 1
        ? '1 change waiting for Sync Reader — click to open the Library'
        : `${count} changes waiting for Sync Reader — click to open the Library`;
  }

  window.epubDropTabs = { show, setPending, current: () => current };

  // A tab in the URL wins on load, so a reload or a bookmark keeps its place.
  const wanted = new URL(window.location.href).searchParams.get('tab');
  show(panels[wanted] ? wanted : 'read');
})();
