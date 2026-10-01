// api/golden-trip.test.js
// Golden-trip regression suite for the "consistent optimal day" bar.
// Run with: node --test api/golden-trip.test.js
// Uses Node built-in test runner (node:test + node:assert). No external deps, no API calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildSkeleton,
  buildFillPrompt,
  applyFills,
  verifyScaffold,
  closedNamesForDate,
  closureKey,
  diffClosureLists,
  alertIdFor,
  buildCatalogIndex,
  parseCatalogVenues,
  deterministicBackfill,
  verifyTripParams,
  enforceTripParams
} from './scaffold.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, f), 'utf8');
// cron-cache.js canonical mirror lives in tpcp-cache-debug (tpcp-plan/ copy is synced)
const srcCache = (f) => readFileSync(join(here, '..', 'tpcp-cache-debug', f), 'utf8');

const FAKE_CATALOG = [
  { name: 'Space Mountain', park: 'DL', land: 'Tomorrowland', status: 'operating', typicalPeakWait: 45 },
  { name: 'Jungle Cruise', park: 'DL', land: 'Adventureland', status: 'operating', typicalPeakWait: 40 },
  { name: 'Pirates of the Caribbean', park: 'DL', land: 'New Orleans Square', status: 'operating', typicalPeakWait: 35 },
  { name: 'Radiator Springs Racers', park: 'DCA', land: 'Cars Land', status: 'operating', typicalPeakWait: 90 },
];
const FAKE_VENUES = [
  { name: 'Carthay Circle Restaurant', park: 'DCA', land: 'Buena Vista Street', service: 'table', reservationPolicy: 'required', exclude: false },
  { name: 'Flo\u2019s V8 Cafe', park: 'DCA', land: 'Cars Land', service: 'quickservice', reservationPolicy: 'walkup', exclude: false },
];
const landToPark = (l) => {
  const s = String(l || '').toLowerCase();
  if (/cars land|buena vista/.test(s)) return 'DCA';
  if (/tomorrowland|adventureland|new orleans|frontierland|fantasyland/.test(s)) return 'DL';
  return null;
};
function rideSlot(over = {}) {
  return Object.assign({ id: 's01', block: 'ride', type: 'ride', park: 'Disneyland', window: [485, 500], role: 'morning ride' }, over);
}

// ---------------------------------------------------------------------------
// buildSkeleton: deterministic
// ---------------------------------------------------------------------------
test('buildSkeleton: identical config -> identical skeleton', () => {
  const cfg = { park: 'Disneyland', openMin: 480, closeMin: 1380, hasLL: true, dayNum: 1 };
  const a = buildSkeleton(cfg);
  const b = buildSkeleton(cfg);
  assert.deepEqual(a, b);
  assert.ok(a.slots.length > 10, 'skeleton should have many slots, got ' + a.slots.length);
});

// ---------------------------------------------------------------------------
// closedNamesForDate: null-date contract
// ---------------------------------------------------------------------------
test('closedNamesForDate: null closeDate = already closed (builder contract)', () => {
  const closures = [{ name: 'Matterhorn Bobsleds', park: 'DL', status: 'closed_for_refurbishment', closeDate: null, reopenDate: null }];
  assert.deepEqual(closedNamesForDate(closures, '2026-10-15'), ['Matterhorn Bobsleds']);
  assert.deepEqual(closedNamesForDate(JSON.stringify(closures), '2026-10-15'), ['Matterhorn Bobsleds']);
});

test('closedNamesForDate: null closeDate + known reopenDate -> open on/after reopen', () => {
  const closures = [{ name: 'Matterhorn Bobsleds', closeDate: null, reopenDate: '2026-10-10' }];
  assert.deepEqual(closedNamesForDate(closures, '2026-10-09'), ['Matterhorn Bobsleds']);
  assert.deepEqual(closedNamesForDate(closures, '2026-10-10'), []);
  assert.deepEqual(closedNamesForDate(closures, '2026-10-15'), []);
});

