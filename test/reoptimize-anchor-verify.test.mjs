// Tests for the reoptimize post-check's use of the shared anchor verify
// (api/reoptimize.js; anchor fix lane part 2, Nov 4, 2026 -- Claude
// msg 205 section 2, call site 2).
//
// Until this part, reservations and the VIP window were protected in
// reoptimize by prompt text only -- "ANCHORED ITEMS: Never move dining
// reservations..." plus a preservation block that explicitly licensed a
// 30-minute reservation drift -- and nothing checked the model's plan.
// The deterministic held-return guard (Oct 8, 2026) covered held returns
// alone, and only for rides present in the input plan. The fix runs the
// plan reoptimize ships through the shared verifyAnchorDay (the same
// function the post-generation check and the /api/trip save seam use)
// against the anchor RECORDS in the stored trip config: a plan that
// drops or moves a reservation, the VIP window, or a held return is
// refused with the anchor named, in the guards' existing refusal shape
// (input schedule unchanged + named conflicts). The held-return guard
// itself is untouched and fires first for the cases it has always
// caught -- case (d) below is that guard's own case, kept as the
// equivalence proof.
//
// Negative controls (run against pre-part-2 main, recorded in the lane's
// build log): cases (a), (b), (c) and (e) FAIL there -- the moved/dropped
// plans ship and the damaged day optimizes clean. Cases (d) and (f)
// pass on both trees by design: (d) is the pre-existing guard behaving
// identically, (f) proves the new check does not over-refuse a legal
// plan.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/reoptimize-anchor-verify.test.mjs
// Harness mirrors test/reoptimize-held-guard.test.mjs: @vercel/blob is
// redirected to an inline stub via module.register hooks, global fetch
// serves blob reads + the Anthropic call, and the wall clock is frozen
// at 2026-11-04 (weeks before the fixture trip, so the remainder-scope
// guard stays silent and only the anchor checks speak).
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const blobStubSrc = [
  'export async function list({ prefix } = {}) {',
  '  const table = globalThis.__anchorP2BlobTable || {};',
  '  if (prefix && Object.prototype.hasOwnProperty.call(table, prefix)) {',
  "    return { blobs: [{ url: 'https://blob.test/' + prefix, downloadUrl: 'https://blob.test/' + prefix }] };",
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
delete process.env.ADMIN_KEY;
delete process.env.BLOB_PATH_SALT;

const DL = 'Disneyland';
const SM = 'Space Mountain';
const BB = 'Blue Bayou Restaurant';
const HELD_SM = { day: 1, rideKey: 'space mountain', ride: SM, returnStart: '2:00 PM', returnEnd: '3:00 PM', bookedAt: '2026-11-01T00:00:00.000Z', conflict: '' };

const CATALOG = {
  attractions: [
    { name: SM, park: DL, land: 'Tomorrowland', typicalPeakWait: 75, ropeDropValue: 'high', llKind: 'multi' },
    { name: 'Jungle Cruise', park: DL, land: 'Adventureland', typicalPeakWait: 35, ropeDropValue: '', llKind: 'none' },
    { name: 'Indiana Jones Adventure', park: DL, land: 'Adventureland', typicalPeakWait: 70, ropeDropValue: 'high', llKind: 'multi' },
    { name: 'Haunted Mansion', park: DL, land: 'New Orleans Square', typicalPeakWait: 45, ropeDropValue: '', llKind: 'multi' },
  ],
  venues: [
    { name: BB, park: DL, land: 'New Orleans Square', service: 'table', reservationPolicy: 'required' },
    { name: 'Bengal Barbecue', park: DL, land: 'Adventureland', service: 'quickservice', reservationPolicy: 'walkup' },
  ],
};

// The stored trip: day 2 (index 1) carries all three anchor classes --
// a confirmed Blue Bayou reservation at 6:30 PM (dining.reservations,
// day 1-based), a held Space Mountain return 2:00-3:00 PM
// (heldReturns, day 0-based), and a VIP window 10:00 AM-12:00 PM.
globalThis.__anchorP2BlobTable = {
  'twize/trip_registry.json': {
    ANCHORP2: { tripId: 'anchor-p2-trip', role: 'admin', status: 'active' },
  },
  'twize/park_intel_dl_stable.json': {
    data: { sections: { LAND_MAP: 'lands', WAIT_PATTERNS: 'waits', CROWD_FLOW: 'crowds', WALKING_ROUTES: 'walks', CATALOG } },
  },
  'twize/park_intel_dl_dynamic.json': { data: { sections: { CURRENT_CLOSURES: 'All attractions operating today.' } } },
  'twize/trip_anchor-p2-trip.json': {
    tripConfig: {
      location: 'Disneyland',
      days: [
        { date: 'Dec 7, 2026', park: DL },
        { date: 'Dec 8, 2026', park: DL, isVip: true, vipStart: '10:00 AM', vipEnd: '12:00 PM' },
      ],
      reservations: [],
      dining: { reservations: [{ name: BB, time: '6:30 PM', day: 2 }] },
      heldReturns: [HELD_SM],
      ridePreferences: { mustDo: [], wantToDo: [], skip: [] },
    },
  },
};

// The day being optimized (day index 1), honoring all three anchors.
const ITEMS = [
  { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: '' },
  { t: '10:00 AM', h: 'VIP Tour', type: 'vip', n: '' },
  { t: '1:00 PM', h: 'Jungle Cruise', type: 'ride', n: '' },
  { t: '2:00 PM', h: SM, type: 'ride', n: '' },
  { t: '6:30 PM', h: BB, type: 'dining', n: '', isConfirmed: true },
];

let proposal = null;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://blob.test/')) {
    const key = decodeURIComponent(u.slice('https://blob.test/'.length));
    const payload = globalThis.__anchorP2BlobTable[key];
    return { ok: !!payload, json: async () => payload };
  }
  if (u.includes('api.anthropic.com')) {
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ sections: [{ title: 'Park', entries: proposal }], explanation: 'Test proposal.' }) }],
        usage: { input_tokens: 10, output_tokens: 10 },
        stop_reason: 'end_turn',
        model: 'claude-haiku-4-5-20251001',
      }),
    };
  }
  throw new Error('unexpected fetch: ' + u);
};

