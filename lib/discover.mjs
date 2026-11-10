// "Find feeds": a hand-picked directory of feeds that carry their articles in
// full, checked live before it is shown.
//
// An edition contains only what a feed contains (the app never takes articles
// from publishers' pages), so a feed with only summaries makes a thin book.
// These were chosen because their feeds include the whole article: measured
// on 2026-11-10 across the feeds on Feeder's "RSS feed list: 100+ news RSS
// feeds by topic" and this list's earlier picks, keeping those whose items
// mostly run past ~250 words. Big names whose feeds carry only summaries (the
// BBC, NPR, the New York Times, the Guardian and others) are left out for that
// reason.
//
// What is found on the internet is whether each is alive today and still
// full text: every feed is fetched when the list is asked for, and only those
// that answer with a parseable feed whose recent items are mostly full
// articles are offered, each with its latest headline.

import { fetchFeed } from './rss.mjs';
import { normalizeUrl } from './feeds.mjs';

export const DIRECTORY = [
  {
    group: 'News',
    feeds: [
      { name: 'TIME', url: 'https://time.com/feed/', about: 'News and analysis from TIME.' },
      { name: 'Vox', url: 'https://www.vox.com/rss/index.xml', about: 'Explanatory journalism on news and policy.' },
      { name: 'Axios', url: 'https://api.axios.com/feed/', about: 'Short, structured news briefs.' },
      { name: 'Yahoo News', url: 'https://news.yahoo.com/rss/topstories', about: 'Top stories from Yahoo News and its partners.' },
      { name: 'Fox News', url: 'https://moxie.foxnews.com/google-publisher/latest.xml', about: 'The latest from Fox News.' },
      { name: 'MS NOW', url: 'https://www.ms.now/feed', about: 'News and opinion from MS NOW (formerly MSNBC).' },
    ],
  },
  {
    group: 'Politics',
    feeds: [
      { name: 'Politico', url: 'https://rss.politico.com/politics-news.xml', about: 'US politics and policy.' },
      { name: 'Politico Europe', url: 'https://www.politico.eu/feed/', about: 'European politics and policy.' },
      { name: 'Fox News Politics', url: 'https://moxie.foxnews.com/google-publisher/politics.xml', about: 'Political news from Fox News.' },
      { name: 'Washington Examiner', url: 'https://www.washingtonexaminer.com/feed/', about: 'Conservative news and commentary.' },
      { name: 'The Daily Signal', url: 'https://www.dailysignal.com/feed/', about: 'Conservative news from the Heritage Foundation.' },
    ],
  },
  {
    group: 'Investigations & local',
    feeds: [
      { name: 'ProPublica', url: 'https://www.propublica.org/feeds/propublica/main', about: 'Nonprofit investigative reporting.' },
      { name: 'The Markup', url: 'https://themarkup.org/feeds/rss.xml', about: 'Nonprofit newsroom investigating technology.' },
      { name: 'CalMatters', url: 'https://calmatters.org/feed/', about: 'Nonprofit coverage of California policy and politics.' },
    ],
  },
  {
    group: 'Ideas & culture',
    feeds: [
      { name: 'The Atlantic', url: 'https://www.theatlantic.com/feed/all/', about: 'Politics, culture and ideas.' },
      { name: 'The Marginalian', url: 'https://www.themarginalian.org/feed/', about: 'Maria Popova on books, art and ideas.' },
    ],
  },
  {
    group: 'Business',
    feeds: [
      { name: 'Fortune', url: 'https://fortune.com/feed/fortune-feeds/?id=3230629', about: 'Business, finance and leadership.' },
      { name: 'Business Insider', url: 'https://feeds.businessinsider.com/custom/all', about: 'Business, markets and tech.' },
      { name: 'Fast Company', url: 'https://www.fastcompany.com/latest/rss', about: 'Innovation, design and work.' },
    ],
  },
  {
    group: 'Science',
    feeds: [
      { name: 'NASA', url: 'https://www.nasa.gov/news-release/feed/', about: 'News releases from NASA.' },
      { name: 'The Conversation', url: 'https://theconversation.com/us/articles.atom', about: 'Researchers and academics writing for the public.' },
    ],
  },
  {
    group: 'Technology',
    feeds: [
      { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed/', about: "Emerging technology, from MIT's magazine." },
      { name: 'IEEE Spectrum', url: 'https://spectrum.ieee.org/feeds/feed.rss', about: 'Engineering and technology from the IEEE.' },
      { name: 'TechRadar', url: 'https://www.techradar.com/feeds.xml', about: 'Technology news, reviews and buying guides.' },
      { name: 'Mashable', url: 'https://mashable.com/feeds/rss/all', about: 'Tech, culture and entertainment.' },
    ],
  },
  {
    group: 'Sports',
    feeds: [
      { name: 'ProFootballTalk', url: 'https://www.nbcsports.com/profootballtalk.rss', about: 'NFL news from NBC Sports.' },
      { name: 'Yahoo Sports', url: 'https://sports.yahoo.com/rss/', about: 'Sports news from Yahoo.' },
    ],
  },
  {
    group: 'Gaming',
    feeds: [
      { name: 'IGN', url: 'https://www.ign.com/rss/articles/feed', about: 'Games, film and TV.' },
      { name: 'GameSpot', url: 'https://www.gamespot.com/feeds/mashup/', about: 'Game news and reviews.' },
      { name: 'PC Gamer', url: 'https://www.pcgamer.com/rss/', about: 'PC gaming news, reviews and guides.' },
      { name: 'Game Informer', url: 'https://gameinformer.com/rss.xml', about: 'Game news, previews and reviews.' },
      { name: 'PlayStation Blog', url: 'https://blog.playstation.com/feed/', about: "Sony's official PlayStation news." },
      { name: 'Xbox Wire', url: 'https://news.xbox.com/en-us/feed/', about: "Microsoft's official Xbox news." },
    ],
  },
];

/** A recent item counts as a full article past this many characters of text (~250 words). */
const FULL_ARTICLE_CHARS = 1500;
/** And a feed counts as full text when at least this share of its recent items are. */
const FULL_TEXT_SHARE = 0.5;
const articleChars = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().length;

/** Whether a fetched feed's recent items are mostly full articles. */
export function carriesFullText(feed) {
  const recent = (feed.items || []).slice(0, 10);
  if (!recent.length) return false;
  return recent.filter((item) => articleChars(item.html) >= FULL_ARTICLE_CHARS).length / recent.length >= FULL_TEXT_SHARE;
}

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
      fullText: carriesFullText(feed),
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
 * @param {boolean} [options.requireFullText] Leave out feeds that now carry
 *   only summaries (default: for the real directory).
 */
export async function discoverFeeds({ following = [], fresh = false, fetcher = fetchFeed, directory = DIRECTORY, requireFullText } = {}) {
  const usingDefaults = fetcher === fetchFeed && directory === DIRECTORY;
  // The real directory offers only feeds that still carry full articles.
  const onlyFullText = requireFullText ?? usingDefaults;
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
      // A feed that now sends only summaries is left out (one that is down
      // still shows, as unavailable, as before).
      .filter((p) => !onlyFullText || !p.ok || p.fullText)
      .map(({ group, ...p }) => ({ ...p, following: followed.has(normalizeUrl(p.url)) })),
  }));
}
