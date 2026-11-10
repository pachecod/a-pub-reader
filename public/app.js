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
  resultsEmpty: $('results-empty'),
  host: $('host'),
  send: $('send'),
  removalNote: $('removal-note'),
  sendStatus: $('send-status'),
  // The Library's own Sync Reader button and status line.
  syncLibrary: $('read-sync'),
  sendBottom: $('send-bottom'),
  syncLibraryStatus: $('read-sync-status'),
  queueStatus: $('queue-status'),
  device: $('device'),
  deviceText: $('device-text'),
  deviceLabel: $('device-label'),
  deviceInfo: $('device-info'),
  find: $('find'),
  useHotspot: $('use-hotspot'),
  destination: $('destination'),
  hostField: $('host-field'),
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
  typeTurn: $('type-turn'),
  viewerClip: $('viewer-clip'),
  viewerFlow: $('viewer-flow'),
};

/** Pending inputs: {key, kind:'html'|'pdf'|'url', name, text?, pdfBase64?, url?} */
let queue = [];
/** Converted EPUBs from the server, newest last. */
let results = [];
/**
 * Per-item send failures, keyed by queue id.
 *
 * Kept outside `results` because a send is followed by re-reading the queue
 * from the server, which rebuilds every row — so failure messages were being
 * wiped a moment after being set, leaving only a summary count with no way to
 * tell which item had a problem.
 */
const sendFailures = new Map();
/** Running on a server, with the device features off (from /api/config). */
let hosted = false;
/** The Send via choice saved last time, applied once the list is loaded. */
let savedDestination = 'wifi';
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
  reloadQueue: () => loadOutbox(),
  reloadRemovals: (count) => loadRemovals(count),
  // The Library tab lists delivered items and opens them in the same previewer.
  reloadRead: () => window.epubDropRead?.load(),
  preview: (entry) => openViewer(entry),
  readerSwitch: (entry) => readerSwitch(entry),
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

let shownQueueLength = 0;