test('closedNamesForDate: upcoming dated closure not flagged early; flagged inside window', () => {
  const closures = [{ name: 'Big Thunder Mountain Railroad', closeDate: '2026-12-01', reopenDate: '2027-01-15' }];
  assert.deepEqual(closedNamesForDate(closures, '2026-10-15'), []);
  assert.deepEqual(closedNamesForDate(closures, '2026-12-10'), ['Big Thunder Mountain Railroad']);
  assert.deepEqual(closedNamesForDate(closures, '2027-02-01'), []);
});

test('closedNamesForDate: garbage in -> [] (never throws)', () => {
  assert.deepEqual(closedNamesForDate(null, '2026-10-15'), []);
  assert.deepEqual(closedNamesForDate('not json', '2026-10-15'), []);
  assert.deepEqual(closedNamesForDate([], null), []);
});

// ---------------------------------------------------------------------------
// deterministicBackfill
// ---------------------------------------------------------------------------
test('deterministicBackfill: ride slot gets highest-wait unused operating ride', () => {
  const used = new Set();
  const c1 = deterministicBackfill(rideSlot(), { catalog: FAKE_CATALOG, venues: [], closedNames: [], usedRideKeys: used, usedNames: new Set() });
  assert.equal(c1.h, 'Space Mountain');
  assert.equal(c1.type, 'ride');
  // second call skips the used ride -> deterministic next pick
  const c2 = deterministicBackfill(rideSlot({ id: 's02' }), { catalog: FAKE_CATALOG, venues: [], closedNames: [], usedRideKeys: used, usedNames: new Set() });
  assert.equal(c2.h, 'Jungle Cruise');
});

test('deterministicBackfill: closed rides never picked', () => {
  const c = deterministicBackfill(rideSlot(), {
    catalog: FAKE_CATALOG, venues: [], closedNames: ['Space Mountain', 'Jungle Cruise', 'Pirates of the Caribbean'],
    usedRideKeys: new Set(), usedNames: new Set()
  });
  // no DL ride left unclosed -> falls through to honest tip, never a closed ride
  assert.ok(!/space mountain|jungle cruise|pirates/i.test(c.h), 'picked a closed ride: ' + c.h);
});

test('deterministicBackfill: wrong-park catalog entries never picked', () => {
  const c = deterministicBackfill(rideSlot(), { catalog: FAKE_CATALOG, venues: [], closedNames: [], usedRideKeys: new Set(), usedNames: new Set() });
  assert.notEqual(c.h, 'Radiator Springs Racers');
});

test('deterministicBackfill: same inputs -> same card (no randomness)', () => {
  const mk = () => deterministicBackfill(rideSlot(), { catalog: FAKE_CATALOG, venues: [], closedNames: [], usedRideKeys: new Set(), usedNames: new Set() });
  assert.deepEqual(mk(), mk());
});

test('deterministicBackfill: dining slot picks walkup quickservice over reservation-required table', () => {
  const slot = { id: 's10', block: 'dinner', type: 'dining', park: 'Disney California Adventure', window: [990, 1050], role: 'one dinner' };
  const c = deterministicBackfill(slot, { catalog: [], venues: FAKE_VENUES, closedNames: [], usedRideKeys: new Set(), usedNames: new Set() });
  assert.ok(/v8 cafe/i.test(c.h), 'expected Flo\u2019s V8 Cafe, got ' + c.h);
  assert.equal(c.type, 'dining');
});

test('deterministicBackfill: never emits placeholder text', () => {
  const slots = [
    rideSlot(),
    { id: 's10', block: 'dinner', type: 'dining', park: 'Disneyland', window: [990, 1050], role: 'one dinner' },
    { id: 's02', block: 'llTip', type: 'tip', park: 'Disneyland', window: [420, 455], role: 'book the opening Lightning Lane' },
    { id: 's20', block: 'show', type: 'show', park: 'Disneyland', window: [1200, 1260], role: 'nighttime spectacular' },
  ];
  for (const s of slots) {
    const c = deterministicBackfill(s, { catalog: FAKE_CATALOG, venues: FAKE_VENUES, closedNames: [], usedRideKeys: new Set(), usedNames: new Set() });
    const blob = JSON.stringify(c);
    assert.ok(!/flex time|\(to fill\)|ai could not confirm|open dining choice/i.test(blob), 'placeholder leaked: ' + blob);
    assert.ok(c.h && c.h.length > 0, 'empty title for slot ' + s.id);
  }
});