// Freeze the wall clock weeks before the fixture trip (scope guard off).
const RealDate = Date;
const FIXED_MS = RealDate.UTC(2026, 10, 4, 18, 0, 0);
class FixedDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [FIXED_MS])); }
  static now() { return FIXED_MS; }
  static parse(s) { return RealDate.parse(s); }
  static UTC(...a) { return RealDate.UTC(...a); }
}
globalThis.Date = FixedDate;
console.log = () => {};
console.warn = () => {};

const mod = await import('../api/reoptimize.js');
const handler = mod.default;

let ipCounter = 0;
async function callHandler(body) {
  const req = {
    method: 'POST',
    url: '/api/reoptimize',
    headers: { 'x-forwarded-for': '10.2.0.' + (++ipCounter) },
    body,
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
const clone = (x) => JSON.parse(JSON.stringify(x));
function bodyFor(items, held) {
  return {
    scheduleItems: items, dayLabel: 'Tuesday Dec 8', tripDayDate: 'Dec 8, 2026',
    isInTrip: false, currentTime: null, liveWaits: null, tripCode: 'ANCHORP2',
    heldReturns: held === undefined ? clone([HELD_SM]) : held,
  };
}
function anchorConf(res, kind, name) {
  return (res.payload.anchorConflicts || []).filter(v => v && v.kind === kind && v.name === name);
}
function outEntries(res) {
  return (res.payload.sections || []).flatMap(s => s.entries || []);
}

// ------------------------------------------------------------ the cases
test('(a) a plan that moves a confirmed reservation is refused and names it', async () => {
  proposal = clone(ITEMS);
  proposal.find(e => e.h === BB).t = '7:15 PM';
  const res = await callHandler(bodyFor(clone(ITEMS)));
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, false, 'the moved-reservation plan must not ship');
  assert.deepEqual(outEntries(res), ITEMS, 'the input schedule is returned unchanged');
  const conf = anchorConf(res, 'reservation-moved', BB);
  assert.equal(conf.length, 1, 'the refusal names the reservation');
});

test('(b) a plan that moves the VIP window boundary is refused and names it', async () => {
  proposal = clone(ITEMS);
  proposal.find(e => e.type === 'vip').t = '10:30 AM';
  const res = await callHandler(bodyFor(clone(ITEMS)));
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, false, 'the moved-VIP plan must not ship');
  assert.deepEqual(outEntries(res), ITEMS, 'the input schedule is returned unchanged');
  const conf = anchorConf(res, 'vip-moved', 'VIP Tour');
  assert.equal(conf.length, 1, 'the refusal names the VIP window');
});