function renderQueue() {
  el.queueSection.classList.toggle('hidden', queue.length === 0);
  // Something was just added: if the list is off screen (a narrow window puts
  // it below Add content), bring it into view so it is clear where it went.
  if (queue.length > shownQueueLength) {
    requestAnimationFrame(() => {
      const box = el.queueSection.getBoundingClientRect();
      if (box.height && (box.top > window.innerHeight - 80 || box.bottom < 0)) {
        el.queueSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }
  shownQueueLength = queue.length;
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
    el.queueStatus.textContent = failed.map((r) => `${r.label}: ${r.error}`).join(' · ');
    el.queueStatus.className = `status ${failed.length ? 'bad' : ''}`;
    // Hosted there is no sync list beside the queue to show the new items, so
    // go to the Library, where they now are.
    if (hosted && okCount && !failed.length && window.epubDropTabs?.current() === 'add') {
      window.epubDropTabs.show('read');
      window.epubDropRead?.load?.();
    }

    return { ok: !failed.length, okCount, failed: failed.length };
  } catch (err) {
    setStatus(err.message, 'bad');
    el.queueStatus.textContent = err.message;
    el.queueStatus.className = 'status bad';
    return { ok: false, error: err.message };
  } finally {
    setBusy(false, el.convert, 'Convert to EPUB');
  }
}

/**
 * The queue as shown: like the Library, only the newest edition of each feed.
 * An older edition still on the reader is replaced by the newer one at the
 * next sync, and the feed's switch covers both.
 */
function shownResults() {
  const seenFeeds = new Set();
  return results.filter((r) => {
    const feedId = r.source?.feedId;
    if (!feedId) return true;
    if (seenFeeds.has(feedId)) return false;
    seenFeeds.add(feedId);
    return true;
  });
}

function renderResults(failures = []) {
  const shown = shownResults();
  el.resultsCount.textContent = shown.length ? `· ${shown.length}` : '';
  if (el.resultsEmpty) el.resultsEmpty.hidden = shown.length > 0 || failures.length > 0;
  // The closing Sync Reader is only worth having under an actual list.
  if (el.sendBottom) el.sendBottom.parentElement.hidden = shown.length === 0;
  updateSyncButtons();

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

  for (const r of shown) {
    const li = document.createElement('li');
    li.className = r.deliveredAt ? 'item delivered' : 'item';

    const body = document.createElement('div');
    body.className = 'item-body';

    const title = document.createElement('div');
    title.className = 'item-title';
    // As on the Library card, the title opens the reading page, which also
    // has Read as eBook and Download eBook.
    const link = document.createElement('a');
    link.href = `/read/${r.id}`;
    link.className = 'card-title-link';
    link.textContent = r.title;
    title.appendChild(link);
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


    if (r.warnings?.length) {
      const warn = document.createElement('div');
      warn.className = 'item-warn';
      warn.textContent = r.warnings.join(' · ');
      body.appendChild(warn);
    }
    // The same On reader switch as the Library card, so the two always agree.
    body.appendChild(readerSwitch(r));
    if (r.sendError) {
      const bad = document.createElement('div');
      bad.className = 'item-err';
      bad.textContent = r.sendError;
      body.appendChild(bad);
    }

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.title = 'Forget — remove it here, and optionally from the reader as well';
    remove.setAttribute('aria-label', `Forget ${r.title}`);
    remove.textContent = '×';
    // The same Forget dialog as the Library's ×, so both ask before acting.
    remove.addEventListener('click', () => window.epubDropRead?.askForget(r));

    // Feed editions have no × here either: a feed is dropped under Feeds, and
    // kept off the reader with its switch.
    if (r.source?.kind === 'feed') li.appendChild(body);
    else li.append(body, remove);
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
/** What a set of synced files were, counted by the folder each went to. */
const KINDS = {
  '/A-pub Books': ['book', 'books'],
  '/A-pub Documents': ['document', 'documents'],
  '/A-pub Notes': ['note', 'notes'],
  '/A-pub Feeds': ['feed edition', 'feed editions'],
};

function describeFiles(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const [one, many] = KINDS[entry.folder] || ['file', 'files'];
    const tally = counts.get(one) || { n: 0, one, many };
    tally.n++;
    counts.set(one, tally);
  }
  const parts = [...counts.values()].map(({ n, one, many }) => `${n} ${n === 1 ? one : many}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || '';
}

/**
 * One line describing what a sync did.
 *
 * A sync can upload, delete, or both, and says what it moved — books, notes or
 * feed editions, by the folder each went to — rather than a bare count and one
 * folder, so a sync of only feeds does not read as books going over. "Sent 0"
 * after successfully clearing three files off the reader would read as a
 * failure, so each part appears only when it happened.
 */
function summarize(okCount, payload) {
  const sent = (payload.results || []).filter((r) => r.ok);
  const removed = (payload.removed || []).filter((r) => r.ok);
  const stuck = (payload.removed || []).filter((r) => !r.ok).length;
  const parts = [];
  if (okCount) parts.push(`Sent ${describeFiles(sent) || okCount} to ${payload.host}`);
  if (removed.length) parts.push(`${parts.length ? 'removed' : 'Removed'} ${describeFiles(removed)} from the reader`);
  if (stuck) parts.push(`${stuck} could not be removed — still queued`);
  if (!parts.length) return 'Nothing to do.';
  return `${parts.join(' · ')}.`;
}

// ---------------------------------------------------------------- sync
//
// One switch per item decides what belongs on the reader; Sync Reader makes
// the reader match: it sends everything switched on that is not there yet, and
// carries out the removals queued by switching things off.

/** Items switched on that have not reached the reader yet. */
function toSync() {
  return results.filter((r) => r.onReader && !r.deliveredAt);
}

// A synced cloud folder reaches the reader through the cloud, so it is still
// Sync Reader; a card in the Mac is a drive being copied to.
const syncLabel = () => {
  if (el.destination.value === 'wifi') return 'Sync Reader';
  return volumes.find((v) => v.path === el.destination.value)?.kind === 'cloud' ? 'Sync Reader' : 'Sync drive';
};

function updateSyncButtons() {
  const changes = toSync().length + pendingRemovals.length;
  const idle = changes === 0;
  // The menu bar badge counts the same changes: items to send and to remove.
  window.epubDropTabs?.setPending(changes);
  for (const button of [el.send, el.sendBottom, el.syncLibrary]) {
    if (button) button.disabled = busy || idle;
  }
}

/** Where an item stands, in the words under its switch. */
function readerState(entry) {
  const on = entry.onReader !== false;
  if (on) return entry.deliveredAt ? 'On the reader' : 'Goes over at the next sync';
  return entry.deliveredAt ? 'Comes off at the next sync' : 'Not on the reader';
}

/**
 * The On reader switch, used on Library cards and in the queue on Add/Remove.
 * On: it goes to the reader at the next sync, or stays there. Off: it is not
 * sent, or comes off at the next sync. The app keeps its copy either way.
 */
function readerSwitch(entry) {
  const on = entry.onReader !== false;
  const wrap = document.createElement('div');
  wrap.className = 'reader-switch';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'switch';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(on));
  toggle.setAttribute('aria-label', `On reader: ${entry.title}`);
  toggle.title = on ? 'Switch off to keep it off the reader' : 'Switch on to put it on the reader';
  toggle.innerHTML = '<span class="switch-knob" aria-hidden="true"></span>';
  toggle.addEventListener('click', () => setOnReader(entry, !on, toggle));

  const label = document.createElement('span');
  label.className = 'switch-label';
  label.textContent = 'On reader';

  const note = document.createElement('span');
  note.className = 'switch-note';
  note.textContent = readerState(entry);

  wrap.append(toggle, label, note);
  return wrap;
}

async function setOnReader(entry, on, toggle) {
  toggle.disabled = true;
  toggle.setAttribute('aria-checked', String(on));
  try {
    const { pending } = await api('/api/outbox/on-reader', {
      method: 'POST',
      body: JSON.stringify({ id: entry.id, on }),
    });
    // Reloading the queue redraws both lists, the badge and the sync buttons.
    await loadRemovals(pending);
    await loadOutbox();
  } catch (err) {
    toggle.setAttribute('aria-checked', String(!on));
    toggle.disabled = false;
    setStatus(err.message, 'bad');
  }
}

async function send(trigger = el.send) {
  const selected = toSync();
  // A sync with nothing to upload still has work to do if files are queued to
  // come off the reader.
  if (busy || (!selected.length && !pendingRemovals.length)) return;

  setBusy(true, trigger, 'Syncing…');
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

    // Only failures are remembered: a sent item's switch note already says it
    // is on the reader, and a failure is what tells you which row to look at.
    for (const outcome of payload.results) {
      if (outcome.ok) sendFailures.delete(outcome.id);
      else sendFailures.set(outcome.id, outcome.error);
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
        `Sent ${okCount}. Failed: ${named}${more} — the reason is on each row in Add/Remove. Sync again to retry.`,
        'bad'
      );
    } else {
      setStatus(summarize(okCount, payload), 'ok');
    }

    // Whatever came off the reader is no longer queued to.
    await loadRemovals();

    saveConfig();
    checkDevice();
    // The queue owns delivered state; re-reading it redraws the Library too.
    await loadOutbox();
  } catch (err) {
    setStatus(err.message, 'bad');
  } finally {
    setBusy(false, trigger, syncLabel());
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
// Like a book, the spine is on the left. The default, "Corner curl", peels the
// page back from its top-right corner: a fold line sweeps across the page, the
// part beyond it lifts over and shows its back (the print faintly mirrored, as
// through thin paper), and the next page is revealed underneath with a shadow
// along the fold. Going back runs the same turn in reverse, laying the
// previous page back down over the current one. "Swing" is the older effect,
// the whole page swinging about the spine; "None" just changes the page.
//
// With the curl, the page can also be turned by hand: press near the right
// edge and drag left (or near the left edge and drag right), and the corner
// follows the pointer; let go past halfway and it completes, short of that it
// falls back. A tap in those edge zones turns the page.
//
// It is decoration only — the page has already changed underneath by the time
// a turn starts — so a fast reader holding an arrow key just cuts the previous
// turn short.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let turning = null;

const TURN_KEY = 'apub.pageTurn';
const TURN_STYLES = ['curl', 'swing', 'none'];
let turnStyle = 'curl';
try {
  const saved = localStorage.getItem(TURN_KEY);
  if (TURN_STYLES.includes(saved)) turnStyle = saved;
} catch {
  /* the default is fine */
}

function finishTurn() {
  if (!turning) return;
  turning.animation?.cancel();
  if (turning.frame) cancelAnimationFrame(turning.frame);
  clearTimeout(turning.timer);
  turning.leaf?.remove();
  for (const node of turning.extras || []) node.remove();
  turning.page.classList.remove('page-arriving');
  turning.page.style.transformOrigin = '';
  turning.page.style.clipPath = '';
  el.viewerFlow.classList.remove('turning');
  el.viewer.querySelector('.viewer-stage')?.classList.remove('is-turning');
  turning = null;
}

const stripIds = (node) => {
  node.removeAttribute('id');
  for (const child of node.querySelectorAll('[id]')) child.removeAttribute('id');
  return node;
};

/** Where the page sits within the stage, for laying copies exactly over it. */
function pageBox(page) {
  const stage = el.viewer.querySelector('.viewer-stage');
  const rect = page.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  return {
    stage,
    left: rect.left - stageRect.left + stage.scrollLeft,
    top: rect.top - stageRect.top + stage.scrollTop,
    width: rect.width,
    height: rect.height,
  };
}

/** A copy of the page as it looks now, laid exactly over it. */
function snapshot(page, box) {
  const leaf = stripIds(page.cloneNode(true));
  leaf.classList.add('page-leaf');
  leaf.setAttribute('aria-hidden', 'true');
  Object.assign(leaf.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  });
  box.stage.appendChild(leaf);
  return leaf;
}

async function turnPage(page, delta, change) {
  finishTurn();
  if (turnStyle === 'none' || reduceMotion.matches || page.hidden) return change();
  if (turnStyle === 'curl') {
    const live = await beginCurl(page, delta, change);
    if (live) live.play();
    return;
  }

  const box = pageBox(page);
  const leaf = snapshot(page, box);
  leaf.style.transformOrigin = 'left center';
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

// ---- the corner curl's geometry
//
// The page is W×H with its turning corner C at the top right, (W, 0). Wherever
// that corner has been pulled to, P, the fold is the line halfway between C
// and P, at right angles to CP. Everything on C's side of it has lifted and
// lies reflected across the fold; everything else is still flat.

/** The fold for a corner pulled to P: a point on it and the normal towards C. */
function foldFor(W, P) {
  const dx = W - P.x;
  const dy = 0 - P.y;
  const len = Math.hypot(dx, dy);
  return { M: { x: (W + P.x) / 2, y: P.y / 2 }, n: len ? { x: dx / len, y: dy / len } : { x: 1, y: 0 }, len };
}

/** The part of the page on one side of the fold, as a CSS polygon (side 1: lifted). */
function pageSide(W, H, M, n, side) {
  const corners = [[0, 0], [W, 0], [W, H], [0, H]];
  const dist = ([x, y]) => side * ((x - M.x) * n.x + (y - M.y) * n.y);
  const out = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const da = dist(a);
    const db = dist(b);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  if (out.length < 3) return 'polygon(0 0, 0 0, 0 0)';
  return `polygon(${out.map(([x, y]) => `${x.toFixed(2)}px ${y.toFixed(2)}px`).join(', ')})`;
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Where the corner is at a point in an automatic turn: it dips as it is pulled over. */
const curlPath = (W, H, e) => ({ x: W - 2 * W * e, y: H * 0.3 * Math.sin(Math.PI * e) });

/**
 * Start a curl: copy the page as it is, make the change underneath, and lay
 * out the layers. Resolves to controls for drawing it (play, follow, settle),
 * or null if another turn took over meanwhile.
 *
 * Forward, the copy of the old page is what lifts away, over the new page.
 * Back, the real page (now the previous one) is what comes down, over a copy
 * of the old one.
 */
async function beginCurl(page, delta, change) {
  finishTurn();
  const box = pageBox(page);
  const leaf = snapshot(page, box);
  const current = { leaf, page, extras: [], frame: 0, timer: 0 };
  turning = current;
  box.stage.classList.add('is-turning');

  el.viewerFlow.classList.add('turning');
  try {
    await change();
  } finally {
    el.viewerFlow.classList.remove('turning');
  }
  if (turning !== current) return null;

  const W = box.width;
  const H = box.height;
  let front = leaf;
  if (delta < 0) {
    leaf.classList.add('page-leaf-under');
    page.classList.add('page-arriving');
    front = page;
  }

  // The lifted part: the back of the page, its print faint and mirrored, with
  // light and shade across it from the fold.
  const place = (node) =>
    Object.assign(node.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${W}px`, height: `${H}px` });
  const flap = document.createElement('div');
  flap.className = 'page-flap';
  flap.setAttribute('aria-hidden', 'true');
  const face = document.createElement('div');
  face.className = 'page-flap-face';
  const print = stripIds(front.cloneNode(true));
  print.classList.remove('page-leaf', 'page-leaf-under', 'page-arriving');
  print.classList.add('page-flap-print');
  Object.assign(print.style, { left: '0', top: '0', width: `${W}px`, height: `${H}px`, clipPath: '' });
  const shine = document.createElement('div');
  shine.className = 'page-curl-strip page-flap-shine';
  face.append(print, shine);
  flap.appendChild(face);
  place(flap);

  // The shadow the lifted page casts on the page being revealed.
  const shade = document.createElement('div');
  shade.className = 'page-curl-shade';
  shade.setAttribute('aria-hidden', 'true');
  const shadeStrip = document.createElement('div');
  shadeStrip.className = 'page-curl-strip page-curl-shadow';
  shade.appendChild(shadeStrip);
  place(shade);

  box.stage.append(shade, flap);
  current.extras = [flap, shade];

  const diag = Math.hypot(W, H);
  for (const strip of [shine, shadeStrip]) Object.assign(strip.style, { width: `${diag * 1.5}px`, height: `${diag * 3}px` });

  /** Draw with the corner at P; fade is the lifted page's opacity. */
  function draw(P, fade = 1) {
    const x = Math.max(-W, Math.min(W, P.x));
    const y = Math.max(-H * 0.25, Math.min(H, P.y));
    const { M, n, len } = foldFor(W, { x, y });
    if (len < 0.5) {
      front.style.clipPath = '';
      flap.style.visibility = shade.style.visibility = 'hidden';
      return;
    }
    flap.style.visibility = shade.style.visibility = '';
    front.style.clipPath = pageSide(W, H, M, n, -1);
    const lifted = pageSide(W, H, M, n, 1);
    face.style.clipPath = lifted;
    shade.style.clipPath = lifted;
    // Reflect the lifted part across the fold.
    const k = 2 * (M.x * n.x + M.y * n.y);
    flap.style.transform = `matrix(${1 - 2 * n.x * n.x}, ${-2 * n.x * n.y}, ${-2 * n.x * n.y}, ${1 - 2 * n.y * n.y}, ${k * n.x}, ${k * n.y})`;
    flap.style.opacity = String(fade);
    // Both strips start on the fold and run towards the corner.
    const angle = (Math.atan2(n.y, n.x) * 180) / Math.PI;
    for (const strip of [shine, shadeStrip]) {
      strip.style.left = `${M.x}px`;
      strip.style.top = `${M.y - diag * 1.5}px`;
      strip.style.transform = `rotate(${angle}deg)`;
    }
    // The shadow is deepest mid-turn, when the page stands highest.
    shadeStrip.style.opacity = String(0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, len / (2 * W))));
  }

  /** Run P along a path over ms, then call done. Time-based, and safe in a background tab. */
  function run(pointAt, ms, done) {
    const start = performance.now();
    let finished = false;
    const end = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(current.frame);
      clearTimeout(current.timer);
      if (turning === current) done();
    };
    const frame = (now) => {
      if (turning !== current) return;
      const t = Math.min(1, (now - start) / ms);
      const { P, fade } = pointAt(t);
      draw(P, fade);
      if (t < 1) current.frame = requestAnimationFrame(frame);
      else end();
    };
    current.frame = requestAnimationFrame(frame);
    current.timer = setTimeout(end, ms + 250);
  }

  // The lifted page fades only at the very end, as it settles to the left.
  const fadeAt = (e) => (e > 0.88 ? Math.max(0, (1 - e) / 0.12) : 1);
  const startAt = delta > 0 ? 0 : 1;
  draw(curlPath(W, H, easeInOut(startAt)), fadeAt(startAt));

  let last = delta > 0 ? { x: W, y: 0 } : { x: -W, y: 0 };
  return {
    W,
    H,
    /** An automatic turn, all the way. */
    play() {
      run((t) => {
        const e = easeInOut(delta > 0 ? t : 1 - t);
        return { P: curlPath(W, H, e), fade: fadeAt(e) };
      }, 700, finishTurn);
    },
    /** By hand: put the corner at P. */
    follow(P) {
      last = P;
      draw(P, 1);
    },
    /** By hand, let go: finish the turn, or fall back and undo it. */
    settle(complete, undo) {
      const from = last;
      // Forward completes with the corner at the far left; back completes flat.
      const forwardEnd = delta > 0 ? complete : !complete;
      const to = forwardEnd ? { x: -W, y: 0 } : { x: W, y: 0 };
      const distance = Math.hypot(to.x - from.x, to.y - from.y) / (2 * W);
      run((t) => {
        const e = 1 - Math.pow(1 - t, 3);
        const P = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
        const fade = forwardEnd ? (t > 0.8 ? (1 - t) / 0.2 : 1) : 1;
        return { P, fade };
      }, Math.max(160, 420 * distance), () => {
        if (!complete) undo();
        finishTurn();
      });
    },
  };
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