test('deterministicBackfill: tip slots get role-based titles', () => {
  const c = deterministicBackfill(
    { id: 's02', block: 'llTip', type: 'tip', park: 'Disneyland', window: [420, 455], role: 'book the opening Lightning Lane' },
    { catalog: [], venues: [], closedNames: [], usedRideKeys: new Set(), usedNames: new Set() });
  assert.equal(c.h, 'Lightning Lane check');
});

// ---------------------------------------------------------------------------
// applyFills + backfill integration: no holes survive
// ---------------------------------------------------------------------------
test('applyFills with deterministic backfill: empty fills -> every ride slot filled with a real ride', () => {
  const sk = buildSkeleton({ park: 'Disneyland', openMin: 480, closeMin: 1320, hasLL: false, dayNum: 1 });
  const fb = (slot, f) => deterministicBackfill(slot, {
    catalog: FAKE_CATALOG, venues: FAKE_VENUES, closedNames: [],
    usedRideKeys: f.usedRideKeys, usedNames: f.usedNames
  });
  const { cards, report } = applyFills(sk, [], { landToPark, closedNames: [], fallbackFor: fb });
  assert.equal(cards.length, sk.slots.length);
  const rideSlots = sk.slots.filter(s => s.type === 'ride');
  assert.ok(rideSlots.length > 5, 'expected several ride slots');
  for (const card of cards) {
    const blob = JSON.stringify(card);
    assert.ok(!/flex time|\(to fill\)|ai could not confirm|open dining choice/i.test(blob), 'placeholder leaked: ' + blob);
  }
  assert.ok(report.fallback > 0, 'expected fallbacks to have fired');
});

test('applyFills: generic fill on a ride slot is dropped and retried, not shipped', () => {
  const sk = buildSkeleton({ park: 'Disneyland', openMin: 480, closeMin: 1320, hasLL: false, dayNum: 1 });
  const rideSlot0 = sk.slots.find(s => s.type === 'ride');
  const fills = [{ id: rideSlot0.id, t: '8:10 AM', h: 'Free time', type: 'ride', land: 'Fantasyland', n: 'wander around' }];
  const fb = (slot, f) => deterministicBackfill(slot, {
    catalog: FAKE_CATALOG, venues: [], closedNames: [],
    usedRideKeys: f.usedRideKeys, usedNames: f.usedNames
  });
  const { cards, needsRetry } = applyFills(sk, fills, { landToPark, closedNames: [], fallbackFor: fb });
  assert.ok(needsRetry.includes(rideSlot0.id), 'generic fill should need retry');
  const card = cards.find(c => c.t === cards[sk.slots.indexOf(rideSlot0)].t);
  assert.ok(!/free time/i.test(card.h), 'generic fill shipped: ' + card.h);
});

// ---------------------------------------------------------------------------
// verifyTripParams + enforceTripParams
// ---------------------------------------------------------------------------
test('verifyTripParams: detects mustdo-missing, skip-present, ll-when-none', () => {
  const cards = [
    { t: '8:05 AM', h: 'Space Mountain', type: 'ride', n: '', land: 'Tomorrowland', ride: 'Space Mountain' },
    { t: '9:00 AM', h: "It's a Small World", type: 'ride', n: '', land: 'Fantasyland' },
    { t: '10:00 AM', h: 'Book Space Mountain via Lightning Lane', type: 'tip', n: '', land: 'Tomorrowland', ll: { t: 'multi', a: 'x' } },
  ];
  const v = verifyTripParams(cards, { mustDo: ['Big Thunder Mountain Railroad'], skip: ["It's a Small World"], hasLL: false });
  const kinds = v.map(x => x.kind).sort();
  assert.deepEqual(kinds, ['ll-when-none', 'mustdo-missing', 'skip-present']);
});

test('verifyTripParams: clean cards -> no violations', () => {
  const cards = [{ t: '8:05 AM', h: 'Big Thunder Mountain Railroad', type: 'ride', n: '', land: 'Frontierland', ride: 'Big Thunder Mountain Railroad' }];
  assert.deepEqual(verifyTripParams(cards, { mustDo: ['Big Thunder Mountain Railroad'], skip: ['Jungle Cruise'], hasLL: true }), []);
});

