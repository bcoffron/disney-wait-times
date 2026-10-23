// Tests for the manual Single Pass record control (Claude ruling,
// Oct 23, 2026; item 16 step 2). Beau's report: a Disneyland leader
// who buys a Single Pass in Disney's app (day-of, after scanning in,
// next available window) had NO way to record it when the generator's
// singleSeparate recommendation list came back empty -- the game-plan
// rows only exist for generator-listed rides. The control renders the
// same single-pass row (same write path, tpcpRecordBookedReturn) for
// the two purchasable rides, hardcoded: Disneyland Park -> Rise of
// the Resistance, Disney California Adventure -> Radiator Springs
// Racers (hopper days offer both). Placement: inside the day's
// existing LL card (game-plan card on Multi-Pass days, compact card
// on standby days). Leader-only, viewed-day-is-today (park-local)
// only.
//
// The suite extracts the REAL code from app.html (llState block,
// time helpers, the whole record/held/singles region including the
// new manual block) and drives it in a vm with browser stubs, so the
// code under test is the code that ships -- the rework suite's
// pattern. The wall clock is frozen at 2026-10-23T15:00:00Z
// (8:00 AM PDT) so Day 2 (Oct 23, 2026) is "today" and Day 1 is not.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/single-pass-manual.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appHtml = readFileSync(new URL('../app.html', import.meta.url), 'utf8');

function sliceRange(startMarker, endMarker) {
  const s = appHtml.indexOf(startMarker);
  assert.ok(s !== -1, 'range start not found: ' + startMarker);
  const e = appHtml.indexOf(endMarker, s + startMarker.length);
  assert.ok(e > s, 'range end not found: ' + endMarker);
  return appHtml.slice(s, e);
}
const SRC = [
  sliceRange('var llState=', 'function showLLPlanningPrompt'),
  sliceRange('function parseTimeMins', 'function walkBetween'),
  sliceRange('function tpcpParseDayDate', 'function tpcpRealDays'),
  sliceRange('function tpcpRecordBookedReturn', '//    Magic Day fireworks'),
].join('\n');
assert.ok(SRC.includes('function tpcpManualSinglePassHTML'), 'manual control missing from app.html');
assert.ok(SRC.includes('function tpcpRecordBookedReturn'), 'record path missing');
assert.ok(SRC.includes('function tpcpSingleRowHTML'), 'single row renderer missing');

const RealDate = Date;
const FIXED_MS = RealDate.UTC(2026, 9, 23, 15, 0, 0); // 8:00 AM PDT, Oct 23 2026
class FixedDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [FIXED_MS])); }
  static now() { return FIXED_MS; }
  static parse(s) { return RealDate.parse(s); }
  static UTC(...a) { return RealDate.UTC(...a); }
}

const RISE = 'Star Wars: Rise of the Resistance';
const RACERS = 'Radiator Springs Racers';

function memStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

function makeWorld(opts = {}) {
  const world = { admin: opts.admin !== false, posts: [] };
  const dayPark = opts.dayPark || 'Disneyland';
  const tc = {
    location: 'Disneyland',
    parkHopping: !!opts.parkHopping,
    heldReturns: [],
    days: [
      { date: 'Oct 22, 2026', park: 'Disneyland', startPark: 'Disneyland', hopTo: false },
      { date: 'Oct 23, 2026', park: dayPark, startPark: dayPark, hopTo: !!opts.hopTo },
    ],
  };
  world.tc = tc;
  const windowObj = {
    _loadedTripData: { tripConfig: tc },
    _schedData: {
      days: [
        { park: 'Disneyland', items: [{ t: '8:05 AM', h: 'Space Mountain', type: 'ride' }] },
        { park: dayPark, items: [{ t: '8:05 AM', h: 'Space Mountain', type: 'ride' }], llSequence: null, generatedWith: { hasLLMP: false, hasILL: false } },
      ],
    },
  };
  const localStorage = memStorage({ tpcp_code: 'TESTDL' });
  world.localStorage = localStorage;
  const ctx = {
    console,
    Date: FixedDate,
    Intl,
    window: windowObj,
    localStorage,
    TRIP_CONFIG: tc,
    curDay: 1,
    isAdmin: () => world.admin,
    lookupWait: () => null,
    ensureAdminKey: () => '',
    tpcpDeviceToken: () => 'tok',
    SYNC_BASE: '',
    fetch: async (url, fetchOpts) => {
      world.posts.push({ url: String(url), body: JSON.parse(fetchOpts.body) });
      return { ok: true };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  world.ctx = ctx;
  return world;
}
const flush = async () => { await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); };

// ------------------------------------------------------------ (a) + (e)
test('(a) MP-off DL day, empty llSequence: control renders; recording Rise persists as a held anchor with a derived window', async () => {
  const w = makeWorld();
  const html = w.ctx.tpcpManualSinglePassHTML(1, null);
  assert.ok(html.includes(RISE), 'Rise row offered');
  assert.ok(!html.includes(RACERS), 'DCA ride not offered on a DL day');
  assert.ok(html.includes('Single Pass goes on sale once you'), 'empty-state line teaches the entry rule');
  assert.ok(html.includes('Return time:'), 'inline entry present');

  const rec = w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RISE), RISE, '10:30 AM');
  assert.ok(rec, 'leader record returns the held record');
  assert.equal(rec.returnStart, '10:30 AM');
  assert.equal(rec.returnEnd, '11:30 AM', '(e) window end derived as start + 60');
  await flush();

  const held = w.ctx.getHeldReturnsForDay(1).filter(r => r.ride === RISE);
  assert.equal(held.length, 1, 'held return recorded on the trip');
  const post = w.posts.find(p => p.url.endsWith('/api/trip'));
  assert.ok(post, 'held returns persisted through the trip save');
  assert.equal(post.body.tripData.tripConfig.heldReturns.filter(r => r.ride === RISE).length, 1);
  const local = JSON.parse(w.localStorage.getItem('ll_state_1'));
  assert.equal(local.bookedTimes[w.ctx.tpcpSingleBannerKey(RISE)], '10:30 AM', 'device-local record written');

  const after = w.ctx.tpcpManualSinglePassHTML(1, null);
  assert.ok(after.includes('Booked') && after.includes('10:30 AM') && after.includes('11:30 AM'), 'row renders the booked window');
  assert.ok(after.includes('Locked into the plan'), 'row renders as an anchor');
  assert.ok(!after.includes('Single Pass goes on sale'), 'teach line gone once recorded');
});

