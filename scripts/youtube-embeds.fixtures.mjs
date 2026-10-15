#!/usr/bin/env node
// ---------------------------------------------------------------------------
// youtube-embeds.fixtures.mjs -- fixture tests for the embed placement
// engine in youtube-embeds.mjs. Synthetic bodies only; the engine was
// additionally differentially tested against the jsdom reference
// implementation across all 50 real post bodies (identical insertion
// points on all 39 jobs, Oct 15, 2026).
//
// Run: node scripts/youtube-embeds.fixtures.mjs   (exit 1 on failure)
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitBlocks, textOf, embedHtml, chooseInsertion, applyJob, checkInvariants } from './youtube-embeds.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ok -', name); } else { fail++; console.log('  FAIL -', name); } };
const p = (txt) => `<p>${txt}</p>`;
const words = n => Array(n).fill('word').join(' '); // n words, no-whitespace length 4n

console.log('embed markup:');
{
  const html = embedHtml('ABCDEFGHIJK');
  check('wrapper class + iframe src', html.includes('class="ql-video-wrapper"') && html.includes('src="https://www.youtube.com/embed/ABCDEFGHIJK"'));
  check('no share-tracking param', !html.includes('?si='));
  check('responsive 16:9 wrapper', html.includes('padding-bottom: 56.25%'));
}

console.log('block splitting:');
{
  const body = p(words(5)) + '\n' + '<p><img src="a.jpg"></p>' + '<ul><li>one</li><li>two</li></ul>' + embedHtml('OLDEMPTY123'.slice(0, 11));
  const { blocks, loose } = splitBlocks(body);
  check('four top-level blocks (list counts as one)', blocks.length === 4);
  check('no loose text', loose === false);
  const looseBody = 'stray text' + p(words(3));
  check('loose top-level text detected', splitBlocks(looseBody).loose === true);
  check('textOf strips tags and decodes entities', textOf('<p>Fish &amp; Chips &#8212; ok</p>') === 'Fish & Chips — ok');
}

console.log('placement rules:');
{
  // Six equal paragraphs (100 chars each): halfway boundary is before block 3 (50%).
  const body = [100, 100, 100, 100, 100, 100].map(n => p(words(25))).join('');
  // words(25) = 25 words * 4 chars = 100 non-space chars
  const { blocks } = splitBlocks(body);
  const pick = chooseInsertion(blocks);
  check('equal paragraphs: first valid boundary at exactly 50%', pick && pick.index === 3 && Math.abs(pick.frac - 0.5) < 0.001 && pick.via === 'first-valid');
}
{
  // An h2 inside the 50-80% window wins over an earlier plain boundary.
  const blocks = [p(words(40)), p(words(40)), p(words(5)), '<h2>Heading</h2>', p(words(40)), p(words(40))];
  // lens: 160,160,20,7,160,160 total 667. boundaries: after b1=160(24%), b2=320(48%), b3=340(51%, next is h2) -> before-h2
  const pick = chooseInsertion(blocks);
  check('h2 preference inside the window', pick && pick.via === 'before-h2' && blocks[pick.index].startsWith('<h2'));
}
{
  // A photo at the halfway point disqualifies the boundary right after it:
  // both neighbors of an insertion must be non-photo.
  const photo = '<p><img src="x.jpg"></p>';
  const blocks = [p(words(70)), photo, p(words(10)), p(words(60))];
  // text lens: 280, 0, 40, 240 (total 560). The boundary right after the photo
  // sits at 280/560 = 50% but its previous block is the photo -> invalid.
  // The next boundary (320/560 = 57%) has text blocks on both sides -> chosen.
  const pick = chooseInsertion(blocks);
  check('photo neighbor disqualifies the boundary', pick && pick.index === 3);
  check('insertion never adjacent to the photo block', pick && !blocks[pick.index - 1].includes('<img') && !blocks[pick.index].includes('<img'));
}

console.log('applyJob modes and guards:');
{
  const body = [p(words(30)), p(words(30)), p(words(30)), p(words(30))].join('');
  const r = applyJob(body, { slug: 'x', videoId: 'ABCDEFGHIJK', mode: 'new' });
  check('new embed inserts exactly one iframe', !r.error && (r.body.match(/youtube\.com\/embed\//g) || []).length === 1);
  const inv = checkInvariants(body, r.body);
  check('invariants hold after insertion', inv.textSame && inv.imgsSame);
  const again = applyJob(r.body, { slug: 'x', videoId: 'ZZZZZZZZZZZ', mode: 'new' });
  check('new-mode refuses a body that already has an embed', again.error === 'new-mode-but-embed-already-present');
}
{
  const withOld = [p(words(30)), embedHtml('OLDVIDEO123'.slice(0, 11)), p(words(30)), p(words(30)), p(words(30))].join('');
  const r = applyJob(withOld, { slug: 'x', videoId: 'NEWVIDEO123'.slice(0, 11), mode: 'replace' });
  check('replace applies without error', !r.error);
  check('replace result has old id gone and exactly one embed', !r.error && !r.body.includes('OLDVIDEO123') && (r.body.match(/youtube\.com\/embed\//g) || []).length === 1);
  const noEmbed = applyJob(p(words(10)), { slug: 'x', videoId: 'ABCDEFGHIJK', mode: 'replace' });
  check('replace-mode refuses a body with no embed', noEmbed.error === 'replace-mode-but-no-existing-embed');
  const loose = applyJob('loose' + p(words(10)), { slug: 'x', videoId: 'ABCDEFGHIJK', mode: 'new' });
  check('loose top-level text refuses', loose.error === 'loose-top-level-text');
}

console.log('jobs table:');
{
  const doc = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'youtube-embeds.jobs.json'), 'utf8'));
  const jobs = doc.jobs;
  check('39 jobs', jobs.length === 39);
  check('slugs unique', new Set(jobs.map(j => j.slug)).size === 39);
  check('35 new + 4 replace', jobs.filter(j => j.mode === 'new').length === 35 && jobs.filter(j => j.mode === 'replace').length === 4);
  check('every videoId is 11 chars', jobs.every(j => /^[A-Za-z0-9_-]{11}$/.test(j.videoId)));
  check('replacements name the video they remove', jobs.filter(j => j.mode === 'replace').every(j => /^[A-Za-z0-9_-]{11}$/.test(j.replaces || '')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
