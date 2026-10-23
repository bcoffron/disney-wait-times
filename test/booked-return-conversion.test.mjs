// Tests for booked-return conversion (Claude ruling, Oct 23, 2026;
// item 22). Beau's pair, confirmed by the display check after PR #132:
// the alert filter treated the recorded return as the truth while the
// plan item kept stating its planned standby time beside a pill. Now
// recording a return CONVERTS the matching plan item -- its time
// becomes the return window's start, it carries the booked window via
// the item's ll marker, the day re-sorts -- and removing the return
// restores the item EXACTLY (record/remove are an inverse pair, via
// the _preBook stash on the item). A ride with no plan item records
// the held return only (PR #128 behavior; nothing to convert, nothing
// to stash). Past-item friction (ruling Q2): converting an item more
// than 60 minutes behind park-local now first surfaces one honest
// line in the recorder; the same Got it tap then proceeds.
//
// The suite extracts the REAL code from app.html (the record/held/
// conversion region, the save path, the load path, time helpers) and
// drives it in a vm with browser stubs, so the code under test is the
// code that ships. The wall clock is frozen at 2026-10-23T17:00:00Z
// (10:00 AM PDT) so Day 2 (Oct 23, 2026) is today in park-local time.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/booked-return-conversion.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appHtml = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const monitorSrc = readFileSync(new URL('../api/cron-push-monitor.js', import.meta.url), 'utf8');

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
  sliceRange('function tpcpParkTodayIso', 'function tpcpParkTimeEpoch'),
  sliceRange('async function pushSchedule()', 'async function pullSchedule()'),
  sliceRange('function loadCustom()', '//    VIP notes'),
  sliceRange('function tpcpRecordBookedReturn', '//    Magic Day fireworks'),
].join('\n');
assert.ok(SRC.includes('function tpcpConvertRideItem'), 'conversion missing from app.html');
assert.ok(SRC.includes('function tpcpRestoreRideItem'), 'restoration missing from app.html');
assert.ok(SRC.includes('function tpcpFrictionGate'), 'friction gate missing from app.html');

const RealDate = Date;
const FIXED_MS = RealDate.UTC(2026, 9, 23, 17, 0, 0); // 10:00 AM PDT, Oct 23 2026
class FixedDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [FIXED_MS])); }
  static now() { return FIXED_MS; }
  static parse(s) { return RealDate.parse(s); }
  static UTC(...a) { return RealDate.UTC(...a); }
}

const RISE = 'Star Wars: Rise of the Resistance';
const RACERS = 'Radiator Springs Racers';
const SPACE = 'Space Mountain';
const RAILWAY = "Mickey & Minnie's Runaway Railway";
const TIANA = "Tiana's Bayou Adventure";

