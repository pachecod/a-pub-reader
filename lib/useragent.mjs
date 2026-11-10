// How the app identifies itself to the sites it fetches from.
//
// Honestly, as itself, with a link to a page saying what it fetches and how a
// publisher can get in touch or opt out (/about/fetching on a hosted install;
// the project's page on your own computer). Earlier versions sent a desktop
// Chrome user agent.

/** The name sites see. */
export const AGENT_NAME = 'A-PubReader';
export const AGENT_VERSION = '2.0';

let infoUrl = 'https://github.com/pachecod/a-pub-reader';

/** Point the user agent at this install's About fetching page. */
export function configureUserAgent({ siteUrl } = {}) {
  const base = String(siteUrl || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(base)) infoUrl = `${base}/about/fetching`;
}

/** The User-Agent header for every fetch the app makes. */
export const userAgent = () => `${AGENT_NAME}/${AGENT_VERSION} (+${infoUrl})`;

/** Where the user agent points. */
export const userAgentInfoUrl = () => infoUrl;