test('(c) a plan that drops a confirmed reservation is refused and names it', async () => {
  proposal = clone(ITEMS).filter(e => e.h !== BB);
  const res = await callHandler(bodyFor(clone(ITEMS)));
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, false, 'the dropped-reservation plan must not ship');
  assert.deepEqual(outEntries(res), ITEMS, 'the input schedule is returned unchanged');
  const conf = anchorConf(res, 'reservation-missing', BB);
  assert.equal(conf.length, 1, 'the refusal names the reservation');
});

test('(d) the pre-existing held-return refusal still fires (guard equivalence)', async () => {
  proposal = clone(ITEMS).filter(e => e.h !== SM);
  const res = await callHandler(bodyFor(clone(ITEMS)));
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, false, 'the held-return guard still keeps the plan unchanged');
  assert.deepEqual(outEntries(res), ITEMS, 'the input schedule is returned unchanged');
  const conf = (res.payload.heldReturnConflicts || []).filter(c => c && c.ride === SM && c.type === 'held-dropped');
  assert.equal(conf.length, 1, 'the Oct 8 guard fires with its own conflict shape, unchanged');
});

test('(e) a day already missing its held return (pre-fix damage) refuses every plan and names the return', async () => {
  // The stored day lacks the Space Mountain card entirely -- the part 1
  // bug's damage shape. The ride is in neither the input nor the
  // proposal, so the old guard (drop requires an input item) is silent;
  // the shared verify judges the plan against the stored record and
  // refuses, per msg 205: "tapping Optimize on that day should refuse
  // every plan and name the return, because the input day already
  // lacks it."
  const damaged = clone(ITEMS).filter(e => e.h !== SM);
  proposal = clone(damaged);
  proposal.find(e => e.h === 'Jungle Cruise').t = '12:30 PM';
  const res = await callHandler(bodyFor(damaged));
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, false, 'no plan ships for a day missing its booked return');
  assert.deepEqual(outEntries(res), damaged, 'the input schedule is returned unchanged');
  const conf = anchorConf(res, 'held-return-missing', SM);
  assert.equal(conf.length, 1, 'the refusal names the missing return');
});

test('(f) a legal plan that keeps every anchor ships (no over-refusal)', async () => {
  proposal = clone(ITEMS);
  proposal.find(e => e.h === 'Jungle Cruise').t = '12:30 PM';
  const res = await callHandler(bodyFor(clone(ITEMS)));
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, true, 'a legal re-time goes through');
  assert.equal((res.payload.anchorConflicts || []).length, 0, 'no anchor conflicts on a clean plan');
  assert.equal(outEntries(res).find(e => e.h === 'Jungle Cruise').t, '12:30 PM');
});

// ------------------------------------------------------------ part 6
// Flag 5 close at this call site (anchor fix lane part 6, Nov 4,
// 2026): a stored reservation record with a readable time but NO day
// (a legacy flat shape; the shipped Dining slide always writes a day)
// belongs to no day. Part 2's record reads handed it to
// verifyAnchorDay untouched, where day:null reads as "expected on the
// day being judged" -- a false refusal of every plan for a day that
// never owed the venue a card. The record-keyed paths now partition
// such records out of the judged config and surface them by name on
// the response (anchorRecordsNeedingDay) as needing a day. Negative
// control: this case FAILS against pre-part-6 main -- the plan is
// refused there with a reservation-missing conflict.
test('(g) a stored null-day reservation creates no expectation and surfaces as needing a day (part 6)', async () => {
  const KEY = 'twize/trip_anchor-p2-trip.json';
  const orig = globalThis.__anchorP2BlobTable[KEY];
  const variant = clone(orig);
  variant.tripConfig.dining = { reservations: [{ name: BB, time: '6:30 PM' }] }; // no day recorded
  globalThis.__anchorP2BlobTable[KEY] = variant;
  try {
    // A legal plan that keeps the day's real anchors (held return,
    // VIP window) and simply has no Blue Bayou card on it -- the
    // null-day record names no day, so this day owes it nothing.
    proposal = clone(ITEMS).filter(e => e.h !== BB);
    proposal.find(e => e.h === 'Jungle Cruise').t = '12:30 PM';
    const res = await callHandler(bodyFor(clone(ITEMS)));
    assert.equal(res.code, 200);
    assert.equal(res.payload.changed, true, 'the null-day record must not refuse the plan');
    assert.equal((res.payload.anchorConflicts || []).length, 0, 'no anchor conflicts from a record with no day');
    const nd = (res.payload.anchorRecordsNeedingDay || []).filter(x => x && x.name === BB);
    assert.equal(nd.length, 1, 'the record surfaces by name as needing a day');
  } finally {
    globalThis.__anchorP2BlobTable[KEY] = orig;
  }
});
