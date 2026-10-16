'use strict';

// Draft editor with three views over one document.
//
// Markdown is the canonical format, following the same reasoning as
// faculty-materials-builder: markdown is what survives a round trip through a
// rich-text surface, it reads well on disk, and it maps onto the small tag
// vocabulary an e-ink reader renders properly.
//
//   Write     rich text (contenteditable) -> turndown -> markdown
//   Markdown  the source itself
//   Preview   marked + DOMPurify, styled like the EPUB
//
// Conversion happens on view switch, not per keystroke: round-tripping
// continuously would fight the caret and slowly mangle the document.
//
// The lifecycle mirrors that app's Preview -> Edit -> Rebuild -> Promote loop:
// Save draft -> Build EPUB -> Send to reader, with each status line naming the
// next step.

(function () {
  const $ = (id) => document.getElementById(id);

  const el = {
    picker: $('draft-picker'),
    newDraft: $('new-draft'),
    deleteDraft: $('delete-draft'),
    state: $('draft-state'),
    title: $('draft-title'),
    author: $('draft-author'),
    tabs: document.querySelector('.mode-tabs'),
    richToolbar: $('rich-toolbar'),
    mdToolbar: $('md-toolbar'),
    editor: $('editor'),
    markdown: $('markdown'),
    preview: $('preview'),
    count: $('draft-count'),
    save: $('save-draft'),
    reveal: $('reveal-drafts'),
    convert: $('convert-draft'),
    queuedDialog: $('queued-dialog'),
    queuedBody: $('queued-body'),
    queuedStay: $('queued-stay'),
    queuedGo: $('queued-go'),
    richImage: $('rich-image'),
    mdImage: $('md-image'),
    imageInput: $('image-input'),
  };

  const PASTE_ALLOWED = new Set([
    'P', 'BR', 'H1', 'H2', 'H3', 'H4', 'STRONG', 'B', 'EM', 'I', 'U', 'S',
    'BLOCKQUOTE', 'UL', 'OL', 'LI', 'A', 'CODE', 'PRE', 'HR',
    'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SUP', 'SUB',
  ]);

  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  });

  let draftId = null;
  let mode = 'rich';
  let markdown = '';
  let saveTimer = null;
  let lastSaved = '';
  let saving = false;

  // ------------------------------------------------------------ conversion

  function mdToHtml(md) {
    const raw = marked.parse(String(md || ''));
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] });
  }

  function htmlToMd(html) {
    return turndown
      .turndown(String(html || ''))
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Pull the current view's edits back into the canonical markdown. */
  function harvest() {
    if (mode === 'rich') markdown = htmlToMd(el.editor.innerHTML);
    else if (mode === 'markdown') markdown = el.markdown.value;
    return markdown;
  }

  // ------------------------------------------------------------ views

  function setMode(next) {
    if (next === mode) return;
    harvest();
    mode = next;

    el.editor.hidden = next !== 'rich';
    el.markdown.hidden = next !== 'markdown';
    el.preview.hidden = next !== 'preview';
    el.richToolbar.hidden = next !== 'rich';
    el.mdToolbar.hidden = next !== 'markdown';

    for (const tab of el.tabs.querySelectorAll('.mode-tab')) {
      const active = tab.dataset.mode === next;
      tab.setAttribute('aria-selected', String(active));
      tab.classList.toggle('active', active);
    }

    if (next === 'rich') {
      el.editor.innerHTML = mdToHtml(markdown);
      el.editor.focus();
    } else if (next === 'markdown') {
      el.markdown.value = markdown;
      el.markdown.focus();
      el.markdown.setSelectionRange(0, 0);
    } else {
      renderPreview();
    }
    updateCount();
  }

  async function renderPreview() {
    // Render on the server so the preview reflects the real conversion path,
    // with the client render as an offline fallback.
    try {
      const res = await fetch('/api/drafts/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markdown }),
      });
      const data = await res.json();
      el.preview.innerHTML = DOMPurify.sanitize(data.html || '');
    } catch {
      el.preview.innerHTML = mdToHtml(markdown);
    }
    if (!el.preview.textContent.trim()) {
      el.preview.innerHTML = '<p class="muted">Nothing to preview yet.</p>';
    }
  }

  el.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.mode-tab');
    if (tab) setMode(tab.dataset.mode);
  });

  // ------------------------------------------------------------ images

  /**
   * Upload an image file and insert a reference to it.
   *
   * The server stores it under assets/ and hands back a stable URL, so the same
   * bytes back the editor, the preview and the finished EPUB. Base64 over JSON
   * matches how PDFs already arrive, which avoids a multipart parser.
   */
  async function insertImageFiles(files) {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;

    setState(images.length > 1 ? `Uploading ${images.length} images…` : 'Uploading image…');

    for (const file of images) {
      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
          reader.onerror = () => reject(new Error('Could not read that file.'));
          reader.readAsDataURL(file);
        });

        const saved = await api('/api/assets', {
          method: 'POST',
          body: JSON.stringify({ data: base64, mime: file.type, name: file.name }),
        });

        // Alt text doubles as the caption in fixed-layout output, so seed it
        // from the filename rather than leaving it empty.
        const alt = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
        insertImage(saved.url, alt);
      } catch (err) {
        setState(err.message, 'bad');
        return;
      }
    }

    queueSave();
    if (mode === 'preview') renderPreview();
  }

  function insertImage(url, alt = '') {
    const safeAlt = alt.replace(/["\[\]()]/g, '');
    if (mode === 'markdown') {
      insertAtCursor(el.markdown, `\n\n![${safeAlt}](${url})\n\n`);
      return;
    }
    // In preview there is nothing to type into, so append to the markdown and
    // let the next tab switch render it.
    if (mode !== 'rich') {
      markdown = `${markdown.trimEnd()}\n\n![${safeAlt}](${url})\n`;
      return;
    }

    const figure = document.createElement('p');
    const img = document.createElement('img');
    img.src = url;
    img.alt = safeAlt;
    figure.appendChild(img);

    insertBlock(figure);
  }

  /**
   * Insert a block element after the block the caret is in, or at the end when
   * the caret isn't in the editor.
   *
   * execCommand('insertHTML') would nest the image inside whatever block holds
   * the caret — dropping a picture into the middle of a heading — and with no
   * caret at all it lands at the very start of the document.
   */
  function insertBlock(block) {
    const selection = window.getSelection();
    let anchor = null;

    if (selection?.rangeCount && el.editor.contains(selection.anchorNode)) {
      anchor = selection.anchorNode.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode
        : selection.anchorNode.parentElement;
      // Walk up to the direct child of the editor, so the new block is a sibling.
      while (anchor && anchor.parentElement !== el.editor) anchor = anchor.parentElement;
    }

    if (anchor?.parentElement === el.editor) anchor.after(block);
    else el.editor.appendChild(block);

    // Leave an empty paragraph after it so typing can continue.
    let next = block.nextElementSibling;
    if (!next || next.tagName !== 'P' || next.textContent.trim() || next.querySelector('img')) {
      next = document.createElement('p');
      next.appendChild(document.createElement('br'));
      block.after(next);
    }

    const range = document.createRange();
    range.setStart(next, 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.editor.focus();
  }

  el.richImage.addEventListener('click', (event) => {
    event.preventDefault();
    el.imageInput.click();
  });
  el.mdImage.addEventListener('click', (event) => {
    event.preventDefault();
    el.imageInput.click();
  });
  el.imageInput.addEventListener('change', () => {
    insertImageFiles(el.imageInput.files);
    el.imageInput.value = '';
  });

  // Dropping an image file onto either editing surface uploads and inserts it.
  // app.js cancels drops on window so the browser never navigates to a file;
  // these listeners are on the target, so they run first.
  for (const surface of [el.editor, el.markdown]) {
    surface.addEventListener('dragover', (event) => {
      if ([...(event.dataTransfer?.items || [])].some((i) => i.kind === 'file')) {
        event.preventDefault();
        surface.classList.add('drag-over');
      }
    });
    for (const type of ['dragleave', 'drop']) {
      surface.addEventListener(type, () => surface.classList.remove('drag-over'));
    }
    surface.addEventListener('drop', (event) => {
      const dropped = [...(event.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!dropped.length) return;
      event.preventDefault();
      event.stopPropagation();
      insertImageFiles(dropped);
    });
  }

  // ------------------------------------------------------------ paste

  /** Strip attributes and unwrap unknown tags from pasted markup. */
  function cleanPastedHtml(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');

    for (const node of [...doc.body.querySelectorAll('script, style, meta, link, title, xml, o\\:p')]) {
      node.remove();
    }

    const walk = (parent) => {
      for (const child of [...parent.children]) {
        walk(child);
        for (const attr of [...child.attributes]) {
          const keep = child.tagName === 'A' && attr.name.toLowerCase() === 'href';
          if (!keep) child.removeAttribute(attr.name);
        }
        if (child.tagName === 'A' && !/^https?:/i.test(child.getAttribute('href') || '')) {
          child.removeAttribute('href');
        }
        if (!PASTE_ALLOWED.has(child.tagName)) {
          const parentNode = child.parentNode;
          while (child.firstChild) parentNode.insertBefore(child.firstChild, child);
          parentNode.removeChild(child);
        }
      }
    };
    walk(doc.body);

    return doc.body.innerHTML.replace(/<!--[\s\S]*?-->/g, '');
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  el.editor.addEventListener('paste', (event) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;

    // A screenshot or copied picture arrives as a file, not as markup.
    const pastedImages = [...clipboard.files].filter((f) => f.type.startsWith('image/'));
    if (pastedImages.length) {
      event.preventDefault();
      insertImageFiles(pastedImages);
      return;
    }

    event.preventDefault();

    const html = clipboard.getData('text/html');
    const text = clipboard.getData('text/plain');

    if (html) {
      document.execCommand('insertHTML', false, cleanPastedHtml(html));
    } else if (text) {
      const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
      document.execCommand(
        'insertHTML',
        false,
        blocks.length
          ? blocks.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
          : `<p>${escapeHtml(text)}</p>`
      );
    }
    queueSave();
  });

  // Pasting into the markdown view: if the clipboard carries HTML, convert it
  // to markdown rather than dumping tags into the source.
  el.markdown.addEventListener('paste', (event) => {
    const pastedImages = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (pastedImages.length) {
      event.preventDefault();
      insertImageFiles(pastedImages);
      return;
    }
    const html = event.clipboardData?.getData('text/html');
    if (!html) return; // plain text pastes normally
    event.preventDefault();
    insertAtCursor(el.markdown, `\n\n${htmlToMd(cleanPastedHtml(html))}\n\n`);
    queueSave();
  });

  // ------------------------------------------------------------ formatting

  /** Run one rich-text action, from the toolbar or from a keyboard shortcut. */
  function applyRich({ block, cmd }) {
    el.editor.focus();

    if (block) {
      document.execCommand('formatBlock', false, block);
    } else if (cmd === 'createLink') {
      const url = prompt('Link URL:', 'https://');
      if (url && /^https?:\/\//i.test(url)) document.execCommand('createLink', false, url);
    } else if (cmd) {
      document.execCommand(cmd, false, null);
    }
    syncToolbar();
    queueSave();
  }

  el.richToolbar.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    event.preventDefault();
    // The Image button has its own handler; nothing to apply here.
    if (button.id === 'rich-image') return;
    applyRich({ block: button.dataset.block, cmd: button.dataset.cmd });
  });

  el.mdToolbar.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button?.dataset.md) return;
    event.preventDefault();
    applyMarkdown(button.dataset.md);
    queueSave();
  });

  /** Markdown toolbar: wrap the selection or prefix the selected lines. */
  function applyMarkdown(kind) {
    const ta = el.markdown;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.slice(start, end);

    const wrap = (token) => replaceRange(ta, start, end, `${token}${selected || 'text'}${token}`);
    const prefixLines = (make) => {
      const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = ta.value.indexOf('\n', end) === -1 ? ta.value.length : ta.value.indexOf('\n', end);
      const block = ta.value.slice(lineStart, lineEnd) || 'text';
      const out = block.split('\n').map((line, i) => make(line, i)).join('\n');
      replaceRange(ta, lineStart, lineEnd, out);
    };

    switch (kind) {
      case 'bold': wrap('**'); break;
      case 'italic': wrap('*'); break;
      case 'h2': prefixLines((line) => `## ${line.replace(/^#{1,6}\s*/, '')}`); break;
      case 'h3': prefixLines((line) => `### ${line.replace(/^#{1,6}\s*/, '')}`); break;
      case 'ul': prefixLines((line) => `- ${line.replace(/^[-*+]\s*|^\d+\.\s*/, '')}`); break;
      case 'ol': prefixLines((line, i) => `${i + 1}. ${line.replace(/^[-*+]\s*|^\d+\.\s*/, '')}`); break;
      case 'quote': prefixLines((line) => `> ${line.replace(/^>\s*/, '')}`); break;
      case 'hr': insertAtCursor(ta, '\n\n---\n\n'); break;
      case 'link': {
        const url = prompt('Link URL:', 'https://');
        if (url) replaceRange(ta, start, end, `[${selected || 'link text'}](${url})`);
        break;
      }
    }
  }

  // Keep caret and scroll stable across programmatic edits — losing your place
  // mid-sentence is the fastest way to make an editor feel broken.
  function replaceRange(ta, start, end, text) {
    const scroll = ta.scrollTop;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.focus();
    ta.setSelectionRange(start, start + text.length);
    ta.scrollTop = scroll;
  }

  function insertAtCursor(ta, text) {
    replaceRange(ta, ta.selectionStart, ta.selectionEnd, text);
    ta.setSelectionRange(ta.selectionStart + text.length, ta.selectionStart + text.length);
  }

  function syncToolbar() {
    for (const button of el.richToolbar.querySelectorAll('button[data-cmd]')) {
      const cmd = button.dataset.cmd;
      if (cmd === 'createLink' || cmd === 'removeFormat') continue;
      let active = false;
      try {
        active = document.queryCommandState(cmd);
      } catch {
        /* not supported for this command */
      }
      button.classList.toggle('active', active);
    }
  }

  document.addEventListener('selectionchange', () => {
    if (document.activeElement === el.editor) syncToolbar();
  });

  document.execCommand('defaultParagraphSeparator', false, 'p');

  // ------------------------------------------------------------ persistence

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function snapshot() {
    return JSON.stringify({ title: el.title.value, author: el.author.value, markdown: harvest() });
  }

  function isDirty() {
    return snapshot() !== lastSaved;
  }

  function queueSave() {
    updateCount();
    if (!isDirty()) return;
    setState('Unsaved changes');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(), 900);
  }

  async function saveNow({ silent = true } = {}) {
    if (saving) return null;
    const current = snapshot();
    const parsed = JSON.parse(current);
    // Don't create an empty draft just because the editor got focus.
    if (!draftId && !parsed.markdown.trim() && !parsed.title.trim()) return null;
    if (current === lastSaved) return null;

    saving = true;
    setState('Saving…');
    try {
      const draft = await api('/api/drafts/save', {
        method: 'POST',
        body: JSON.stringify({
          id: draftId,
          title: el.title.value,
          author: el.author.value,
          markdown: parsed.markdown,
        }),
      });
      draftId = draft.id;
      lastSaved = current;
      setState(silent ? `Saved ${time(draft.updatedAt)}` : `Saved ${time(draft.updatedAt)} — Build EPUB to package it`);
      await refreshPicker(draftId);
      return draft;
    } catch (err) {
      setState(err.message, 'bad');
      return null;
    } finally {
      saving = false;
    }
  }

  const time = (iso) => new Date(iso).toLocaleTimeString();

  function setState(text, kind = '') {
    el.state.textContent = text ? `· ${text}` : '';
    el.state.style.color = kind === 'bad' ? 'var(--bad)' : '';
  }

  function updateCount() {
    const text = String(markdown || '')
      .replace(/[#>*_`~\-|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const words = text ? text.split(' ').length : 0;
    el.count.textContent = words ? `${words} word${words === 1 ? '' : 's'}` : '';
    el.convert.disabled = !words;
    el.save.disabled = !isDirty();
  }

  async function refreshPicker(selectId) {
    const { drafts } = await api('/api/drafts');
    const options = [];

    if (!drafts.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No saved drafts';
      options.push(option);
    }

    for (const draft of drafts) {
      const option = document.createElement('option');
      option.value = draft.id;
      option.textContent = `${draft.title || 'Untitled'} · ${draft.words}w · ${new Date(draft.updatedAt).toLocaleDateString()}`;
      options.push(option);
    }

    el.picker.replaceChildren(...options);
    el.picker.value = selectId || draftId || '';
    el.deleteDraft.disabled = !draftId;
  }

  function load(draft) {
    draftId = draft.id;
    el.title.value = draft.title || '';
    el.author.value = draft.author || '';
    // Drafts saved before markdown became canonical carry `html` instead.
    markdown = typeof draft.markdown === 'string' ? draft.markdown : htmlToMd(draft.html || '');

    if (mode === 'rich') el.editor.innerHTML = mdToHtml(markdown);
    else if (mode === 'markdown') el.markdown.value = markdown;
    else renderPreview();

    lastSaved = snapshot();
    setState(`Saved ${time(draft.updatedAt)}`);
    updateCount();
    el.deleteDraft.disabled = false;
  }

  async function openDraft(id) {
    if (!id || id === draftId) return;
    // Flush pending edits before swapping documents, and never drop work
    // silently if that save failed.
    clearTimeout(saveTimer);
    if (isDirty()) {
      const saved = await saveNow();
      if (!saved && isDirty()) {
        const proceed = confirm('This draft has unsaved changes that could not be saved. Open the other draft anyway and lose them?');
        if (!proceed) {
          el.picker.value = draftId || '';
          return;
        }
      }
    }
    try {
      load(await api(`/api/drafts/get?id=${encodeURIComponent(id)}`));
    } catch (err) {
      setState(err.message, 'bad');
    }
  }

  async function newDraft() {
    clearTimeout(saveTimer);
    if (isDirty()) await saveNow();

    draftId = null;
    markdown = '';
    el.title.value = '';
    el.author.value = '';
    el.editor.innerHTML = '';
    el.markdown.value = '';
    el.preview.innerHTML = '';
    lastSaved = snapshot();
    setState('New draft');
    updateCount();
    el.picker.value = '';
    el.deleteDraft.disabled = true;
    el.title.focus();
  }

  async function deleteDraft() {
    if (!draftId) return;
    const label = el.title.value.trim() || 'this untitled draft';
    if (!confirm(`Delete "${label}"? This removes the draft from your Mac and cannot be undone.`)) return;
    try {
      await api('/api/drafts/delete', { method: 'POST', body: JSON.stringify({ id: draftId }) });
      await newDraft();
      await refreshPicker(null);
      setState('Draft deleted');
    } catch (err) {
      setState(err.message, 'bad');
    }
  }

  // ------------------------------------------------------------ build

  /**
   * Confirm where the note went, because building and sending are separate
   * steps and the button is on a different tab from the queue.
   */
  function confirmQueued(title) {
    if (typeof el.queuedDialog?.showModal !== 'function') return;
    el.queuedBody.textContent =
      `“${title}” is built and waiting on the Add/Remove tab. Send it from there ` +
      `when the reader is connected and it will go to /A-pub Notes, along with ` +
      `anything else you have queued.`;
    el.queuedDialog.showModal();
  }

  async function buildEpub() {
    clearTimeout(saveTimer);
    if (isDirty()) await saveNow();
    if (!draftId) {
      setState('Nothing to add yet', 'bad');
      return;
    }
    const title = el.title.value.trim() || 'Untitled';
    setState('Saved — building');

    const result = await window.epubDrop?.convertDraft(draftId, title);
    if (result?.ok) {
      setState('Added to the queue');
      confirmQueued(title);
    } else if (result?.reason === 'busy') {
      setState('Still finishing the last one — try again in a moment', 'bad');
    } else if (result) {
      setState(result.error || 'Could not add this draft', 'bad');
    }
  }

  // ------------------------------------------------------------ wiring

  el.editor.addEventListener('input', queueSave);
  el.markdown.addEventListener('input', queueSave);
  el.title.addEventListener('input', queueSave);
  el.author.addEventListener('input', queueSave);

  for (const node of [el.editor, el.markdown]) {
    node.addEventListener('blur', () => {
      clearTimeout(saveTimer);
      saveNow();
    });
  }

  el.picker.addEventListener('change', () => openDraft(el.picker.value));
  el.newDraft.addEventListener('click', newDraft);
  el.deleteDraft.addEventListener('click', deleteDraft);
  el.convert.addEventListener('click', buildEpub);
  el.save.addEventListener('click', () => {
    clearTimeout(saveTimer);
    saveNow({ silent: false });
  });
  el.queuedStay.addEventListener('click', () => el.queuedDialog.close());
  el.queuedGo.addEventListener('click', () => {
    el.queuedDialog.close();
    window.epubDropTabs?.show('add');
  });

  el.reveal.addEventListener('click', () =>
    fetch('/api/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ what: 'drafts' }),
    })
  );

  /**
   * Map a ⌘/Ctrl chord to a formatting action, following the conventions people
   * bring from Word and Google Docs.
   *
   * Which digit a chord names has to be read from more than one place. With
   * Shift or Option held, `event.key` is whatever glyph the layout produces —
   * Option-2 is `™` on a US Mac, Shift-8 is `*` — so `code` is the reliable
   * source. But `code` is empty in some synthetic events, and a stray layout
   * could surprise us, so the digit is taken from `code` first, then from a
   * bare digit in `key`, then from the shifted punctuation on a US layout.
   */
  const SHIFTED_DIGITS = { '&': '7', '*': '8', '(': '9', ')': '0', '@': '2', '#': '3' };

  function digitOf(event) {
    const fromCode = /^Digit(\d)$/.exec(event.code || '');
    if (fromCode) return fromCode[1];
    if (/^\d$/.test(event.key)) return event.key;
    return SHIFTED_DIGITS[event.key] || null;
  }

  function chordFor(event) {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const { shiftKey: shift, altKey: alt } = event;
    const digit = digitOf(event);

    if (!shift && !alt) {
      if (key === 'b') return { cmd: 'bold', md: 'bold' };
      if (key === 'i') return { cmd: 'italic', md: 'italic' };
      if (key === 'k') return { cmd: 'createLink', md: 'link' };
      if (event.code === 'Backslash' || key === '\\') return { cmd: 'removeFormat' };
      // Markdown has no underline, so ⌘U would apply formatting that vanishes
      // on the next save. Better to say so than to lose it silently.
      if (key === 'u') return { refuse: 'Underline isn’t available — markdown has no underline. Use bold or italic.' };
    }
    if (shift && !alt) {
      if (digit === '7') return { cmd: 'insertOrderedList', md: 'ol' };
      if (digit === '8') return { cmd: 'insertUnorderedList', md: 'ul' };
      if (digit === '9') return { block: 'blockquote', md: 'quote' };
    }
    if (alt && !shift) {
      if (digit === '0') return { block: 'p' };
      if (digit === '2') return { block: 'h2', md: 'h2' };
      if (digit === '3') return { block: 'h3', md: 'h3' };
    }
    return null;
  }

  // ⌘S saves, ⌘↩ adds to the queue, and the usual formatting chords work in
  // both editing views.
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;

    if (event.key === 's') {
      event.preventDefault();
      clearTimeout(saveTimer);
      saveNow({ silent: false });
      return;
    }
    if (event.key === 'Enter' && el.editor.contains(document.activeElement)) {
      event.preventDefault();
      buildEpub();
      return;
    }

    const inRich = mode === 'rich' && el.editor.contains(document.activeElement);
    const inMarkdown = mode === 'markdown' && document.activeElement === el.markdown;
    if (!inRich && !inMarkdown) return;

    const chord = chordFor(event);
    if (!chord) return;

    // Claimed either way: the browser's own ⌘B on a contenteditable would
    // otherwise run as well and undo what we just did.
    event.preventDefault();

    if (chord.refuse) {
      setState(chord.refuse, 'bad');
      return;
    }
    if (inRich) {
      applyRich(chord);
    } else if (chord.md) {
      applyMarkdown(chord.md);
      queueSave();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (isDirty() && draftId) {
      navigator.sendBeacon?.(
        '/api/drafts/save',
        new Blob(
          [JSON.stringify({ id: draftId, title: el.title.value, author: el.author.value, markdown })],
          { type: 'application/json' }
        )
      );
    } else if (isDirty()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  // The Write tab starts hidden, so anything that measures layout has to wait
  // until it is actually on screen.
  window.epubDropEditor = {
    shown: () => el.editor.focus(),
    // After Remove everything: forget the open draft so neither the save timer
    // nor the unload beacon writes it back.
    discard: () => {
      clearTimeout(saveTimer);
      draftId = null;
      lastSaved = snapshot();
    },
  };

  lastSaved = snapshot();
  updateCount();
  refreshPicker().then(() => {
    const first = el.picker.options[0];
    if (first?.value) openDraft(first.value);
    else setState('New draft');
  });
})();
