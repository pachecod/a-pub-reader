// Explaining failed fetches. Synthetic responses rather than live sites, so each
// kind of failure — bot protection, logins, rate limits, outages — is pinned.

import { explainHttpFailure } from '../lib/httperror.mjs';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

/** A Response that reports `url` as where it came from, as fetch() does. */
function response(status, { headers = {}, body = '', url = 'https://www.example.org/feed' } = {}) {
  const res = new Response(body, { status, headers });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

const cloudflare = await explainHttpFailure(
  response(403, {
    headers: { server: 'cloudflare', 'cf-ray': 'abc-DFW' },
    body: '<html><head><title>Attention Required! | Cloudflare</title></head></html>',
    url: 'https://www.niemanlab.org/feed',
  }),
  { what: 'feed' }
);
assert(/niemanlab\.org/.test(cloudflare.message), 'names the site, without www');
assert(/Cloudflare/.test(cloudflare.message) && /automated/.test(cloudflare.message), `a Cloudflare block is named as bot protection: "${cloudflare.message.slice(0, 90)}…"`);
assert(/cannot get past it/.test(cloudflare.message), 'says the app cannot work around it');
assert(/another feed|browser/.test(cloudflare.message), 'suggests what to do instead');
assert(cloudflare.status === 403 && cloudflare.shield === 'Cloudflare', 'carries the status and the protection for callers');

const challenge = await explainHttpFailure(response(403, { headers: { 'cf-mitigated': 'challenge' } }), { what: 'feed' });
assert(challenge.shield === 'Cloudflare' && /blocked this app/.test(challenge.message), 'a challenge header alone is enough');

const plain = await explainHttpFailure(response(403), { what: 'feed' });
assert(/refused/.test(plain.message) && /subscribers only/.test(plain.message), 'a bare 403 lists the likely causes');
assert(/browser/.test(plain.message), 'and how to tell which one it is');
assert(/HTTP 403/.test(plain.message), 'the status code is still there for reference');

const behindCdn = await explainHttpFailure(response(403, { headers: { server: 'cloudflare' } }), { what: 'feed' });
assert(/behind Cloudflare/.test(behindCdn.message) && !/blocked this app/.test(behindCdn.message), 'Cloudflare as a host only is mentioned, not blamed');

const akamai = await explainHttpFailure(
  response(403, { headers: { server: 'AkamaiGHost' }, body: '<title>Access Denied</title>' }),
  { what: 'page' }
);
assert(akamai.shield === 'Akamai' && /blocked this app/.test(akamai.message), 'Akamai blocks are recognised');

const login = await explainHttpFailure(response(401), { what: 'feed' });
assert(/login/.test(login.message) && /private URL/.test(login.message), '401 explains subscriber feeds');

const missing = await explainHttpFailure(response(404), { what: 'feed' });
assert(/no feed at that address/.test(missing.message), '404 says nothing is there');

const limited = await explainHttpFailure(response(429, { headers: { 'retry-after': '30' } }), { what: 'feed' });
assert(/limiting/.test(limited.message) && /30 seconds/.test(limited.message), '429 explains rate limiting and the wait it asked for');

const down = await explainHttpFailure(response(503, { headers: { 'retry-after': '600' } }), { what: 'feed' });
assert(/their end/.test(down.message) && /maintenance/.test(down.message) && /10 minutes/.test(down.message), '503 is the site\'s problem, with its wait');

const page = await explainHttpFailure(response(404), { what: 'page' });
assert(/no page at that address/.test(page.message), 'the wording follows what was fetched');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
