// Generation held-return anchor suite (anchor fix lane part 1, Nov 4,
// 2026 -- Claude msg 205 section 4).
//
// The bug this suite exists to keep dead: a full schedule regeneration
// silently un-anchored a booked Lightning Lane return, because nothing on
// the generation path read tripConfig.heldReturns (proof:
// ~/workspace/tpcp-code-audit/completesetup-proof.md -- at the pre-fix
// main, generation output was BYTE-IDENTICAL with and without a held
// return). The core test is that A/B: the same day regenerated with a
// return held at 2:00-3:00 PM and at 9:30-10:30 AM must place the ride at
// the held window both times, and the two outputs must differ. Byte-
// identical output across windows = the generator is ignoring the record
// = fail. Against the pre-fix main this suite fails on exactly those
// assertions (the negative control, run and recorded in the lane's build
// log).
//
// Also covered: the held ride appears exactly once at its window; the
// 2:00-3:00 PM window survives the headliner-window gate (the anchor is a
// genuine LL return, not forbidden afternoon standby); no other placed
// card overlaps the anchor window; both conflict cases (a held window
// overlapping a confirmed reservation seats BOTH and surfaces the
// overlap by name; a held return for a park the day does not visit is
// surfaced by name, not seated); an unseatable held return appears in
// conflicts by name; and unit coverage of the shared anchor-verify
// (verifyAnchorDay) for all three anchor classes, since the
// post-generation check in api/generateschedule.js is only as good as
// the function it calls.
//
// Harness mirrors test/reoptimize-held-guard.test.mjs: @vercel/blob is
// redirected to an inline stub via module.register hooks, global fetch
// serves the blob table, and generation runs in stubFill mode (the
// BEAU01 test code skips the model entirely -- deterministic, $0), so
// the Anthropic leg is never called.
//
//   node --test test/generation-held-anchors.test.mjs
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const blobStubSrc = [
  'export async function list({ prefix } = {}) {',
  '  const table = globalThis.__anchorBlobTable || {};',
  '  if (prefix && Object.prototype.hasOwnProperty.call(table, prefix)) {',
  "    return { blobs: [{ url: 'https://blob.test/' + prefix, downloadUrl: 'https://blob.test/' + prefix, pathname: prefix, uploadedAt: '2026-11-01T00:00:00.000Z' }] };",
  '  }',
  '  return { blobs: [] };',
  '}',
  'export async function put() { throw new Error("put not stubbed"); }',
  'export async function del() {}',
].join('\n');

const hooksSrc = [
  'let stubUrl = "";',
  'export async function initialize(data) { stubUrl = data.blob; }',
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === '@vercel/blob') return { url: stubUrl, shortCircuit: true };",
  '  return nextResolve(specifier, context);',
  '}',
].join('\n');

register('data:text/javascript;base64,' + Buffer.from(hooksSrc).toString('base64'), {
  data: { blob: 'data:text/javascript;base64,' + Buffer.from(blobStubSrc).toString('base64') },
});

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.ADMIN_KEY = 'suite-admin-key-never-sent';

