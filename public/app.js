'use strict';

const $ = (id) => document.getElementById(id);

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const el = {
  drop: $('drop'),
  fileInput: $('file-input'),
  pick: $('pick'),
  urlInput: $('url-input'),
  addUrls: $('add-urls'),
  queueSection: $('queue-section'),
  queue: $('queue'),
  queueCount: $('queue-count'),
  clearQueue: $('clear-queue'),
  includeImages: $('include-images'),
  convert: $('convert'),
  resultsSection: $('results-section'),
  results: $('results'),
  resultsCount: $('results-count'),
  clearResults: $('clear-results'),
  resultsEmpty: $('results-empty'),
  folder: $('folder'),
  host: $('host'),
  send: $('send'),
  removalNote: $('removal-note'),
  sendStatus: $('send-status'),
  device: $('device'),
  deviceText: $('device-text'),
  deviceLabel: $('device-label'),
  deviceInfo: $('device-info'),
  find: $('find'),
  useHotspot: $('use-hotspot'),
  destination: $('destination'),
  hostField: $('host-field'),
  librarySection: $('library-section'),
  library: $('library'),
  libraryFolder: $('library-folder'),
  librarySection: $('library-section'),
  libraryStatus: $('library-status'),
  libraryAll: $('library-all'),
  refreshLibrary: $('refresh-library'),
  deleteLibrary: $('delete-library'),
  imageMode: $('image-mode'),
  imageOptions: $('image-options'),
  imageScale: $('image-scale'),
  imageSplit: $('image-split'),
  imageFont: $('image-font'),
  composeModeNote: $('compose-mode-note'),
  viewer: $('page-viewer'),
  viewerImage: $('viewer-image'),
  viewerTitle: $('viewer-title'),
  viewerPos: $('viewer-pos'),
  viewerPrev: $('viewer-prev'),
  viewerNext: $('viewer-next'),
  viewerClose: $('viewer-close'),
  viewerText: $('viewer-text'),
  viewerChapters: $('viewer-chapters'),
  viewerMode: $('viewer-mode'),
  viewerType: $('viewer-type'),
  typography: $('viewer-typography'),
  typeFamily: $('type-family'),
  typeSmaller: $('type-smaller'),
  typeBigger: $('type-bigger'),
  typeSize: $('type-size'),
  typeLeading: $('type-leading'),
  typeAlign: $('type-align'),
  typeReset: $('type-reset'),
  viewerClip: $('viewer-clip'),
  viewerFlow: $('viewer-flow'),
};

/** Pending inputs: {key, kind:'html'|'pdf'|'url', name, text?, pdfBase64?, url?} */
let queue = [];
/** Converted EPUBs from the server, newest last. */
let results = [];
/** What the reader currently holds in the managed folder. */
let library = [];
let libraryCanDelete = false;
/**
 * Per-item send outcomes, keyed by queue id.
 *
 * Kept outside `results` because a send is followed by re-reading the queue
 * from the server, which rebuilds every row — so failure messages were being
 * wiped a moment after being set, leaving only a summary count with no way to
 * tell which item had a problem.
 */
const sendOutcomes = new Map();
/** Mounted drives that might be the reader's card. */
let volumes = [];
let busy = false;

const HTML_EXT = /\.(x?html?|htm)$/i;
const PDF_EXT = /\.pdf$/i;

// ---------------------------------------------------------------- api

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- queue

function addFiles(files) {
  const accepted = [];
  const rejected = [];

  for (const file of files) {
    // Browsers often report an empty type for .html, so trust the extension too.
    if (PDF_EXT.test(file.name) || file.type === 'application/pdf') accepted.push({ file, kind: 'pdf' });
    else if (HTML_EXT.test(file.name) || /html/.test(file.type)) accepted.push({ file, kind: 'html' });
    else rejected.push(file.name);
  }

  if (rejected.length) {
    setStatus(
      `Skipped ${rejected.length} unsupported file(s): ${rejected.slice(0, 3).join(', ')}. Drop HTML or PDF.`,
      'bad'
    );
  }

  Promise.all(accepted.map(readOne)).then((items) => {
    queue = queue.concat(items.filter(Boolean));
    renderQueue();
  });
}

function readOne({ file, kind }) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);

    if (kind === 'pdf') {
      reader.onload = () =>
        resolve({
          key: crypto.randomUUID(),
          kind: 'pdf',
          name: file.name,
          bytes: file.size,
          // readAsDataURL gives "data:application/pdf;base64,...."; keep the payload.
          pdfBase64: String(reader.result || '').split(',')[1] || '',
        });
      reader.readAsDataURL(file);
    } else {
      reader.onload = () =>
        resolve({
          key: crypto.randomUUID(),
          kind: 'html',
          name: file.name,
          bytes: file.size,
          text: String(reader.result || ''),
        });
      reader.readAsText(file);
    }
  });
}

/**
 * Queue a saved draft and convert immediately. Called by editor.js so the
 * editor doesn't need its own copy of the conversion pipeline.
 */
function convertDraft(id, title) {
  // One pending entry per draft: converting twice should replace, not stack.
  queue = queue.filter((q) => q.draftId !== id);
  queue.push({ key: crypto.randomUUID(), kind: 'draft', name: title, draftId: id });
  renderQueue();
  // Returned so the Write tab can confirm the result rather than guess at it.
  return convert();
}

window.epubDrop = {
  convertDraft,
  reloadLibrary: () => loadLibrary(),
  reloadQueue: () => loadOutbox(),
  reloadRemovals: (count) => loadRemovals(count),
  // The Library tab lists delivered items and opens them in the same previewer.
  reloadRead: () => window.epubDropRead?.load(),
  preview: (entry) => openViewer(entry),
  editorShown: () => window.epubDropEditor?.shown?.(),
};

function addUrls() {
  const lines = el.urlInput.value
    .split(/[\n\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!lines.length) return;
  for (const url of lines) {
    queue.push({ key: crypto.randomUUID(), kind: 'url', name: url, url });
  }
  el.urlInput.value = '';
  renderQueue();
}

function renderQueue() {
  el.queueSection.classList.toggle('hidden', queue.length === 0);
  el.queueCount.textContent = queue.length ? `· ${queue.length}` : '';
  el.convert.disabled = busy || queue.length === 0;

  el.queue.replaceChildren(
    ...queue.map((item) => {
      const li = document.createElement('li');
      li.className = 'item';

      const body = document.createElement('div');
      body.className = 'item-body';

      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = item.name;
      body.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'item-meta';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent =
        item.kind === 'url' ? 'URL' : item.kind === 'pdf' ? 'PDF' : item.kind === 'draft' ? 'DRAFT' : 'HTML';
      meta.appendChild(badge);
      meta.append(
        item.kind === 'url'
          ? 'will be fetched on convert'
          : item.kind === 'draft'
            ? 'saved draft'
            : formatBytes(item.bytes || 0)
      );
      body.appendChild(meta);

      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.type = 'button';
      remove.title = 'Remove';
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        queue = queue.filter((q) => q.key !== item.key);
        renderQueue();
      });

      li.append(body, remove);
      return li;
    })
  );
}

// ---------------------------------------------------------------- convert

