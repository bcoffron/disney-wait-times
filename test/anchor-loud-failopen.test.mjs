// Tests for the LOUD fail-open at the three anchor-checker seams
// (anchor fix lane part 8, Nov 4, 2026 -- Claude anchor-lane ruling,
// hardening point 2).
//
// The shared anchor verify (verifyAnchorDay) runs at three call sites
// and every one of them fails OPEN on a checker exception -- correctly:
// a checker defect must not brick generation, a save, or a plan. Until
// this part the failure was quiet (console.log in reoptimize,
// console.warn in the other two), so a broken checker would silently
// turn the lane's guarantee off with no sign in any log anyone reads.
// Now every seam logs the exception with console.error, naming the
// seam, before failing open. Behavior is otherwise unchanged: still
// fail-open, still no refusal on checker error.
//
// Cases:
//   (a) save seam (api/trip.js), BEHAVIORAL: a marked write whose held
//       record's ride getter throws on first read -- the first read
//       happens inside verifyAnchorDay's held leg, inside the seam's
//       try. The save must SUCCEED (200, and the card-free day the
//       checker would have refused is what persists: fail-open), AND
//       a console.error line naming the seam + the exception must
//       have been emitted.
//   (b) reoptimize post-check, BEHAVIORAL: the same poisoned record in
//       the STORED trip config (the reoptimize verify's record
//       source). The legal plan must still ship, AND the console.error
//       line must exist.
//   (c) STATIC PINS for all three seams: the catch that swallows the
//       anchor-checker exception logs via console.error and names its
//       seam. The generation post-generation check is pinned this way
//       because forcing a checker throw there behaviorally is
//       impractical: a poisoned record is read by the seating
//       planners first (the throw lands in generation's own safe-
//       failure catch, never reaching the verify's fail-open catch).
//
// Negative controls (against pre-part-8 main 13429785): (a) and (b)
// FAIL -- the saves/plans still succeed (fail-open predates this
// part), but the failure surfaces on console.warn / console.log, so
// no console.error line exists. The (c) pins FAIL on all three files
// for the same reason.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/anchor-loud-failopen.test.mjs
// Harnesses mirror test/trip-anchor-seam.test.mjs (trip) and
// test/reoptimize-anchor-stamps.test.mjs (reoptimize): @vercel/blob
// and web-push redirected to inline stubs, one fetch router serving
// blob reads + the Anthropic call, wall clock frozen 2026-11-04.
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const blobStubSrc = [
  'const table = () => globalThis.__p8BlobTable;',
  'export async function list({ prefix } = {}) {',
  '  const t = table(); const out = [];',
  '  for (const k of Object.keys(t)) if (!prefix || k.startsWith(prefix)) out.push({ url: "https://blob.test/" + k, downloadUrl: "https://blob.test/" + k, pathname: k });',
  '  return { blobs: out };',
  '}',
  'export async function put(key, body) { table()[key] = typeof body === "string" ? body : JSON.stringify(body); return { url: "https://blob.test/" + key }; }',
  'export async function del() {}',
  'export async function head() { return null; }',
].join('\n');

const webpushStubSrc = 'export default { setVapidDetails() {}, sendNotification: async () => ({}), generateVAPIDKeys: () => ({ publicKey: "", privateKey: "" }) };';

const hooksSrc = [
  'let stubUrl = ""; let wpUrl = "";',
  'export async function initialize(data) { stubUrl = data.blob; wpUrl = data.wp; }',
  'export async function resolve(specifier, context, nextResolve) {',
  '  if (specifier === "@vercel/blob") return { url: stubUrl, shortCircuit: true };',
  '  if (specifier === "web-push") return { url: wpUrl, shortCircuit: true };',
  '  return nextResolve(specifier, context);',
  '}',
].join('\n');

register('data:text/javascript;base64,' + Buffer.from(hooksSrc).toString('base64'), {
  data: {
    blob: 'data:text/javascript;base64,' + Buffer.from(blobStubSrc).toString('base64'),
    wp: 'data:text/javascript;base64,' + Buffer.from(webpushStubSrc).toString('base64'),
  },
});

