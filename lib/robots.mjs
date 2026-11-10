// robots.txt, for fetching articles' own web pages.
//
// A feed is published for machines to read, so fetching it needs no
// permission. Following each item's link to fetch the full article is
// crawling, so before that the app asks the site's robots.txt, as the robots
// standard (RFC 9309) describes:
//
// - the group for our name (A-PubReader) if there is one, otherwise the `*` one;
// - the longest matching Allow or Disallow wins, Allow on a tie; `*` and `$`
//   work as in the standard;
// - no robots.txt (a 4xx answer) means everything is allowed; a server error or
//   no answer means nothing is, for now.
//
// Answers are remembered per site for a day (an error, for half an hour).

import { AGENT_NAME } from './useragent.mjs';
import { safeFetch } from './netguard.mjs';
import { userAgent } from './useragent.mjs';

const KEEP_MS = 24 * 60 * 60 * 1000;
const KEEP_ERROR_MS = 30 * 60 * 1000;
const MAX_BYTES = 500 * 1024;
const cache = new Map();

/** Parse robots.txt into groups: { agents: [...], rules: [{ allow, path }] }. */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const at = line.indexOf(':');
    if (at < 0) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      // An empty Disallow allows everything; an empty Allow says nothing.
      if (current && value) current.rules.push({ allow: field === 'allow', path: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

/** Whether a robots.txt pattern matches a path (with `*` and a trailing `$`). */
function matches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

/**
 * Whether robots.txt rules allow a path for an agent. Exported for tests.
 * @param {Array} groups  From parseRobots.
 */
export function rulesAllow(groups, path, agent = AGENT_NAME) {
  const name = agent.toLowerCase();
  const ours = groups.filter((g) => g.agents.some((a) => a !== '*' && name.includes(a)));
  const chosen = ours.length ? ours : groups.filter((g) => g.agents.includes('*'));
  if (!chosen.length) return true;
  let best = null;
  for (const rule of chosen.flatMap((g) => g.rules)) {
    if (!matches(rule.path, path)) continue;
    const length = rule.path.replace(/\*/g, '').length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
      best = { allow: rule.allow, length };
    }
  }
  return best ? best.allow : true;
}

/** What a site's robots.txt says, fetched once a day. */
async function siteRules(origin, fetchImpl) {
  const hit = cache.get(origin);
  if (hit && hit.until > Date.now()) return hit.verdict;
  let verdict;
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(8000),
      maxBytes: MAX_BYTES,
      redirect: 'follow',
      headers: { 'user-agent': userAgent(), accept: 'text/plain,*/*' },
    });
    if (res.ok) verdict = { groups: parseRobots(await res.text()) };
    else if (res.status >= 400 && res.status < 500) verdict = { all: true };
    else verdict = { none: true };
  } catch {
    verdict = { none: true, error: true };
  }
  cache.set(origin, { verdict, until: Date.now() + (verdict.none ? KEEP_ERROR_MS : KEEP_MS) });
  return verdict;
}

/**
 * Whether the app may fetch this page, by its site's robots.txt.
 * @param {string} url
 * @param {{fetch?: Function}} [options] A stand-in fetch, for tests.
 */
export async function robotsAllow(url, { fetch: fetchImpl = safeFetch } = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(target.protocol)) return false;
  const verdict = await siteRules(target.origin, fetchImpl);
  if (verdict.all) return true;
  if (verdict.none) return false;
  return rulesAllow(verdict.groups, `${target.pathname}${target.search}`);
}

/** Forget what robots.txt files said (tests). */
export function clearRobotsCache() {
  cache.clear();
}