/** The page element being read: the image of a fixed-layout page, or the text frame. */
function currentPage() {
  if (viewing?.kind === 'images') return el.viewerImage;
  if (viewing?.kind === 'text' && readerMode === 'page') return el.viewerText;
  return null;
}

/**
 * What one step forward or back does, crossing chapter boundaries in paged
 * mode, as a function to call; null at either end of the book. Its opposite
 * step exactly undoes it, which is how a turn dragged by hand falls back.
 */
function pageChange(delta) {
  if (viewing?.kind === 'images') {
    const target = viewingPage + delta;
    if (target < 1 || target > viewing.pageCount) return null;
    return () => {
      viewingPage = target;
      showPage();
      return imageSettled(el.viewerImage);
    };
  }
  // Scroll view has no pages to step through; Prev/Next are disabled there.
  if (viewing?.kind !== 'text' || readerMode !== 'page') return null;

  const next = chapterPage + delta;
  if (next >= 1 && next <= chapterPages) {
    return () => {
      chapterPage = next;
      applyPageOffset();
    };
  }
  // Off the end of the chapter: move to the neighbour, entering from the side
  // the reader is travelling.
  const total = viewing.chapters.length;
  if (delta > 0 && viewingPage < total) {
    return () => {
      viewingPage += 1;
      return showChapter('start');
    };
  }
  if (delta < 0 && viewingPage > 1) {
    return () => {
      viewingPage -= 1;
      return showChapter('end');
    };
  }
  return null;
}

