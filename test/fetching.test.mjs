// Fetching politely: the app's own user agent, conditional requests for feeds
// (ETag / Last-Modified), pictures named in feeds, and a feed parser that
// refuses XML entity tricks. Against a small local site.

import http from 'node:http';

import * as rss from '../lib/rss.mjs';
import { configureUserAgent, userAgent } from '../lib/useragent.mjs';

const { fetchFeed, parseFeed } = rss;

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`PASS  ${msg}`);
  } else {
    fail++;
    console.log(`FAIL  ${msg}`);
  }
};

console.log('== the user agent ==');
assert(/^A-PubReader\/2\.0 \(\+https:\/\/github\.com\/pachecod\/a-pub-reader\)$/.test(userAgent()), `the app names itself, with a link (${userAgent()})`);
configureUserAgent({ siteUrl: 'https://reader.example.org/' });
assert(userAgent() === 'A-PubReader/2.0 (+https://reader.example.org/about/fetching)', 'hosted, it links to that install’s About fetching page');
assert(!/Mozilla|Chrome|Safari/.test(userAgent()), 'and does not pretend to be a browser');

// ------------------------------------------------------------ a local site

const hits = [];
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Local News</title><link>http://127.0.0.1/</link>
<item><title>Open story</title><link>LINK/open/1</link><description>teaser one</description></item>
<item><title>Blocked story</title><link>LINK/blocked/2</link><description>teaser two</description></item>
</channel></rss>`;
const ARTICLE = (title) => `<html><head><title>${title}</title></head><body><article><h1>${title}</h1>${'<p>A full paragraph of the article, long enough to be the body. </p>'.repeat(8)}</article></body></html>`;

const server = http.createServer((req, res) => {
  hits.push({ path: req.url, ua: req.headers['user-agent'], inm: req.headers['if-none-match'] || '', ims: req.headers['if-modified-since'] || '' });
  if (req.url === '/feed.xml') {
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"v1"', 'last-modified': 'Mon, 09 Nov 2026 12:00:00 GMT' });
    return res.end(FEED.replaceAll('LINK', `http://127.0.0.1:${server.address().port}`));
  }
  if (req.url.startsWith('/open/') || req.url.startsWith('/blocked/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(ARTICLE(req.url));
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  console.log('\n== conditional feed requests ==');
  const first = await fetchFeed(`${base}/feed.xml`);
  assert(first.items.length === 2 && first.etag === '"v1"' && first.lastModified.startsWith('Mon, 09 Nov'), 'a feed comes back with its ETag and Last-Modified');
  assert(hits.at(-1).ua === userAgent(), 'fetched with the app’s own user agent');
  const again = await fetchFeed(`${base}/feed.xml`, { etag: first.etag, lastModified: first.lastModified });
  assert(again.notModified === true, 'asked again with them, an unchanged feed answers 304 and is reused');
  assert(hits.at(-1).inm === '"v1"' && hits.at(-1).ims === first.lastModified, 'If-None-Match and If-Modified-Since were sent');

  console.log('\n== never the articles’ own pages ==');
  assert(!('hydrateItems' in rss), 'the feed code has no way to fetch an article’s page');
  assert(!hits.some((h) => h.path.startsWith('/open/') || h.path.startsWith('/blocked/')), 'and no article page was requested');
} finally {
  server.close();
}

console.log('\n== pictures from the feed ==');
{
  const feed = parseFeed(`<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>T</title>
    <item><title>Media content</title><link>https://news.example/a</link><media:content url="https://img.example/small.jpg" medium="image" width="240"/><media:content url="https://img.example/big.jpg" medium="image" width="1200"/><media:content url="https://video.example/clip.mp4" type="video/mp4"/></item>
    <item><title>Thumbnail in a group</title><link>https://news.example/b</link><media:group><media:thumbnail url="/thumbs/b.jpg" width="320"/></media:group></item>
    <item><title>Enclosure</title><link>https://news.example/c</link><enclosure url="https://img.example/c.png" type="image/png" length="1"/></item>
    <item><title>In the text</title><link>https://news.example/d</link><description><![CDATA[<img src="https://track.example/p.gif" width="1" height="1"><p>Hi</p><img src="https://img.example/d.jpg" width="600">]]></description></item>
    <item><title>None</title><link>https://news.example/e</link><description>Just words.</description></item>
  </channel></rss>`);
  const images = feed.items.map((i) => i.image);
  assert(images[0] === 'https://img.example/big.jpg', 'media:content: the largest picture, never a video');
  assert(images[1] === 'https://news.example/thumbs/b.jpg', 'media:thumbnail inside a group, made absolute');
  assert(images[2] === 'https://img.example/c.png', 'an image enclosure');
  assert(images[3] === 'https://img.example/d.jpg', 'otherwise the first real picture in the text, skipping tracking pixels');
  assert(images[4] === '', 'and nothing when the feed gives none');
}

console.log('\n== XML entity tricks ==');
const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>`;
const laughs = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><rss><channel><title>&c;</title></channel></rss>`;
const refused = (xml) => {
  try {
    parseFeed(xml);
    return false;
  } catch {
    return true;
  }
};
assert(refused(xxe), 'a feed reaching for an external file (XXE) is refused, not read');
assert(refused(laughs), 'a feed expanding entities into each other ("billion laughs") is refused');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
