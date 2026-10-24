// Tests for the photo-op duplicate guard (Item 25, Oct 23 2026).
// Beau's rule: "we can't have the same photo twice in a photo op."
// Two distinct bundle-covered spots can resolve to ONE bundled file
// (until Item 27 restored the Rock Spires photo, "Galaxy's Edge Rock
// Spires" and "Millennium Falcon Plaza" both mapped to
// millennium-falcon-plaza-tpcp.jpg). Neither layer may show it twice:
//
// (a) Compose time (api/scaffold.js deterministicBackfill): picks are
//     deduped on the RESOLVED FILE, never the spot key. Fall-through
//     reaches only spots that scored above zero on the existing
//     near-land + time-of-day rubric; below that the card composes
//     single-pick and the prose goes singular by construction.
// (b) Render time (app.html bundledPhotosInfo): within one card, a
//     link whose resolved file already rendered is dropped; when a
//     drop happens the card's prose swaps to the generic singular
//     lead (tpcpPhotoNoteForCard) so two-shot prose never stands over
//     one photo, and the drop is counted once per card as the
//     tripwire surfaced in the Info readouts (tpcpPhotoDupDropsHtml).
//
// The composer tests import the REAL scaffold module; the renderer
// tests extract the REAL photo region + fixEncoding from app.html and
// drive them in a vm, mirroring the other client suites.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/photo-op-dedupe.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { deterministicBackfill } from '../api/scaffold.js';

// ---------------------------------------------------------------------
// (a) Composer fixtures
// ---------------------------------------------------------------------
const spot = (name, land, bestTime, short) => ({
  name, park: 'Disneyland', land, bestTime, short,
  shot: 'Stand with the spot behind your group and face the camera.',
});
const GEAR = "Star Wars: Galaxy's Edge";
const rockSpires = () => spot("Galaxy's Edge Rock Spires", GEAR, 'Golden hour', 'Black Spire Outpost path with Batuu rock spires behind');
const falconPlaza = () => spot('Millennium Falcon Plaza', GEAR, 'Golden hour', 'Millennium Falcon plaza with the full ship behind you');
const partners = () => spot('Partners Statue', 'Main Street, U.S.A.', 'Golden hour', 'Partners statue with the castle behind');

const pmSlot = { block: 'photoPM', type: 'break', park: 'Disneyland', window: [1110, 1170], breakTitle: 'Photo Op & Shopping Break' };
const middaySlot = { block: 'photoMidday', type: 'break', park: 'Disneyland', window: [710, 740], breakTitle: 'Photo Op' };
const labels = (card) => (card.photoLinks || []).map(l => l.label);

// The pre-restore bundle shape: both Galaxy's Edge spots resolved to
// the one Falcon file. Item 27 (Oct 23, 2026) restored the vetted Rock
// Spires photo, so the REAL manifest no longer holds a same-file pair
// and the composer legitimately picks both GE spots (pinned by the
// (a)(restored) test below, against the real manifest). The same-file
// fixtures inject this map via ctx.photoCovered so the dedupe rule
// itself stays exercised exactly as Item 25 built it.
const PRE_RESTORE_COVERED = {
  'galaxy s edge rock spires': 'millennium-falcon-plaza-tpcp.jpg',
  'millennium falcon plaza': 'millennium-falcon-plaza-tpcp.jpg',
  'partners statue': 'partners-statue.jpg',
  'snow white s wishing well grotto': 'snow-whites-wishing-well-grotto.jpg',
};

test('(a)(i) top two spots share one file: falls through to the next above-rubric distinct-file spot', () => {
  const card = deterministicBackfill(pmSlot, { photoSpots: [rockSpires(), falconPlaza(), partners()], nearLand: GEAR, photoCovered: PRE_RESTORE_COVERED });
  assert.deepEqual(labels(card), ["Galaxy's Edge Rock Spires", 'Partners Statue']);
  assert.ok(card.n.startsWith('Two easy shots nearby: '), card.n);
  assert.ok(card.n.includes('Batuu rock spires'), card.n);
  assert.ok(card.n.includes('Partners statue'), card.n);
  assert.ok(!card.n.includes('full ship'), 'dropped spot phrase leaked into prose: ' + card.n);
});