async function convert() {
  if (busy || !queue.length) return { ok: false, reason: busy ? 'busy' : 'empty' };
  setBusy(true, el.convert, 'Converting…');
  setStatus('');

  try {
    const { results: converted } = await api('/api/convert', {
      method: 'POST',
      body: JSON.stringify({
        includeImages: el.includeImages.checked,
        imageMode: el.imageMode.checked,
        imageScale: Number(el.imageScale.value),
        imageSplit: el.imageSplit.value,
        imageFontSize: Number(el.imageFont.value),
        items: queue.map((q) => ({
          name: q.name,
          text: q.text,
          pdfBase64: q.pdfBase64,
          url: q.url,
          draftId: q.draftId,
        })),
      }),
    });

    const failed = converted.filter((r) => !r.ok);
    // Keep failures in the queue so a retry doesn't need a re-drop.
    const failedLabels = new Set(failed.map((r) => r.label));
    queue = queue.filter((q) => failedLabels.has(q.name));

    renderQueue();
    // The server queued them; read the queue back so this page and the queue
    // never disagree about what is pending.
    await loadOutbox();
    renderResults(converted.filter((r) => !r.ok));

    const okCount = converted.length - failed.length;
    setStatus(
      failed.length
        ? `Converted ${okCount}, failed ${failed.length}.`
        : `Converted ${okCount} file${okCount === 1 ? '' : 's'}.`,
      failed.length ? 'bad' : 'ok'
    );

    return { ok: !failed.length, okCount, failed: failed.length };
  } catch (err) {
    setStatus(err.message, 'bad');
    return { ok: false, error: err.message };
  } finally {
    setBusy(false, el.convert, 'Convert to EPUB');
  }
}

function renderResults(failures = []) {
  el.resultsCount.textContent = results.length ? `· ${results.length}` : '';
  if (el.resultsEmpty) el.resultsEmpty.hidden = results.length > 0 || failures.length > 0;
  el.send.disabled = busy || (!results.some((r) => r.selected) && pendingRemovals.length === 0);

  const nodes = [];

  for (const fail of failures) {
    const li = document.createElement('li');
    li.className = 'item bad';
    const body = document.createElement('div');
    body.className = 'item-body';
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = fail.label;
    const err = document.createElement('div');
    err.className = 'item-err';
    err.textContent = fail.error;
    body.append(title, err);
    li.appendChild(body);
    nodes.push(li);
  }

  for (const r of results) {
    const li = document.createElement('li');
    li.className = r.deliveredAt ? 'item delivered' : 'item';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = r.selected;
    check.addEventListener('change', () => {
      r.selected = check.checked;
      el.send.disabled = busy || !results.some((x) => x.selected);
    });

    const body = document.createElement('div');
    body.className = 'item-body';

    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = r.title;
    body.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'item-meta';

    // Where it came from, so a feed edition is distinguishable at a glance from
    // a dropped file once several things are queued.
    const kind = r.source?.kind;
    if (kind) {
      const badge = document.createElement('span');
      badge.className = kind === 'feed' ? 'badge badge-feed' : 'badge';
      badge.textContent = kind === 'feed' ? 'FEED' : kind.toUpperCase();
      meta.appendChild(badge);
    }

    const bits = [r.filename, formatBytes(r.size)];
    if (r.mode === 'images') {
      bits.push(`${r.pageCount} page image${r.pageCount === 1 ? '' : 's'}`, r.pageSize);
    } else {
      bits.push(`${r.chapters} chapter${r.chapters === 1 ? '' : 's'}`);
      if (r.images) bits.push(`${r.images} image${r.images === 1 ? '' : 's'}`);
    }
    if (r.author) bits.unshift(r.author);
    // Feeds and notes always go to their own folder, whatever Send via says.
    if (r.folder) bits.push(`→ ${r.folder}`);
    meta.append(bits.join(' · '));
    body.appendChild(meta);

    const linkWrap = document.createElement('div');
    linkWrap.style.marginTop = '0.25rem';
    linkWrap.style.display = 'flex';
    linkWrap.style.gap = '0.75rem';

    // Every queued item is previewable, whatever produced it.
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'link';
    preview.textContent =
      r.mode === 'images'
        ? `Preview ${r.pageCount} page${r.pageCount === 1 ? '' : 's'}`
        : `Preview ${r.chapters || ''} ${r.chapters === 1 ? 'chapter' : 'chapters'}`.replace(/ +/g, ' ').trim();
    preview.addEventListener('click', () => openViewer(r));
    linkWrap.appendChild(preview);

    const link = document.createElement('a');
    link.href = `/out/${r.id}`;
    link.textContent = 'Download locally';
    link.style.fontSize = '0.8rem';
    linkWrap.appendChild(link);
    body.appendChild(linkWrap);

    if (r.warnings?.length) {
      const warn = document.createElement('div');
      warn.className = 'item-warn';
      warn.textContent = r.warnings.join(' · ');
      body.appendChild(warn);
    }
    if (r.sendState === 'ok') {
      const ok = document.createElement('div');
      ok.className = 'item-ok';
      ok.textContent = `✓ On the reader — ${r.sendMessage || 'sent'}`;
      body.appendChild(ok);
    }
    if (r.sendState === 'bad') {
      const bad = document.createElement('div');
      bad.className = 'item-err';
      bad.textContent = r.sendMessage;
      body.appendChild(bad);
    }

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.title = 'Remove from the queue';
    remove.textContent = '×';
    remove.addEventListener('click', () => removeFromQueue(r));

    li.append(check, body, remove);
    nodes.push(li);
  }

  el.results.replaceChildren(...nodes);
}

// ---------------------------------------------------------------- send

/**
 * One line describing what a sync did.
 *
 * A sync can upload, delete, or both, and saying "Sent 0" after successfully
 * clearing three files off the reader reads as a failure.
 */
function summarize(okCount, payload) {
  const removed = (payload.removed || []).filter((r) => r.ok).length;
  const stuck = (payload.removed || []).filter((r) => !r.ok).length;
  const parts = [];
  if (okCount) parts.push(`Sent ${okCount} to ${payload.host}${payload.folder}`);
  if (removed) parts.push(`removed ${removed} from the reader`);
  if (stuck) parts.push(`${stuck} could not be removed — still queued`);
  if (!parts.length) return 'Nothing to do.';
  return `${parts.join(' · ')}.`;
}

