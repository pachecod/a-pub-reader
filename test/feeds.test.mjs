// RSS/Atom parsing, feed storage, and composing a feed into chapters.
//
// Fixtures rather than live feeds: the point is to pin down the variations
// publishers actually ship — RSS 2.0, Atom, RDF, `content:encoded` vs
// `description`, double-encoded entities, missing dates — none of which a
// single live feed would exercise.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { composeFeedHtml, decodeEntities, demoteHeadings, parseFeed } from '../lib/rss.mjs';
import { FeedStore, feedFilename, normalizeUrl, FEED_FOLDER } from '../lib/feeds.mjs';
import { extractArticle } from '../lib/extract.mjs';
import { DIRECTORY, discoverFeeds } from '../lib/discover.mjs';
import { buildEpub } from '../lib/epub.mjs';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

// ------------------------------------------------------------ RSS 2.0

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Newhouse News</title>
    <link>https://example.edu/news</link>
    <description>Reporting from the school</description>
    <item>
      <title>Second story</title>
      <link>https://example.edu/news/second</link>
      <pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
      <dc:creator>Dana Reyes</dc:creator>
      <description>A short teaser only.</description>
      <content:encoded><![CDATA[<p>The full body of the second story, which is much longer than the teaser.</p>]]></content:encoded>
    </item>
    <item>
      <title>Third story</title>
      <guid isPermaLink="true">https://example.edu/news/third</guid>
      <pubDate>Mon, 31 Aug 2026 08:00:00 GMT</pubDate>
      <description>Third story body.</description>
    </item>
    <item>
      <title>Newest story</title>
      <link>https://example.edu/news/newest</link>
      <pubDate>Wed, 02 Sep 2026 09:00:00 GMT</pubDate>
      <description>Newest story body.</description>
    </item>
  </channel>
</rss>`;

console.log('== RSS 2.0 ==');
const rss = parseFeed(RSS2);
assert(rss.title === 'Newhouse News', `channel title: ${rss.title}`);
assert(rss.link === 'https://example.edu/news', 'channel link');
assert(rss.items.length === 3, `all items parsed (${rss.items.length})`);
assert(
  rss.items.map((i) => i.title).join(' | ') === 'Newest story | Second story | Third story',
  `sorted newest first: ${rss.items.map((i) => i.title).join(' | ')}`
);

const second = rss.items.find((i) => i.title === 'Second story');
assert(/full body of the second story/.test(second.html), 'content:encoded preferred over the teaser');
assert(!/short teaser/.test(second.html), 'the teaser is not used when full content exists');
assert(second.author === 'Dana Reyes', `dc:creator read as the author: ${second.author}`);
assert(second.date instanceof Date && second.date.getUTCFullYear() === 2026, 'pubDate parsed');

const third = rss.items.find((i) => i.title === 'Third story');
assert(third.link === 'https://example.edu/news/third', 'a permalink guid stands in for a missing link');

// ------------------------------------------------------------ Atom

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>The Example</title>
  <subtitle>Tech, mostly</subtitle>
  <link rel="self" href="https://example.com/feed.xml"/>
  <link rel="alternate" href="https://example.com/"/>
  <entry>
    <title>An Atom entry</title>
    <link rel="edit" href="https://example.com/edit/1"/>
    <link rel="alternate" href="https://example.com/post/1"/>
    <published>2026-09-01T12:00:00Z</published>
    <author><name>Sam Ito</name></author>
    <summary>Just the summary.</summary>
    <content type="html">&lt;p&gt;The full Atom content, longer than the summary.&lt;/p&gt;</content>
  </entry>
</feed>`;

console.log('\n== Atom ==');
const atom = parseFeed(ATOM);
assert(atom.title === 'The Example', `feed title: ${atom.title}`);
assert(atom.link === 'https://example.com/', `alternate link preferred over self: ${atom.link}`);
assert(atom.items.length === 1, 'entry parsed');
assert(atom.items[0].link === 'https://example.com/post/1', `rel=alternate link chosen: ${atom.items[0].link}`);
assert(atom.items[0].author === 'Sam Ito', 'nested author/name read');
assert(/full Atom content/.test(atom.items[0].html), 'content preferred over summary');
assert(atom.items[0].date?.getUTCMonth() === 8, 'published date parsed');

// ------------------------------------------------------------ RSS 1.0 / RDF

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://old.example/feed">
    <title>Old School</title>
    <link>https://old.example</link>
  </channel>
  <item rdf:about="https://old.example/1">
    <title>An RDF item</title>
    <link>https://old.example/1</link>
    <dc:date>2026-08-30T00:00:00Z</dc:date>
    <description>RDF body text.</description>
  </item>
