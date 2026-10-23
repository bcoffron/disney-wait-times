// Tests for recorded-return INSERT (Beau's decision, Oct 23, 2026;
// item 23). PR #133 conversion covers a ride the generator planned.
// Beau's other case is the ride it did NOT plan -- an Individual
// Lightning Lane bought in the park for a ride with no plan item.
// PR #128 recorded only the held return there: the anchor existed
// but the day's timeline showed nothing. Beau's ruling: "Recorded
// return time that is locked in that spot for a purchased Individual
// LL." Recording now inserts a timeline item at the return window --
// shaped like a generated LL ride item, flagged _recordedInsert --
// and removing the return deletes it, so record/remove stay a
// byte-identical inverse pair, exactly like conversion's.
//
// The suite extracts the REAL code from app.html (same regions as
// the conversion suite) and drives it in a vm with browser stubs.
// The wall clock is frozen at 2026-10-23T17:00:00Z (10:00 AM PDT) so
// Day 2 (Oct 23, 2026) is today in park-local time.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/booked-return-insert.test.mjs
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
  sliceRange('function tpcpParkTodayIso', 'function tpcpParkTimeEpoch'),
  sliceRange('async function pushSchedule()', 'async function pullSchedule()'),
  sliceRange('function loadCustom()', '//    VIP notes'),
  sliceRange('function tpcpRecordBookedReturn', '//    Magic Day fireworks'),
].join('\n');
assert.ok(SRC.includes('function tpcpInsertRideItem'), 'insert missing from app.html');
assert.ok(SRC.includes('function tpcpDeleteInsertedRideItem'), 'insert-delete missing from app.html');
assert.ok(SRC.includes('function tpcpRideItemPresence'), 'presence probe missing from app.html');

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
const MATTERHORN = 'Matterhorn Bobsleds';
const SMALLWORLD = "it's a small world";

function day2Items() {
  // Production shapes (TEST02, Oct 23): Rise planned standby, Multi
  // Pass items carrying ll {t, a}. RACERS is NOT planned today -- the
  // insert case.
  return [
    { t: '8:25 AM', h: RISE, type: 'ride', n: 'Rope-drop priority: ride this first while the line is shortest.', land: "Star Wars: Galaxy's Edge", ride: RISE },
    { t: '8:30 AM', h: SPACE, type: 'ride', n: 'First ride of the day at rope drop.', land: 'Tomorrowland', ride: SPACE },
    { t: '9:30 AM', h: RAILWAY, type: 'ride', n: 'Rope-drop priority.', land: "Mickey's Toontown", ride: RAILWAY, ll: { t: 'multi', a: 'Lightning Lane Multi Pass pick -- book a return time in the app.' } },
    { t: '11:00 AM', h: TIANA, type: 'ride', n: 'Morning waits are still reasonable.', land: 'Bayou Country', ride: TIANA, ll: { t: 'multi', a: 'Popular newer attraction.' } },
    { t: '12:00 PM', h: 'Lunch — Café Orleans', type: 'dining', n: '', land: 'New Orleans Square', isConfirmed: true },
  ];
}
function makeWorld(day2It, day1It) {
  const world = { posts: [] };
  const day1 = { park: 'Disneyland', items: day1It || [{ t: '8:05 AM', h: SPACE, type: 'ride', ride: SPACE }] };
  const day2 = { park: 'Disneyland', items: day2It || day2Items(), llSequence: { bookFirst: SPACE, order: [SPACE], singleSeparate: [] }, generatedWith: { hasLLMP: true, hasILL: false } };
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
const byName = (day, name) => day.items.filter(e => e.h === name);

// ------------------------------------------------------------ (a)
test('(a) round-trip: record-insert -> save -> reload -> remove restores the stored day byte-identically', async () => {
  const w = makeWorld();
  const before = JSON.stringify(w.day2);
  const rec = w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RACERS), RACERS, '1:00 PM');
  assert.ok(rec, 'leader record returns the held record');
  await flush();

  const ins = byName(w.day2, RACERS);
  assert.equal(ins.length, 1, 'exactly one item inserted');
  assert.equal(ins[0]._recordedInsert, true, 'inserted item carries the flag');
  assert.equal(ins[0].t, '1:00 PM', 'item sits at the return window start');

  // The save bodies carry the inserted item WITH its flag (the
  // round-trip survival check: items serialize wholesale).
  const bodies = w.posts.filter(p => p.url.endsWith('/api/trip')).map(p => p.body.tripData.tripConfig);
  assert.ok(bodies.length >= 1, 'trip save posted');
  const savedDay = bodies.map(tc => tc.schedule && tc.schedule.days && tc.schedule.days[1]).find(d => d && d.items && byName(d, RACERS).length && byName(d, RACERS)[0]._recordedInsert);
  assert.ok(savedDay, 'a posted schedule carries the inserted item with its flag');
  assert.ok(bodies.some(tc => (tc.heldReturns || []).some(r => r.ride === RACERS)), 'a posted body carries the held return');

  // Reload: the stored blob comes back and is ingested whole.
  const storedDay = JSON.parse(JSON.stringify(savedDay));
  w.sched.days[1] = storedDay;
  w.tc.schedule = w.sched;
  w.ctx.loadCustom();
  assert.equal(byName(storedDay, RACERS).length, 1, 'insert survives the reload');
  assert.equal(byName(storedDay, RACERS)[0]._recordedInsert, true, 'flag survives the reload');

  // Remove: the exact inverse -- the inserted item is deleted.
  await w.ctx.llRemoveHeld(w.ctx.tpcpSingleBannerKey(RACERS), RACERS);
  await flush();
  assert.equal(JSON.stringify(w.sched.days[1]), before, 'stored day is byte-identical to the pre-record day');
  assert.equal(w.ctx.getHeldReturnsForDay(1).length, 0, 'held return removed');
  assert.equal(w.ctx.tpcpRestoreRideItem(1, RACERS), false, 'restore still has nothing to do for an inserted ride');
});

