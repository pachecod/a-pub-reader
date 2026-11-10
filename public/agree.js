'use strict';

// Agreeing to personal use, before content leaves the publisher's hands:
//
// - Before an EPUB leaves the app as a file (a single eBook, /out/<id>, or the
//   whole library, /download/ebooks.zip): "solely for my personal,
//   non-commercial use".
// - Before a pasted web page is added (app.js asks through apubAgree): "only
//   for my personal use, as if I had printed it out".
//
// OK goes ahead; Cancel (or Escape) closes the box and nothing happens.
// (Readers fetching over OPDS cannot show this; the About page and Terms say
// the same.)

(function () {
  const DOWNLOAD_TEXT = 'I agree to use this ePub file solely for my personal, non-commercial use.';
  const DOWNLOADS = [/^\/out\/[0-9a-f-]{36}$/i, /^\/download\/ebooks\.zip$/];
  let dialog = null;
  let answer = null;

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'agree-dialog';
    dialog.setAttribute('aria-labelledby', 'agree-text');
    const text = document.createElement('p');
    text.id = 'agree-text';
    text.className = 'agree-text';
    const actions = document.createElement('div');
    actions.className = 'agree-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'agree-cancel';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'agree-ok';
    ok.textContent = 'OK';
    actions.append(cancel, ok);
    dialog.append(text, actions);
    document.body.appendChild(dialog);

    const settle = (agreed) => {
      const done = answer;
      answer = null;
      if (dialog.open) dialog.close();
      done?.(agreed);
    };
    cancel.addEventListener('click', () => settle(false));
    ok.addEventListener('click', () => settle(true));
    // Escape, like Cancel.
    dialog.addEventListener('cancel', () => settle(false));
  }

  /** Ask; resolves true for OK, false for Cancel. */
  function ask(text) {
    if (!dialog) build();
    if (answer) answer(false);
    dialog.querySelector('.agree-text').textContent = text;
    dialog.showModal();
    dialog.querySelector('.agree-ok').focus();
    return new Promise((resolve) => {
      answer = resolve;
    });
  }

  window.apubAgree = ask;

  document.addEventListener(
    'click',
    async (event) => {
      const link = event.target.closest?.('a[href]');
      if (!link || link.dataset.agreed === 'yes') return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || !DOWNLOADS.some((pattern) => pattern.test(url.pathname))) return;
      event.preventDefault();
      event.stopPropagation();
      if (!(await ask(DOWNLOAD_TEXT))) return;
      // A fresh link, so the original's own handler does not ask again.
      const go = document.createElement('a');
      go.href = link.href;
      if (link.hasAttribute('download')) go.download = link.getAttribute('download') || '';
      go.dataset.agreed = 'yes';
      document.body.appendChild(go);
      go.click();
      go.remove();
    },
    true
  );
})();