// ------------------------------------------------------------ (b)
test('(b) MP-on day: control renders in-block when singleSeparate is empty; yields when the generator already listed the ride', () => {
  const w = makeWorld();
  const seqEmpty = { bookFirst: 'Space Mountain', order: ['Space Mountain'], singleSeparate: [] };
  assert.ok(w.ctx.tpcpManualSinglePassHTML(1, seqEmpty).includes(RISE), 'row offered with empty singleSeparate');
  const seqCover = { bookFirst: 'Space Mountain', order: ['Space Mountain'], singleSeparate: [RISE] };
  assert.equal(w.ctx.tpcpManualSinglePassHTML(1, seqCover), '', 'no duplicate surface for a generator-listed ride');
});

// ------------------------------------------------------------ (c)
test('(c) recording the same ride twice replaces the record (one per attraction per day)', async () => {
  const w = makeWorld();
  const key = w.ctx.tpcpSingleBannerKey(RISE);
  w.ctx.tpcpRecordBookedReturn(1, key, RISE, '10:30 AM');
  w.ctx.tpcpRecordBookedReturn(1, key, RISE, '2:00 PM');
  await flush();
  const held = w.ctx.getHeldReturnsForDay(1).filter(r => r.ride === RISE);
  assert.equal(held.length, 1);
  assert.equal(held[0].returnStart, '2:00 PM');
  assert.equal(held[0].returnEnd, '3:00 PM');
});

// ------------------------------------------------------------ (d)
test('(d) hidden for non-today days and for guests', () => {
  const w = makeWorld();
  assert.equal(w.ctx.tpcpManualSinglePassHTML(0, null), '', 'yesterday renders nothing');
  const g = makeWorld({ admin: false });
  assert.equal(g.ctx.tpcpManualSinglePassHTML(1, null), '', 'guest renders nothing');
});

// ------------------------------------------------- park / hopper sets
test('DCA day offers Racers only; a hopper day offers both, own park first', () => {
  const dca = makeWorld({ dayPark: 'Disney California Adventure' });
  const dcaHtml = dca.ctx.tpcpManualSinglePassHTML(1, null);
  assert.ok(dcaHtml.includes(RACERS) && !dcaHtml.includes(RISE), 'DCA-only set');
  const hop = makeWorld({ dayPark: 'Disney California Adventure', hopTo: true });
  const hopHtml = hop.ctx.tpcpManualSinglePassHTML(1, null);
  assert.ok(hopHtml.includes(RACERS) && hopHtml.includes(RISE), 'hopper offers both');
  assert.ok(hopHtml.indexOf(RACERS) < hopHtml.indexOf(RISE), 'own park first');
});

// ------------------------------------------------------------ wiring
test('wiring: the control is called from both LL card branches, and only there', () => {
  const calls = appHtml.match(/[+=]tpcpManualSinglePassHTML\(dayIdx/g) || [];
  assert.equal(calls.length, 2, 'two render call sites (game-plan card + compact card)');
  assert.ok(appHtml.includes("tpcpManualSinglePassHTML(dayIdx,null)+renderLLToggleFooter"), 'compact-card placement');
  assert.ok(appHtml.includes('h+=tpcpManualSinglePassHTML(dayIdx,seq);'), 'game-plan placement');
});
