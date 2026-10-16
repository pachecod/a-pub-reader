// CrossPoint Reader (Xteink X3/X4) local network client.
//
// Protocol per the firmware's docs/webserver-endpoints.md:
//   HTTP  :80    /api/status, /api/files, /upload, /mkdir, /download
//   WS    :81    binary chunk upload (faster; not needed for article-sized files)
//   UDP   :8134  send "hello" -> "crosspoint (on <hostname>);81"
//
// The device only serves these while it is in File Transfer or Calibre
// Wireless mode, so every call here can legitimately fail with ECONNREFUSED.

import dgram from 'node:dgram';

export const HTTP_PORT = 80;
export const DISCOVERY_PORT = 8134;
export const DEFAULT_HOST = 'crosspoint.local';

// In hotspot (AP) mode the reader runs its own network, `CrossPoint-Reader`,
// and answers on this fixed address. mDNS usually does not work there, so this
// is the address to fall back on.
export const HOTSPOT_HOST = '192.168.4.1';

// A status check is a few bytes and always fast. Listing, mkdir and delete all
// touch the SD card, and the firmware clears its EPUB cache for a path after an
// upload — so a folder holding a dozen books can take seconds to answer. Timing
// those out was reporting successful writes as failures.
const STATUS_TIMEOUT_MS = 6000;
const CARD_TIMEOUT_MS = 25000;
const UPLOAD_TIMEOUT_MS = 180000;

/** Strip any scheme/trailing slash a user may have pasted in. */
export function normalizeHost(host) {
  return String(host || DEFAULT_HOST)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

// Port 80 is the default, so a bare host works; an explicit host:port also passes through.
function base(host) {
  return `http://${normalizeHost(host)}`;
}

/** GET /api/status — also the reachability check the UI polls. */
export async function getStatus(host) {
  const res = await fetch(`${base(host)}/api/status`, {
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Device returned HTTP ${res.status}`);
  return res.json();
}

/** GET /api/files?path= — returns [{name, size, isDirectory, isEpub}]. */
export async function listFiles(host, path = '/') {
  const url = `${base(host)}/api/files?path=${encodeURIComponent(normalizePath(path))}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(CARD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Device returned HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

/**
 * Create every missing level of `path`. /mkdir takes a parent plus one name,
 * so nested folders need one call per level.
 */
export async function ensureDir(host, path) {
  const segments = normalizePath(path).split('/').filter(Boolean);
  let parent = '/';

  for (const segment of segments) {
    const entries = await listFiles(host, parent);
    const existing = entries.find((e) => e.name === segment);

    if (existing?.isDirectory) {
      parent = joinPath(parent, segment);
      continue;
    }
    if (existing) throw new Error(`"${joinPath(parent, segment)}" exists on the device but is a file.`);

    const body = new URLSearchParams({ name: segment, path: parent });
    const res = await fetch(`${base(host)}/mkdir`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(CARD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`mkdir "${segment}" failed: HTTP ${res.status}`);
    parent = joinPath(parent, segment);
  }

  return normalizePath(path);
}

/**
 * POST /upload?path=<dir> as multipart form data.
 *
 * The firmware's docs say a same-named file is overwritten, but 1.5.0 answers
 * "HTTP 400 — File already exists" instead. Replacing a file therefore means
 * deleting it first; see replaceOnDevice().
 */
export async function uploadEpub(host, dir, filename, buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/epub+zip' }), filename);

  const url = `${base(host)}/upload?path=${encodeURIComponent(normalizePath(dir))}`;
  const res = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  const text = (await res.text().catch(() => '')).trim();
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}${text ? ` — ${text}` : ''}`);
  return text || `Uploaded ${filename}`;
}


/**
 * Upload, replacing any file already there under the same name.
 *
 * Needed because the firmware refuses an upload onto an existing name rather
 * than overwriting it. Without this, refreshing a feed twice in one day could
 * never reach the device: the new edition has the same dated filename as the
 * one already on the card, so every send was rejected.
 *
 * The existing file is only removed once we hold the replacement in memory, so
 * a failure here cannot leave the reader with neither version.
 *
 * @param {Set<string>} [known] Names already known to be in `dir`, so a batch
 *   of uploads to one folder does not re-list it for every file.
 * @returns {Promise<{message: string, replaced: boolean}>}
 */
export async function replaceOnDevice(host, dir, filename, buffer, known) {
  const names = known || new Set((await deletableNames(host, dir)).keys());

  let replaced = false;
  if (names.has(filename)) {
    await deleteFiles(host, [joinPath(normalizePath(dir), filename)]);
    names.delete(filename);
    replaced = true;
  }

  let message;
  try {
    message = await uploadEpub(host, dir, filename, buffer);
  } catch (err) {
    // A slow response often still means a successful write.
    if (!(await verifyUploaded(host, dir, filename, buffer.length))) throw err;
    message = `Uploaded ${filename} (confirmed on the device after a slow response)`;
  }

  names.add(filename);
  return { message: replaced ? `${message} (replaced the previous file)` : message, replaced };
}

/**
 * Did this file actually land, at the right size?
 *
 * The device can finish writing a file and then be slow to answer — clearing
 * its EPUB cache for the folder, or just busy — so an upload whose response
 * times out has very often succeeded. Reporting those as failures made the app
 * claim books had not been sent when they were sitting on the card, and invited
 * the user to send duplicates. Size is compared too, so a truncated write is
 * still correctly a failure.
 *
 * @returns {Promise<boolean>}
 */
export async function verifyUploaded(host, dir, filename, expectedBytes) {
  try {
    const entries = await listFiles(host, dir);
    const found = entries.find((e) => e.name === filename && !e.isDirectory);
    if (!found) return false;
    // Some firmware revisions report 0 for a file it has not finished flushing.
    if (!expectedBytes || !found.size) return Boolean(found.size);
    return found.size === expectedBytes;
  } catch {
    return false;
  }
}

/**
 * POST /delete with a JSON array of absolute paths.
 *
 * This deletes from the SD card irreversibly, so callers are expected to have
 * already established that every path is one they are allowed to touch —
 * see deletableNames() for how the app constrains that.
 */
export async function deleteFiles(host, paths) {
  if (!paths.length) return 'Nothing to delete';

  const body = new URLSearchParams({ paths: JSON.stringify(paths) });
  const res = await fetch(`${base(host)}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(CARD_TIMEOUT_MS),
  });

  const text = (await res.text().catch(() => '')).trim();
  if (!res.ok) throw new Error(`Delete failed: HTTP ${res.status}${text ? ` — ${text}` : ''}`);
  return text || `Deleted ${paths.length} file(s)`;
}

/**
 * The set of filenames that may be deleted from `dir`: exactly the plain files
 * the device reports as direct children.
 *
 * Deriving the allowlist from a fresh device listing means a caller cannot
 * reach outside `dir` no matter what it sends — a name containing `..` or `/`
 * simply will not be in the set, and directories are excluded, so neither the
 * folder itself nor anything below it can be removed.
 */
export async function deletableNames(host, dir) {
  const entries = await listFiles(host, dir);
  return new Map(entries.filter((e) => !e.isDirectory).map((e) => [e.name, e]));
}

/**
 * Broadcast "hello" on UDP 8134 and collect replies.
 * @returns {Promise<Array<{address: string, hostname: string, wsPort: number}>>}
 */
export function discover({ timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...found.values()]);
    };

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8').trim();
      // "crosspoint (on <hostname>);81"
      const match = /^crosspoint(?:\s+\(on\s+([^)]*)\))?\s*;\s*(\d+)/i.exec(text);
      if (!match) return;
      found.set(rinfo.address, {
        address: rinfo.address,
        hostname: (match[1] || '').trim(),
        wsPort: Number(match[2]) || 81,
      });
    });

    socket.on('error', finish);

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* some interfaces refuse broadcast; the unicast probe below still runs */
      }
      const probe = Buffer.from('hello');
      for (const target of ['255.255.255.255', '192.168.4.1']) {
        socket.send(probe, DISCOVERY_PORT, target, () => {});
      }
      setTimeout(finish, timeoutMs);
    });
  });
}

