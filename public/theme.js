'use strict';

// Color themes, shared by every page (the app, reading pages, the eBook view).
//
// Loaded in <head>, not deferred, so the saved theme is on <html> before the
// first paint and nothing flashes in the wrong colors. Each theme is a set of
// color variables in themes.css, selected by <html data-theme="…">;
// Automatic sets no attribute, so the page follows the system's light or dark
// setting as it always has.
//
// The choice is kept per browser. (With accounts, Phase 2, it can follow the
// person instead; admins adding their own themes is planned for the admin
// dashboard.)

(function () {
  const KEY = 'apub.theme';

  // Swatches are the page, the surface, the accent and the text, for the picker.
  const THEMES = [
    { id: 'auto', name: 'Automatic', note: 'Light or dark, following your system', swatch: ['#e9edf2', '#14161a', '#1c63d6', '#7cb0ff'] },
    { id: 'classic-light', name: 'Classic Light', note: 'Crisp white panels, blue accent', swatch: ['#e9edf2', '#ffffff', '#1c63d6', '#141821'] },
    { id: 'classic-dark', name: 'Classic Dark', note: 'Charcoal, soft blue accent', swatch: ['#14161a', '#1c1f25', '#7cb0ff', '#e7e9ee'] },
    { id: 'paper', name: 'Paper', note: 'Warm cream, like a printed page', swatch: ['#f3ece0', '#fbf7ef', '#a0461f', '#3b2f24'] },
    { id: 'sage', name: 'Sage', note: 'Soft greens, calm and quiet', swatch: ['#e8eee8', '#fbfcfa', '#2f6b4f', '#1f2a22'] },
    { id: 'harbor', name: 'Harbor', note: 'Cool blue-grey, teal accent', swatch: ['#e6edf1', '#fafcfd', '#0e6e7e', '#142229'] },
    { id: 'dusk', name: 'Dusk', note: 'Warm dark, amber light', swatch: ['#1b1714', '#241f1b', '#e0a458', '#ece3d6'] },
    { id: 'midnight', name: 'Midnight', note: 'Deep navy, violet accent', swatch: ['#0e1424', '#151d33', '#a78bfa', '#e4e8f4'] },
    { id: 'contrast', name: 'High Contrast', note: 'Black on white, strongest legibility', swatch: ['#ffffff', '#ffffff', '#0040c1', '#000000'] },
  ];
  const known = (id) => THEMES.some((t) => t.id === id);

  function read() {
    try {
      const saved = localStorage.getItem(KEY);
      return known(saved) ? saved : 'auto';
    } catch {
      return 'auto';
    }
  }

  function apply(id) {
    const root = document.documentElement;
    if (!id || id === 'auto') delete root.dataset.theme;
    else root.dataset.theme = id;
  }

  let current = read();
  apply(current);

  const lists = new Set();

  function set(id) {
    if (!known(id)) return;
    current = id;
    apply(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* not kept between visits, but still applied now */
    }
    for (const list of lists) mark(list);
  }

  function mark(list) {
    for (const button of list.querySelectorAll('[data-theme-id]')) {
      button.setAttribute('aria-checked', String(button.dataset.themeId === current));
    }
  }

  /**
   * Fill an element with the themes as a pick list: a swatch, the name and a
   * line about it. Choosing one applies it at once.
   */
  function renderList(container, { compact = false } = {}) {
    container.setAttribute('role', 'radiogroup');
    container.setAttribute('aria-label', 'Color theme');
    container.classList.add('theme-list');
    if (compact) container.classList.add('is-compact');
    container.replaceChildren(
      ...THEMES.map((theme) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'theme-option';
        button.setAttribute('role', 'radio');
        button.dataset.themeId = theme.id;
        const swatch = document.createElement('span');
        swatch.className = 'theme-swatch';
        swatch.setAttribute('aria-hidden', 'true');
        // Page color behind, the surface as a card, accent and text as dots.
        swatch.style.background = theme.swatch[0];
        const card = document.createElement('span');
        card.style.background = theme.swatch[1];
        const accent = document.createElement('i');
        accent.style.background = theme.swatch[2];
        const text = document.createElement('i');
        text.style.background = theme.swatch[3];
        card.append(accent, text);
        swatch.appendChild(card);
        const words = document.createElement('span');
        words.className = 'theme-words';
        const name = document.createElement('span');
        name.className = 'theme-name';
        name.textContent = theme.name;
        words.appendChild(name);
        if (!compact) {
          const note = document.createElement('span');
          note.className = 'theme-note';
          note.textContent = theme.note;
          words.appendChild(note);
        }
        button.append(swatch, words);
        button.addEventListener('click', () => set(theme.id));
        return button;
      })
    );
    lists.add(container);
    mark(container);
  }

  // Another tab changed it: follow along.
  window.addEventListener('storage', (event) => {
    if (event.key === KEY) {
      current = read();
      apply(current);
      for (const list of lists) mark(list);
    }
  });

  window.apubTheme = { THEMES, get: () => current, set, renderList };

  // Fill every picker on the page, and make a [data-theme-toggle] button open
  // and close its panel like a menu (click elsewhere or Escape closes it).
  document.addEventListener('DOMContentLoaded', () => {
    for (const el of document.querySelectorAll('[data-theme-choices]')) {
      renderList(el, { compact: el.hasAttribute('data-compact') });
    }
    for (const toggle of document.querySelectorAll('[data-theme-toggle]')) {
      const panel = document.getElementById(toggle.getAttribute('aria-controls'));
      if (!panel) continue;
      const open = (yes) => {
        panel.hidden = !yes;
        toggle.setAttribute('aria-expanded', String(yes));
        if (yes) panel.querySelector('[aria-checked="true"]')?.focus();
      };
      toggle.addEventListener('click', () => open(panel.hidden));
      document.addEventListener('click', (event) => {
        if (!panel.hidden && !panel.contains(event.target) && !toggle.contains(event.target)) open(false);
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !panel.hidden) {
          open(false);
          toggle.focus();
        }
      });
    }
  });
})();