// ------------------------------------------------------------ fixtures
const DL = 'Disneyland', DCA = 'Disney California Adventure';
const RIDE = (name, park, land, peak, rope, ll) => ({ name, park, land, typicalPeakWait: peak, ropeDropValue: rope || '', llKind: ll || '' });
const CATALOG = {
  attractions: [
    RIDE('Space Mountain', DL, 'Tomorrowland', 75, 'high', 'multi'),
    RIDE('Indiana Jones Adventure', DL, 'Adventureland', 70, 'high', 'multi'),
    RIDE('Star Wars: Rise of the Resistance', DL, "Star Wars: Galaxy's Edge", 100, 'high', 'single'),
    RIDE('Big Thunder Mountain Railroad', DL, 'Frontierland', 55, '', 'multi'),
    RIDE('Pirates of the Caribbean', DL, 'New Orleans Square', 40, '', 'none'),
    RIDE('Haunted Mansion', DL, 'New Orleans Square', 45, '', 'multi'),
    RIDE('Jungle Cruise', DL, 'Adventureland', 35, '', 'none'),
    RIDE('Matterhorn Bobsleds', DL, 'Fantasyland', 50, '', 'multi'),
    RIDE('Millennium Falcon: Smugglers Run', DL, "Star Wars: Galaxy's Edge", 60, '', 'multi'),
    RIDE("Mickey & Minnie's Runaway Railway", DL, "Mickey's Toontown", 55, '', 'multi'),
    RIDE('Buzz Lightyear Astro Blasters', DL, 'Tomorrowland', 30, '', 'multi'),
    RIDE('Star Tours', DL, 'Tomorrowland', 35, '', 'multi'),
    RIDE("Peter Pan's Flight", DL, 'Fantasyland', 45, '', 'none'),
    RIDE('Mad Tea Party', DL, 'Fantasyland', 25, '', 'none'),
    RIDE('Autopia', DL, 'Tomorrowland', 30, '', 'none'),
    RIDE('Finding Nemo Submarine Voyage', DL, 'Tomorrowland', 40, '', 'none'),
    RIDE("Mr. Toad's Wild Ride", DL, 'Fantasyland', 25, '', 'none'),
    RIDE("Snow White's Enchanted Wish", DL, 'Fantasyland', 20, '', 'none'),
    RIDE("Roger Rabbit's Car Toon Spin", DL, "Mickey's Toontown", 30, '', 'multi'),
    RIDE('The Many Adventures of Winnie the Pooh', DL, 'Critter Country', 20, '', 'none'),
    RIDE('Radiator Springs Racers', DCA, 'Cars Land', 95, 'high', 'single'),
    RIDE('Incredicoaster', DCA, 'Pixar Pier', 50, '', 'multi'),
    RIDE("Soarin' Around the World", DCA, 'Grizzly Peak', 45, '', 'multi'),
    RIDE('Guardians of the Galaxy - Mission: BREAKOUT!', DCA, 'Avengers Campus', 70, 'high', 'multi'),
  ],
  venues: [
    { name: 'Blue Bayou Restaurant', park: DL, land: 'New Orleans Square', service: 'table', reservationPolicy: 'required' },
    { name: 'Bengal Barbecue', park: DL, land: 'Adventureland', service: 'quickservice', reservationPolicy: 'walkup' },
    { name: 'Jolly Holiday Bakery Cafe', park: DL, land: 'Main Street, U.S.A.', service: 'quickservice', reservationPolicy: 'walkup' },
    { name: 'Galactic Grill', park: DL, land: 'Tomorrowland', service: 'quickservice', reservationPolicy: 'walkup' },
    { name: 'Red Rose Taverne', park: DL, land: 'Fantasyland', service: 'quickservice', reservationPolicy: 'walkup' },
    { name: 'Hungry Bear Restaurant', park: DL, land: 'Critter Country', service: 'quickservice', reservationPolicy: 'walkup' },
    { name: 'Harbour Galley', park: DL, land: 'New Orleans Square', service: 'quickservice', reservationPolicy: 'walkup' },
  ],
};

globalThis.__anchorBlobTable = {
  'twize/trip_registry.json': {
    BEAU01: { tripId: 'beau01-anchor-suite', role: 'admin', status: 'active' },
  },
  'twize/park_intel_dl_stable.json': {
    data: {
      sections: {
        LAND_MAP: 'Tomorrowland in Disneyland; Cars Land in Disney California Adventure.',
        WAIT_PATTERNS: '{}',
        ROPE_DROP_STRATEGY: 'rope drop strategy',
        LIGHTNING_LANE_STRATEGY: 'lightning lane strategy',
        DINING_TIMING: 'dining timing',
        CROWD_FLOW: 'crowd flow',
        PARK_HOP_STRATEGY: 'park hop strategy',
        SHOW_AND_ENTERTAINMENT: 'shows and entertainment',
        CATALOG,
      },
    },
  },
  'twize/park_intel_dl_dynamic.json': {
    data: {
      sections: {
        CURRENT_CLOSURES: 'All attractions operating today.',
        CLOSURES: [],
        DINING_CLOSURES: [],
        SHOWS: { shows: [] },
      },
    },
  },
  'twize/dining_intel_dl.json': { data: 'Verified dining list.' },
  'twize/park_hours_intel.json': {
    data: { '2026-12-07': { dl: { open: '08:00', close: '24:00' }, dca: { open: '08:00', close: '22:00' } } },
  },
};

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://blob.test/')) {
    const key = decodeURIComponent(u.slice('https://blob.test/'.length));
    const payload = globalThis.__anchorBlobTable[key];
    return { ok: !!payload, json: async () => payload };
  }
  throw new Error('unexpected fetch (stubFill must never call out): ' + u);
};
console.log = () => {};
console.warn = () => {};
// console.error stays live: the handler's anchor-violation path uses it,
// and a silent suite hides exactly the failures it exists to catch.