</rdf:RDF>`;

console.log('\n== RSS 1.0 (RDF) ==');
const rdf = parseFeed(RDF);
assert(rdf.title === 'Old School', `channel title from RDF: ${rdf.title}`);
assert(rdf.items.length === 1, 'items that sit outside <channel> are still found');
assert(rdf.items[0].date?.getUTCDate() === 30, 'dc:date parsed');

// ------------------------------------------------------------ entities

console.log('\n== entity decoding ==');
assert(decodeEntities('OpenAI&#8217;s') === 'OpenAI’s', 'numeric entity decoded');
assert(decodeEntities('a &amp;#8217; b') === 'a ’ b', 'double-encoded entity decoded (publishers do this)');
assert(decodeEntities('&#x2014;') === '—', 'hex entity decoded');
assert(decodeEntities('caf&eacute;') === 'café', 'named entity decoded');
assert(decodeEntities('5 &lt; 6') === '5 < 6', 'lt decoded');
assert(decodeEntities('&notareal;') === '&notareal;', 'unknown entity left alone');
assert(decodeEntities('') === '', 'empty input is safe');

const DOUBLE = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
  <item><title>Ada&amp;#8217;s Feed &amp;amp; More</title><description>x</description></item>
</channel></rss>`;
assert(
  parseFeed(DOUBLE).items[0].title === 'Ada’s Feed & More',
  `titles are decoded during parse: ${parseFeed(DOUBLE).items[0].title}`
);

// ------------------------------------------------------------ heading demotion

console.log('\n== heading demotion ==');
assert(demoteHeadings('<h1>A</h1>') === '<h3>A</h3>', 'h1 demoted past the split threshold');
assert(demoteHeadings('<h2>B</h2>') === '<h3>B</h3>', 'h2 demoted past the split threshold');
assert(demoteHeadings('<h3>C</h3>') === '<h4>C</h4>', 'h3 shifted down one');
assert(demoteHeadings('<h6>F</h6>') === '<p><strong>F</strong></p>', 'h6 becomes a bold paragraph');
assert(
  demoteHeadings('<h1 class="wp-block-heading">G</h1>') === '<h3 class="wp-block-heading">G</h3>',
  'attributes survive demotion'
);
assert(!/<h[12]\b/.test(demoteHeadings('<h1>a</h1><h2>b</h2><h3>c</h3>')), 'nothing is left at h1 or h2');

// ------------------------------------------------------------ compose + build

console.log('\n== compose into chapters ==');
const composed = composeFeedHtml(rss, rss.items);
const h2Count = (composed.match(/<h2>/g) || []).length;
assert(h2Count === 3, `one h2 per item (${h2Count})`);
assert(/summary only/.test(composed), 'items that were not hydrated say so');
assert(/https:\/\/example.edu\/news\/newest/.test(composed), 'source link included');

const article = await extractArticle({
  html: `<!DOCTYPE html><body>${composed}</body>`,
  fragment: true,
  includeImages: false,
});
article.title = 'Newhouse News';
assert(article.chapters.length === 3, `one chapter per item (${article.chapters.length})`);
assert(
  article.chapters.map((c) => c.title).join(' | ') === 'Newest story | Second story | Third story',
  `chapter titles are the item titles: ${article.chapters.map((c) => c.title).join(' | ')}`
);

// An item whose own body carries an h1 must not split into two chapters.
const withHeading = [...rss.items];
withHeading[0] = { ...withHeading[0], html: '<h1>Inner heading</h1><p>Body.</p>' };
const nested = await extractArticle({
  html: `<!DOCTYPE html><body>${composeFeedHtml(rss, withHeading)}</body>`,
  fragment: true,
  includeImages: false,
});
assert(nested.chapters.length === 3, `an item containing its own h1 stays one chapter (${nested.chapters.length})`);
assert(/<h3>Inner heading<\/h3>/.test(nested.chapters[0].body), 'the inner heading survives as a subheading');

const epub = await buildEpub(article);
const zip = await JSZip.loadAsync(epub.buffer);
let xmlOk = true;
for (const name of Object.keys(zip.files).filter((n) => /\.(xhtml|opf|ncx|xml)$/.test(n))) {
  const text = await zip.file(name).async('string');
  try {
    if (new JSDOM(text, { contentType: 'application/xml' }).window.document.querySelector('parsererror')) xmlOk = false;
  } catch {
    xmlOk = false;
  }
}
assert(xmlOk, 'the feed EPUB is valid XML throughout');

// ------------------------------------------------------------ bad input

console.log('\n== rejected input ==');
for (const [label, xml] of [
  ['an HTML page', '<!DOCTYPE html><html><body><h1>Not a feed</h1></body></html>'],
  ['unrelated XML', '<?xml version="1.0"?><catalog><book/></catalog>'],
  ['empty string', ''],
  ['plain text', 'just some text'],
]) {
  let rejected = false;
  let message = '';
  try {
    parseFeed(xml);
  } catch (err) {
    rejected = true;
    message = err.message;
  }
  assert(rejected, `${label} is rejected: ${message.slice(0, 60)}`);
}

// A feed with zero items parses — the refresh path reports that separately.
const EMPTY = '<?xml version="1.0"?><rss version="2.0"><channel><title>Quiet</title></channel></rss>';
assert(parseFeed(EMPTY).items.length === 0, 'a feed with no items parses to an empty list');