test('(a)(ii) same-file spots and no other above-rubric spot: single-pick card, singular prose', () => {
  const card = deterministicBackfill(pmSlot, { photoSpots: [rockSpires(), falconPlaza()], nearLand: GEAR, photoCovered: PRE_RESTORE_COVERED });
  assert.deepEqual(labels(card), ["Galaxy's Edge Rock Spires"]);
  assert.ok(card.n.startsWith('An easy shot nearby: '), card.n);
  assert.ok(card.n.includes('Batuu rock spires'), card.n);
  assert.ok(!card.n.includes('full ship'), card.n);
});

test('(a)(ii-midday) single-pick at midday uses the lunch singular lead', () => {
  const rs = rockSpires(); rs.bestTime = 'Any time';
  const fp = falconPlaza(); fp.bestTime = 'Any time';
  const card = deterministicBackfill(middaySlot, { photoSpots: [rs, fp], nearLand: GEAR, photoCovered: PRE_RESTORE_COVERED });
  assert.deepEqual(labels(card), ["Galaxy's Edge Rock Spires"]);
  assert.ok(card.n.startsWith('An easy shot near your lunch spot: '), card.n);
});

test('(a)(ii-gate) fall-through does NOT reach a distinct-file spot at/below the rubric line', () => {
  // Small World facade is a NIGHT spot: on an evening card it scores,
  // so use a morning-only distinct spot instead -- 'Snow White's
  // Wishing Well Grotto' with bestTime 'Morning' scores 0 on a PM card
  // away from its land. The composer must go single-pick rather than
  // pad the card with a shot that does not fit.
  const grotto = spot("Snow White's Wishing Well Grotto", 'Fantasyland', 'Morning', 'Wishing well in the grotto by the castle');
  const card = deterministicBackfill(pmSlot, { photoSpots: [rockSpires(), falconPlaza(), grotto], nearLand: GEAR, photoCovered: PRE_RESTORE_COVERED });
  assert.deepEqual(labels(card), ["Galaxy's Edge Rock Spires"]);
  assert.ok(card.n.startsWith('An easy shot nearby: '), card.n);
});

test('(a)(iii) two distinct-file above-rubric spots: two picks, two-shot prose (unchanged)', () => {
  const mainSt = spot('Main Street Castle Shot', 'Main Street, U.S.A.', 'Golden hour', 'Center of Main Street facing the castle');
  const castleFront = spot('Sleeping Beauty Castle Front', 'Fantasyland', 'Golden hour', 'Castle drawbridge facing Sleeping Beauty Castle');
  const card = deterministicBackfill(pmSlot, { photoSpots: [mainSt, castleFront], nearLand: 'Main Street, U.S.A.' });
  assert.deepEqual(labels(card), ['Main Street Castle Shot', 'Sleeping Beauty Castle Front']);
  assert.ok(card.n.startsWith('Two easy shots nearby: '), card.n);
  assert.ok(card.n.includes('Center of Main Street'), card.n);
  assert.ok(card.n.includes('Castle drawbridge'), card.n);
});

test('(a)(regression) distinct-file second pick is kept even at rubric zero when no fall-through was needed', () => {
  // Pre-fix behavior took the top 2 outright; the dedupe must only
  // change outcomes when a duplicate file forces a fall-through.
  const p = spot('Partners Statue', 'Main Street, U.S.A.', 'Morning', 'Partners statue with the castle behind');
  const grotto = spot("Snow White's Wishing Well Grotto", 'Fantasyland', 'Morning', 'Wishing well in the grotto by the castle');
  const card = deterministicBackfill(pmSlot, { photoSpots: [p, grotto], nearLand: 'Main Street, U.S.A.' });
  assert.deepEqual(labels(card), ['Partners Statue', "Snow White's Wishing Well Grotto"]);
  assert.ok(card.n.startsWith('Two easy shots nearby: '), card.n);
});