function day2Items() {
  // Production shapes (TEST02, Oct 23): compact items, Rise planned
  // standby with NO ll marker, Multi Pass items carrying ll {t, a}.
  return [
    { t: '8:25 AM', h: RISE, type: 'ride', n: 'Rope-drop priority: ride this first while the line is shortest.', land: "Star Wars: Galaxy's Edge", ride: RISE },
    { t: '8:30 AM', h: SPACE, type: 'ride', n: 'First ride of the day at rope drop.', land: 'Tomorrowland', ride: SPACE },
    { t: '9:30 AM', h: RAILWAY, type: 'ride', n: 'Rope-drop priority.', land: "Mickey's Toontown", ride: RAILWAY, ll: { t: 'multi', a: 'Lightning Lane Multi Pass pick -- book a return time in the app.' } },
    { t: '11:00 AM', h: TIANA, type: 'ride', n: 'Morning waits are still reasonable.', land: 'Bayou Country', ride: TIANA, ll: { t: 'multi', a: 'Popular newer attraction.' } },
    { t: '12:00 PM', h: 'Lunch — Café Orleans', type: 'dining', n: '', land: 'New Orleans Square', isConfirmed: true },
  ];
}
function makeWorld() {
  const world = { posts: [] };
  const day1 = { park: 'Disneyland', items: [{ t: '8:05 AM', h: SPACE, type: 'ride', ride: SPACE }] };
  const day2 = { park: 'Disneyland', items: day2Items(), llSequence: { bookFirst: SPACE, order: [SPACE], singleSeparate: [] }, generatedWith: { hasLLMP: true, hasILL: false } };
  const sched = { days: [day1, day2] };
  const tc = {
    location: 'Disneyland',
    parkHopping: false,
    heldReturns: [],
    schedule: sched,
    days: [
      { date: 'Oct 22, 2026', park: 'Disneyland', startPark: 'Disneyland', hopTo: false },
      { date: 'Oct 23, 2026', park: 'Disneyland', startPark: 'Disneyland', hopTo: false },
    ],
  };
  world.tc = tc; world.sched = sched; world.day2 = day2;
  const windowObj = { _loadedTripData: { tripConfig: tc }, _schedData: sched };
  const localStorage = (() => {
    const m = new Map(Object.entries({ tpcp_code: 'TEST02' }));
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _map: m };
  })();
  world.localStorage = localStorage;
  const ctx = {
    console,
    Date: FixedDate,
    Intl,
    window: windowObj,
    localStorage,
    TRIP_CONFIG: tc,
    curDay: 1,
    customSched: [],
    DAYS: [{ sections: [] }, { sections: [] }],
    isAdmin: () => true,
    lookupWait: () => null,
    ensureAdminKey: () => '',
    tpcpDeviceToken: () => 'tok',
    SYNC_BASE: '',
    // Stand-in for the real fit (day-count fitting only; it never
    // touches item fields).
    tpcpFitCustomSched: () => {
      const n = windowObj._schedData.days.length;
      while (ctx.customSched.length < n) ctx.customSched.push(null);
      ctx.customSched.length = n;
      return n;
    },
    fetch: async (url, fetchOpts) => {
      world.posts.push({ url: String(url), body: JSON.parse(fetchOpts.body) });
      return { ok: true };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  ctx.loadCustom(); // build the editing model from the server copy
  world.ctx = ctx;
  return world;
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };
const riseItem = (day) => day.items.find(e => e.h === RISE);

// ------------------------------------------------------------ (a)
test('(a) round-trip: record -> save -> reload -> remove restores the stored day byte-identically', async () => {
  const w = makeWorld();
  const before = JSON.stringify(w.day2);
  const rec = w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RISE), RISE, '2:30 PM');
  assert.ok(rec, 'leader record returns the held record');
  await flush();

  // The save bodies that left the device carry BOTH halves: the held
  // record and the converted day WITH its stash (the stash-survival
  // check: pushSchedule serializes items wholesale and the endpoint
  // stores them verbatim, so what is asserted here is the client half
  // of that round-trip).
  const bodies = w.posts.filter(p => p.url.endsWith('/api/trip')).map(p => p.body.tripData.tripConfig);
  assert.ok(bodies.length >= 1, 'trip save posted');
  const savedDay = bodies.map(tc => tc.schedule && tc.schedule.days && tc.schedule.days[1]).find(d => d && d.items && riseItem(d) && riseItem(d)._preBook);
  assert.ok(savedDay, 'a posted schedule carries the converted item with its _preBook stash');
  assert.equal(riseItem(savedDay).t, '2:30 PM');
  assert.equal(riseItem(savedDay)._preBook.item.t, '8:25 AM');
  assert.ok(bodies.some(tc => (tc.heldReturns || []).some(r => r.ride === RISE)), 'a posted body carries the held return');

  // Reload: the stored blob comes back and is ingested whole.
  const storedDay = JSON.parse(JSON.stringify(savedDay));
  w.sched.days[1] = storedDay;
  w.tc.schedule = w.sched;
  w.ctx.loadCustom();
  assert.equal(riseItem(storedDay).t, '2:30 PM', 'converted state survives the reload');
  assert.ok(riseItem(storedDay)._preBook, 'stash survives the reload');

  // Remove: the exact inverse.
  await w.ctx.llRemoveHeld(w.ctx.tpcpSingleBannerKey(RISE), RISE);
  await flush();
  assert.equal(JSON.stringify(w.sched.days[1]), before, 'stored day is byte-identical to the pre-record day');
  assert.equal(w.ctx.getHeldReturnsForDay(1).length, 0, 'held return removed');
});