/** One step forward or back. */
function step(delta) {
  const page = currentPage();
  const change = pageChange(delta);
  if (page && change) turnPage(page, delta, change);
}

// Turning by hand: press near the right edge of the page and drag left to
// turn forward, or near the left edge and drag right to turn back. A tap in
// those edges turns the page too. Only with the corner curl.
(function pageDrag() {
  const stage = el.viewer.querySelector('.viewer-stage');
  const EDGE = 0.22;
  let drag = null;

  /** Which way a press at this point would turn, or 0. */
  function edgeAt(event) {
    const page = currentPage();
    if (!page || page.hidden || turnStyle !== 'curl' || reduceMotion.matches) return null;
    if (!page.contains(event.target) || event.target.closest('a, button, input, select, textarea')) return null;
    const rect = page.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const delta = x > 1 - EDGE ? 1 : x < EDGE ? -1 : 0;
    return delta ? { page, delta, rect } : null;
  }

  stage.addEventListener('pointermove', (event) => {
    if (!drag) {
      // A hint that the edges can be taken hold of.
      const edge = event.pointerType === 'mouse' ? edgeAt(event) : null;
      stage.style.cursor = edge ? 'grab' : '';
      return;
    }
    if (event.pointerId !== drag.id) return;
    drag.dx = event.clientX - drag.x;
    drag.dy = event.clientY - drag.y;
    if (!drag.live) {
      // Not a drag until it has moved a little; a tap stays a tap.
      if (Math.hypot(drag.dx, drag.dy) < 6) return;
      const change = pageChange(drag.delta);
      if (!change) {
        drag = null;
        return;
      }
      stage.setPointerCapture?.(event.pointerId);
      stage.style.cursor = 'grabbing';
      drag.live = beginCurl(drag.page, drag.delta, change);
    }
    drag.live.then((live) => live && drag && live.follow(cornerFor(drag, live)));
  });

  /** Where the corner is for the pointer's travel so far. */
  function cornerFor(d, live) {
    // Forward, the corner follows the pointer; back, it comes from off the
    // left of the page, so it travels twice as far as the pointer.
    return d.delta > 0
      ? { x: live.W + d.dx, y: d.dy }
      : { x: -live.W + 2 * d.dx, y: d.dy };
  }

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return;
    const edge = edgeAt(event);
    if (!edge) return;
    drag = { ...edge, id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0, live: null };
  });

  function release(event, cancelled) {
    if (!drag || event.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    stage.style.cursor = '';
    if (!d.live) {
      // A tap at the edge turns the page.
      if (!cancelled) step(d.delta);
      return;
    }
    d.live.then((live) => {
      if (!live) return;
      const corner = cornerFor(d, live);
      // Past halfway, it goes over; short of it, it falls back.
      const complete = !cancelled && (d.delta > 0 ? corner.x < live.W * 0.5 : corner.x > -live.W * 0.5);
      live.settle(complete, () => pageChange(-d.delta)?.());
    });
  }
  stage.addEventListener('pointerup', (event) => release(event, false));
  stage.addEventListener('pointercancel', (event) => release(event, true));
})();

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

