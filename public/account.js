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

  function showReaderKey(readerKey) {
    const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    $('reader-state').textContent = readerKey
      ? `Reader access is on (key made ${when(readerKey.createdAt)}${readerKey.usedAt ? `, last used ${when(readerKey.usedAt)}` : ', not used yet'}).`
      : 'Reader access is off: no reader key yet.';
    $('reader-make').textContent = readerKey ? 'Make a new key (the old one stops working)' : 'Make a reader key';
    $('reader-remove').hidden = !readerKey;
  }

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