test('enforceTripParams: skip-present removed, ll stripped', () => {
  const cards = [
    { t: '9:00 AM', h: "It's a Small World", type: 'ride', n: '', land: 'Fantasyland' },
    { t: '10:00 AM', h: 'Tip', type: 'tip', n: '', land: '', ll: { t: 'multi', a: 'x' } },
  ];
  const out = enforceTripParams(cards,
    [{ kind: 'skip-present', name: "It's a Small World" }, { kind: 'll-when-none', name: 'Tip' }],
    { catalog: {}, landToPark });
  assert.equal(out.cards.length, 1);
  assert.ok(!out.cards[0].ll, 'll field should be stripped');
  assert.deepEqual(out.fixed.map(f => f.action).sort(), ['ll-stripped', 'removed']);
});

test('enforceTripParams: mustdo-missing swaps earliest non-rope-drop ride, preserves rope drop', () => {
  const cards = [
    { t: '8:05 AM', h: 'Space Mountain', type: 'ride', n: '', land: 'Tomorrowland', ride: 'Space Mountain' },
    { t: '9:00 AM', h: 'Jungle Cruise', type: 'ride', n: '', land: 'Adventureland', ride: 'Jungle Cruise' },
  ];
  const idx = buildCatalogIndex({ attractions: [{ name: 'Big Thunder Mountain Railroad', park: 'DL', land: 'Frontierland', status: 'operating' }] });
  const out = enforceTripParams(cards, [{ kind: 'mustdo-missing', name: 'Big Thunder Mountain Railroad' }], { catalog: idx, landToPark });
  assert.equal(out.cards[0].h, 'Space Mountain', 'rope-drop ride must be preserved');
  assert.equal(out.cards[1].h, 'Big Thunder Mountain Railroad');
  assert.equal(out.cards[1].land, 'Frontierland');
  assert.equal(out.fixed[0].action, 'swapped-in');
});

test('enforceTripParams: mustdo with no ride slot in its park -> unfixable, nothing changed', () => {
  const cards = [{ t: '8:05 AM', h: 'Arrival', type: 'tip', n: '', land: '' }];
  const out = enforceTripParams(cards, [{ kind: 'mustdo-missing', name: 'Big Thunder Mountain Railroad' }], { catalog: {}, landToPark });
  assert.equal(out.cards.length, 1);
  assert.equal(out.unfixable.length, 1);
});

// ---------------------------------------------------------------------------
// verifyScaffold still removes closed rides (incl. null-date) end to end
// ---------------------------------------------------------------------------
test('verifyScaffold: null-date closure drops the ride card', () => {
  const cards = [{ t: '8:05 AM', h: 'Matterhorn Bobsleds', type: 'ride', n: '', land: 'Fantasyland', ride: 'Matterhorn Bobsleds' }];
  const closed = closedNamesForDate([{ name: 'Matterhorn Bobsleds', closeDate: null, reopenDate: null }], '2026-10-15');
  const { cards: kept, removed } = verifyScaffold(cards, { parks: ['Disneyland'], landToPark, closedNames: closed, catalog: {} });
  assert.equal(kept.length, 0);
  assert.equal(removed[0].reason, 'closed');
});

// ---------------------------------------------------------------------------
// parseCatalogVenues
// ---------------------------------------------------------------------------
test('parseCatalogVenues: parses venue objects, [] on garbage', () => {
  const raw = JSON.stringify({ attractions: [], venues: [{ name: 'Flo\u2019s V8 Cafe', park: 'DCA', land: 'Cars Land', service: 'quickservice', reservationPolicy: 'walkup' }] });
  const v = parseCatalogVenues(raw);
  assert.equal(v.length, 1);
  assert.equal(v[0].service, 'quickservice');
  assert.deepEqual(parseCatalogVenues('garbage'), []);
  assert.deepEqual(parseCatalogVenues(null), []);
});

