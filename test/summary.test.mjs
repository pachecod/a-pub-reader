// The Read tab's summaries: an article's byline and opening, picked out of the
// HTML feeds produce, skipping the captions, standfirsts and bios that often
// come first.

import { excerpt, summarizeArticle } from '../lib/summary.mjs';

let pass = 0;
let fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? pass++ : fail++;
};

const story = 'CHUNCHEON, South Korea — "Is the Frankenstein monster human?" a teacher asks students at a public elementary school some fifty miles east of Seoul.';

const plain = summarizeArticle(`<h2>Headline</h2><p><em>Anthony Kuhn · Nov 9, 2026</em></p><p>${story}</p>`);
assert(plain.byline === 'Anthony Kuhn · Nov 9, 2026', `the italic "Author · Date" line is the byline: ${plain.byline}`);
assert(plain.excerpt.startsWith('CHUNCHEON'), 'the first story paragraph is the opening');

const captioned = summarizeArticle(
  `<p><em>Reporter · Nov 9, 2026 · summary only</em></p>` +
    `<p class="cp-meta"><em>A long standfirst that the feed marks as metadata rather than the story itself, which should be skipped.</em></p>` +
    `<p>Student Ma Yeonwoo raises his hand during a seminar about Frankenstein. Anthony Kuhn/NPR hide caption</p>` +
    `<p>Short.</p><p>${story}</p>`
);
assert(captioned.byline === 'Reporter · Nov 9, 2026', '"summary only" is dropped from the byline');
assert(captioned.excerpt.startsWith('CHUNCHEON'), 'standfirsts, photo captions and very short lines are skipped');

const bio = summarizeArticle(
  `<p><em>Jess Weatherbed · Nov 9, 2026</em></p>` +
    `<p>Jess Weatherbed is a news writer focused on creative industries, computing, and internet culture.</p><p>${story}</p>`
);
assert(bio.excerpt.startsWith('CHUNCHEON'), "a paragraph opening with the writer's name (a bio) is skipped");

const repeated = summarizeArticle(`<p>Google sues to block a law ${story}</p>`, 'Google sues to block a law');
assert(repeated.excerpt.startsWith('CHUNCHEON'), 'a headline repeated as the first words is trimmed');

const long = excerpt('word '.repeat(100), 50);
assert(long.length <= 51 && long.endsWith('…'), `long openings are cut at a word with an ellipsis: ${long.length} chars`);
assert(excerpt('Short and complete.') === 'Short and complete.', 'short ones are left whole');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
