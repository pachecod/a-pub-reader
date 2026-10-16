// "Find feeds": a short, hand-picked directory of feeds from established
// publishers, checked live before it is shown.
//
// Searching the open web for feeds turns up spam, scrapers and abandoned blogs
// as readily as anything worth reading, so the sources are chosen here rather
// than discovered: public broadcasters, nonprofit newsrooms, scientific
// publishers and long-running magazines. What is found on the internet is
// whether each one is alive today — every feed is fetched when the list is
// asked for, and only the ones that answer with a parseable feed are offered,
// each with its latest headline so you can see what it publishes.

import { fetchFeed } from './rss.mjs';
import { normalizeUrl } from './feeds.mjs';

export const DIRECTORY = [
  {
    group: 'News',
    feeds: [
      { name: 'BBC News — World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', about: 'International news from the BBC.' },
      { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml', about: 'Top stories from National Public Radio.' },
      { name: 'PBS News Hour', url: 'https://www.pbs.org/newshour/feeds/rss/headlines', about: 'The latest from the PBS News Hour newsroom.' },
      { name: 'The Guardian — World', url: 'https://www.theguardian.com/world/rss', about: 'World news from The Guardian.' },
      { name: 'Deutsche Welle', url: 'https://rss.dw.com/rdf/rss-en-all', about: "Germany's international broadcaster, in English." },
      { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', about: 'Global news with a focus beyond the US and Europe.' },
    ],
  },
  {
    group: 'Investigations & journalism',
    feeds: [
      { name: 'ProPublica', url: 'https://www.propublica.org/feeds/propublica/main', about: 'Nonprofit investigative reporting.' },
      { name: 'The Marshall Project', url: 'https://www.themarshallproject.org/rss/recent.rss', about: 'Nonprofit reporting on criminal justice.' },
      { name: 'The Markup', url: 'https://themarkup.org/feeds/rss.xml', about: 'Nonprofit newsroom investigating technology.' },
      { name: 'CalMatters', url: 'https://calmatters.org/feed/', about: 'Nonprofit coverage of California policy and politics.' },
      { name: 'Columbia Journalism Review', url: 'https://www.cjr.org/feed', about: 'The media and the press, from Columbia University.' },
      { name: 'Poynter', url: 'https://www.poynter.org/feed', about: 'Journalism practice, ethics and fact-checking.' },
    ],
  },
  {
    group: 'Science',
    feeds: [
      { name: 'Quanta Magazine', url: 'https://www.quantamagazine.org/feed/', about: 'Long-form math, physics, biology and computer science.' },
      { name: 'Nature', url: 'https://www.nature.com/nature.rss', about: 'News and research from the journal Nature.' },
      { name: 'Scientific American', url: 'http://rss.sciam.com/ScientificAmerican-Global', about: 'Science news and features.' },
      { name: 'Knowable Magazine', url: 'https://knowablemagazine.org/rss', about: 'Explanatory science journalism from Annual Reviews.' },
      { name: 'NPR Science', url: 'https://feeds.npr.org/1007/rss.xml', about: 'Science stories from NPR.' },
      { name: 'NASA', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss', about: 'News from NASA.' },
      { name: 'The Conversation', url: 'https://theconversation.com/us/articles.atom', about: 'Researchers and academics writing for the public.' },
    ],
  },
  {
    group: 'Technology',
    feeds: [
      { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', about: 'Technology, science and policy in depth.' },
      { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed', about: "Emerging technology, from MIT's magazine." },
      { name: 'IEEE Spectrum', url: 'https://spectrum.ieee.org/feeds/feed.rss', about: 'Engineering and technology from the IEEE.' },
      { name: 'WIRED', url: 'https://www.wired.com/feed/rss', about: 'Technology, culture and business.' },
      { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', about: 'Technology news and reviews.' },
      { name: 'NPR Technology', url: 'https://feeds.npr.org/1019/rss.xml', about: 'Technology stories from NPR.' },
    ],
  },
  {
    group: 'Ideas & long reads',
    feeds: [
      { name: 'Aeon', url: 'https://aeon.co/feed.rss', about: 'Essays on philosophy, science and culture.' },
      { name: 'Psyche', url: 'https://psyche.co/feed', about: "Aeon's sister magazine on the human condition." },
      { name: 'Nautilus', url: 'https://nautil.us/feed/', about: 'Science connected to culture and ideas.' },
      { name: 'Longreads', url: 'https://longreads.com/feed/', about: 'The best long-form stories, picked and published.' },
      { name: 'The Atlantic', url: 'https://www.theatlantic.com/feed/all/', about: 'Politics, culture and ideas.' },
      { name: 'The New Yorker', url: 'https://www.newyorker.com/feed/everything', about: 'Reporting, criticism and fiction.' },
    ],
  },
  {
    group: 'Culture & history',
    feeds: [
      { name: 'Smithsonian', url: 'https://www.smithsonianmag.com/rss/latest_articles/', about: 'History, science and the arts.' },
      { name: 'The Public Domain Review', url: 'https://publicdomainreview.org/rss.xml', about: 'Essays on curious works from the public domain.' },
      { name: 'The Marginalian', url: 'https://www.themarginalian.org/feed/', about: 'Maria Popova on books, art and ideas.' },
      { name: 'NPR Culture', url: 'https://feeds.npr.org/1008/rss.xml', about: 'Arts and culture from NPR.' },
    ],
  },
];

const CONCURRENCY = 8;
const CACHE_MS = 10 * 60 * 1000;
let cache = null;

/** Run `fn` over `items`, at most `limit` at a time. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function probe(entry, fetcher) {
  try {
    const feed = await fetcher(entry.url);
    const latest = feed.items[0];
    return {
      ...entry,
      ok: true,
      items: feed.items.length,
      latest: latest ? { title: latest.title, date: latest.date?.toISOString?.() || null } : null,
    };
  } catch (err) {
    return { ...entry, ok: false, error: err.message };
  }
}

/**
 * The directory with each feed's live status, and whether you already follow it.
 *
 * @param {object} options
 * @param {string[]} options.following  URLs of saved feeds.
 * @param {boolean} [options.fresh]     Skip the short-lived cache.
 * @param {Function} [options.fetcher]  Feed fetcher, replaceable for tests.
 * @param {Array} [options.directory]   Directory, replaceable for tests.
 */
export async function discoverFeeds({ following = [], fresh = false, fetcher = fetchFeed, directory = DIRECTORY } = {}) {
  const usingDefaults = fetcher === fetchFeed && directory === DIRECTORY;
  let probed;
  if (usingDefaults && !fresh && cache && Date.now() - cache.at < CACHE_MS) {
    probed = cache.probed;
  } else {
    const flat = directory.flatMap((g) => g.feeds.map((f) => ({ ...f, group: g.group })));
    probed = await mapLimit(flat, CONCURRENCY, (entry) => probe(entry, fetcher));
    if (usingDefaults) cache = { at: Date.now(), probed };
  }

  const followed = new Set(following.map(normalizeUrl));
  return directory.map((g) => ({
    group: g.group,
    feeds: probed
      .filter((p) => p.group === g.group)
      .map(({ group, ...p }) => ({ ...p, following: followed.has(normalizeUrl(p.url)) })),
  }));
}