// ---------------------------------------------------------------------------
// Temperature pins: every Anthropic call site must pin temperature 0
// ---------------------------------------------------------------------------
test('temperature pinned: ai.js (1 call)', () => {
  const pins = (src('ai.js').match(/temperature\s*:\s*0/g) || []).length;
  assert.ok(pins >= 1, 'ai.js has ' + pins + ' temperature pins, need >= 1');
});

test('temperature pinned: generateschedule.js (2 calls)', () => {
  const pins = (src('generateschedule.js').match(/temperature\s*:\s*0/g) || []).length;
  assert.ok(pins >= 2, 'generateschedule.js has ' + pins + ' temperature pins, need >= 2');
});

test('temperature pinned: reoptimize.js (1 call)', () => {
  const pins = (src('reoptimize.js').match(/temperature\s*:\s*0/g) || []).length;
  assert.ok(pins >= 1, 'reoptimize.js has ' + pins + ' temperature pins, need >= 1');
});

test('temperature pinned: cron-cache.js (3 builder calls)', () => {
  const pins = (srcCache('cron-cache.js').match(/temperature\s*:\s*0/g) || []).length;
  assert.ok(pins >= 3, 'cron-cache.js has ' + pins + ' temperature pins, need >= 3');
});

// Dining closures (twice-weekly sweep) -- venues honor the same contract as rides
// ---------------------------------------------------------------------------
const DL_VENUES = [
  { name: 'Blue Bayou Restaurant', park: 'DL', land: 'New Orleans Square', service: 'table', reservationPolicy: 'recommended', exclude: false },
  { name: 'Jolly Holiday Bakery', park: 'DL', land: 'Main Street U.S.A.', service: 'quickservice', reservationPolicy: 'walkup', exclude: false },
];

test('closedNamesForDate: venue closure window covers the trip date', () => {
  const dining = [
    { name: 'Blue Bayou Restaurant', park: 'DL', closeDate: '2026-10-05', reopenDate: '2026-10-19' },
    { name: 'Cafe Orleans', park: 'DL', closeDate: null, reopenDate: null }, // already closed, unknown reopen
  ];
  assert.deepEqual(closedNamesForDate(dining, '2026-10-10'), ['Blue Bayou Restaurant', 'Cafe Orleans']);
  assert.deepEqual(closedNamesForDate(dining, '2026-10-01'), ['Cafe Orleans']); // before Blue Bayou's window
  assert.deepEqual(closedNamesForDate(dining, '2026-10-20'), ['Cafe Orleans']); // after reopen
});