// ------------------------------------------------------------ (b)
test('(b) insert position, shape, land sourcing, and the render fields a converted item gets', async () => {
  const w = makeWorld();
  w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RACERS), RACERS, '10:30 AM');
  await flush();
  const times = w.day2.items.map(e => e.t);
  assert.deepEqual(times, ['8:25 AM', '8:30 AM', '9:30 AM', '10:30 AM', '11:00 AM', '12:00 PM'], 'insert lands in time order');
  const it = byName(w.day2, RACERS)[0];
  assert.equal(it.type, 'ride');
  assert.equal(it.ride, RACERS, 'ride field set (held matching, directions, banner keying)');
  assert.equal(it.h, RACERS);
  assert.equal(it.ll.t, 'single', 'Single Pass marker, the generated shape');
  assert.ok(typeof it.ll.a === 'string' && it.ll.a.indexOf('Single Pass pick') > -1, 'll advice text matches the conversion marker text');
  assert.equal(it.land, 'Cars Land', 'land from the hardcoded Single Pass fallback');
  assert.ok(!('_preBook' in it), 'an inserted item is never stashed');
  // The editing model shows the same item (this is what renderSched reads).
  const entry = w.ctx.customSched[1].sections[0].entries.find(e => e.h === RACERS);
  assert.ok(entry && entry._recordedInsert === true && entry.t === '10:30 AM', 'editing model carries the insert');
  // Fields renderSched branches on for the converted-item presentation:
  // the is-lls card class and LL $ badge key off ll.t==='single'; the
  // booked pill keys off getHeldReturn for the item's ride.
  const held = w.ctx.getHeldReturn(1, RACERS);
  assert.ok(held && held.returnStart === '10:30 AM' && held.returnEnd === '11:30 AM', 'held record pairs with the item (the pill + guard authority)');

  // Land from the trip itself beats the fallback: Matterhorn is
  // planned on Day 1 with a land, absent on Day 2, not hardcoded.
  const w2 = makeWorld(day2Items(), [
    { t: '8:05 AM', h: SPACE, type: 'ride', ride: SPACE },
    { t: '9:00 AM', h: MATTERHORN, type: 'ride', ride: MATTERHORN, land: 'Fantasyland' },
  ]);
  w2.ctx.tpcpRecordBookedReturn(1, w2.ctx.tpcpSingleBannerKey(MATTERHORN), MATTERHORN, '3:00 PM');
  await flush();
  const mh = byName(w2.day2, MATTERHORN)[0];
  assert.ok(mh && mh._recordedInsert === true, 'Matterhorn inserted on Day 2');
  assert.equal(mh.land, 'Fantasyland', 'land sourced from the same ride on another day of the trip');
  assert.equal(mh.ll.t, 'multi', 'a non-Single-Pass ride records as a Multi Pass kind');

  // No land anywhere and not hardcoded: the item still inserts,
  // without a land field -- the record never blocks on metadata.
  const w3 = makeWorld();
  w3.ctx.tpcpRecordBookedReturn(1, w3.ctx.tpcpSingleBannerKey(SMALLWORLD), SMALLWORLD, '4:00 PM');
  await flush();
  const sw = byName(w3.day2, SMALLWORLD)[0];
  assert.ok(sw && sw._recordedInsert === true, 'item inserts even with no land source');
  assert.ok(!('land' in sw), 'no land field invented');
});