// ------------------------------------------------------------ (b)
test('(b) conversion retimes, repositions, marks LL; neighbors untouched; heldReturns stays a distinct authority', async () => {
  const w = makeWorld();
  const lunchBefore = JSON.stringify(w.day2.items.find(e => e.type === 'dining'));
  const spaceBefore = JSON.stringify(w.day2.items.find(e => e.h === SPACE));
  w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RISE), RISE, '2:30 PM');
  await flush();

  const times = w.day2.items.map(e => e.t);
  assert.deepEqual(times, ['8:30 AM', '9:30 AM', '11:00 AM', '12:00 PM', '2:30 PM'], 'day re-sorted into time order');
  const it = riseItem(w.day2);
  assert.equal(it.t, '2:30 PM', 'item time is the return window start');
  assert.equal(it.ll.t, 'single', 'item carries the LL marker (single for a Single Pass ride)');
  assert.ok(typeof it.ll.a === 'string' && it.ll.a.length > 0, 'll marker carries its advice text, the generated shape');
  assert.equal(it._preBook.idx, 0, 'original position stashed');
  assert.equal(it._preBook.item.t, '8:25 AM', 'original time stashed');
  assert.ok(!('ll' in it._preBook.item), 'stash holds the pre-conversion item (no ll marker)');
  assert.ok(!('_preBook' in it._preBook.item), 'stash is not self-nested');
  assert.equal(JSON.stringify(w.day2.items.find(e => e.type === 'dining')), lunchBefore, 'dining neighbor untouched');
  assert.equal(JSON.stringify(w.day2.items.find(e => e.h === SPACE)), spaceBefore, 'standby neighbor untouched');
  // The two records stay distinct (ruling Q4): the rest of the day was
  // NOT retimed or re-planned, and heldReturns is its own record.
  const held = w.ctx.getHeldReturn(1, RISE);
  assert.ok(held && held.returnStart === '2:30 PM' && held.returnEnd === '3:30 PM', 'heldReturns record intact and separate');
  // The editing model shows the same single story.
  const entry = w.ctx.customSched[1].sections[0].entries.find(e => e.h === RISE);
  assert.equal(entry.t, '2:30 PM', 'editing model converted too');
});

// ------------------------------------------------------------ (c)
test('(c) past-item friction: line over 60 minutes past only; the gate shows it once, then the write proceeds', async () => {
  const w = makeWorld();
  // Frozen park-local now: 10:00 AM. Space Mountain 8:30 AM = 90 past.
  assert.equal(
    w.ctx.tpcpConversionFriction(1, SPACE, '2:30 PM'),
    'Space Mountain moves from 8:30 AM to your 2:30 PM return.',
    'friction line names the move for a >60-minute-past item'
  );
  assert.equal(
    w.ctx.tpcpConversionFriction(1, RISE, '2:30 PM'),
    'Star Wars: Rise of the Resistance moves from 8:25 AM to your 2:30 PM return.',
    'Rise (95 past) shows the line too'
  );
  assert.equal(w.ctx.tpcpConversionFriction(1, RAILWAY, '2:30 PM'), '', 'Railway (30 past) converts silently');
  assert.equal(w.ctx.tpcpConversionFriction(1, TIANA, '2:30 PM'), '', 'future item converts silently');
  assert.equal(w.ctx.tpcpConversionFriction(0, SPACE, '2:30 PM'), '', 'no friction for a day that is not today');

  // The gate: first tap reveals, nothing is written; same tap proceeds.
  const line = w.ctx.tpcpFrictionGate(1, SPACE, '2:30 PM');
  assert.equal(line, 'Space Mountain moves from 8:30 AM to your 2:30 PM return.');
  assert.equal(w.ctx.getHeldReturnsForDay(1).length, 0, 'nothing recorded while the line is showing');
  assert.equal(w.ctx.tpcpFrictionGate(1, SPACE, '3:00 PM'),
    'Space Mountain moves from 8:30 AM to your 3:00 PM return.',
    'a different return time re-arms the line (mistyped time gets caught)');
  assert.equal(w.ctx.tpcpFrictionGate(1, SPACE, '3:00 PM'), '', 'the same entry, seen, proceeds');
  w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(SPACE), SPACE, '3:00 PM');
  await flush();
  const sp = w.day2.items.find(e => e.h === SPACE);
  assert.equal(sp.t, '3:00 PM', 'conversion completes on the confirming tap');
  assert.equal(sp._preBook.item.t, '8:30 AM', 'stash holds the planned standby time');
});

