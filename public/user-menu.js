'use strict';

// The account menu in the app's top bar, when accounts are on: your name, and
// under it Your account, Admin (for administrators) and Sign out. If your
// password was set by an administrator, a dot asks you to choose your own.
//
// It also notices a session that has ended (signed out elsewhere, or expired)
// while the page is open: the next call that comes back "sign in first" takes
// you to the sign-in page, and back here afterwards.

(function () {
  const realFetch = window.fetch.bind(window);
  let accounts = false;
  window.fetch = async (input, init) => {
    const res = await realFetch(input, init);
    if (accounts && res.status === 401) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.origin === location.origin && url.pathname.startsWith('/api/') && url.pathname !== '/api/auth/signin') {
        location.assign(`/signin?next=${encodeURIComponent(location.pathname + location.search)}`);
      }
    }
    return res;
  };

  function item(label, href, onClick) {
    const a = document.createElement(href ? 'a' : 'button');
    a.className = 'user-menu-item';
    a.textContent = label;
    if (href) a.href = href;
    else {
      a.type = 'button';
      a.addEventListener('click', onClick);
    }
    return a;
  }

  async function build() {
    let me;
    try {
      me = await (await realFetch('/api/auth/me')).json();
    } catch {
      return;
    }
    accounts = Boolean(me.accounts);
    if (!accounts || !me.user) return;
    const bar = document.querySelector('.menubar');
    if (!bar) return;

    const wrap = document.createElement('span');
    wrap.className = 'user-menu';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'user-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'user-panel');
    toggle.textContent = me.user.username;
    if (me.user.adminSetPassword) {
      const dot = document.createElement('span');
      dot.className = 'user-dot';
      dot.setAttribute('aria-label', 'choose your own password');
      toggle.appendChild(dot);
    }
    const panel = document.createElement('div');
    panel.className = 'user-panel';
    panel.id = 'user-panel';
    panel.hidden = true;
    if (me.user.adminSetPassword) panel.appendChild(item('Choose your own password', '/account'));
    panel.appendChild(item('Your account', '/account'));
    if (me.user.role === 'admin') panel.appendChild(item('Admin', '/admin'));
    panel.appendChild(
      item('Sign out', null, async () => {
        await realFetch('/api/auth/signout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
        location.replace('/signin');
      })
    );
    wrap.append(toggle, panel);
    // After the theme button, before the sync badge.
    const theme = bar.querySelector('.theme-menu');
    if (theme) theme.after(wrap);
    else bar.appendChild(wrap);

    const open = (yes) => {
      panel.hidden = !yes;
      toggle.setAttribute('aria-expanded', String(yes));
    };
    toggle.addEventListener('click', () => open(panel.hidden));
    document.addEventListener('click', (event) => {
      if (!panel.hidden && !wrap.contains(event.target)) open(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) {
        open(false);
        toggle.focus();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