const genMod = await import('../api/generateschedule.js');
const handler = genMod.default;
const scaffold = await import('../api/scaffold.js');
const { landToPark } = await import('../api/validate-schedule.js');

const SM = 'Space Mountain';
const RSR = 'Radiator Springs Racers';
const held = (ride, returnStart, returnEnd, day = 0) => ({
  day, rideKey: ride.toLowerCase(), ride, returnStart, returnEnd,
  bookedAt: '2026-11-01T00:00:00.000Z', standbyAtConfirm: 60, conflict: '',
});

function cfgWith(heldReturns, extra) {
  const cfg = {
    location: 'Disneyland',
    days: [{ date: '2026-12-07', park: 'Disneyland', hasLL: true, hasLLMP: true, hasILL: true }],
    groupProfile: { size: 2 },
    ridePreferences: { mustDo: [], wantToDo: [], skip: [] },
    characters: { priority: 'skip', categories: [] },
    dining: { reservations: [], usedVenues: [] },
    reservations: [],
  };
  if (heldReturns) cfg.heldReturns = heldReturns;
  return Object.assign(cfg, extra || {});
}

let ipCounter = 0;
async function generate(cfg) {
  const req = {
    method: 'POST', url: '/api/generateschedule',
    headers: { 'x-forwarded-for': '10.2.0.' + (++ipCounter), 'content-length': '0' },
    body: {
      prompt: 'Build the day schedule for this group.', scaffold: true, stubFill: true,
      dayIndex: 0, mode: 'setup', maxTokens: 8000, tripCode: 'BEAU01', tripConfig: cfg,
    },
  };
  const res = {
    code: null, payload: null,
    setHeader() {},
    status(c) { this.code = c; return this; },
    json(o) { this.payload = o; return this; },
    end() {},
  };
  await handler(req, res);
  return res;
}

const mins = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})\s*([AaPp])/); if (!m) return null; let h = parseInt(m[1], 10); if (/p/i.test(m[3]) && h !== 12) h += 12; if (/a/i.test(m[3]) && h === 12) h = 0; return h * 60 + parseInt(m[2], 10); };
const rideCards = (items, name) => (items || []).filter(c => c && c.type === 'ride' && scaffold.normName(c.ride || c.h) === scaffold.normName(name));

// ------------------------------------------------------------ the A/B
test('A/B: placement follows the held window (2-3 PM vs 9:30-10:30 AM); outputs differ', async () => {
  const rNone = await generate(cfgWith(null));
  const rPm = await generate(cfgWith([held(SM, '2:00 PM', '3:00 PM')]));
  const rAm = await generate(cfgWith([held(SM, '9:30 AM', '10:30 AM')]));
  for (const [label, r] of [['none', rNone], ['pm', rPm], ['am', rAm]]) {
    assert.equal(r.code, 200, label + ' generation succeeds');
    assert.equal(r.payload.ok, true, label + ' ok');
    assert.equal(r.payload.scaffold, true, label + ' scaffold path');
  }
  const pm = rideCards(rPm.payload.parsed, SM);
  assert.equal(pm.length, 1, 'held ride appears exactly once (PM run)');
  assert.equal(pm[0].t, '2:00 PM', 'PM run seats the ride at its held window start');
  assert.equal(pm[0].anchor, true, 'the seated card is an anchor');
  const am = rideCards(rAm.payload.parsed, SM);
  assert.equal(am.length, 1, 'held ride appears exactly once (AM run)');
  assert.equal(am[0].t, '9:30 AM', 'AM run seats the ride at its held window start');
  // The discrimination the bug failed: the generator must READ the window.
  assert.notEqual(JSON.stringify(rPm.payload.parsed), JSON.stringify(rAm.payload.parsed), 'outputs differ across windows');
  assert.notEqual(JSON.stringify(rPm.payload.parsed), JSON.stringify(rNone.payload.parsed), 'a held return changes the day');
  assert.deepEqual(rPm.payload.heldAnchors.map(a => a.name), [SM], 'response names the seated held anchor');
  assert.deepEqual(rNone.payload.heldAnchors, [], 'no held anchors on a trip with no held returns');
  assert.deepEqual(rNone.payload.heldConflicts, [], 'no held conflicts on a trip with no held returns');
});