// ------------------------------------------------------------ (d)
test('(d) Change keeps the original stash: remove after a re-record still restores the pre-record day', async () => {
  const w = makeWorld();
  const before = JSON.stringify(w.day2);
  w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RISE), RISE, '2:30 PM');
  await flush();
  w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RISE), RISE, '4:00 PM');
  await flush();
  const it = riseItem(w.day2);
  assert.equal(it.t, '4:00 PM', 're-record updates the converted item');
  assert.equal(it._preBook.item.t, '8:25 AM', 'the stash is still the ORIGINAL pre-conversion item, never the converted state');
  assert.equal(w.ctx.getHeldReturn(1, RISE).returnStart, '4:00 PM', 'held record replaced');
  assert.equal(w.ctx.tpcpConversionFriction(1, RISE, '5:00 PM'), '', 'no friction on a re-record of a converted item');
  await w.ctx.llRemoveHeld(w.ctx.tpcpSingleBannerKey(RISE), RISE);
  await flush();
  assert.equal(JSON.stringify(w.day2), before, 'remove after Change restores the pre-record day byte-identically');
});

// ------------------------------------------------------------ (e)
test('(e) no plan item: the held return records (PR #128 behavior), the day is untouched, nothing stashed', async () => {
  const w = makeWorld();
  const itemsBefore = JSON.stringify(w.day2.items);
  const rec = w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RACERS), RACERS, '1:00 PM');
  assert.ok(rec && rec.returnStart === '1:00 PM' && rec.returnEnd === '2:00 PM', 'held return recorded for a ride with no plan item');
  await flush();
  assert.equal(JSON.stringify(w.day2.items), itemsBefore, 'no item created, converted, or stashed');
  assert.equal(w.ctx.tpcpRestoreRideItem(1, RACERS), false, 'nothing to reverse for a record-only return');
});

// ------------------------------------------------------------ (f)
test('(f) PR #132 interplay: the monitor done-at inputs are unchanged by conversion', async () => {
  const w = makeWorld();
  w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RISE), RISE, '2:30 PM');
  await flush();
  const held = w.ctx.getHeldReturn(1, RISE);
  // The monitor (PR #132) resolves done-at from tripConfig.heldReturns
  // branch (a) -- "booked return governs" -- ahead of any plan-item
  // read. Conversion does not touch that record's window; it makes
  // the plan item AGREE with it (item t == returnStart).
  assert.equal(held.returnEnd, '3:30 PM', 'the done-at the monitor reads is the booked window end');
  assert.equal(riseItem(w.day2).t, held.returnStart, 'converted item starts where the held window starts');
  assert.ok(monitorSrc.includes('evaluateRideEligibility'), 'monitor eligibility resolver present (server-side, untouched by this PR)');
  assert.ok(monitorSrc.includes('booked return governs'), 'monitor branch (a): booked return governs done-at');
});

// ------------------------------------------------------------ wiring
test('wiring: record converts, remove restores, both Got it surfaces gate on friction, both recorders render the slot', () => {
  assert.ok(appHtml.includes('tpcpConvertRideItem(dayIdx,_dispName,_startMin)'), 'record path converts');
  assert.ok(appHtml.includes('tpcpRestoreRideItem(curDay,rideName||rideKey)'), 'remove path restores');
  const gotItBodies = appHtml.match(/tpcpFrictionGate\(/g) || [];
  assert.equal(gotItBodies.length, 3, 'friction gate: definition + banner handler + single-row handler');
  const slots = appHtml.match(/tpcp-friction-slot/g) || [];
  assert.ok(slots.length >= 4, 'friction slot rendered by both recorders and read by both handlers');
  assert.ok(appHtml.includes('.tpcp-friction-line{'), 'friction line styled');
});
