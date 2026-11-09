// Outbound fetches of addresses that users supply: pages to convert, feeds,
// images inside articles, catalogues and book downloads.
//
// Hosted, a server that fetches whatever URL it is given can be aimed at its
// own network: the cloud provider's metadata service, the database, other
// services on the private network, or the server itself. So when private
// addresses are not allowed (always when hosted), every fetch here:
//
// - accepts only http and https, with no user name or password in the URL;
// - refuses loopback, private, link-local, carrier-grade NAT, multicast,
//   documentation and other reserved ranges, IPv4 and IPv6, including IPv4
//   hidden inside IPv6 (mapped, NAT64, 6to4, Teredo);
// - checks the addresses a name resolves to at the moment of connecting and
//   connects to an address it checked, so a name that answers "public" to a
//   first lookup and "private" to a second (DNS rebinding) cannot get through;
// - follows redirects itself, checking each new address the same way;
// - stops after a time limit and a size limit.
//
// Numeric tricks (`0x7f.1`, `2130706433`, octal `0177.0.0.1`, fullwidth
// digits) are normalised by the WHATWG URL parser to the plain address before
// any check runs, so they meet the same blocklist.
//
// On your own computer private addresses stay allowed (a page on your home
// network, a test server); the size, time, scheme and credential rules still
// apply.

import dns from 'node:dns';
import net from 'node:net';
import { Agent, Response, fetch as undiciFetch } from 'undici';

/** Most a response may be unless the caller says otherwise. */
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Statuses whose responses cannot carry a body.
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

const V4_BLOCKED = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and broadcast
];

const V6_BLOCKED = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local (private)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // old site-local
  ['ff00::', 8], // multicast
];

const blocklist = new net.BlockList();
for (const [address, prefix] of V4_BLOCKED) blocklist.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of V6_BLOCKED) blocklist.addSubnet(address, prefix, 'ipv6');

/** Names that only ever mean "this machine" or "this private network". */
const PRIVATE_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

let allowPrivate = true;

/**
 * Set whether private addresses may be fetched. The server turns this off when
 * hosted; the default suits the app running on your own computer.
 */
export function configureNetGuard(options = {}) {
  if (typeof options.allowPrivate === 'boolean') allowPrivate = options.allowPrivate;
}

export function privateAddressesAllowed() {
  return allowPrivate;
}

/** A refused address. Its message is safe to show to the user. */
export class BlockedAddressError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedAddressError';
    this.code = 'EBLOCKEDADDRESS';
  }
}

/** The eight 16-bit groups of an IPv6 address, or null. */
function ipv6Groups(address) {
  let text = address.toLowerCase().split('%')[0];
  // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted[1].split('.').map(Number);
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    text = `${text.slice(0, -dotted[1].length)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

const v4From = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');

/** The IPv4 address an IPv6 address carries inside it, if it is one that does. */
function embeddedIpv4(groups) {
  const [a, b, c, d, e, f, g, h] = groups;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (the old "compatible" form).
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) return v4From(g, h);
  // 64:ff9b::a.b.c.d and 64:ff9b:1::/48 (NAT64).
  if (a === 0x64 && b === 0xff9b) return v4From(g, h);
  // 2002:aabb:ccdd::/16 (6to4).
  if (a === 0x2002) return v4From(b, c);
  // 2001:0000::/32 (Teredo): the client address is stored inverted.
  if (a === 0x2001 && b === 0) return v4From(g ^ 0xffff, h ^ 0xffff);
  return null;
}

/** Whether an IP address is one the app must not connect to when hosted. */
export function isBlockedAddress(address) {
  const ip = String(address || '').replace(/^\[|\]$/g, '');
  const family = net.isIP(ip.split('%')[0]);
  if (family === 4) return blocklist.check(ip, 'ipv4');
  if (family !== 6) return true; // not an address at all
  const groups = ipv6Groups(ip);
  if (!groups) return true;
  const inner = embeddedIpv4(groups);
  if (inner && blocklist.check(inner, 'ipv4')) return true;
  const plain = groups.map((g) => g.toString(16)).join(':');
  return blocklist.check(plain, 'ipv6');
}

/**
 * Parse and check a URL before fetching it. Returns the URL object, or throws
 * BlockedAddressError with a reason that can be shown to the user.
 */
export function checkUrl(input) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input));
  } catch {
    throw new BlockedAddressError(`That is not a web address: ${String(input).slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedAddressError(`Only http and https addresses can be fetched, not ${url.protocol.replace(':', '')}.`);
  }
  if (url.username || url.password) {
    throw new BlockedAddressError('Addresses with a user name or password in them cannot be fetched.');
  }
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (net.isIP(host) ? isBlockedAddress(host) : PRIVATE_NAME.test(host) || !host.includes('.')) {
      throw new BlockedAddressError(`${url.hostname} is a private or local address, which cannot be fetched here.`);
    }
  }
  return url;
}