async function send() {
  const selected = results.filter((r) => r.selected);
  // A sync with nothing to upload still has work to do if files are queued to
  // come off the reader.
  if (busy || (!selected.length && !pendingRemovals.length)) return;

  setBusy(true, el.send, 'Sending…');
  setStatus('');

  try {
    const viaVolume = el.destination.value !== 'wifi';
    const payload = await api(viaVolume ? '/api/send-volume' : '/api/send', {
      method: 'POST',
      body: JSON.stringify({
        ids: selected.map((r) => r.id),
        ...(viaVolume ? { volume: el.destination.value } : { host: el.host.value.trim() }),
      }),
    });

    if (payload.error && !payload.results.length) {
      setStatus(payload.error, 'bad');
      await loadRemovals();
      return;
    }

    for (const outcome of payload.results) {
      sendOutcomes.set(outcome.id, {
        state: outcome.ok ? 'ok' : 'bad',
        message: outcome.ok ? outcome.message : outcome.error,
      });
      // Leave failures checked so the retry is one click.
      const match = results.find((r) => r.id === outcome.id);
      if (match && outcome.ok) match.selected = false;
    }

    const failures = payload.results.filter((r) => !r.ok);
    const okCount = payload.results.length - failures.length;
    if (failures.length) {
      // Name them: a bare count gives nothing to act on.
      const named = failures
        .map((f) => f.filename || f.id)
        .slice(0, 3)
        .join(', ');
      const more = failures.length > 3 ? ` +${failures.length - 3} more` : '';
      setStatus(
        `Sent ${okCount}. Failed: ${named}${more} — the reason is on each row below.`,
        'bad'
      );
    } else {
      setStatus(summarize(okCount, payload), 'ok');
    }

    // Whatever came off the reader is no longer queued to.
    await loadRemovals();

    saveConfig();
    checkDevice();
    // Re-read both: the queue owns delivered state, and the library shows what
    // just landed.
    await loadOutbox();
    loadLibrary();
  } catch (err) {
    setStatus(err.message, 'bad');
  } finally {
    setBusy(false, el.send, 'Send to reader');
  }
}

// ---------------------------------------------------------------- preview

// Everything in the queue can be previewed. Fixed-layout books show their page
// images; reflowable ones are read back out of the built EPUB — chapters, table
// of contents and embedded pictures — so what you check is the file that will be
// sent, not the markdown or article HTML it came from.
//
// Reflowable text reads a page at a time in a portrait frame, which is the point
// of previewing: you are checking how it will look on a reader, and a tall
// scrolling column tells you nothing about where pages break. Scroll mode is
// there for skimming or copying text, and the choice is remembered.

let viewing = null;
let viewingPage = 1; // page number in image mode, chapter number in text mode
let chapterPage = 1; // page within the current chapter, paged mode only
let chapterPages = 1;
/** Exact column pitch in px, kept fractional so paging cannot drift. */
let pageStep = 0;
let readerMode = 'page';

// ---- reading type
//
// Font, size and spacing, the way an e-reader offers them. They change how many
// pages a chapter holds, so every change re-measures rather than just restyling.
// Stacks are named families that are actually present on a Mac or Windows box —
// no webfont to load, so a change takes effect on the same frame.

