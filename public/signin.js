'use strict';

// The sign-in form. On success the server sets the session cookie and this
// page goes to where the person was heading (?next=, a path on this site).

(function () {
  const form = document.getElementById('signin-form');
  const login = document.getElementById('signin-login');
  const password = document.getElementById('signin-password');
  const submit = document.getElementById('signin-submit');
  const status = document.getElementById('signin-status');

  const next = new URLSearchParams(location.search).get('next') || '/';
  const safeNext = /^\/(?!\/)[^\\]*$/.test(next) ? next : '/';

  login.focus();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!login.value.trim() || !password.value) {
      status.textContent = 'Enter your username (or email) and password.';
      status.className = 'status bad';
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    status.textContent = '';
    try {
      const res = await fetch('/api/auth/signin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: login.value.trim(), password: password.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Could not sign in (HTTP ${res.status}).`);
      location.replace(safeNext);
    } catch (err) {
      status.textContent = err.message;
      status.className = 'status bad';
      password.select();
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });
})();