test('verifyScaffold: dining card at a closed venue is removed with reason venue-closed', () => {
  const cards = [
    { t: '12:30 PM', h: 'Blue Bayou Restaurant', type: 'dining', land: 'New Orleans Square', n: 'lunch' },
    { t: '6:00 PM', h: "Flo's V8 Cafe", type: 'quickservice', land: 'Cars Land', n: 'dinner' },
  ];
  const r = verifyScaffold(cards, { parks: ['Disneyland', 'DCA'], landToPark, closedNames: [], closedVenueNames: ['blue bayou restaurant'], catalog: {} });
  assert.equal(r.cards.length, 1);
  assert.match(r.cards[0].h, /Flo's/);
  assert.equal(r.removed.length, 1);
  assert.equal(r.removed[0].reason, 'venue-closed');
});

test('applyFills: AI fill placing a closed venue is dropped and retried', () => {
  const sk = buildSkeleton({ park: 'Disneyland', openMin: 480, closeMin: 1320, hasLL: false, dayNum: 1 });
  const diningSlot = sk.slots.find(s => s.type === 'dining');
  const fills = [{ id: diningSlot.id, t: '12:30 PM', h: 'Blue Bayou Restaurant', type: 'dining', land: 'New Orleans Square', n: 'lunch' }];
  const fb = (slot, f) => deterministicBackfill(slot, {
    catalog: [], venues: DL_VENUES, closedNames: [], closedVenueNames: ['blue bayou restaurant'],
    usedRideKeys: f.usedRideKeys, usedNames: f.usedNames
  });
  const { needsRetry, report } = applyFills(sk, fills, { landToPark, closedNames: [], closedVenueNames: ['Blue Bayou Restaurant'], fallbackFor: fb });
  assert.ok(needsRetry.includes(diningSlot.id), 'closed-venue fill should need retry');
  assert.ok((report.closed || 0) >= 1, 'expected a closed drop in the report');
});

test('deterministicBackfill: closed venue is skipped, next verified venue picked', () => {
  const slot = { type: 'dining', park: 'Disneyland', window: [660, 705], block: 'lunch' };
  const card = deterministicBackfill(slot, {
    catalog: [], venues: DL_VENUES, closedNames: [], closedVenueNames: ['blue bayou restaurant'],
    usedRideKeys: new Set(), usedNames: new Set()
  });
  assert.equal(card.h, 'Jolly Holiday Bakery');
});

test('buildFillPrompt: closed venues listed as dining exclusions', () => {
  const sk = buildSkeleton({ park: 'Disneyland', openMin: 480, closeMin: 1320, hasLL: false, dayNum: 1 });
  const sys = buildFillPrompt(sk, { closedVenueNames: ['Blue Bayou Restaurant'] });
  assert.ok(sys.includes('Blue Bayou Restaurant'), 'venue exclusion missing from fill prompt');
  assert.ok(/dining, quickservice, or snack slot/i.test(sys));
});

// Closure diff (material-change detection for the watcher)
// ---------------------------------------------------------------------------
test('diffClosureLists: detects added, removed, and date-shifted entries', () => {
  const prev = [
    { name: 'Indiana Jones Adventure', park: 'DL', status: 'closed_for_refurbishment', closeDate: '2026-09-08', reopenDate: null },
    { name: 'Mark Twain Riverboat', park: 'DL', status: 'closed_for_refurbishment', closeDate: '2026-09-08', reopenDate: '2026-09-11' },
    { name: 'Pirates of the Caribbean', park: 'DL', status: 'closed_for_refurbishment', closeDate: '2026-06-01', reopenDate: '2026-07-01' },
  ];
  const next = [
    { name: 'Indiana Jones Adventure', park: 'DL', status: 'closed_for_refurbishment', closeDate: '2026-09-08', reopenDate: '2026-11-12' },
    { name: 'Mark Twain Riverboat', park: 'DL', status: 'closed_for_refurbishment', closeDate: '2026-09-08', reopenDate: '2026-09-11' },
    { name: "it's a small world", park: 'DL', status: 'closed_for_refurbishment', closeDate: '2026-10-30', reopenDate: null },
  ];
  const d = diffClosureLists(prev, next);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].name, "it's a small world");
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].name, 'Pirates of the Caribbean');
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].after.reopenDate, '2026-11-12');
});

test('diffClosureLists: note-only edits are not material', () => {
  const prev = [{ name: 'Blue Bayou Restaurant', park: 'DL', status: 'closed_for_refurbishment', closeDate: '2026-10-05', reopenDate: '2026-10-19', note: 'old note' }];
  const next = [{ name: 'Blue Bayou Restaurant', park: 'DL', status: 'closed_for_refurbishment', closeDate: '2026-10-05', reopenDate: '2026-10-19', note: 'new note' }];
  const d = diffClosureLists(prev, next);
  assert.deepEqual([d.added.length, d.removed.length, d.changed.length], [0, 0, 0]);
});

test('alertIdFor: stable per closure, distinct across start dates and kinds', () => {
  const e = { name: 'Blue Bayou Restaurant', park: 'DL', closeDate: '2026-10-05' };
  assert.equal(alertIdFor('dining', e), alertIdFor('dining', Object.assign({}, e)));
  assert.notEqual(alertIdFor('dining', e), alertIdFor('dining', Object.assign({}, e, { closeDate: '2026-10-06' })));
  assert.notEqual(alertIdFor('dining', e), alertIdFor('ride', e));
});