// ---------------------------------------------------------------- setup
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.ADMIN_KEY;
delete process.env.BLOB_PATH_SALT;

// Console capture: the seams' loud lines are the subject. log is
// silenced; warn and error are recorded separately so a case can prove
// the failure went to ERROR (pre-part-8 it went to log/warn).
const errLines = [], warnLines = [];
const fmt = (a) => a.map(x => { try { return String(x && x.message ? x.message : x); } catch (e) { return '?'; } }).join(' ');
console.log = () => {};
console.warn = (...a) => { warnLines.push(fmt(a)); };
console.error = (...a) => { errLines.push(fmt(a)); };

const DL = 'Disneyland';
const SM = 'Space Mountain';
const BB = 'Blue Bayou Restaurant';
const CATALOG = {
  attractions: [
    { name: SM, park: DL, land: 'Tomorrowland', typicalPeakWait: 75, ropeDropValue: 'high', llKind: 'multi' },
    { name: 'Jungle Cruise', park: DL, land: 'Adventureland', typicalPeakWait: 35, ropeDropValue: '', llKind: 'none' },
    { name: 'Haunted Mansion', park: DL, land: 'New Orleans Square', typicalPeakWait: 45, ropeDropValue: '', llKind: 'multi' },
  ],
  venues: [
    { name: BB, park: DL, land: 'New Orleans Square', service: 'table', reservationPolicy: 'required' },
  ],
};

// A held-return record whose `ride` throws on its FIRST read and reads
// normally afterwards. The first read is the one verifyAnchorDay's
// held leg performs; every later read (the write's JSON serialization,
// any post-save surfacing) succeeds, so the fixture isolates the
// checker failure itself.
function poisonHeld(day, msg) {
  let thrown = false;
  const rec = { day, rideKey: 'space mountain', returnStart: '2:00 PM', returnEnd: '3:00 PM', bookedAt: '2026-11-01T00:00:00.000Z', conflict: '' };
  Object.defineProperty(rec, 'ride', {
    enumerable: true,
    get() { if (!thrown) { thrown = true; throw new Error(msg); } return SM; },
  });
  return rec;
}

const REG_KEY = 'twize/trip_registry.json';
const STABLE_KEY = 'twize/park_intel_dl_stable.json';
const DYNAMIC_KEY = 'twize/park_intel_dl_dynamic.json';
const SEAM_TRIP_KEY = 'twize/trip_seam-p8-trip.json';
const REOPT_TRIP_KEY = 'twize/trip_anchor-p8l-trip.json';

let proposal = null;
globalThis.fetch = async (url) => {
  const s = String(url);
  const m = s.match(/^https:\/\/blob\.test\/([^?]+)/);
  if (m) {
    const raw = globalThis.__p8BlobTable[m[1]];
    if (raw === undefined) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    return {
      ok: true, status: 200,
      text: async () => (typeof raw === 'string' ? raw : JSON.stringify(raw)),
      json: async () => (typeof raw === 'string' ? JSON.parse(raw) : raw),
    };
  }
  if (s.includes('api.anthropic.com')) {
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
  throw new Error('unexpected fetch: ' + s);
};

// Freeze the wall clock weeks before the fixture trips (scope guard
// silent, session dates resolve pre-trip).
const RealDate = Date;
const FIXED_MS = RealDate.UTC(2026, 10, 4, 18, 0, 0);
class FixedDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [FIXED_MS])); }
  static now() { return FIXED_MS; }
  static parse(s) { return RealDate.parse(s); }
  static UTC(...a) { return RealDate.UTC(...a); }
}
globalThis.Date = FixedDate;

const tripHandler = (await import('../api/trip.js')).default;
const reoptHandler = (await import('../api/reoptimize.js')).default;