const FONTS = [
  { id: 'georgia', label: 'Georgia', stack: 'Georgia, "Times New Roman", Times, serif' },
  { id: 'palatino', label: 'Palatino', stack: 'Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif' },
  { id: 'iowan', label: 'Iowan Old Style', stack: '"Iowan Old Style", "Sitka Text", Charter, Georgia, serif' },
  { id: 'system', label: 'System sans', stack: 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif' },
  { id: 'verdana', label: 'Verdana', stack: 'Verdana, Tahoma, "DejaVu Sans", sans-serif' },
  { id: 'mono', label: 'Monospace', stack: 'ui-monospace, Menlo, Consolas, "Courier New", monospace' },
];

const SIZE_MIN = 13;
const SIZE_MAX = 28;
const TYPE_DEFAULTS = { font: 'georgia', size: 17, leading: '1.55', align: 'justify' };
const TYPE_KEY = 'apub.readerType';

let readerType = { ...TYPE_DEFAULTS };

try {
  const saved = JSON.parse(localStorage.getItem(TYPE_KEY) || '{}');
  readerType = {
    font: FONTS.some((f) => f.id === saved.font) ? saved.font : TYPE_DEFAULTS.font,
    size: clamp(Number(saved.size) || TYPE_DEFAULTS.size, SIZE_MIN, SIZE_MAX),
    leading: ['1.3', '1.55', '1.8'].includes(saved.leading) ? saved.leading : TYPE_DEFAULTS.leading,
    align: ['left', 'justify'].includes(saved.align) ? saved.align : TYPE_DEFAULTS.align,
  };
} catch {
  /* private window, or nothing stored yet — the defaults are fine */
}

el.typeFamily.replaceChildren(...FONTS.map((f) => new Option(f.label, f.id)));

/** Push the current settings onto the page and re-measure the pagination. */
function applyReaderType({ remeasure = true } = {}) {
  const font = FONTS.find((f) => f.id === readerType.font) || FONTS[0];
  const style = el.viewerText.style;
  style.setProperty('--reader-font', font.stack);
  style.setProperty('--reader-size', `${readerType.size}px`);
  style.setProperty('--reader-leading', readerType.leading);
  style.setProperty('--reader-align', readerType.align);

  el.typeFamily.value = readerType.font;
  el.typeSize.textContent = `${readerType.size} px`;
  el.typeLeading.value = readerType.leading;
  el.typeAlign.value = readerType.align;
  el.typeSmaller.disabled = readerType.size <= SIZE_MIN;
  el.typeBigger.disabled = readerType.size >= SIZE_MAX;

  try {
    localStorage.setItem(TYPE_KEY, JSON.stringify(readerType));
  } catch {
    /* not persisting is not a failure */
  }

  // Bigger text means fewer words per page, so the page count is now wrong.
  // Hold the reader's place proportionally rather than jumping to page one.
  if (remeasure && readerMode === 'page' && viewing?.kind === 'text') {
    const through = chapterPages > 1 ? (chapterPage - 1) / chapterPages : 0;
    layoutPages();
    chapterPage = Math.min(chapterPages, Math.max(1, Math.round(through * chapterPages) + 1));
    applyPageOffset();
  }
}

function setReaderType(patch) {
  readerType = { ...readerType, ...patch };
  applyReaderType();
}

function toggleTypography(show = el.typography.hidden) {
  el.typography.hidden = !show;
  el.viewerType.setAttribute('aria-expanded', String(show));
}

// How wide the text runs: an eBook-shaped column, or the whole window.
let readerWidth = 'ebook';

// Width is remembered. The view is not: every book opens as flipping eBook
// pages, and scroll is something you switch to for that reading.
try {
  readerWidth = localStorage.getItem('apub.readerWidth') === 'full' ? 'full' : 'ebook';
  // Earlier versions remembered scroll view too; drop that so it stops winning.
  localStorage.removeItem('apub.readerMode');
} catch {
  /* private window, or storage blocked — the default is fine */
}

async function openViewer(result) {
  readerMode = 'page';
  el.viewer.hidden = false;
  el.viewerTitle.textContent = result.title;
  el.viewerImage.hidden = true;
  el.viewerText.hidden = true;
  el.viewerChapters.hidden = true;
  el.viewerMode.hidden = true;
  el.viewerType.hidden = true;
  toggleTypography(false);
  el.viewerPos.textContent = 'Loading…';
  el.viewerPrev.disabled = true;
  el.viewerNext.disabled = true;
  el.viewerClose.focus();

  try {
    const info = await api(`/api/outbox/preview?id=${encodeURIComponent(result.id)}`);

    if (info.kind === 'images') {
      viewing = { kind: 'images', id: result.id, title: info.title, pageCount: info.pageCount };
      viewingPage = 1;
      showPage();
      return;
    }
    if (info.kind !== 'text') throw new Error(info.error || 'This file cannot be previewed.');

    viewing = { kind: 'text', id: result.id, title: info.title, chapters: info.chapters };
    viewingPage = 1;

    el.viewerChapters.replaceChildren(
      ...info.chapters.map((c, i) => new Option(`${i + 1}. ${c.title}`, String(i)))
    );
    el.viewerChapters.hidden = info.chapters.length < 2;
    el.viewerMode.hidden = false;
    el.viewerType.hidden = false;
    applyReaderType({ remeasure: false });
    await showChapter();
  } catch (err) {
    viewing = null;
    showNote(err.message);
  }
}

function showNote(message) {
  el.viewerImage.hidden = true;
  el.viewerText.hidden = false;
  el.viewerFlow.replaceChildren();
  const note = document.createElement('p');
  note.className = 'viewer-note';
  note.textContent = message;
  el.viewerFlow.appendChild(note);
  el.viewerPos.textContent = '';
}

// ---- fixed-layout books: one rendered image per page

function showPage() {
  if (viewing?.kind !== 'images') return;
  viewingPage = Math.min(viewing.pageCount, Math.max(1, viewingPage));
  el.viewerImage.hidden = false;
  el.viewerText.hidden = true;
  el.viewerImage.src = `/out/${viewing.id}/pages/${viewingPage}.png`;
  el.viewerPos.textContent = `page ${viewingPage} / ${viewing.pageCount}`;
  el.viewerPrev.disabled = viewingPage <= 1;
  el.viewerNext.disabled = viewingPage >= viewing.pageCount;
  el.viewer.querySelector('.viewer-stage').scrollTop = 0;
}

// ---- reflowable books: paginate the chapter into a portrait page

/**
 * Size the page frame to the stage and measure how many pages the chapter fills.
 *
 * The column width has to equal the visible width exactly, so one column is one
 * page and stepping is a multiple of that width.
 */
function layoutPages() {
  if (viewing?.kind !== 'text' || readerMode !== 'page') return;

  const stage = el.viewer.querySelector('.viewer-stage');
  const availableHeight = stage.clientHeight - 40;
  const availableWidth = stage.clientWidth - 40;

  // Portrait, roughly a reader's proportions, but wide enough for a comfortable
  // measure — a narrow column with 6 words a line is harder to judge than the
  // real thing. Never wider than the stage.
  const frameHeight = Math.max(360, Math.min(availableHeight, 940));
  // Full width drops the reader's proportions and uses the whole stage.
  const frameWidth = Math.round(
    readerWidth === 'full'
      ? Math.max(360, availableWidth)
      : Math.max(360, Math.min(frameHeight * 0.72, availableWidth, 720))
  );

  el.viewerText.style.width = `${frameWidth}px`;
  el.viewerText.style.height = `${frameHeight}px`;

  // Measure the content box as a fraction, not via clientWidth: that rounds
  // to an integer, and stepping by the rounded value drifts by the difference
  // on every page — a few pixels in, which clips the text at the edges.
  const clip = el.viewerClip.getBoundingClientRect();
  if (!clip.width || !clip.height) return;

  pageStep = clip.width;
  el.viewerFlow.style.height = `${clip.height}px`;
  el.viewerFlow.style.columnWidth = `${clip.width}px`;

  chapterPages = Math.max(1, Math.round(el.viewerFlow.scrollWidth / pageStep));
  chapterPage = Math.min(chapterPage, chapterPages);
  applyPageOffset();
}

function applyPageOffset() {
  // Same fractional step the columns were laid out with, so page N lines up
  // exactly with column N however deep into the chapter it is.
  const step = pageStep || el.viewerClip.getBoundingClientRect().width || 1;
  el.viewerFlow.style.transform = `translateX(-${(chapterPage - 1) * step}px)`;
  updateTextPosition();
}

function updateTextPosition() {
  if (viewing?.kind !== 'text') return;
  const total = viewing.chapters.length;

  if (readerMode === 'page') {
    el.viewerPos.textContent = `ch ${viewingPage}/${total} · p ${chapterPage}/${chapterPages}`;
    // Prev/Next walk pages and roll over into the neighbouring chapter, so the
    // whole book is reachable with one key.
    el.viewerPrev.disabled = viewingPage <= 1 && chapterPage <= 1;
    el.viewerNext.disabled = viewingPage >= total && chapterPage >= chapterPages;
  } else {
    // Scroll view is one continuous column: there are no pages to step
    // through, so Prev/Next are off. The chapter picker still jumps.
    el.viewerPos.textContent = `chapter ${viewingPage} / ${total}`;
    el.viewerPrev.disabled = true;
    el.viewerNext.disabled = true;
  }
  el.viewerChapters.value = String(viewingPage - 1);
}

function applyReaderMode() {
  const paged = readerMode === 'page';
  el.viewerText.classList.toggle('page-mode', paged);
  el.viewerText.classList.toggle('scroll-mode', !paged);
  el.viewerText.classList.toggle('full-width', readerWidth === 'full');
  for (const button of el.viewerMode.querySelectorAll('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === readerMode));
  }
  for (const button of el.viewerMode.querySelectorAll('[data-width]')) {
    button.setAttribute('aria-pressed', String(button.dataset.width === readerWidth));
  }

  if (paged) {
    layoutPages();
  } else {
    // Undo the paged geometry, or the column rules keep applying.
    el.viewerText.style.width = '';
    el.viewerText.style.height = '';
    el.viewerFlow.style.height = '';
    el.viewerFlow.style.columnWidth = '';
    el.viewerFlow.style.transform = '';
    updateTextPosition();
  }
}

// What the text frame currently holds: one chapter's number in page view, or
// 'all' when scroll view has laid the whole book out in one column.
let flowHolds = null;

// ---- scroll view: the whole book, top to bottom

async function showWholeBook() {
  const book = viewing;
  el.viewerImage.hidden = true;
  el.viewerText.hidden = false;

  if (flowHolds !== 'all') {
    el.viewerPos.textContent = 'Loading…';
    let chapters;
    try {
      chapters = await Promise.all(
        book.chapters.map((_, i) =>
          api(`/api/outbox/chapter?id=${encodeURIComponent(book.id)}&n=${i}`)
        )
      );
    } catch (err) {
      showNote(err.message);
      return;
    }
    // Closed, or switched back to page view, while the chapters were loading.
    if (viewing !== book || readerMode === 'page') return;
    // Sanitized server-side (no scripts, styles or internal links).
    el.viewerFlow.innerHTML = chapters
      .map((c, i) => `<section class="scroll-chapter" data-chapter="${i + 1}">${c.html || ''}</section>`)
      .join('<hr class="chapter-break">');
    flowHolds = 'all';
  }

  applyReaderMode();
  scrollToChapter(viewingPage, 'auto');
}

function chapterSections() {
  return [...el.viewerFlow.querySelectorAll('.scroll-chapter')];
}

function scrollToChapter(n, behavior = 'smooth') {
  const stage = el.viewer.querySelector('.viewer-stage');
  const section = chapterSections()[n - 1];
  if (!section) return;
  viewingPage = n;
  updateTextPosition();
  const top = section.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop;
  stage.scrollTo({ top: n === 1 ? 0 : Math.max(0, top - 12), behavior });
}

// As the book scrolls, the chapter at the top of the view is the current one,
// so the picker and the position read where you are.
el.viewer.querySelector('.viewer-stage').addEventListener(
  'scroll',
  () => {
    if (readerMode === 'page' || flowHolds !== 'all' || viewing?.kind !== 'text') return;
    const stageTop = el.viewer.querySelector('.viewer-stage').getBoundingClientRect().top;
    let current = 1;
    for (const section of chapterSections()) {
      if (section.getBoundingClientRect().top - stageTop <= 80) current = Number(section.dataset.chapter);
      else break;
    }
    if (current !== viewingPage) {
      viewingPage = current;
      updateTextPosition();
    }
  },
  { passive: true }
);

/** @param {'start'|'end'} at Which end of the chapter to open at. */
async function showChapter(at = 'start') {
  if (viewing?.kind !== 'text') return;
  const total = viewing.chapters.length;
  viewingPage = Math.min(total, Math.max(1, viewingPage));

  if (readerMode !== 'page') return showWholeBook();

  el.viewerImage.hidden = true;
  el.viewerText.hidden = false;

  try {
    const chapter = await api(
      `/api/outbox/chapter?id=${encodeURIComponent(viewing.id)}&n=${viewingPage - 1}`
    );
    // Sanitized server-side (no scripts, styles or internal links), and it is
    // content this app built moments ago.
    el.viewerFlow.innerHTML = chapter.html || '<p class="viewer-note">This chapter is empty.</p>';
    flowHolds = viewingPage;
  } catch (err) {
    showNote(err.message);
    return;
  }

  chapterPage = 1;
  applyReaderMode();

  // Arriving backwards should land on the last page, not the first.
  if (readerMode === 'page' && at === 'end') {
    chapterPage = chapterPages;
    applyPageOffset();
  }

  // Images change the column count once they have dimensions, so measure again
  // after they load.
  if (readerMode === 'page') {
    const images = [...el.viewerFlow.querySelectorAll('img')];
    for (const img of images) {
      if (img.complete) continue;
      img.addEventListener('load', layoutPages, { once: true });
      img.addEventListener('error', layoutPages, { once: true });
    }
  }

  el.viewer.querySelector('.viewer-stage').scrollTop = 0;
}

// ---- page-turn effect
//
// Like leafing through a book, the spine is always on the left. Going forward,
// a snapshot of the page being left is laid over the frame, the frame moves to
// the next page underneath, and the snapshot swings away to the left. Going
// back, the snapshot stays put underneath while the previous page swings in
// from the left and settles on top of it. It is decoration only — the page has
// already changed by the time it starts — so a fast reader holding an arrow key
// just cuts the previous turn short.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let turning = null;

function finishTurn() {
  turning?.animation?.cancel();
  turning?.leaf.remove();
  turning?.page.classList.remove('page-arriving');
  if (turning) turning.page.style.transformOrigin = '';
  el.viewerFlow.classList.remove('turning');
  turning = null;
}

async function turnPage(page, delta, change) {
  finishTurn();
  if (reduceMotion.matches || page.hidden) return change();

  const stage = el.viewer.querySelector('.viewer-stage');
  const rect = page.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();

  const leaf = page.cloneNode(true);
  leaf.removeAttribute('id');
  for (const node of leaf.querySelectorAll('[id]')) node.removeAttribute('id');
  leaf.classList.add('page-leaf');
  leaf.setAttribute('aria-hidden', 'true');
  Object.assign(leaf.style, {
    left: `${rect.left - stageRect.left + stage.scrollLeft}px`,
    top: `${rect.top - stageRect.top + stage.scrollTop}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    transformOrigin: 'left center',
  });
  stage.appendChild(leaf);
  const current = { leaf, page, animation: null };
  turning = current;

  // The page underneath should already be in place, not sliding into it.
  el.viewerFlow.classList.add('turning');
  try {
    await change();
  } finally {
    el.viewerFlow.classList.remove('turning');
  }
  if (turning !== current) return;

  const timing = { duration: 420, easing: 'cubic-bezier(0.3, 0.1, 0.4, 1)' };
  if (delta > 0) {
    // The old page lifts off to the left.
    current.animation = leaf.animate(
      [
        { transform: 'perspective(2200px) rotateY(0deg)', boxShadow: '0 10px 40px rgba(0,0,0,0.5)', opacity: 1 },
        { transform: 'perspective(2200px) rotateY(-60deg)', boxShadow: '0 20px 60px rgba(0,0,0,0.45)', opacity: 1, offset: 0.6 },
        { transform: 'perspective(2200px) rotateY(-100deg)', boxShadow: '0 20px 60px rgba(0,0,0,0)', opacity: 0 },
      ],
      timing
    );
  } else {
    // The previous page comes back over from the left, onto the old one.
    leaf.classList.add('page-leaf-under');
    page.classList.add('page-arriving');
    page.style.transformOrigin = 'left center';
    current.animation = page.animate(
      [
        { transform: 'perspective(2200px) rotateY(-100deg)', boxShadow: '0 20px 60px rgba(0,0,0,0)', opacity: 0 },
        { transform: 'perspective(2200px) rotateY(-60deg)', boxShadow: '0 20px 60px rgba(0,0,0,0.45)', opacity: 1, offset: 0.4 },
        { transform: 'perspective(2200px) rotateY(0deg)', boxShadow: '0 10px 40px rgba(0,0,0,0.5)', opacity: 1 },
      ],
      timing
    );
  }
  // A throttled or background tab can run animations far slower than their
  // nominal length; never leave the snapshot covering the page for long.
  const done = () => turning === current && finishTurn();
  current.animation.finished.then(done, () => {});
  setTimeout(done, 520);
}

/** Resolves once the page image has loaded (or failed), capped so a slow one never stalls a turn. */
function imageSettled(img) {
  if (img.complete) return Promise.resolve();
  return new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
    setTimeout(resolve, 800);
  });
}

/** One step forward or back, crossing chapter boundaries in paged mode. */
function step(delta) {
  if (viewing?.kind === 'images') {
    const target = viewingPage + delta;
    if (target < 1 || target > viewing.pageCount) return;
    turnPage(el.viewerImage, delta, () => {
      viewingPage = target;
      showPage();
      return imageSettled(el.viewerImage);
    });
    return;
  }
  if (viewing?.kind !== 'text') return;

  // Scroll view has no pages to step through; Prev/Next are disabled there.
  if (readerMode !== 'page') return;

  const next = chapterPage + delta;
  if (next >= 1 && next <= chapterPages) {
    turnPage(el.viewerText, delta, () => {
      chapterPage = next;
      applyPageOffset();
    });
    return;
  }

  // Off the end of the chapter: move to the neighbour, entering from the side
  // the reader is travelling.
  const total = viewing.chapters.length;
  if (delta > 0 && viewingPage < total) {
    turnPage(el.viewerText, delta, () => {
      viewingPage += 1;
      return showChapter('start');
    });
  } else if (delta < 0 && viewingPage > 1) {
    turnPage(el.viewerText, delta, () => {
      viewingPage -= 1;
      return showChapter('end');
    });
  }
}

function closeViewer() {
  finishTurn();
  flowHolds = null;
  el.viewer.hidden = true;
  toggleTypography(false);
  el.viewerImage.removeAttribute('src');
  el.viewerFlow.replaceChildren();
  viewing = null;
}

el.viewerPrev.addEventListener('click', () => step(-1));
el.viewerNext.addEventListener('click', () => step(1));
el.viewerClose.addEventListener('click', closeViewer);

el.viewerType.addEventListener('click', () => toggleTypography());
el.typeFamily.addEventListener('change', () => setReaderType({ font: el.typeFamily.value }));
el.typeLeading.addEventListener('change', () => setReaderType({ leading: el.typeLeading.value }));
el.typeAlign.addEventListener('change', () => setReaderType({ align: el.typeAlign.value }));
el.typeSmaller.addEventListener('click', () =>
  setReaderType({ size: clamp(readerType.size - 1, SIZE_MIN, SIZE_MAX) })
);
el.typeBigger.addEventListener('click', () =>
  setReaderType({ size: clamp(readerType.size + 1, SIZE_MIN, SIZE_MAX) })
);
el.typeReset.addEventListener('click', () => setReaderType({ ...TYPE_DEFAULTS }));

el.viewerMode.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const mode = button.dataset.mode;
  const width = button.dataset.width;
  const save = () => {
    try {
      localStorage.setItem('apub.readerWidth', readerWidth);
    } catch {
      /* not persisting is not a failure */
    }
  };
  if (mode && mode !== readerMode) {
    // Switching view changes what the frame holds — one chapter, or the whole
    // book — so reload it at the chapter being read.
    readerMode = mode;
    chapterPage = 1;
    save();
    if (viewing?.kind === 'text') showChapter();
  } else if (width && width !== readerWidth) {
    readerWidth = width;
    save();
    applyReaderMode();
  }
});

el.viewerChapters.addEventListener('change', () => {
  const n = Number(el.viewerChapters.value) + 1;
  if (readerMode !== 'page' && flowHolds === 'all') scrollToChapter(n);
  else {
    viewingPage = n;
    showChapter();
  }
});

el.viewer.addEventListener('click', (event) => {
  // Clicking away from the type panel closes it, without closing the viewer.
  if (!el.typography.hidden && !el.typography.contains(event.target) && event.target !== el.viewerType) {
    toggleTypography(false);
  }
  // Clicking the backdrop closes; clicking the page or the bar does not.
  if (event.target === el.viewer) closeViewer();
});

// Re-measure when the window changes shape, or the page would show a stale
// column count and clip text.
window.addEventListener('resize', () => {
  if (!el.viewer.hidden) layoutPages();
});

document.addEventListener('keydown', (event) => {
  if (el.viewer.hidden) return;
  // Don't hijack keys while the chapter picker has focus.
  if (event.target === el.viewerChapters && event.key !== 'Escape') return;
  if (event.key === 'Escape') {
    if (!el.typography.hidden) toggleTypography(false);
    else closeViewer();
  } else if (viewing?.kind === 'text' && (event.key === '+' || event.key === '=')) {
    setReaderType({ size: clamp(readerType.size + 1, SIZE_MIN, SIZE_MAX) });
  } else if (viewing?.kind === 'text' && event.key === '-') {
    setReaderType({ size: clamp(readerType.size - 1, SIZE_MIN, SIZE_MAX) });
  }
  // In scroll view these keys scroll the text as usual, not turn pages.
  else if (event.key === 'ArrowLeft' || (event.key === 'PageUp' && readerMode === 'page')) step(-1);
  else if (event.key === 'ArrowRight' || (event.key === 'PageDown' && readerMode === 'page')) step(1);
  else if (event.key === ' ' && readerMode === 'page') {
    event.preventDefault();
    step(1);
  }
});

// ---------------------------------------------------------------- outbox

/**
 * Load the pending queue from the server.
 *
 * The queue lives on disk, not in this page, because the reader is usually
 * connected later than the moment something was built — refresh feeds on your
 * own Wi-Fi, then join the reader's hotspot and push. So a reload, a network
 * switch or an app restart must not lose what is waiting.
 */
// Files waiting to be taken off the reader. Kept here because the Send button
// is what carries them out, so the count belongs next to it.
let pendingRemovals = [];

async function loadRemovals(count) {
  try {
    // A count from the caller saves a round trip after it just changed one.
    if (typeof count === 'number' && count === 0) pendingRemovals = [];
    else pendingRemovals = (await api('/api/removals')).removals || [];
  } catch {
    pendingRemovals = [];
  }
  renderRemovals();
}

function renderRemovals() {
  const n = pendingRemovals.length;
  el.removalNote.hidden = n === 0;
  if (n) {
    const names = pendingRemovals.slice(0, 3).map((r) => r.title || r.filename);
    el.removalNote.textContent =
      `${n} file${n === 1 ? '' : 's'} will be removed from the reader on the next send: ` +
      `${names.join(', ')}${n > names.length ? `, and ${n - names.length} more` : ''}.`;
  }
  // A sync that only deletes is still worth doing, so Send stays available.
  el.send.disabled = busy || (!results.some((r) => r.selected) && n === 0);
}

async function loadOutbox() {
  try {
    const { items } = await api('/api/outbox');
    // Preserve tick state for anything already on screen.
    const chosen = new Map(results.map((r) => [r.id, r.selected]));
    // An item switched off in the Library is not queued for the reader; any
    // copy already there is covered by the removal note instead.
    results = items.filter((entry) => entry.onReader !== false).map((entry) => ({
      id: entry.id,
      filename: entry.filename,
      title: entry.title,
      author: entry.source?.kind === 'feed' ? '' : entry.author || '',
      size: entry.size,
      chapters: entry.chapters,
      mode: entry.mode,
      pageCount: entry.pageCount,
      images: entry.mode === 'images' ? entry.pageCount : 0,
      source: entry.source,
      folder: entry.folder,
      deliveredAt: entry.deliveredAt,
      deliveredTo: entry.deliveredTo,
      warnings: [],
      // Default to sending what hasn't been sent yet.
      selected: chosen.has(entry.id) ? chosen.get(entry.id) : !entry.deliveredAt,
      // A recorded outcome wins over the stored state: it is the newer news,
      // and a failure message is what tells you which row to look at.
      sendState: sendOutcomes.get(entry.id)?.state ?? (entry.deliveredAt ? 'ok' : undefined),
      sendMessage:
        sendOutcomes.get(entry.id)?.message ??
        (entry.deliveredAt ? `Sent to ${entry.deliveredTo || 'the reader'}` : undefined),
    }));
    renderResults();

    // Two other places depend on the queue: the badge on the tab bar, and the
    // Library tab's list of what has been sent.
    window.epubDropTabs?.setPending(results.filter((r) => !r.deliveredAt).length);
    window.epubDropRead?.load();
  } catch (err) {
    setStatus(err.message, 'bad');
  }
}

async function removeFromQueue(result) {
  try {
    await api('/api/outbox/remove', { method: 'POST', body: JSON.stringify({ id: result.id }) });
    await loadOutbox();
  } catch (err) {
    setStatus(err.message, 'bad');
  }
}

// ---------------------------------------------------------------- destination

/**
 * Populate the Wi-Fi / mounted-drive picker.
 *
 * A drive is offered as a destination only when it looks like the reader's card
 * (the firmware's own folders are present) or when nothing better is mounted —
 * writing books onto someone's backup disk would be worse than making them pick.
 */
async function loadVolumes() {
  const previous = el.destination.value;
  try {
    ({ volumes } = await api('/api/volumes'));
  } catch {
    volumes = [];
  }

  const options = [new Option('Wi-Fi', 'wifi')];
  for (const volume of volumes) {
    const label = volume.likely
      ? `${volume.name} — looks like the reader's card`
      : `${volume.name}${volume.writable ? '' : ' (read-only)'}`;
    options.push(new Option(label, volume.path));
  }
  el.destination.replaceChildren(...options);

  // Keep the current choice if that drive is still mounted.
  el.destination.value = [...el.destination.options].some((o) => o.value === previous) ? previous : 'wifi';
  syncDestination();
}

function syncDestination() {
  const viaVolume = el.destination.value !== 'wifi';
  el.hostField.hidden = viaVolume;
  el.find.hidden = viaVolume;
  el.useHotspot.hidden = viaVolume;
  el.send.textContent = viaVolume ? 'Copy to drive' : 'Send to reader';

  if (viaVolume) {
    const volume = volumes.find((v) => v.path === el.destination.value);
    setDevice('ok', volume ? `Copying to ${volume.name}${volume.likely ? '' : ' (unverified)'}` : 'Drive selected');
  } else {
    checkDevice();
  }
}

// ---------------------------------------------------------------- library

async function loadLibrary() {
  // Hidden in favour of the Library's On reader switches; listing the device
  // for a section nobody sees would only probe it for nothing.
  if (el.librarySection?.hidden) return;
  el.refreshLibrary.disabled = true;
  try {
    const data = await api(
      el.destination.value === 'wifi'
        ? `/api/library?host=${encodeURIComponent(el.host.value.trim())}`
        : `/api/library?volume=${encodeURIComponent(el.destination.value)}`
    );
    el.libraryFolder.textContent = data.folder ? `· ${data.folder}` : '';

    if (!data.ok) {
      library = [];
      libraryCanDelete = false;
      renderLibrary();
      setLibraryStatus(data.error || 'Reader not reachable.', 'bad');
      return;
    }

    libraryCanDelete = data.canDelete;
    library = data.entries.map((e) => ({ ...e, selected: false }));
    renderLibrary();
    setLibraryStatus(
      library.length
        ? `${library.length} file${library.length === 1 ? '' : 's'} in ${data.folder}`
        : `${data.folder} is empty.`
    );
    if (!data.canDelete) {
      setLibraryStatus(
        'Deleting is disabled while the reader folder is the SD-card root. Set a folder such as /A-pub Books.',
        'bad'
      );
    }
  } catch (err) {
    setLibraryStatus(err.message, 'bad');
  } finally {
    el.refreshLibrary.disabled = false;
  }
}

function renderLibrary() {
  const anySelected = library.some((f) => f.selected);
  el.deleteLibrary.disabled = busy || !anySelected || !libraryCanDelete;
  el.libraryAll.checked = library.length > 0 && library.every((f) => f.selected);
  el.libraryAll.disabled = !library.length || !libraryCanDelete;

  if (!library.length) {
    el.library.replaceChildren();
    return;
  }

  el.library.replaceChildren(
    ...library.map((file) => {
      const li = document.createElement('li');
      li.className = 'item';

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = file.selected;
      check.disabled = !libraryCanDelete;
      check.addEventListener('change', () => {
        file.selected = check.checked;
        renderLibrary();
      });

      const body = document.createElement('div');
      body.className = 'item-body';

      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = file.name;
      body.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'item-meta';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = file.isEpub ? 'EPUB' : 'file';
      meta.appendChild(badge);
      meta.append(formatBytes(file.size));
      body.appendChild(meta);

      if (file.deleteError) {
        const err = document.createElement('div');
        err.className = 'item-err';
        err.textContent = file.deleteError;
        body.appendChild(err);
      }

      li.append(check, body);
      return li;
    })
  );
}

async function deleteSelected() {
  const selected = library.filter((f) => f.selected);
  if (!selected.length || busy) return;

  const names = selected.map((f) => f.name);
  const preview = names.slice(0, 5).join('\n  ');
  const more = names.length > 5 ? `\n  …and ${names.length - 5} more` : '';
  // Deleting from the SD card cannot be undone, so make the list explicit.
  if (
    !confirm(
      `Delete ${names.length} file${names.length === 1 ? '' : 's'} from the reader?\n\n  ${preview}${more}\n\nThis cannot be undone.`
    )
  ) {
    return;
  }

  setBusy(true, el.deleteLibrary, 'Deleting…');
  setLibraryStatus('');
  try {
    const payload = await api('/api/library/delete', {
      method: 'POST',
      body: JSON.stringify(
        el.destination.value === 'wifi'
          ? { names, host: el.host.value.trim() }
          : { names, volume: el.destination.value }
      ),
    });

    if (payload.error && !payload.results?.length) {
      setLibraryStatus(payload.error, 'bad');
      return;
    }

    const failed = payload.results.filter((r) => !r.ok);
    for (const failure of failed) {
      const match = library.find((f) => f.name === failure.name);
      if (match) match.deleteError = failure.error;
    }

    const okCount = payload.results.length - failed.length;
    setLibraryStatus(
      failed.length
        ? `Deleted ${okCount}, ${failed.length} failed.`
        : `Deleted ${okCount} file${okCount === 1 ? '' : 's'} from ${payload.folder}.`,
      failed.length ? 'bad' : 'ok'
    );

    await loadLibrary();
  } catch (err) {
    setLibraryStatus(err.message, 'bad');
  } finally {
    setBusy(false, el.deleteLibrary, 'Delete selected');
  }
}

function setLibraryStatus(text, kind = '') {
  el.libraryStatus.textContent = text;
  el.libraryStatus.className = `status ${kind}`;
}

// ---------------------------------------------------------------- device

async function checkDevice() {
  // A drive destination has its own label; polling the reader would overwrite it.
  if (el.destination.value !== 'wifi') return;
  setDevice('busy', 'Checking reader…');
  try {
    const data = await api(`/api/device?host=${encodeURIComponent(el.host.value.trim())}`);
    if (data.ok) {
      const s = data.status || {};
      const rssi = typeof s.rssi === 'number' && s.rssi !== 0 ? `, ${s.rssi} dBm` : '';
      const mode = s.mode === 'AP' ? ', hotspot' : '';
      setDevice('ok', `${s.device || 'Reader'} at ${data.host} (fw ${s.version || '?'}${mode}${rssi})`);
    } else {
      setDevice('off', data.error || 'Reader not reachable');
    }
  } catch (err) {
    setDevice('off', err.message);
  }
}

async function findDevice() {
  setDevice('busy', 'Broadcasting on the local network…');
  el.find.disabled = true;
  try {
    const { devices } = await api('/api/discover', { method: 'POST' });
    const live = devices.find((d) => d.ok) || devices[0];
    if (!live) {
      setDevice('off', 'Nothing answered. Open File Transfer on the reader, then retry.');
      return;
    }
    el.host.value = live.address;
    await saveConfig();
    await checkDevice();
    await loadLibrary();
  } catch (err) {
    setDevice('off', err.message);
  } finally {
    el.find.disabled = false;
  }
}

// The footer shows a short label; the full message (often a paragraph of advice
// about File Transfer and addresses) is behind the info button.
const DEVICE_LABELS = { ok: 'Reader connected', off: 'Reader not connected', busy: 'Checking reader…' };

function setDevice(state, text) {
  el.device.dataset.state = state;
  el.deviceText.textContent = text;
  el.deviceInfo.title = text;
  // Connected is the one state whose details are short and worth seeing.
  el.deviceLabel.textContent = state === 'ok' ? text : DEVICE_LABELS[state] || text;
}

el.deviceInfo.addEventListener('click', () => {
  const open = el.deviceText.hidden;
  el.deviceText.hidden = !open;
  el.deviceInfo.setAttribute('aria-expanded', String(open));
});

// ---------------------------------------------------------------- config

async function loadFolders() {
  try {
    const { folders } = await api('/api/folders');
    el.folder.replaceChildren(...folders.map((f) => new Option(`${f.label} — ${f.path}`, f.path)));
  } catch {
    /* the folder the config reports is still selectable below */
  }
}

async function loadConfig() {
  try {
    const config = await api('/api/config');
    el.host.value = config.host || 'crosspoint.local';
    // A value the picker doesn't offer would select nothing; fall back to Books.
    el.folder.value = config.folder || '/A-pub Books';
    if (!el.folder.value) el.folder.value = '/A-pub Books';
    el.includeImages.checked = config.includeImages !== false;
    el.imageMode.checked = Boolean(config.imageMode);
    el.imageScale.value = String(config.imageScale || 2);
    el.imageSplit.value = config.imageSplit || 'whole';
    el.imageFont.value = String(config.imageFontSize || 21);
  } catch {
    /* defaults from the markup are fine */
  }
  syncImageMode();
}

/** Show the fixed-layout controls only when that mode is on. */
function syncImageMode() {
  const on = el.imageMode.checked;
  el.imageOptions.hidden = !on;
  el.composeModeNote.hidden = !on;
  // "Include images" refers to fetching pictures out of an article, which is
  // meaningless once every page is itself a picture.
  el.includeImages.disabled = on;
  el.convert.textContent = on ? 'Convert to page images' : 'Convert to EPUB';
}

async function saveConfig() {
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        host: el.host.value.trim(),
        folder: el.folder.value,
        includeImages: el.includeImages.checked,
        imageMode: el.imageMode.checked,
        imageScale: Number(el.imageScale.value),
        imageSplit: el.imageSplit.value,
        imageFontSize: Number(el.imageFont.value),
      }),
    });
  } catch {
    /* non-fatal: settings just won't persist */
  }
}