// ------------------------------------------------------------ (c)
test('(c) Change retimes the inserted item; it stays an insert; remove still deletes it cleanly', async () => {
  const w = makeWorld();
  const before = JSON.stringify(w.day2);
  w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RACERS), RACERS, '1:00 PM');
  await flush();
  w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RACERS), RACERS, '2:30 PM');
  await flush();
  const ins = byName(w.day2, RACERS);
  assert.equal(ins.length, 1, 'Change never creates a second item');
  assert.equal(ins[0].t, '2:30 PM', 'inserted item retimed to the new window');
  assert.equal(ins[0]._recordedInsert, true, 'still flagged as an insert');
  assert.ok(!('_preBook' in ins[0]), 'Change on an insert never stashes it as a conversion');
  assert.equal(w.ctx.getHeldReturn(1, RACERS).returnStart, '2:30 PM', 'held record replaced');
  // Position followed the new time (after the 12:00 PM lunch).
  const times = w.day2.items.map(e => e.t);
  assert.deepEqual(times, ['8:25 AM', '8:30 AM', '9:30 AM', '11:00 AM', '12:00 PM', '2:30 PM'], 'day re-sorted around the new window');
  await w.ctx.llRemoveHeld(w.ctx.tpcpSingleBannerKey(RACERS), RACERS);
  await flush();
  assert.equal(JSON.stringify(w.day2), before, 'remove after Change restores the pre-record day byte-identically');
});

// ------------------------------------------------------------ (d)
test('(d) duplicate protection: repeat records and direct inserts never create a second item', async () => {
  const w = makeWorld();
  w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RACERS), RACERS, '1:00 PM');
  await flush();
  w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RACERS), RACERS, '1:00 PM');
  await flush();
  assert.equal(byName(w.day2, RACERS).length, 1, 'same record twice -> one item');
  assert.equal(w.ctx.tpcpInsertRideItem(1, RACERS, 13 * 60), false, 'direct insert is a no-op when the ride is present');
  assert.equal(w.ctx.tpcpInsertRideItem(1, SPACE, 13 * 60), false, 'direct insert refuses a ride with a plan item');
  // A planned ride records through conversion, not insert:
  w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(SPACE), SPACE, '3:00 PM');
  await flush();
  const sp = byName(w.day2, SPACE);
  assert.equal(sp.length, 1, 'planned ride still exactly one item');
  assert.ok(sp[0]._preBook, 'planned ride converted (stash present)');
  assert.ok(!('_recordedInsert' in sp[0]), 'planned ride is not flagged as an insert');
  // Presence is conservative: a prefix-relative name counts as present.
  assert.equal(w.ctx.tpcpRideItemPresence(w.day2.items, 'Space'), true, 'prefix candidate counts as present (never duplicate on a variant)');
  assert.equal(w.ctx.tpcpRideItemPresence(w.day2.items, 'Radiator'), true, 'prefix of an inserted name counts as present');
  assert.equal(w.ctx.tpcpRideItemPresence(w.day2.items, 'Matterhorn Bobsleds'), false, 'an absent ride reads absent');
});