/**
 * Resolve a usable host.
 *
 * Discovery is only used as a fallback when the configured host is the default
 * mDNS name — `crosspoint.local` fails on plenty of networks, and finding the
 * same reader by IP is exactly right. When someone has typed a specific
 * address, a failure is reported instead: silently uploading to a different
 * device that happened to answer a broadcast would be worse than an error.
 */
export async function resolveHost(preferred) {
  const host = normalizeHost(preferred || DEFAULT_HOST);

  try {
    return { host, status: await getStatus(host) };
  } catch (err) {
    if (host !== DEFAULT_HOST) {
      throw new Error(
        `${host} did not answer. Check the address on the reader's File Transfer screen, ` +
          'or use "Find reader" to search the network.'
      );
    }
    // mDNS name failed — fall back to a broadcast probe.
    for (const device of await discover()) {
      try {
        return { host: device.address, status: await getStatus(device.address) };
      } catch {
        /* answered UDP but is not serving HTTP yet */
      }
    }

    // Last resort: the fixed hotspot address. Worth trying even when discovery
    // found nothing, since a Mac joined to the reader's own network may have
    // UDP broadcast filtered while plain HTTP works fine.
    try {
      return { host: HOTSPOT_HOST, status: await getStatus(HOTSPOT_HOST) };
    } catch {
      /* not in hotspot mode either */
    }

    throw new Error(
      'No CrossPoint reader answered. On the reader open File Transfer and join Wi-Fi, ' +
        `or start its hotspot and join "CrossPoint-Reader" from this Mac (then use ${HOTSPOT_HOST}).`
    );
  }
}

export function joinPath(parent, name) {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

export function normalizePath(path) {
  const clean = String(path || '/')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  if (!clean || clean === '/') return '/';
  return clean.startsWith('/') ? clean : `/${clean}`;
}