// ------------------------------------------------------------ store

console.log('\n== feed store ==');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epub-drop-feeds-'));
const store = new FeedStore(path.join(dir, 'feeds.json'));

assert(FEED_FOLDER === '/A-pub Feeds', `feeds have their own folder: ${FEED_FOLDER}`);
assert((await store.list()).length === 0, 'a new store is empty');

const first = await store.add({ url: 'example.com/feed' });
assert(first.added === true && first.feed.url === 'https://example.com/feed', `URL normalized: ${first.feed.url}`);
assert(first.feed.lastFilename === null, 'nothing is recorded as delivered yet');

const dupe = await store.add({ url: 'https://example.com/feed/' });
assert(dupe.added === false && dupe.feed.id === first.feed.id, 'a trailing slash is the same feed, not a duplicate');
assert((await store.list()).length === 1, 'no duplicate record was written');

const clamped = await store.add({ url: 'https://other.example/rss', limit: 999 });
assert(clamped.feed.limit === 50, `an absurd limit is clamped (${clamped.feed.limit})`);
const low = await store.update(clamped.feed.id, { limit: 0 });
assert(low.limit === 1, `a zero limit is clamped up (${low.limit})`);

const updated = await store.update(first.feed.id, { lastFilename: 'Feed - 2026-09-02.epub', fullText: false });
assert(updated.lastFilename === 'Feed - 2026-09-02.epub', 'the delivered filename is remembered');
assert(updated.fullText === false, 'the full-text option persists');
assert(updated.id === first.feed.id, 'the id is never overwritten by a patch');

let missing = false;
try {
  await store.update('not-a-real-id', { limit: 5 });
} catch {
  missing = true;
}
assert(missing, 'updating an unknown feed errors');

assert((await store.remove(first.feed.id)) === true, 'remove works');
assert((await store.remove(first.feed.id)) === false, 'removing twice reports false');
assert((await store.list()).length === 1, 'the other feed is untouched');

let blank = false;
try {
  await store.add({ url: '   ' });
} catch {
  blank = true;
}
assert(blank, 'a blank URL is refused');

console.log('\n== filenames and URLs ==');
const when = new Date(2026, 8, 2);
assert(feedFilename('Newhouse News', when) === 'Newhouse News - 2026-09-02.epub', 'dated filename');
assert(feedFilename('A/B: Testing?', when) === 'A-B- Testing- - 2026-09-02.epub', 'reserved characters replaced');
assert(feedFilename('', when) === 'Feed - 2026-09-02.epub', 'an empty title falls back');
assert(feedFilename('x'.repeat(200), when).length < 90, 'long titles are shortened');
assert(
  feedFilename('Feed', new Date(2026, 8, 2)) !== feedFilename('Feed', new Date(2026, 8, 3)),
  'a different day produces a different filename, so the old one can be replaced'
);
assert(normalizeUrl('not a url') === '', 'an unparseable URL normalizes to empty');
assert(normalizeUrl('http://x.test/a/') === 'http://x.test/a', 'trailing slash dropped');

// ------------------------------------------------------------ find feeds

const allDirectory = DIRECTORY.flatMap((g) => g.feeds);
assert(allDirectory.length >= 20, `the directory offers a real choice: ${allDirectory.length} feeds`);
assert(allDirectory.every((f) => /^https?:\/\//.test(f.url) && f.name && f.about), 'every entry has a URL, a name and a description');
assert(new Set(allDirectory.map((f) => normalizeUrl(f.url))).size === allDirectory.length, 'no feed is listed twice');

const fakeDirectory = [
  { group: 'One', feeds: [
    { name: 'Alive', url: 'https://alive.test/feed/', about: 'works' },
    { name: 'Dead', url: 'https://dead.test/feed', about: 'broken' },
  ] },
  { group: 'Two', feeds: [{ name: 'Followed', url: 'https://followed.test/rss', about: 'saved already' }] },
];
const fakeFetch = async (url) => {
  if (url.includes('dead')) throw new Error('Feed returned HTTP 503.');
  return { title: url, items: [{ title: `Newest from ${url}`, date: new Date('2026-10-16T12:00:00Z') }] };
};
const discovered = await discoverFeeds({
  directory: fakeDirectory,
  fetcher: fakeFetch,
  following: ['https://followed.test/rss/'],
});
const byName = Object.fromEntries(discovered.flatMap((g) => g.feeds).map((f) => [f.name, f]));
assert(discovered.map((g) => g.group).join(',') === 'One,Two', 'groups come back in directory order');
assert(byName.Alive.ok && byName.Alive.latest.title === 'Newest from https://alive.test/feed/', 'a working feed reports its latest headline');
assert(byName.Dead.ok === false && /503/.test(byName.Dead.error), 'a broken feed is reported, not thrown');
assert(byName.Followed.following === true, 'a saved feed is recognised despite a trailing slash');
assert(byName.Alive.following === false, 'an unsaved feed is not marked as followed');

await fs.rm(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
