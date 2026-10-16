// Turning a failed web response into something a person can act on.
//
// "HTTP 403" is true but useless: it is the same number whether a site's bot
// protection stopped the app, the feed needs a subscriber login, or the
// publisher only serves some countries. The response usually says which — in
// its headers, or in the title of the block page it sent instead — so this
// reads both and explains the likely cause and what, if anything, can be done.

/** Who is standing in front of the site, judged from headers and the block page. */
function detectShield(headers, page) {
  const server = (headers.get('server') || '').toLowerCase();
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(page)?.[1] || '').trim();

  if (headers.get('cf-mitigated') === 'challenge' || /just a moment|attention required|cloudflare/i.test(title)) {
    return { name: 'Cloudflare', title };
  }
  if (server.includes('cloudflare') || headers.get('cf-ray')) return { name: 'Cloudflare', title, weak: true };
  if (server.includes('akamai') || /access denied/i.test(title)) return { name: 'Akamai', title, weak: !server.includes('akamai') };
  if (headers.get('x-sucuri-id') || /sucuri/i.test(title)) return { name: 'Sucuri', title };
  if (headers.get('x-datadome') || /datadome/i.test(page.slice(0, 4000))) return { name: 'DataDome', title };
  if (headers.get('x-amzn-waf-action') || /request blocked/i.test(title)) return { name: 'a web firewall', title };
  return { name: '', title };
}

function retryAfter(headers) {
  const value = headers.get('retry-after');
  if (!value) return '';
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds < 120 ? ` It asked for a wait of ${seconds} seconds.` : ` It asked for a wait of about ${Math.round(seconds / 60)} minutes.`;
  }
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? '' : ` It asked to wait until ${when.toLocaleTimeString()}.`;
}

/**
 * An Error explaining why `res` failed.
 *
 * @param {Response} res     The non-OK response (its body is read, a little).
 * @param {object} options
 * @param {string} options.what  What was being fetched, for the message: "feed", "page".
 */
export async function explainHttpFailure(res, { what = 'page' } = {}) {
  const status = res.status;
  let host = '';
  try {
    host = new URL(res.url).hostname.replace(/^www\./, '');
  } catch {}
  const site = host || 'The site';

  // Block pages are small; the start is enough to find a <title>.
  let page = '';
  try {
    page = (await res.text()).slice(0, 20000);
  } catch {}

  const shield = detectShield(res.headers, page);
  const code = `(HTTP ${status})`;

  let reason;
  if (status === 403 && shield.name && !shield.weak) {
    reason =
      `${site} is protected by ${shield.name}, which blocked this app as an automated visitor ${code}. ` +
      `Instead of the ${what} it sent ${shield.title ? `a page titled "${shield.title}"` : 'a challenge page'}, meant for a browser to solve. ` +
      `This is the site's choice, not a problem with the URL or your connection, and the app cannot get past it. ` +
      `Look for another feed from the same publisher (a newsletter or section feed), or read it in your browser.`;
  } else if (status === 403) {
    reason =
      `${site} refused the request ${code}.` +
      (shield.name ? ` It sits behind ${shield.name}, which often turns away apps that are not a browser.` : '') +
      ` Usually that means the site blocks automated readers, the ${what} is for subscribers only, ` +
      `or it is not available in your country. Opening the URL in a browser shows which: ` +
      `if it loads there, the site is blocking apps; if it asks you to sign in, it needs a subscription.`;
  } else if (status === 401) {
    reason = `${site} wants a login for this ${what} ${code}. Subscriber-only feeds usually give you a private URL with a key in it — use that one.`;
  } else if (status === 404) {
    reason = `${site} has no ${what} at that address ${code}. It may have moved: check the site for a current RSS link, or try the address without anything after the domain.`;
  } else if (status === 410) {
    reason = `${site} says this ${what} has been removed for good ${code}.`;
  } else if (status === 406) {
    reason = `${site} would not send the ${what} in a form this app asked for ${code}. Some sites reject apps this way as a softer kind of bot blocking.`;
  } else if (status === 429) {
    reason = `${site} is limiting how often it can be fetched ${code} — too many requests in a short time.${retryAfter(res.headers)} Try again later.`;
  } else if (status === 451) {
    reason = `${site} says this ${what} is unavailable for legal reasons ${code}, often because of where you are.`;
  } else if (status >= 500) {
    reason =
      `${site} had a problem of its own ${code}.` +
      (status === 503 ? ' It may be down for maintenance or overloaded.' : '') +
      `${retryAfter(res.headers)} This is on their end — try again later.`;
  } else {
    reason = `${site} answered with an error ${code}.`;
  }

  const error = new Error(reason);
  error.status = status;
  error.shield = shield.name || null;
  return error;
}