async function callHandler(handler, body, ipPrefix) {
  const req = { method: 'POST', url: '/api/x', headers: { 'x-forwarded-for': ipPrefix + (++callHandler.n) }, query: {}, body };
  const res = {
    code: null, payload: null,
    setHeader() {},
    status(c) { this.code = c; return this; },
    json(o) { this.payload = o; return this; },
    end() { return this; },
  };
  await handler(req, res);
  return res;
}
callHandler.n = 0;

// ---------------------------------------------------------------- (a)
test('(a) save seam: a checker exception is logged with console.error and the save still succeeds (fail-open)', async () => {
  const CFG_DAYS_1 = [{ date: 'Dec 7, 2026', park: DL, isVip: false }];
  const HELD_PLAIN = [{ day: 0, rideKey: 'space mountain', ride: SM, returnStart: '2:00 PM', returnEnd: '3:00 PM', bookedAt: '2026-11-01T00:00:00.000Z', conflict: '' }];
  const ITEMS_GOOD = [
    { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: '' },
    { t: '1:00 PM', h: 'Jungle Cruise', type: 'ride', n: '' },
    { t: '2:00 PM', h: SM, type: 'ride', n: '', anchor: true, heldReturn: true },
  ];
  const ITEMS_DROPPED = ITEMS_GOOD.filter(e => e.h !== SM);
  const cfg = (items, heldReturns) => ({
    location: 'Disneyland', days: CFG_DAYS_1, heldReturns, reservations: [],
    dining: { reservations: [] }, ridePreferences: { mustDo: [], wantToDo: [], skip: [] },
    schedule: { days: [{ park: DL, items }] }, onboardingComplete: true,
  });
  globalThis.__p8BlobTable = {
    [REG_KEY]: JSON.stringify({ SEAMP8: { tripId: 'seam-p8-trip', role: 'admin', status: 'active' } }),
    [STABLE_KEY]: { data: { sections: { CATALOG } } },
    [DYNAMIC_KEY]: { data: { sections: { CLOSURES: [], CURRENT_CLOSURES: 'All attractions operating today.', DINING_CLOSURES: [] } } },
    [SEAM_TRIP_KEY]: JSON.stringify({ tripConfig: cfg(ITEMS_GOOD, HELD_PLAIN) }),
  };
  errLines.length = 0; warnLines.length = 0;
  // The marked write carries a day that DROPS the held card while its
  // (poisoned) record persists. A working checker refuses this write
  // (part 2 case (a)); a throwing checker must fail open -- and be
  // heard.
  const res = await callHandler(tripHandler, {
    code: 'SEAMP8',
    tripData: { tripConfig: cfg(ITEMS_DROPPED, [poisonHeld(0, 'forced checker failure (save seam fixture)')]) },
    anchorRecordActions: ['heldReturns'],
  }, '10.8.1.');
  assert.equal(res.code, 200, 'the save succeeds despite the checker exception: ' + JSON.stringify(res.payload));
  assert.equal(res.payload.ok, true);
  const stored = JSON.parse(globalThis.__p8BlobTable[SEAM_TRIP_KEY]);
  assert.equal(stored.tripConfig.schedule.days[0].items.some(e => e.h === SM), false, 'fail-open: the card-free day persisted (a working checker would have refused it)');
  assert.ok(
    errLines.some(l => l.includes('[trip-anchor]') && l.includes('anchor verify failed') && l.includes('forced checker failure (save seam fixture)')),
    'a console.error line names the save seam and carries the exception. error lines: ' + JSON.stringify(errLines),
  );
  assert.ok(
    !warnLines.some(l => l.includes('anchor verify failed')),
    'the seam failure did NOT go to console.warn (pre-part-8 it did)',
  );
});