test('the 2-3 PM window survives the headliner-window gate as a genuine LL return', async () => {
  const r = await generate(cfgWith([held(SM, '2:00 PM', '3:00 PM')]));
  assert.equal(r.code, 200);
  const card = rideCards(r.payload.parsed, SM)[0];
  assert.ok(card, 'anchor card present');
  assert.equal(card.t, '2:00 PM', 'an afternoon headliner placement that is a booked return is legal');
  assert.equal(card.anchor, true);
  assert.equal(card.heldReturn, true);
  assert.ok(card.ll && card.ll.t === 'multi', 'the anchor carries the genuine Multi Pass return tag (llWindowExempt)');
  assert.ok(!(r.payload.verifyRemoved || []).some(x => x && x.h === SM), 'verify did not remove the anchor as an afternoon standby violation');
  assert.ok(!(r.payload.verifyMutations || []).some(x => x && x.h === SM && x.action === 'gate-warning'), 'no headliner-window gate warning on the anchor');
});

test('no other placed card overlaps the anchor window', async () => {
  const r = await generate(cfgWith([held(SM, '2:00 PM', '3:00 PM')]));
  assert.equal(r.code, 200);
  const placed = new Set(['ride', 'dining', 'quickservice', 'snack', 'show', 'character']);
  const inside = (r.payload.parsed || []).filter(c => {
    if (!c || !placed.has(c.type) || c.anchor === true) return false;
    const m = mins(c.t);
    return m !== null && m > 840 && m < 900;
  });
  assert.deepEqual(inside.map(c => c.h + ' @ ' + c.t), [], 'nothing else is seated inside the 2:00-3:00 PM return window');
});

test('conflict case: held window overlapping a reservation seats BOTH and surfaces the overlap by name', async () => {
  const cfg = cfgWith([held(SM, '2:00 PM', '3:00 PM')], {
    dining: { reservations: [{ name: 'Blue Bayou Restaurant', time: '2:30 PM' }], usedVenues: [] },
  });
  const r = await generate(cfg);
  assert.equal(r.code, 200);
  assert.equal(r.payload.ok, true, 'both real bookings seat -- the day still ships');
  const sm = rideCards(r.payload.parsed, SM);
  assert.equal(sm.length, 1);
  assert.equal(sm[0].t, '2:00 PM');
  const bb = (r.payload.parsed || []).filter(c => c && c.type === 'dining' && scaffold.normName(c.venue || c.h) === scaffold.normName('Blue Bayou Restaurant'));
  assert.equal(bb.length, 1, 'the reservation is seated too');
  assert.equal(bb[0].t, '2:30 PM');
  const overlap = (r.payload.heldConflicts || []).find(c => c && c.type === 'held-return-reservation-overlap');
  assert.ok(overlap, 'the overlap is surfaced in heldConflicts');
  assert.ok(overlap.detail.includes(SM) && overlap.detail.includes('Blue Bayou'), 'the surface names both bookings');
});

test('conflict case: held return for a park the day does not visit is surfaced by name, not seated', async () => {
  const r = await generate(cfgWith([held(RSR, '2:00 PM', '3:00 PM')]));
  assert.equal(r.code, 200);
  assert.equal(r.payload.ok, true, 'the day still generates');
  assert.equal(rideCards(r.payload.parsed, RSR).length, 0, 'the DCA return is not seated on a Disneyland day');
  assert.deepEqual(r.payload.heldAnchors, [], 'nothing was seated');
  const conf = (r.payload.heldConflicts || []).find(c => c && c.type === 'held-return-park-conflict');
  assert.ok(conf, 'a named park conflict is surfaced');
  assert.equal(conf.name, RSR, 'the conflict names the ride');
});

test('an unseatable held return appears in conflicts by name (unreadable window)', async () => {
  const bad = held(SM, 'whenever', 'later');
  const r = await generate(cfgWith([bad]));
  assert.equal(r.code, 200);
  const conf = (r.payload.heldConflicts || []).find(c => c && c.type === 'held-return-unparsed');
  assert.ok(conf, 'the unreadable record surfaces as a conflict');
  assert.equal(conf.name, SM, 'the conflict names the ride');
  assert.ok(!(r.payload.parsed || []).some(c => c && c.anchor === true && c.heldReturn === true), 'no anchor card was fabricated for it');
});

