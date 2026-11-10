'use strict';

// Your account: who you are signed in as, changing your password, and signing
// out here or everywhere.

(function () {
  const $ = (id) => document.getElementById(id);

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.signin) location.replace('/signin?next=/account');
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const show = (el, text, kind = '') => {
    el.textContent = text;
    el.className = `status ${kind}`;
  };

  async function load() {
    const { user, sessions, catalog } = await api('/api/auth/me');
    if (!user) return location.replace('/signin?next=/account');
    $('account-who').textContent = `Signed in as ${user.username}${user.email ? ` (${user.email})` : ''}${user.role === 'admin' ? ' · administrator' : ''}.`;
    $('account-adminset').hidden = !user.adminSetPassword;
    $('admin-link').hidden = user.role !== 'admin';
    $('reader-catalog').textContent = catalog || '';
    $('reader-username').textContent = user.username;
    showReaderKey(user.readerKey);
    $('account-sessions').textContent =
      sessions > 1 ? `You are signed in on ${sessions} browsers or devices.` : 'You are signed in on this browser only.';
  }

  const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  /** "just now", "3 minutes ago", or the date. */
  function ago(iso) {
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 45) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)} minute${Math.round(seconds / 60) === 1 ? '' : 's'} ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} hour${Math.round(seconds / 3600) === 1 ? '' : 's'} ago`;
    return when(iso);
  }

  function showReaderKey(readerKey) {
    $('reader-state').textContent = readerKey
      ? `Reader access is on (key made ${when(readerKey.createdAt)}).`
      : 'Reader access is off: no reader key yet.';
    $('reader-make').textContent = readerKey ? 'Make a new key (the old one stops working)' : 'Make a reader key';
    $('reader-remove').hidden = !readerKey;
    $('reader-activity').hidden = !readerKey;
    if (!readerKey) return;
    // Has the reader checked in? What it last did, and its last failed try.
    $('reader-last').textContent = readerKey.usedAt
      ? `${ago(readerKey.usedAt)}: ${readerKey.lastActivity || 'signed in'}`
      : 'not yet. Open the catalog on the reader; this updates by itself.';
    $('reader-dot').classList.toggle('is-ok', Boolean(readerKey.usedAt));
    const failedSince = readerKey.failedAt && (!readerKey.usedAt || readerKey.failedAt > readerKey.usedAt);
    $('reader-failed-row').hidden = !failedSince;
    if (failedSince) $('reader-failed').textContent = `${ago(readerKey.failedAt)}: ${readerKey.lastFailure}`;
  }

  // While this page is open (and showing), check every few seconds whether the
  // reader has been in touch, so setting it up can be watched as it happens.
  setInterval(async () => {
    if (document.hidden || $('reader-activity').hidden) return;
    try {
      const { user } = await api('/api/auth/me');
      if (user) showReaderKey(user.readerKey);
    } catch {
      /* try again next time */
    }
  }, 5000);

  $('reader-make').addEventListener('click', async () => {
    try {
      const { key } = await api('/api/auth/reader-key', {});
      $('reader-key').textContent = key;
      $('reader-key-box').hidden = false;
      $('reader-key-note').hidden = false;
      show($('reader-status'), '', '');
      await load();
    } catch (err) {
      show($('reader-status'), err.message, 'bad');
    }
  });

  $('reader-remove').addEventListener('click', async () => {
    try {
      await api('/api/auth/reader-key/remove', {});
      $('reader-key-box').hidden = true;
      $('reader-key-note').hidden = true;
      show($('reader-status'), 'Reader access is off. Readers using the old key can no longer get in.', 'ok');
      await load();
    } catch (err) {
      show($('reader-status'), err.message, 'bad');
    }
  });

  $('password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const current = $('password-current').value;
    const next = $('password-next').value;
    if (next !== $('password-again').value) return show($('password-status'), 'The two new passwords are not the same.', 'bad');
    $('password-submit').disabled = true;
    try {
      const { signedOut } = await api('/api/auth/password', { current, next });
      event.target.reset();
      show(
        $('password-status'),
        `Your password is changed.${signedOut ? ` ${signedOut} other browser${signedOut === 1 ? ' was' : 's were'} signed out.` : ''}`,
        'ok'
      );
      await load();
    } catch (err) {
      show($('password-status'), err.message, 'bad');
    } finally {
      $('password-submit').disabled = false;
    }
  });

  $('signout').addEventListener('click', async () => {
    await api('/api/auth/signout', {}).catch(() => {});
    location.replace('/signin');
  });

  $('signout-all').addEventListener('click', async () => {
    try {
      await api('/api/auth/signout-everywhere', {});
      location.replace('/signin');
    } catch (err) {
      show($('signout-status'), err.message, 'bad');
    }
  });

  load().catch((err) => show($('password-status'), err.message, 'bad'));
})();