// ---------------------------------------------------------------- (b)
test('(b) reoptimize post-check: a checker exception is logged with console.error and the plan still ships (fail-open)', async () => {
  const ITEMS = [
    { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: '' },
    { t: '10:00 AM', h: 'VIP Tour', type: 'vip', n: '' },
    { t: '1:00 PM', h: 'Jungle Cruise', type: 'ride', n: '' },
    { t: '2:00 PM', h: SM, type: 'ride', n: '', anchor: true, heldReturn: true, _preBook: { idx: 3, item: { t: '2:00 PM', h: SM, type: 'ride', n: '' } } },
    { t: '4:00 PM', h: 'Haunted Mansion', type: 'ride', n: '', _recordedInsert: true },
    { t: '6:30 PM', h: BB, type: 'dining', n: '', anchor: true, reservation: true, isConfirmed: true },
  ];
  const HELD_PLAIN = { day: 1, rideKey: 'space mountain', ride: SM, returnStart: '2:00 PM', returnEnd: '3:00 PM', bookedAt: '2026-11-01T00:00:00.000Z', conflict: '' };
  globalThis.__p8BlobTable = {
    [REG_KEY]: JSON.stringify({ ANCHORP8L: { tripId: 'anchor-p8l-trip', role: 'admin', status: 'active' } }),
    [STABLE_KEY]: { data: { sections: { LAND_MAP: 'lands', WAIT_PATTERNS: 'waits', CROWD_FLOW: 'crowds', WALKING_ROUTES: 'walks', CATALOG } } },
    [DYNAMIC_KEY]: { data: { sections: { CURRENT_CLOSURES: 'All attractions operating today.' } } },
    [REOPT_TRIP_KEY]: {
      tripConfig: {
        location: 'Disneyland',
        days: [
          { date: 'Dec 7, 2026', park: DL },
          { date: 'Dec 8, 2026', park: DL, isVip: true, vipStart: '10:00 AM', vipEnd: '12:00 PM' },
        ],
        reservations: [],
        dining: { reservations: [{ name: BB, time: '6:30 PM', day: 2 }] },
        heldReturns: [poisonHeld(1, 'forced checker failure (reoptimize fixture)')],
        ridePreferences: { mustDo: [], wantToDo: [], skip: [] },
      },
    },
  };
  proposal = JSON.parse(JSON.stringify(ITEMS));
  proposal.find(e => e.h === 'Jungle Cruise').t = '12:30 PM';
  errLines.length = 0;
  const res = await callHandler(reoptHandler, {
    scheduleItems: JSON.parse(JSON.stringify(ITEMS)), dayLabel: 'Tuesday Dec 8', tripDayDate: 'Dec 8, 2026',
    isInTrip: false, currentTime: null, liveWaits: null, tripCode: 'ANCHORP8L',
    heldReturns: [HELD_PLAIN],
  }, '10.8.2.');
  assert.equal(res.code, 200, 'the plan ships despite the checker exception: ' + JSON.stringify(res.payload));
  assert.equal(res.payload.changed, true, 'the legal plan ships (fail-open: judged by the other guards only)');
  assert.ok(
    errLines.some(l => l.includes('[reoptimize]') && l.includes('anchor verify failed') && l.includes('forced checker failure (reoptimize fixture)')),
    'a console.error line names the reoptimize seam and carries the exception. error lines: ' + JSON.stringify(errLines),
  );
});

// ---------------------------------------------------------------- (c)
test('(c) static pins: every anchor-checker catch logs with console.error and names its seam', () => {
  const sites = [
    { file: '../api/generateschedule.js', seam: 'generation post-generation check' },
    { file: '../api/trip.js', seam: 'save seam' },
    { file: '../api/reoptimize.js', seam: 'reoptimize post-check' },
  ];
  for (const { file, seam } of sites) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const i = src.indexOf('anchor verify failed');
    assert.ok(i !== -1, file + ': the anchor verify fail-open log line exists');
    const line = src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i));
    assert.ok(line.includes('console.error'), file + ': the fail-open catch logs with console.error (line: ' + line.trim() + ')');
    assert.ok(line.includes('anchor verify failed') && line.toLowerCase().includes('seam'), file + ': the log line names its seam (' + seam + ')');
  }
});