// ------------------------------------------------------------ unit: planner + fill
test('unit: planner seats the anchor, clears competing assignments, and voids slots starting inside the window', () => {
  assert.equal(typeof scaffold.planHeldReturnAnchors, 'function', 'planHeldReturnAnchors is exported');
  const catIdx = scaffold.buildCatalogIndex(JSON.stringify(CATALOG));
  const sk = scaffold.buildSkeleton({ park: 'Disneyland', openMin: 480, closeMin: 1440, hasLL: true, dayNum: 1 });
  const someSlot = sk.slots.find(s => s.type === 'ride' && s.block !== 'ropedrop');
  someSlot.preferRide = SM; // simulate a coverage/morning assignment of the held ride
  const plan = scaffold.planHeldReturnAnchors(sk, [held(SM, '2:00 PM', '3:00 PM')], { dayIndex: 0, catalog: catIdx, closedNames: [], bannedNames: [], vipWindow: null });
  assert.equal(plan.anchors.length, 1);
  assert.equal(plan.anchors[0].name, SM);
  assert.equal(plan.anchors[0].startMin, 840);
  assert.ok(!sk.slots.some(s => s.preferRide && scaffold.rideGroupKey(s.preferRide) === scaffold.rideGroupKey(SM)), 'no slot keeps an assignment of the held ride -- the anchor is its placement');
  const anchorSlot = sk.slots.find(s => s.block === 'held-anchor');
  assert.ok(anchorSlot, 'a held-anchor slot exists');
  assert.equal(anchorSlot.fixed, 840);
  assert.deepEqual(anchorSlot.window, [840, 900]);
  const intruders = sk.slots.filter(s => s.type === 'ride' && s.block !== 'held-anchor' && s.block !== 'anchor');
  assert.ok(!intruders.some(s => { const w = Array.isArray(s.window[0]) ? s.window[0][0] : s.window[0]; return w >= 840 && w < 900; }), 'no ride slot starts inside the held window');
});

test('unit: applyFills + verifyScaffold place the held ride exactly once, at its window, tag intact', () => {
  const catIdx = scaffold.buildCatalogIndex(JSON.stringify(CATALOG));
  const venues = scaffold.parseCatalogVenues(JSON.stringify(CATALOG));
  const sk = scaffold.buildSkeleton({ park: 'Disneyland', openMin: 480, closeMin: 1440, hasLL: true, dayNum: 1 });
  scaffold.planHeldReturnAnchors(sk, [held(SM, '2:00 PM', '3:00 PM')], { dayIndex: 0, catalog: catIdx, closedNames: [], bannedNames: [], vipWindow: null });
  const fallbackFor = (slot, fb) => scaffold.deterministicBackfill(slot, {
    catalog: Object.values(catIdx), venues, closedNames: [], closedVenueNames: [],
    usedRideKeys: fb.usedRideKeys, usedNames: fb.usedNames, priorRideKeys: fb.priorRideKeys,
    todayRideKeys: fb.todayRideKeys, encoredRideKeys: fb.encoredRideKeys, bannedKeys: fb.bannedKeys,
    closeMin: 1440, usedVenueKeys: fb.usedVenueKeys, shows: [], priorShows: [], diningDetails: {},
  });
  const ap = scaffold.applyFills(sk, [], {
    landToPark, closedNames: [], closedVenueNames: [], fallbackFor, priorRides: [], mustDoNames: [],
    catalog: catIdx, venues, closeMin: 1440, closeMinByPark: { dl: 1440, dca: 1320 }, llmp: true, ill: true,
  });
  const vf = scaffold.verifyScaffold(ap.cards, {
    parks: ['Disneyland'], landToPark, closedNames: [], closedVenueNames: [], catalog: catIdx, shows: [],
    hasILL: true, hasLLMP: true, waitPatterns: {}, mustDoNames: [], closeMin: 1440,
    closeMinByPark: { dl: 1440, dca: 1320 }, bannedNames: [], showSkipNames: [], priorShowNames: [],
  });
  const cards = rideCards(vf.cards, SM);
  assert.equal(cards.length, 1, 'exactly one Space Mountain card ships');
  assert.equal(cards[0].t, '2:00 PM', 'it sits at the held window, unmoved by every post-fill pass');
  assert.equal(cards[0].anchor, true);
  assert.ok(cards[0].ll && cards[0].ll.t === 'multi', 'its genuine LL tag survived LL normalization');
  assert.ok(!vf.removed.some(x => x && x.h === SM), 'verify never removed it');
  // Must-do completeness counts the anchor as the placement.
  const violations = scaffold.verifyTripParams(vf.cards, { mustDo: [SM], skip: [], hasLL: true });
  assert.ok(!violations.some(v => v.kind === 'mustdo-missing'), 'a must-do held ride is satisfied by its anchor');
});

