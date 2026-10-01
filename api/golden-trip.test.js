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
  applyFills,
  verifyScaffold,
  closedNamesForDate,
  buildCatalogIndex,
  parseCatalogVenues,
  deterministicBackfill,
  verifyTripParams,
  enforceTripParams
} from './scaffold.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, f), 'utf8');

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
  const pins = (src('cron-cache.js').match(/temperature\s*:\s*0/g) || []).length;
  assert.ok(pins >= 3, 'cron-cache.js has ' + pins + ' temperature pins, need >= 3');
});
