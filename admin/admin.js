'use strict';

// Admin · Users: list accounts, add one (with a typed or readable password),
// reset or look up an admin-set password, change role, switch off or on, sign
// out everywhere, and delete. Every call is checked by the server again.

(function () {
  const $ = (id) => document.getElementById(id);
  let me = '';
  let lookup = false;

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.signin) location.replace('/signin?next=/admin');
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const show = (el, text, kind = '') => {
    el.textContent = text;
    el.className = `status ${kind}`;
  };

  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');

  function showPassword(title, lead, password) {
    $('password-title').textContent = title;
    $('password-lead').textContent = lead;
    $('password-value').textContent = password;
    $('password-copy').textContent = 'Copy';
    $('password-dialog').showModal();
  }
  $('password-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('password-value').textContent);
      $('password-copy').textContent = 'Copied';
    } catch {
      $('password-copy').textContent = 'Select and copy it';
    }
  });
  $('password-close').addEventListener('click', () => $('password-dialog').close());

  function button(label, onClick, className = 'link') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await onClick();
      } catch (err) {
        show($('users-status'), err.message, 'bad');
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  function cell(text, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    if (text instanceof Node) td.appendChild(text);
    else td.textContent = text;
    return td;
  }

  function row(user) {
    const tr = document.createElement('tr');
    if (user.status === 'disabled') tr.className = 'is-off';
    const who = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = user.username;
    who.appendChild(name);
    if (user.id === me) who.append(' (you)');
    if (user.email) {
      const mail = document.createElement('div');
      mail.className = 'muted';
      mail.textContent = user.email;
      who.appendChild(mail);
    }
    tr.appendChild(cell(who));
    tr.appendChild(cell(user.role === 'admin' ? 'Administrator' : 'User'));
    tr.appendChild(cell(user.status === 'active' ? 'Active' : user.status === 'pending' ? 'Waiting for approval' : 'Switched off'));
    tr.appendChild(cell(user.adminSetPassword ? 'Set by an admin' : 'Their own'));
    tr.appendChild(cell(when(user.lastSignInAt), 'muted'));

    const actions = document.createElement('div');
    actions.className = 'admin-actions';
    actions.appendChild(
      button('Reset password', async () => {
        const { password } = await api('/api/admin/users/reset', { id: user.id });
        await load();
        showPassword(`New password for ${user.username}`, 'They are signed out everywhere. Give them this password; they can change it in Your account.', password);
      })
    );
    if (lookup && user.adminSetPassword) {
      actions.appendChild(
        button('Look up password', async () => {
          const { password, reason } = await api('/api/admin/users/lookup', { id: user.id });
          if (password) showPassword(`Password for ${user.username}`, 'Set by an administrator. Once they choose their own, it can no longer be looked up.', password);
          else show($('users-status'), reason, 'bad');
        })
      );
    }
    if (user.id !== me) {
      actions.appendChild(
        button(user.role === 'admin' ? 'Make user' : 'Make administrator', async () => {
          await api('/api/admin/users/update', { id: user.id, role: user.role === 'admin' ? 'user' : 'admin' });
          await load();
        })
      );
      if (user.status === 'pending') {
        actions.appendChild(button('Approve', async () => {
          await api('/api/admin/users/update', { id: user.id, status: 'active' });
          await load();
        }));
      }
      actions.appendChild(
        button(user.status === 'disabled' ? 'Switch on' : 'Switch off', async () => {
          await api('/api/admin/users/update', { id: user.id, status: user.status === 'disabled' ? 'active' : 'disabled' });
          await load();
        })
      );
      actions.appendChild(
        button('Sign out everywhere', async () => {
          const { count } = await api('/api/admin/users/signout', { id: user.id });
          show($('users-status'), `${user.username} was signed out of ${count} browser${count === 1 ? '' : 's'}.`, 'ok');
        })
      );
      actions.appendChild(button('Delete…', async () => askDelete(user), 'link danger-link'));
    }
    tr.appendChild(cell(actions));
    return tr;
  }

  let deleting = null;
  function askDelete(user) {
    deleting = user;
    $('delete-body').textContent = `This deletes ${user.username}'s account and their whole library: everything they built, their feeds and their drafts. It cannot be undone.`;
    $('delete-confirm').value = '';
    $('delete-go').disabled = true;
    $('delete-dialog').showModal();
    $('delete-confirm').focus();
  }
  $('delete-confirm').addEventListener('input', () => {
    $('delete-go').disabled = $('delete-confirm').value.trim().toLowerCase() !== deleting?.username.toLowerCase();
  });
  $('delete-cancel').addEventListener('click', () => $('delete-dialog').close());
  $('delete-go').addEventListener('click', async () => {
    try {
      await api('/api/admin/users/delete', { id: deleting.id, confirm: $('delete-confirm').value });
      $('delete-dialog').close();
      show($('users-status'), `${deleting.username}'s account was deleted.`, 'ok');
      await load();
    } catch (err) {
      $('delete-dialog').close();
      show($('users-status'), err.message, 'bad');
    }
  });

  async function load() {
    const data = await api('/api/admin/users');
    me = data.me;
    lookup = data.lookup;
    $('users-count').textContent = `· ${data.users.length}`;
    $('lookup-note').textContent = lookup
      ? 'Passwords an admin set can be looked up until the person chooses their own.'
      : 'Password lookup is off (PASSWORD_LOOKUP_KEY is not set): a password is shown once, when it is made.';
    $('users').replaceChildren(...data.users.map(row));
  }

  $('create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('create-submit').disabled = true;
    try {
      const { user, password } = await api('/api/admin/users', {
        username: $('create-username').value.trim(),
        email: $('create-email').value.trim(),
        role: $('create-role').value,
        password: $('create-password').value,
      });
      event.target.reset();
      show($('create-status'), `Added ${user.username}.`, 'ok');
      await load();
      showPassword(`Password for ${user.username}`, 'Give them this password. They can change it in Your account.', password);
    } catch (err) {
      show($('create-status'), err.message, 'bad');
    } finally {
      $('create-submit').disabled = false;
    }
  });

  load().catch((err) => show($('users-status'), err.message, 'bad'));
})();