// ------------------------------------------------------------ unit: the shared verify
const VCFG = (extra) => Object.assign({
  days: [{ date: '2026-12-07', park: 'Disneyland' }],
  heldReturns: [held(SM, '2:00 PM', '3:00 PM')],
  reservations: [],
  dining: { reservations: [] },
}, extra || {});
const VOPTS = () => ({
  dayIndex: 0,
  catalog: scaffold.buildCatalogIndex(JSON.stringify(CATALOG)),
  venues: scaffold.parseCatalogVenues(JSON.stringify(CATALOG)),
  closedNames: [], bannedNames: [], closedVenueNames: [], dayParks: ['Disneyland'],
});
const anchorCard = { t: '2:00 PM', h: SM, ride: SM, type: 'ride', anchor: true, heldReturn: true };

test('unit: verifyAnchorDay passes a day that honors its held return', () => {
  assert.equal(typeof scaffold.verifyAnchorDay, 'function', 'verifyAnchorDay is exported');
  const v = scaffold.verifyAnchorDay([anchorCard], VCFG(), VOPTS());
  assert.equal(v.ok, true);
  assert.deepEqual(v.violations, []);
});

test('unit: verifyAnchorDay names a dropped held return', () => {
  const v = scaffold.verifyAnchorDay([], VCFG(), VOPTS());
  assert.equal(v.ok, false);
  assert.equal(v.violations.length, 1);
  assert.equal(v.violations[0].kind, 'held-return-missing');
  assert.equal(v.violations[0].name, SM);
});

test('unit: verifyAnchorDay names a moved held return', () => {
  const v = scaffold.verifyAnchorDay([{ t: '8:05 AM', h: SM, ride: SM, type: 'ride' }], VCFG(), VOPTS());
  assert.equal(v.ok, false);
  assert.equal(v.violations[0].kind, 'held-return-moved');
  assert.equal(v.violations[0].name, SM);
});

test('unit: verifyAnchorDay names a duplicated held return', () => {
  const v = scaffold.verifyAnchorDay([anchorCard, { t: '8:05 AM', h: SM, ride: SM, type: 'ride' }], VCFG(), VOPTS());
  assert.equal(v.ok, false);
  assert.ok(v.violations.some(x => x.kind === 'held-return-duplicated' && x.name === SM));
});

test('unit: verifyAnchorDay does not expect a wrong-park or VIP-overlapping return', () => {
  const wrongPark = scaffold.verifyAnchorDay([], VCFG({ heldReturns: [held(RSR, '2:00 PM', '3:00 PM')] }), VOPTS());
  assert.equal(wrongPark.ok, true, 'a DCA return is not this DL day\'s anchor to hold');
  const vipCfg = VCFG({ days: [{ date: '2026-12-07', park: 'Disneyland', isVip: true, vipStart: '10:00 AM', vipEnd: '4:00 PM' }] });
  const vipItems = [{ t: '10:00 AM', h: 'VIP Tour', type: 'vip' }];
  const vip = scaffold.verifyAnchorDay(vipItems, vipCfg, VOPTS());
  assert.equal(vip.ok, true, 'a return inside the VIP window is the planner\'s conflict to name, not a verify violation');
});

test('unit: verifyAnchorDay judges reservations and the VIP window too', () => {
  const cfg = VCFG({
    heldReturns: [],
    days: [{ date: '2026-12-07', park: 'Disneyland', isVip: true, vipStart: '10:00 AM', vipEnd: '4:00 PM' }],
    dining: { reservations: [{ name: 'Blue Bayou Restaurant', time: '6:00 PM' }] },
  });
  const good = [
    { t: '10:00 AM', h: 'VIP Tour', type: 'vip' },
    { t: '6:00 PM', h: 'Blue Bayou Restaurant', type: 'dining', anchor: true, reservation: true },
  ];
  assert.equal(scaffold.verifyAnchorDay(good, cfg, VOPTS()).ok, true, 'a day honoring both ships');
  const dropped = scaffold.verifyAnchorDay(good.slice(0, 1), cfg, VOPTS());
  assert.ok(dropped.violations.some(x => x.kind === 'reservation-missing' && x.name === 'Blue Bayou Restaurant'), 'a dropped reservation is named');
  const moved = scaffold.verifyAnchorDay([good[0], Object.assign({}, good[1], { t: '6:45 PM' })], cfg, VOPTS());
  assert.ok(moved.violations.some(x => x.kind === 'reservation-moved'), 'a moved reservation is named');
  const noVip = scaffold.verifyAnchorDay([good[1]], cfg, VOPTS());
  assert.ok(noVip.violations.some(x => x.kind === 'vip-missing'), 'a dropped VIP window is named');
});