/**
 * A DNS lookup that refuses to hand back blocked addresses. Used at connect
 * time, so the address checked is the address connected to.
 */
export function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const opts = typeof options === 'number' ? { family: options } : { ...options };
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [];
    if (!list.length) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }));
    // Any private answer refuses the whole name rather than picking around it.
    if (list.some((a) => isBlockedAddress(a.address))) {
      return callback(new BlockedAddressError(`${hostname} points to a private or local address, which cannot be fetched here.`));
    }
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

// One connection pool per policy, made on first use.
let guardedAgent = null;
let openAgent = null;
function agent() {
  if (allowPrivate) return (openAgent ||= new Agent());
  return (guardedAgent ||= new Agent({ connect: { lookup: guardedLookup } }));
}

/** The error for a response past its size limit. Safe to show to the user. */
function tooLarge(url, maxBytes) {
  const limit = maxBytes >= 1048576 ? `${Math.round(maxBytes / 1048576)} MB` : `${Math.round(maxBytes / 1024)} KB`;
  return Object.assign(new Error(`What ${url.hostname} sent is too large: more than ${limit}, the limit here.`), { code: 'ETOOLARGE' });
}

/** A copy of a response whose body stops with an error past `maxBytes`. */
function capBody(res, url, maxBytes, redirected) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.body?.cancel().catch(() => {});
    throw tooLarge(url, maxBytes);
  }
  let body = null;
  if (res.body && !NULL_BODY.has(res.status)) {
    let seen = 0;
    body = res.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > maxBytes) {
            controller.error(tooLarge(url, maxBytes));
            return;
          }
          controller.enqueue(chunk);
        },
      })
    );
  }
  const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  Object.defineProperty(out, 'url', { value: url.href });
  Object.defineProperty(out, 'redirected', { value: redirected });
  return out;
}

/**
 * fetch() for user-supplied addresses, with the checks above. Takes the usual
 * fetch options plus `maxBytes`. Returns a standard Response whose `url` is the
 * final address after redirects.
 */
export async function safeFetch(input, init = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, redirect = 'follow', signal, ...rest } = init;
  let url = checkUrl(input);
  let method = (rest.method || 'GET').toUpperCase();
  let requestBody = rest.body;
  const timeout = signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS);

  for (let hop = 0; ; hop++) {
    const res = await undiciFetch(url.href, {
      ...rest,
      method,
      body: requestBody,
      signal: timeout,
      redirect: 'manual',
      dispatcher: agent(),
    });
    const location = res.headers.get('location');
    if (redirect === 'follow' && REDIRECTS.has(res.status) && location) {
      res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new Error(`${url.hostname} redirected too many times.`);
      url = checkUrl(new URL(location, url));
      // As browsers do: 303, and 301/302 after a POST, continue as GET.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        requestBody = undefined;
      }
      continue;
    }
    return capBody(res, url, maxBytes, hop > 0);
  }
}

/**
 * The user-facing reason when a fetch was refused by these checks (a blocked
 * address or a response past its size limit), or null. fetch() wraps
 * connection errors, so the refusal may be a cause.
 */
export function blockedReason(err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e instanceof BlockedAddressError || e?.code === 'EBLOCKEDADDRESS' || e?.code === 'ETOOLARGE') return e.message;
  }
  return null;
}
