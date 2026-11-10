'use strict';

// Before any EPUB leaves the app as a file, the person agrees to keep it for
// their own personal, non-commercial use. Covers a single eBook
// (/out/<id>) and the whole library as a zip (/download/ebooks.zip): OK
// starts the download, Cancel closes the box and nothing is downloaded.
// (Readers fetching over OPDS cannot show this; the About page and Terms say
// the same.)

(function () {
  const DOWNLOADS = [/^\/out\/[0-9a-f-]{36}$/i, /^\/download\/ebooks\.zip$/];
  let dialog = null;
  let pending = null;

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'agree-dialog';
    dialog.setAttribute('aria-labelledby', 'agree-text');
    const text = document.createElement('p');
    text.id = 'agree-text';
    text.className = 'agree-text';
    text.textContent = 'I agree to use this ePub file solely for my personal, non-commercial use.';
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

    cancel.addEventListener('click', () => {
      pending = null;
      dialog.close();
    });
    ok.addEventListener('click', () => {
      const link = pending;
      pending = null;
      dialog.close();
      if (!link) return;
      // A fresh link, so the original's own handler does not ask again.
      const go = document.createElement('a');
      go.href = link.href;
      if (link.hasAttribute('download')) go.download = link.getAttribute('download') || '';
      go.dataset.agreed = 'yes';
      document.body.appendChild(go);
      go.click();
      go.remove();
    });
    // Escape, or clicking outside, is the same as Cancel.
    dialog.addEventListener('cancel', () => {
      pending = null;
    });
  }

  document.addEventListener(
    'click',
    (event) => {
      const link = event.target.closest?.('a[href]');
      if (!link || link.dataset.agreed === 'yes') return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || !DOWNLOADS.some((pattern) => pattern.test(url.pathname))) return;
      event.preventDefault();
      event.stopPropagation();
      if (!dialog) build();
      pending = link;
      dialog.showModal();
      dialog.querySelector('.agree-ok').focus();
    },
    true
  );
})();