// ---------------------------------------------------------------------------
// WDW resort-aware closures (permanent design, not a patch).
// Section NAMES stay canonical across resorts (CLOSURES in every key's blob);
// only the prompt varies via _WDW variants + resolveSectionPrompt.
// ---------------------------------------------------------------------------
test('wdw prompts: CLOSURES_WDW / DINING_CLOSURES_WDW / CURRENT_CLOSURES_WDW exist', () => {
  const cc = srcCache('cron-cache.js');
  for (const s of ['CLOSURES_WDW', 'DINING_CLOSURES_WDW', 'CURRENT_CLOSURES_WDW']) {
    assert.ok(cc.includes('  ' + s + ':{') || cc.includes('  ' + s + ': {'), s + ' prompt entry missing');
  }
});

test('wdw prompts: MK/EP/HS/AK park codes, WDW sources, same JSON contract', () => {
  const cc = srcCache('cron-cache.js');
  assert.ok(cc.includes('wdwnt.com'), 'WDW prompts should source WDW News Today');
  assert.ok(/CLOSURES_WDW[\s\S]{0,3000}?"MK", "EP", "HS", or "AK"/.test(cc), 'CLOSURES_WDW must restrict park to MK/EP/HS/AK');
  assert.ok(/DINING_CLOSURES_WDW[\s\S]{0,3000}?"MK", "EP", "HS", or "AK"/.test(cc), 'DINING_CLOSURES_WDW must restrict park to MK/EP/HS/AK');
  assert.ok(/DINING_CLOSURES_WDW[\s\S]{0,3000}?same contract as the attractions CLOSURES/.test(cc), 'dining WDW prompt keeps the shared contract');
  assert.ok(/CLOSURES_WDW[\s\S]{0,3000}?null ONLY when the attraction is ALREADY closed/.test(cc), 'WDW prompt keeps the null-date contract');
});

test('wdw resolution: resolveSectionPrompt + authorityForKey wired into both build paths', () => {
  const cc = srcCache('cron-cache.js');
  assert.ok(/function resolveSectionPrompt\(promptMap, cacheKey, sectionName\)/.test(cc), 'resolveSectionPrompt defined');
  assert.ok(/function authorityForKey\(cacheKey\)/.test(cc), 'authorityForKey defined');
  assert.ok(cc.includes('SOURCE_AUTHORITY_WDW'), 'WDW authority preamble present');
  assert.ok(/const prompt = resolveSectionPrompt\(promptMap, cacheKey, sectionName\)/.test(cc), 'buildSingleSection resolves via resolveSectionPrompt');
  assert.ok(cc.includes('authorityForKey(cacheKey)'), 'buildSingleSection uses authorityForKey');
  assert.ok(/Object\.keys\(promptMap\)\.filter\(\(n\) => resolveSectionPrompt\(promptMap, cacheKey, n\)\)/.test(cc), 'buildAllSections filters sections through resolveSectionPrompt');
});

test('wdw honesty: no DL content leaks into the WDW blob', () => {
  const cc = srcCache('cron-cache.js');
  const gates = cc.match(/if \(!cacheKey\.includes\('stable'\) && !cacheKey\.includes\('_wdw_'\)\)/g) || [];
  assert.equal(gates.length, 2, 'both SHOWS literal injections must be DL-gated, found ' + gates.length);
  assert.ok(/sectionName\.endsWith\('_WDW'\)\) return null/.test(cc), '_WDW variants are never built as sections');
});

test('wdw sweeps: vercel.json has the three Thursday WDW section sweeps', () => {
  const v = JSON.parse(src('vercel.json'));
  const paths = v.crons.map((c) => c.schedule + ' ' + c.path);
  assert.ok(paths.some((p) => p.includes('park_intel_wdw_dynamic&section=CLOSURES')), 'WDW CLOSURES sweep missing');
  assert.ok(paths.some((p) => p.includes('park_intel_wdw_dynamic&section=CURRENT_CLOSURES')), 'WDW CURRENT_CLOSURES sweep missing');
  assert.ok(paths.some((p) => p.includes('park_intel_wdw_dynamic&section=DINING_CLOSURES')), 'WDW DINING_CLOSURES sweep missing');
  const thuCacheRuns = v.crons.filter((c) => c.path.includes('/api/cron-cache') && /\* \* 4$/.test(c.schedule)).length;
  assert.ok(thuCacheRuns <= 7, 'Thursday cron-cache runs must stay within DAILY_RUN_CAP=7, got ' + thuCacheRuns);
});