test('(a)(restored) Item 27: the GE pair resolves to two files in the real manifest, so both spots pick', () => {
  // No photoCovered override -- the REAL PHOTO_BUNDLE_COVERED. Since
  // the Rock Spires photo was restored, "Galaxy's Edge Rock Spires"
  // and "Millennium Falcon Plaza" are distinct-file picks and a
  // Galaxy's Edge evening card composes a genuine two-pick again.
  const card = deterministicBackfill(pmSlot, { photoSpots: [rockSpires(), falconPlaza()], nearLand: GEAR });
  assert.deepEqual(labels(card), ["Galaxy's Edge Rock Spires", 'Millennium Falcon Plaza']);
  assert.ok(card.n.startsWith('Two easy shots nearby: '), card.n);
  assert.ok(card.n.includes('Batuu rock spires'), card.n);
  assert.ok(card.n.includes('full ship'), card.n);
});

// ---------------------------------------------------------------------
// (b) Renderer: real code extracted from app.html
// ---------------------------------------------------------------------
const appHtml = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const scaffoldSrc = readFileSync(new URL('../api/scaffold.js', import.meta.url), 'utf8');

function sliceRange(startMarker, endMarker) {
  const s = appHtml.indexOf(startMarker);
  assert.ok(s !== -1, 'range start not found: ' + startMarker);
  const e = appHtml.indexOf(endMarker, s + startMarker.length);
  assert.ok(e > s, 'range end not found: ' + endMarker);
  return appHtml.slice(s, e);
}
const SRC = [
  sliceRange('var PHOTO_BUNDLES=', '// Item 7 (Oct 7, 2026): full-screen photo viewer'),
  sliceRange('function fixEncoding(s) {', '\nfunction '),
].join('\n');
assert.ok(SRC.includes('function bundledPhotosInfo(links){'), 'bundledPhotosInfo missing from app.html');
assert.ok(SRC.includes('function tpcpPhotoNoteForCard(note,dropped){'), 'note swap helper missing from app.html');
assert.ok(SRC.includes('function tpcpPhotoDupDropsHtml(){'), 'tripwire readout missing from app.html');

const ctx = vm.createContext({ console });
vm.runInContext(SRC, ctx);
const { bundledPhotosInfo, bundledPhotosHtml, tpcpPhotoNoteForCard, tpcpPhotoDupDropNote, tpcpPhotoDupDropsHtml } = ctx;
assert.equal(typeof bundledPhotosInfo, 'function');
assert.equal(typeof tpcpPhotoNoteForCard, 'function');

// TEST02's stored Day 1 6:30 PM item, verbatim links + note.
const TEST02_GE_LINKS = [
  { label: "Galaxy's Edge Rock Spires", url: 'https://commons.wikimedia.org/wiki/File:Disneyland_2019_-_48856643493.jpg' },
  { label: 'Millennium Falcon Plaza', url: 'https://commons.wikimedia.org/wiki/File:Disneyland_2019_-_48857200537.jpg' },
];
const TEST02_GE_NOTE = 'Two easy shots nearby: Black Spire Outpost path with Batuu rock spires behind, and Millennium Falcon plaza with the full ship behind you.';