// ---------------------------------------------------------------- ui plumbing

function setBusy(state, button, label) {
  busy = state;
  el.convert.disabled = busy || queue.length === 0;
  el.send.disabled = busy || (!results.some((r) => r.selected) && pendingRemovals.length === 0);
  el.deleteLibrary.disabled = busy || !libraryCanDelete || !library.some((f) => f.selected);
  if (state) {
    button.disabled = true;
    button.innerHTML = `<span class="spin"></span>${label}`;
  } else {
    button.textContent = label;
  }
}

function setStatus(text, kind = '') {
  el.sendStatus.textContent = text;
  el.sendStatus.className = `status ${kind}`;
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Drag/drop. dragover must be cancelled or the browser navigates to the file.
for (const type of ['dragenter', 'dragover']) {
  el.drop.addEventListener(type, (e) => {
    e.preventDefault();
    el.drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  el.drop.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'dragleave' && el.drop.contains(e.relatedTarget)) return;
    el.drop.classList.remove('over');
  });
}
el.drop.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) addFiles(files);
  // A drag from a browser tab carries a URL instead of a file.
  else {
    const uri = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
    if (uri && /^https?:\/\//i.test(uri.trim())) {
      el.urlInput.value = uri.trim();
      addUrls();
    }
  }
});

