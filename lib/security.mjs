// Request-level protections shared by the server: response headers, checks
// that a request really comes from the app's own pages, the client's address
// behind a proxy, startup checks on secrets, and simple rate limits.

/** Baseline headers on every response. */
export function baseHeaders({ https = false } = {}) {
  const headers = {
    // Files are what their content-type says, never sniffed into HTML.
    'x-content-type-options': 'nosniff',
    // Addresses of pages in the library stay private.
    'referrer-policy': 'no-referrer',
    // The app is never shown inside another site's frame (clickjacking).
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
  // Only over HTTPS (hosted); a browser ignores it on plain HTTP anyway.
  if (https) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

/**
 * The Content-Security-Policy for the app's own pages. Scripts come only from
 * the app's files: no inline script, no eval, nothing from another site.
 * Images may be remote because the editor previews images by address.
 * `extra` adds sources per directive, e.g. Google Analytics' hosts later.
 */
export function appCsp(extra = {}) {
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'frame-src': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  for (const [name, sources] of Object.entries(extra)) {
    directives[name] = [...(directives[name] || []), ...sources];
  }
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The host name of a Host header, without its port. */
function hostName(host) {
  const text = String(host || '').trim().toLowerCase();
  if (text.startsWith('[')) return text.slice(0, text.indexOf(']') + 1);
  return text.split(':')[0];
}

/**
 * On your own computer, only requests addressed to this computer are served.
 * A site that points its own name at 127.0.0.1 (DNS rebinding) sends its own
 * name in Host, and is refused.
 */
export function localHostAllowed(hostHeader) {
  return LOCAL_NAMES.has(hostName(hostHeader));
}

/**
 * Whether a state-changing request comes from the app's own pages. Browsers
 * send Origin on cross-site requests (and on same-site POSTs), so a request
 * whose Origin or Referer names another site is refused. A request with
 * neither is not from a web page (curl, tests, a script) and carries no
 * browser's stored credentials, so it is allowed. There is deliberately no
 * escape hatch for a custom header.
 */
export function sameOrigin(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin === 'null') return false;
    try {
      return new URL(origin).host.toLowerCase() === host;
    } catch {
      return false;
    }
  }
  const referer = req.headers.referer;
  if (referer) {
    try {
      return new URL(referer).host.toLowerCase() === host;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * The client's address. Behind a proxy (Render), the proxy adds the address it
 * saw to the right of X-Forwarded-For; anything further left could have been
 * written by the client, so the entry `trustedHops` from the right is used.
 */
export function clientIp(req, trustedHops = 0) {
  const direct = req.socket?.remoteAddress || '';
  if (!trustedHops) return direct;
  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return chain[chain.length - trustedHops] || chain[0] || direct;
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'changeme', 'change-me', 'admin', 'admin123',
  'letmein', 'welcome', 'secret', 'qwerty', '123456', '12345678', '123456789',
  'apub', 'a-pub', 'apubreader', 'a-pub-reader', 'epubdrop', 'test', 'example',
]);
export const MIN_SECRET_LENGTH = 12;

/**
 * Problems with the secrets a public server needs, as sentences. Empty when
 * all is well. The server refuses to start on any.
 */
export function secretProblems(env, { required = false } = {}) {
  const problems = [];
  if (required) {
    const password = env.APP_PASSWORD || '';
    if (!password) {
      problems.push('APP_PASSWORD is not set.');
    } else if (password.length < MIN_SECRET_LENGTH) {
      problems.push(`APP_PASSWORD is shorter than ${MIN_SECRET_LENGTH} characters.`);
    } else if (COMMON_PASSWORDS.has(password.toLowerCase()) || /^(.)\1+$/.test(password)) {
      problems.push('APP_PASSWORD is a common or placeholder password.');
    }
  }
  // File storage, wherever it is set: all four settings or none, and a real secret.
  const storage = ['STORAGE_ENDPOINT', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY'];
  const set = storage.filter((name) => env[name]);
  if (set.length && set.length < storage.length) {
    problems.push(`File storage is half set up: ${storage.filter((n) => !env[n]).join(', ')} missing.`);
  } else if (set.length && env.STORAGE_SECRET_ACCESS_KEY.length < 20) {
    problems.push('STORAGE_SECRET_ACCESS_KEY is too short to be a real key.');
  }
  return problems;
}

/**
 * Counts hits per key in a fixed window. In memory, so it resets on restart;
 * a database-backed limiter replaces it once there are accounts (Phase 2).
 */
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  /** Record a hit. Returns { ok, retryAfter } with retryAfter in seconds. */
  hit(key, now = Date.now()) {
    let entry = this.hits.get(key);
    if (!entry || now >= entry.reset) {
      entry = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    if (this.hits.size > 10000) this.sweep(now);
    return { ok: entry.count <= this.max, retryAfter: Math.ceil((entry.reset - now) / 1000) };
  }

  /** Whether a key is over its limit, without counting a hit. */
  blocked(key, now = Date.now()) {
    const entry = this.hits.get(key);
    if (!entry || now >= entry.reset) return { blocked: false, retryAfter: 0 };
    return { blocked: entry.count >= this.max, retryAfter: Math.ceil((entry.reset - now) / 1000) };
  }

  sweep(now = Date.now()) {
    for (const [key, entry] of this.hits) if (now >= entry.reset) this.hits.delete(key);
  }
}