test('(b)(iv) TEST02 stored item, post-restore: renders BOTH photos, no drop, prose untouched', () => {
  // Item 27 restored the Rock Spires photo, so the two stored labels
  // now resolve to two distinct files: the render-time guard has
  // nothing to drop, and the card shows both photos under its
  // original two-shot prose (the state Beau asked for).
  const info = bundledPhotosInfo(TEST02_GE_LINKS);
  assert.equal(info.dropped, 0);
  assert.equal((info.html.match(/photo-bundle-img/g) || []).length, 2);
  assert.ok(info.html.includes('galaxys-edge-rock-spires.jpg'));
  assert.ok(info.html.includes('millennium-falcon-plaza-tpcp.jpg'));
  assert.equal(tpcpPhotoNoteForCard(TEST02_GE_NOTE, info.dropped), TEST02_GE_NOTE);
});

test('(b)(iv-dup) a stored item whose links resolve to ONE file renders ONE photo, prose swaps to the generic singular lead', () => {
  // The guard itself, driven with a synthetic same-file pair (two
  // links to the one bundled spot) now that the bundle holds no
  // same-file pair of distinct spots.
  const links = [{ label: 'Millennium Falcon Plaza' }, { label: 'Millennium Falcon Plaza' }];
  const info = bundledPhotosInfo(links);
  assert.equal(info.dropped, 1);
  assert.equal((info.html.match(/photo-bundle-img/g) || []).length, 1);
  assert.equal((info.html.match(/millennium-falcon-plaza-tpcp\.jpg/g) || []).length, 1);
  assert.equal(bundledPhotosHtml(links), info.html, 'bundledPhotosHtml must delegate to the deduped render');
  assert.equal(tpcpPhotoNoteForCard(TEST02_GE_NOTE, info.dropped), 'An easy shot nearby:');
});

test('(b)(iv-tripwire) drops count once per card and surface in the Info readout', () => {
  assert.equal(tpcpPhotoDupDropsHtml(), '', 'readout stays silent at zero');
  tpcpPhotoDupDropNote('0-6-18');
  tpcpPhotoDupDropNote('0-6-18'); // same card re-rendered: still one card
  tpcpPhotoDupDropNote('1-6-18');
  const html = tpcpPhotoDupDropsHtml();
  assert.ok(html.includes('Photo duplicates hidden'), html);
  assert.ok(html.includes('2 cards had the same photo twice'), html);
});

test('(b)(v) distinct-file item renders untouched, prose untouched', () => {
  const links = [{ label: 'Main Street Castle Shot' }, { label: 'Sleeping Beauty Castle Front' }];
  const info = bundledPhotosInfo(links);
  assert.equal(info.dropped, 0);
  assert.equal((info.html.match(/photo-bundle-img/g) || []).length, 2);
  assert.ok(info.html.includes('main-street-castle-shot-tpcp.jpg'));
  assert.ok(info.html.includes('sleeping-beauty-castle-front.jpg'));
  const note = 'Two easy shots nearby: Center of Main Street facing the castle, and Castle drawbridge facing Sleeping Beauty Castle.';
  assert.equal(tpcpPhotoNoteForCard(note, info.dropped), note);
  assert.equal(tpcpPhotoNoteForCard('', 1), '', 'a drop with no note swaps nothing');
});

test('(b)(wiring) the card renderer and Info readouts use the guard', () => {
  assert.ok(appHtml.includes('bundledPhotosInfo(e.photoLinks)'), 'renderer does not call bundledPhotosInfo');
  assert.ok(appHtml.includes('tpcpPhotoNoteForCard(e.n,_phInfo.dropped)'), 'renderer does not swap prose on drop');
  assert.ok(appHtml.includes('if(_phInfo.dropped)tpcpPhotoDupDropNote(_cid);'), 'renderer does not feed the tripwire');
  assert.ok(appHtml.includes("typeof tpcpPhotoDupDropsHtml==='function'"), 'Info readout is not wired');
  assert.ok(scaffoldSrc.includes('coveredMap[photoSpotKey(s.name)]'), 'composer does not resolve picks to files');
  assert.ok(scaffoldSrc.includes('|| PHOTO_BUNDLE_COVERED'), 'composer covered map does not default to the real manifest');
});