// Dropping anywhere else shouldn't make the browser open the file.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

el.drop.addEventListener('click', () => el.fileInput.click());
el.pick.addEventListener('click', (e) => {
  e.stopPropagation();
  el.fileInput.click();
});
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    el.fileInput.click();
  }
});
el.fileInput.addEventListener('change', () => {
  addFiles([...el.fileInput.files]);
  el.fileInput.value = '';
});

el.addUrls.addEventListener('click', addUrls);
el.urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addUrls();
});
el.clearQueue.addEventListener('click', () => {
  queue = [];
  renderQueue();
});
el.clearResults.addEventListener('click', async () => {
  // Only drop what has already gone over: clearing the view would otherwise
  // hide files that are still waiting to be sent.
  try {
    const { removed } = await api('/api/outbox/clear-delivered', { method: 'POST' });
    sendOutcomes.clear();
    await loadOutbox();
    setStatus(removed ? `Cleared ${removed} already sent.` : 'Nothing sent yet to clear.');
  } catch (err) {
    setStatus(err.message, 'bad');
  }
});
el.convert.addEventListener('click', convert);
el.send.addEventListener('click', send);
el.find.addEventListener('click', findDevice);
el.useHotspot.addEventListener('click', async () => {
  el.host.value = '192.168.4.1';
  await saveConfig();
  await checkDevice();
  await loadLibrary();
});
el.host.addEventListener('change', () => {
  saveConfig();
  checkDevice();
  loadLibrary();
});
// The folder has to be saved before the library reloads: the server reads the
// scope from saved config, not from the request.
el.folder.addEventListener('change', () => saveConfig().then(loadLibrary));
el.includeImages.addEventListener('change', saveConfig);
el.imageMode.addEventListener('change', () => {
  syncImageMode();
  saveConfig();
});
for (const control of [el.imageScale, el.imageSplit, el.imageFont]) {
  control.addEventListener('change', saveConfig);
}

el.destination.addEventListener('change', () => {
  syncDestination();
  loadLibrary();
});
el.refreshLibrary.addEventListener('click', () => {
  // Re-scan drives too: the card may have been plugged in since page load.
  loadVolumes().then(loadLibrary);
});
el.deleteLibrary.addEventListener('click', deleteSelected);
el.libraryAll.addEventListener('change', () => {
  for (const file of library) file.selected = el.libraryAll.checked;
  renderLibrary();
});

loadFolders().then(loadConfig).then(async () => {
  // The queue is local state, so show it immediately. Chaining it behind the
  // device probe meant a six-second wait whenever the reader was switched off —
  // exactly when you most want to see what's waiting to go.
  loadOutbox();
  loadRemovals();
  await loadVolumes(); // also picks the destination, which probes the reader
  loadLibrary();
});