// How pages turn: kept per browser, like the type settings.
el.typeTurn.value = turnStyle;
el.typeTurn.addEventListener('change', () => {
  turnStyle = TURN_STYLES.includes(el.typeTurn.value) ? el.typeTurn.value : 'curl';
  finishTurn();
  try {
    localStorage.setItem(TURN_KEY, turnStyle);
  } catch {
    /* applies for now even if it cannot be kept */
  }
});

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
      `${n} file${n === 1 ? '' : 's'} will be removed from the reader on the next sync: ` +
      `${names.join(', ')}${n > names.length ? `, and ${n - names.length} more` : ''}.`;
  }
  // A sync that only deletes is still worth doing, so Send stays available.
  updateSyncButtons();
}

async function loadOutbox() {
  try {
    const { items } = await api('/api/outbox');
    results = items.map((entry) => ({
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
      onReader: entry.onReader !== false,
      sendError: entry.deliveredAt ? undefined : sendFailures.get(entry.id),
    }));
    renderResults();

    // Two other places depend on the queue: the badge on the tab bar, and the
    // Library tab's list of what has been sent.
    updateSyncButtons();
    window.epubDropRead?.load();
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
  // Hosted, there are no drives or reader to look for.
  if (hosted) return;
  const previous = el.destination.value;
  try {
    ({ volumes } = await api('/api/volumes'));
  } catch {
    volumes = [];
  }

  const options = [new Option('Wi-Fi', 'wifi')];
  for (const volume of volumes) {
    const label = volume.kind === 'cloud'
      ? `${volume.name} — synced folder${volume.writable ? '' : ' (no access)'}`
      : volume.likely
        ? `${volume.name} — looks like the reader's card`
        : `${volume.name}${volume.writable ? '' : ' (read-only)'}`;
    options.push(new Option(label, volume.path));
  }
  el.destination.replaceChildren(...options);

  // Keep the current choice, or the one saved last time, if it is still there.
  const has = (value) => [...el.destination.options].some((o) => o.value === value);
  el.destination.value = has(previous) && previous !== 'wifi'
    ? previous
    : has(savedDestination) ? savedDestination : 'wifi';
  syncDestination();
}

function syncDestination() {
  const viaVolume = el.destination.value !== 'wifi';
  savedDestination = el.destination.value;
  el.hostField.hidden = viaVolume;
  el.find.hidden = viaVolume;
  el.useHotspot.hidden = viaVolume;
  for (const button of [el.send, el.sendBottom, el.syncLibrary]) if (button) button.textContent = syncLabel();

  if (viaVolume) {
    const volume = volumes.find((v) => v.path === el.destination.value);
    if (volume?.kind === 'cloud') {
      setDevice(
        volume.writable ? 'ok' : 'off',
        volume.writable
          ? `Syncing through ${volume.name}: files go to “${volume.path}”, and a reader signed in to the same account picks them up`
          : `${volume.name} can't be written: ${volume.problem || 'no access'}. Allow it in System Settings → Privacy & Security → Files & Folders.`
      );
    } else {
      setDevice('ok', volume ? `Copying to ${volume.name}${volume.likely ? '' : ' (unverified)'}` : 'Drive selected');
    }
  } else {
    checkDevice();
  }
}

// ---------------------------------------------------------------- device

async function checkDevice() {
  if (hosted) return;
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

async function loadConfig() {
  try {
    const config = await api('/api/config');
    hosted = Boolean(config.hosted);
    document.documentElement.classList.toggle('hosted', hosted);
    el.host.value = config.host || 'crosspoint.local';
    savedDestination = config.destination || 'wifi';
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
        destination: el.destination.value || 'wifi',
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
  updateSyncButtons();
  if (state) {
    button.disabled = true;
    button.innerHTML = `<span class="spin"></span>${label}`;
  } else {
    button.textContent = label;
  }
}

function setStatus(text, kind = '') {
  for (const line of [el.sendStatus, el.syncLibraryStatus]) {
    if (!line) continue;
    line.textContent = text;
    line.className = `status ${kind}`;
  }
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
el.convert.addEventListener('click', convert);
el.send.addEventListener('click', () => send(el.send));
el.syncLibrary?.addEventListener('click', () => send(el.syncLibrary));
el.sendBottom?.addEventListener('click', () => {
  send(el.sendBottom);
  // The result is reported with the controls at the top of the list.
  el.sendStatus.scrollIntoView({ block: 'center', behavior: 'smooth' });
});
el.find.addEventListener('click', findDevice);
el.useHotspot.addEventListener('click', async () => {
  el.host.value = '192.168.4.1';
  await saveConfig();
  await checkDevice();
});
el.host.addEventListener('change', () => {
  saveConfig();
  checkDevice();
});
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
  saveConfig();
});

loadConfig().then(async () => {
  // The queue is local state, so show it immediately. Chaining it behind the
  // device probe meant a six-second wait whenever the reader was switched off —
  // exactly when you most want to see what's waiting to go.
  loadOutbox();
  loadRemovals();
  await loadVolumes(); // also picks the destination, which probes the reader
});
