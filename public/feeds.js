'use strict';

// RSS feeds: add, refresh, remove.
//
// A refresh fetches the feed, builds one EPUB for it, delivers that to whatever
// destination the Send controls are set to, and removes the edition the previous
// refresh left behind. Feeds always go to their own folder on the device, so the
// cleanup can't touch anything else.

(function () {
  const $ = (id) => document.getElementById(id);

  const el = {
    section: $('feeds-section'),
    url: $('feed-url'),
    add: $('add-feed'),
    list: $('feeds'),
    folder: $('feeds-folder'),
    status: $('feeds-status'),
    refreshAll: $('refresh-feeds'),
    discoverOpen: $('discover-open'),
    discover: $('discover-section'),
    discoverGroups: $('discover-groups'),
    discoverList: $('discover-list'),
    discoverStatus: $('discover-status'),
    discoverRecheck: $('discover-recheck'),
    discoverClose: $('discover-close'),
    banner: $('feeds-refreshing'),
  };


  let feeds = [];
  let folder = '/A-pub Feeds';
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

  function setStatus(text, kind = '') {
    el.status.textContent = text;
    el.status.className = `status ${kind}`;
  }

  function relative(iso) {
    if (!iso) return 'never refreshed';
    const then = new Date(iso);
    const mins = Math.round((Date.now() - then.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
    return then.toLocaleDateString();
  }

  function render() {
    el.folder.textContent = feeds.length ? `· ${folder}` : '';
    el.refreshAll.disabled = working || feeds.length === 0;

    // Following marks in Find feeds track adds and removals made here.
    if (found.length) renderDiscover();

    if (!feeds.length) {
      el.list.replaceChildren();
      return;
    }

    el.list.replaceChildren(
      ...feeds.map((feed) => {
        const li = document.createElement('li');
        li.className = feed.lastError ? 'item bad' : 'item';

        const bodyEl = document.createElement('div');
        bodyEl.className = 'item-body';

        const title = document.createElement('div');
        title.className = 'item-title';
        title.textContent = feed.title || feed.url;
        bodyEl.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'item-meta';
        const bits = [relative(feed.lastRefreshedAt)];
        if (feed.lastItemCount) bits.push(`${feed.lastItemCount} item${feed.lastItemCount === 1 ? '' : 's'}`);
        if (feed.lastFilename) bits.push(`on device: ${feed.lastFilename}`);
        else bits.push('not on device yet');
        meta.textContent = bits.join(' · ');
        bodyEl.appendChild(meta);

        const opts = document.createElement('div');
        opts.className = 'feed-opts';

        const limit = document.createElement('label');
        const limitBox = document.createElement('input');
        limitBox.type = 'number';
        limitBox.min = '1';
        limitBox.max = '50';
        limitBox.value = String(feed.limit || 15);
        limitBox.title = 'How many of the newest items to include';
        limitBox.addEventListener('change', () => save(feed.id, { limit: Number(limitBox.value) }));
        limit.append(document.createTextNode('newest '), limitBox);

        opts.append(limit);
        bodyEl.appendChild(opts);

        if (feed.lastError) {
          const err = document.createElement('div');
          err.className = 'item-err';
          err.textContent = feed.lastError;
          bodyEl.appendChild(err);
        }
        if (feed.steps?.length) {
          const steps = document.createElement('div');
          steps.className = 'feed-steps';
          steps.textContent = feed.steps.join(' → ');
          bodyEl.appendChild(steps);
        }

        const actions = document.createElement('div');
        actions.className = 'feed-item-actions';

        const refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.className = 'secondary';
        refresh.textContent = 'Refresh';
        refresh.disabled = working;
        refresh.addEventListener('click', () => refreshFeeds(feed.id));

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove';
        remove.title = 'Remove feed';
        remove.textContent = '×';
        remove.addEventListener('click', () => removeFeed(feed));

        actions.append(refresh, remove);
        li.append(bodyEl, actions);
        return li;
      })
    );
  }

  async function load() {
    try {
      const data = await api('/api/feeds');
      // Keep any step lists from this session's refreshes.
      const steps = new Map(feeds.map((f) => [f.id, f.steps]));
      feeds = data.feeds.map((f) => ({ ...f, steps: steps.get(f.id) }));
      folder = data.folder || folder;
      render();
    } catch (err) {
      setStatus(err.message, 'bad');
    }
  }

  // ---- a new feed's first edition, built straight after adding it
  //
  // One at a time (adding several feeds in a row queues them), outside the
  // Refresh all lock, and announced so the Library can show "Getting its
  // first edition…" in the meantime.
  const building = new Set();
  let buildChain = Promise.resolve();
  const announce = () => window.dispatchEvent(new CustomEvent('apub:feeds-building', { detail: { ids: [...building] } }));

  function buildFirstEdition(feed) {
    building.add(feed.id);
    announce();
    buildChain = buildChain.then(async () => {
      try {
        const data = await api('/api/feeds/refresh', { method: 'POST', body: JSON.stringify({ id: feed.id }) });
        const result = data.results?.[0];
        if (result && !result.ok) setStatus(`${feed.title || feed.url}: ${result.error}`, 'bad');
        else setStatus(`${feed.title || feed.url} is in your Library.`, 'ok');
        feeds = data.feeds || feeds;
        render();
      } catch (err) {
        setStatus(`${feed.title || feed.url}: ${err.message}`, 'bad');
      } finally {
        building.delete(feed.id);
        announce();
        window.epubDropRead?.load?.();
        window.epubDrop?.reloadQueue?.();
      }
    });
  }

  async function addFeed() {
    const url = el.url.value.trim();
    if (!url) return;

    el.add.disabled = true;
    setStatus('Checking feed…');
    try {
      const data = await api('/api/feeds/add', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      el.url.value = '';
      await load();
      if (!data.added) setStatus('That feed was already saved.');
      else if (data.warning) setStatus(`Saved, but: ${data.warning}`, 'bad');
      else {
        setStatus(`Added ${data.feed.title} — getting its first edition…`, 'ok');
        buildFirstEdition(data.feed);
      }
    } catch (err) {
      setStatus(err.message, 'bad');
    } finally {
      el.add.disabled = false;
    }
  }

  async function save(id, patch) {
    try {
      await api('/api/feeds/update', { method: 'POST', body: JSON.stringify({ id, ...patch }) });
      await load();
    } catch (err) {
      setStatus(err.message, 'bad');
    }
  }

  async function removeFeed(feed) {
    const label = feed.title || feed.url;
    // The EPUB already on the device is left alone; say so rather than implying
    // this cleans up the reader.
    const note = feed.lastFilename
      ? `\n\nIts latest edition stays in your Library, and on the reader if it is there. ` +
        'Switch that edition off in the Library and Sync Reader to take it off the reader.'
      : '';
    if (!confirm(`Stop following "${label}"?${note}`)) return;
    try {
      await api('/api/feeds/remove', { method: 'POST', body: JSON.stringify({ id: feed.id }) });
      await load();
      setStatus(`Removed ${label}.`);
    } catch (err) {
      setStatus(err.message, 'bad');
    }
  }

  async function refreshFeeds(id) {
    if (working) return;
    working = true;
    el.banner.hidden = false;
    render();

    const many = !id;
    setStatus(many ? 'Refreshing all feeds — this fetches articles, so give it a moment…' : 'Refreshing…');

    try {
      // No destination: a refresh only builds and queues, so it works with the
      // reader switched off, and the queue is pushed later with Sync Reader.
      const data = await api('/api/feeds/refresh', {
        method: 'POST',
        body: JSON.stringify(id ? { id } : {}),
      });

      folder = data.folder || folder;
      const byId = new Map(data.results.filter((r) => r.id).map((r) => [r.id, r]));
      feeds = data.feeds.map((f) => {
        // Refresh results are keyed by job id, not feed id, so match on title.
        const result = data.results.find((r) => r.title === f.title) || byId.get(f.id);
        return { ...f, steps: result?.steps };
      });
      render();

      const built = data.results.filter((r) => r.ok);
      const failed = data.results.filter((r) => !r.ok);

      if (failed.length) {
        setStatus(`${built.length} queued, ${failed.length} failed: ${failed.map((x) => x.error).join('; ')}`, 'bad');
      } else {
        setStatus(
          `Queued ${built.length} feed${built.length === 1 ? '' : 's'} for ${folder} — hit Sync Reader when connected.`,
          'ok'
        );
      }

      // The queue is shared with dropped files, so refresh it there too.
      window.epubDrop?.reloadQueue?.();
    } catch (err) {
      setStatus(err.message, 'bad');
    } finally {
      working = false;
      el.banner.hidden = true;
      render();
      // The editions just changed, so the Library's "new" counts are stale.
      window.epubDropRead?.checkForNew?.();
    }
  }

  // ------------------------------------------------------------ find feeds
  //
  // The list is chosen on the server and checked live there; this only shows
  // what answered, and adds through the same route as a pasted URL.

  let found = [];
  let topic = 'All';

  // Same shape as the server's normalizeUrl, enough to match saved feeds.
  const sameFeed = (url) => String(url || '').trim().replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
  const isFollowing = (feed) => feeds.some((f) => sameFeed(f.url) === sameFeed(feed.url));

  function discoverStatus(text, kind = '') {
    el.discoverStatus.textContent = text;
    el.discoverStatus.className = `status ${kind}`;
  }

  function renderDiscover() {
    const topics = ['All', ...found.map((g) => g.group)];
    el.discoverGroups.replaceChildren(
      ...topics.map((name) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.textContent = name;
        chip.setAttribute('aria-pressed', String(name === topic));
        chip.addEventListener('click', () => {
          topic = name;
          renderDiscover();
        });
        return chip;
      })
    );

    const shown = found
      .filter((g) => topic === 'All' || g.group === topic)
      .flatMap((g) => g.feeds.filter((f) => f.ok));

    el.discoverList.replaceChildren(
      ...shown.map((feed) => {
        const li = document.createElement('li');
        li.className = 'item';

        const bodyEl = document.createElement('div');
        bodyEl.className = 'item-body';
        const title = document.createElement('div');
        title.className = 'item-title';
        title.textContent = feed.name;
        const meta = document.createElement('div');
        meta.className = 'item-meta';
        meta.textContent = feed.about;
        bodyEl.append(title, meta);
        if (feed.latest?.title) {
          const latest = document.createElement('div');
          latest.className = 'discover-latest';
          latest.textContent = `Latest: ${feed.latest.title}`;
          bodyEl.appendChild(latest);
        }

        const side = document.createElement('div');
        side.className = 'item-actions-col';
        if (isFollowing(feed)) {
          const done = document.createElement('span');
          done.className = 'following';
          done.textContent = '✓ Following';
          side.appendChild(done);
        } else {
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'secondary';
          add.textContent = 'Add';
          add.addEventListener('click', () => addFound(feed, add));
          side.appendChild(add);
        }

        li.append(bodyEl, side);
        return li;
      })
    );
  }

  async function findFeeds(fresh = false) {
    el.discover.hidden = false;
    el.discoverOpen.setAttribute('aria-expanded', 'true');
    el.discoverRecheck.disabled = true;
    discoverStatus('Checking feeds from trusted publishers…');
    if (!found.length) el.discoverList.replaceChildren();
    try {
      const data = await api(`/api/feeds/discover${fresh ? '?fresh=1' : ''}`);
      found = data.groups;
      renderDiscover();
      const all = found.flatMap((g) => g.feeds);
      const working = all.filter((f) => f.ok).length;
      const down = all.length - working;
      discoverStatus(
        `${working} feed${working === 1 ? '' : 's'} available` +
          (down ? ` · ${down} not responding right now, so hidden` : '') + '.'
      );
    } catch (err) {
      discoverStatus(err.message, 'bad');
    } finally {
      el.discoverRecheck.disabled = false;
    }
  }

  async function addFound(feed, button) {
    button.disabled = true;
    button.textContent = 'Adding…';
    try {
      const data = await api('/api/feeds/add', { method: 'POST', body: JSON.stringify({ url: feed.url }) });
      await load();
      discoverStatus(data.added ? `Added ${feed.name} — getting its first edition…` : `${feed.name} was already saved.`, 'ok');
      if (data.added && !data.warning) buildFirstEdition(data.feed);
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Add';
      discoverStatus(err.message, 'bad');
    }
  }

  el.discoverOpen.addEventListener('click', () => {
    if (el.discover.hidden) findFeeds();
    else el.discoverClose.click();
  });
  el.discoverRecheck.addEventListener('click', () => findFeeds(true));
  el.discoverClose.addEventListener('click', () => {
    el.discover.hidden = true;
    el.discoverOpen.setAttribute('aria-expanded', 'false');
    el.discoverOpen.focus();
  });

  el.add.addEventListener('click', addFeed);
  el.url.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addFeed();
  });
  el.refreshAll.addEventListener('click', () => refreshFeeds());

  // The Library's Refresh feeds button fetches the latest editions. A refresh
  // already running is left to finish rather than started twice.
  window.epubDropFeeds = {
    // Says whether a refresh started, so a caller with nothing to refresh can
    // fall back to just reloading its list.
    refreshAll: () => {
      if (!feeds.length || working) return false;
      refreshFeeds();
      return true;
    },
    /** Feeds whose first edition is being built right now. */
    building: () => [...building],
    /** Build a feed's first edition (the Library asks for ones never built). */
    buildFirstEdition: (feed) => {
      if (!building.has(feed.id)) buildFirstEdition(feed);
    },
  };

  // Feeds refresh only when asked (Refresh feeds in the Library, Refresh all
  // here); the Library checks quietly for new articles in the meantime.
  load();
})();