// ------------------------------------------------------------ (e)
test('(e) itemless day: the insert builds the editing-model wrapper and persists', async () => {
  const w = makeWorld([]);
  assert.equal(w.ctx.customSched[1], null, 'loadCustom leaves an itemless day unwrapped');
  const before = JSON.stringify(w.day2);
  w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RISE), RISE, '9:00 AM');
  await flush();
  const ins = byName(w.day2, RISE);
  assert.equal(ins.length, 1, 'insert lands on an empty day');
  assert.equal(ins[0].land, "Star Wars: Galaxy's Edge", 'Rise land from the hardcoded fallback');
  assert.ok(w.ctx.customSched[1] && w.ctx.customSched[1].sections[0].entries.some(e => e.h === RISE), 'editing model wrapped and carries the insert (what renderSched + pushSchedule read)');
  const bodies = w.posts.filter(p => p.url.endsWith('/api/trip')).map(p => p.body.tripData.tripConfig);
  assert.ok(bodies.some(tc => tc.schedule && tc.schedule.days && tc.schedule.days[1] && byName(tc.schedule.days[1], RISE).length === 1), 'a posted schedule carries the inserted item');
  await w.ctx.llRemoveHeld(w.ctx.tpcpSingleBannerKey(RISE), RISE);
  await flush();
  assert.equal(JSON.stringify(w.day2), before, 'remove restores the empty day byte-identically');
});

// ------------------------------------------------------------ (f)
test('(f) friction: re-recording an inserted item never shows the past-item move line', async () => {
  const w = makeWorld();
  // Frozen park-local now is 10:00 AM. Insert with an 8:00 AM window
  // (already past -- Disney assigned it, the leader is catching up).
  w.ctx.tpcpRecordBookedReturn(1, w.ctx.tpcpSingleBannerKey(RACERS), RACERS, '8:00 AM');
  await flush();
  assert.equal(byName(w.day2, RACERS).length, 1, 'insert recorded');
  assert.equal(w.ctx.tpcpConversionFriction(1, RACERS, '9:00 AM'), '', 'no friction line for a re-record of an inserted item');
  assert.equal(w.ctx.tpcpFrictionGate(1, RACERS, '9:00 AM'), '', 'the gate lets a Change on an insert straight through');
});

// ------------------------------------------------------------ wiring
test('wiring: record inserts when nothing converted, remove deletes inserts, conversion never stashes inserts', () => {
  assert.ok(appHtml.includes('if(!_conv){ try{ tpcpInsertRideItem(dayIdx,_dispName,_startMin); }catch(e){} }'), 'record path inserts when conversion found no plan item');
  assert.ok(appHtml.includes('tpcpDeleteInsertedRideItem(curDay,rideName||rideKey)'), 'remove path deletes inserted items');
  assert.ok(appHtml.includes('if(!it._preBook&&!it._recordedInsert){'), 'conversion stash guard excludes recorded inserts');
  assert.ok(appHtml.includes("if(!hit||hit.item._preBook||hit.item._recordedInsert) return '';"), 'friction excludes recorded inserts');
  // The render presentation a converted item gets is keyed on fields
  // the inserted item carries identically (ll marker + held record):
  assert.ok(appHtml.includes("if(e.ll&&e.ll.t==='single')bc+=' is-lls';"), 'single-LL card styling keys off the ll marker');
  assert.ok(appHtml.includes('if(e.ll&&e.ll.a){ h+=renderLLBanner(e,curDay); }'), 'LL banner renders for ll-marked items (booked state + Change/Remove live there)');
});
