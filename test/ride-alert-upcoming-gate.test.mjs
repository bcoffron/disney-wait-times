// Tests for the upcoming-only ride-alert gate (Beau, Oct 23, 2026;
// Claude msg 606 rulings; api/cron-push-monitor.js emission gate).
//
// The defect: ride-condition alerts (spike / drop / high / down /
// back-up) fired for rides whose moment on today's plan had already
// passed -- a spike ping for the 8:30 AM Space Mountain at 11 AM.
// The fix gates EMISSION only: the wait-state machine keeps tracking
// waits and recording crossings exactly as before (ruling Q1), and a
// candidate is suppressed when park-local now >= the ride's done-at
// on the CURRENT stored day -- booked return's window end when one
// is recorded (Q3), else an LL window end, else the scheduled start;
// the latest occurrence governs. Unparseable times fail OPEN and
// leave a named parse-gap record (Q2); suppressions leave a per-day
// count + names trace in the wait-state (Q4).
//
// Two layers, matching the repo's monitor suites: the pure helpers
// are driven directly, and the real handler is driven end to end
// with @vercel/blob + web-push stubbed (module.register hooks) and
// fetch routed to an in-memory blob store + canned live waits.
// Handler fixtures are built relative to the REAL park-local clock
// (the handler reads Date.now), with item times offset from it.
// Run with Node's built-in runner (no new dependencies):
//   node --test test/ride-alert-upcoming-gate.test.mjs
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

// ------------------------------------------------------------- stubs
const blobStubSrc = [
  'function store() {',
  '  if (!globalThis.__gateBlob) globalThis.__gateBlob = new Map();',
  '  return globalThis.__gateBlob;',
  '}',
  'export async function list(opts) {',
  '  const prefix = (opts && opts.prefix) || "";',
  '  const blobs = [];',
  '  for (const [pathname, body] of store()) {',
  '    if (!prefix || pathname.startsWith(prefix)) {',
  '      blobs.push({ pathname: pathname, url: "https://blob.test/" + pathname, downloadUrl: "https://blob.test/" + pathname, uploadedAt: new Date().toISOString() });',
  '    }',
  '  }',
  '  return { blobs: blobs };',
  '}',
  'export async function put(pathname, body) {',
  '  store().set(pathname, String(body));',
  '  return { url: "https://blob.test/" + pathname, pathname: pathname };',
  '}',
  'export async function del() {}',
  'export async function get() { return null; }',
].join('\n');
const webpushStubSrc = [
  'export default {',
  '  setVapidDetails() {},',
  '  async sendNotification() {',
  '    if (!globalThis.__wpSends) globalThis.__wpSends = [];',
  '    globalThis.__wpSends.push(1);',
  '    return {};',
  '  }',
  '};',
].join('\n');
const hooksSrc = [
  'let blobUrl = "", wpUrl = "";',
  'export async function initialize(data) { blobUrl = data.blob; wpUrl = data.wp; }',
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === '@vercel/blob') return { url: blobUrl, shortCircuit: true };",
  "  if (specifier === 'web-push') return { url: wpUrl, shortCircuit: true };",
  '  return nextResolve(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript;base64,' + Buffer.from(hooksSrc).toString('base64'), {
  data: {
    blob: 'data:text/javascript;base64,' + Buffer.from(blobStubSrc).toString('base64'),
    wp: 'data:text/javascript;base64,' + Buffer.from(webpushStubSrc).toString('base64'),
  },
});

process.env.CRON_SECRET = 'gate-secret';
process.env.VAPID_PUBLIC_KEY = 'gate-pub';
process.env.VAPID_PRIVATE_KEY = 'gate-priv';
delete process.env.APNS_KEY_ID;
delete process.env.APNS_KEY_P8;
delete process.env.BLOB_PATH_SALT;

const monitor = await import('../api/cron-push-monitor.js');
const handler = monitor.default;
const {
  evaluateRideEligibility, gateCandidateList, recordAlertParseGap,
  recordAlertSuppression, heldRideKey, itemWindowEndMin,
} = monitor;

// ------------------------------------------------------- fetch routing
const DL_ID = '7340550b-c14d-4def-80bb-acdb51d49a66';
const DCA_ID = '832fcd51-ea19-4e77-85c7-75d5843b127c';
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api.themeparks.wiki')) {
    const data = u.includes(DCA_ID) ? (globalThis.__liveDCA || []) : (globalThis.__liveDL || []);
    return { ok: true, json: async () => ({ liveData: data }) };
  }
  if (u.startsWith('https://blob.test/')) {
    const pathname = decodeURIComponent(u.slice('https://blob.test/'.length).split('?')[0]);
    const body = globalThis.__gateBlob && globalThis.__gateBlob.get(pathname);
    if (body === undefined) return { ok: false, status: 404, json: async () => null, text: async () => '' };
    return { ok: true, json: async () => JSON.parse(body), text: async () => body };
  }
  throw new Error('unstubbed fetch: ' + u);
};

// ------------------------------------------------------------ fixtures
function ptNow() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value;
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0;
  return { ymd: p.year + '-' + p.month + '-' + p.day, minutes: hour * 60 + parseInt(p.minute, 10) };
}
function fmtMin(m) {
  const mm = ((m % 1440) + 1440) % 1440;
  let h = Math.floor(mm / 60);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + String(mm % 60).padStart(2, '0') + ' ' + ap;
}
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function longDate(ymd) {
  const parts = ymd.split('-');
  return MONTH_NAMES[parseInt(parts[1], 10) - 1] + ' ' + parseInt(parts[2], 10) + ', ' + parts[0];
}

const NOW = ptNow().minutes;
const PAST = Math.max(0, NOW - 120);       // clearly earlier today
const PAST15 = Math.max(0, NOW - 15);      // inside the down-episode past-grace
const FUTURE = Math.min(1439, NOW + 120);  // clearly later today
const DROP_OK = NOW < 21 * 60;             // drop class has a 9 PM park cutoff

const SM = 'Space Mountain';
const INDY = 'Indiana Jones Adventure';
const MATT = 'Matterhorn Bobsleds';
const liveRide = (name, wait, status) => ({
  entityType: 'ATTRACTION', name: name, status: status || 'OPERATING',
  queue: (typeof wait === 'number') ? { STANDBY: { waitTime: wait } } : {},
});
const rideItem = (name, min) => ({ t: fmtMin(min), h: name, type: 'ride', n: '', land: '' });

function resetStore() {
  globalThis.__gateBlob = new Map();
  globalThis.__wpSends = [];
  globalThis.__liveDL = [];
  globalThis.__liveDCA = [];
}
function seedBlob(pathname, obj) {
  globalThis.__gateBlob.set(pathname, JSON.stringify(obj));
}
function readBlob(pathname) {
  const raw = globalThis.__gateBlob.get(pathname);
  return raw === undefined ? null : JSON.parse(raw);
}
function seedTrip(opts) {
  const o = opts || {};
  const code = o.code || 'GATE01';
  const tripId = o.tripId || 'gate-trip-1';
  const ymd = ptNow().ymd;
  seedBlob('twize/trip_registry.json', { [code]: { tripId: tripId, status: 'active', role: 'admin' } });
  seedBlob('twize/push-subs/' + code + '.json', {
    tripCode: code,
    subscriptions: [{ endpoint: 'https://push.test/1', keys: { p256dh: 'a', auth: 'b' } }],
  });
  seedBlob('twize/trip_' + tripId + '.json', {
    tripConfig: {
      days: [{ date: longDate(ymd), park: 'Disneyland' }],
      schedule: { days: [{ park: 'Disneyland', items: o.items || [] }] },
      heldReturns: o.heldReturns || [],
    },
  });
  if (o.state) seedBlob('twize/wait-state/' + tripId + '.json', o.state);
  return { code, tripId };
}
function mockRes() {
  return {
    headers: {}, code: 0, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
  };
}
async function sweep() {
  const res = mockRes();
  await handler({ headers: { authorization: 'Bearer gate-secret' }, query: { force: '1' } }, res);
  assert.equal(res.code, 200, 'handler 200: ' + JSON.stringify(res.body));
  return res.body;
}
const wpCount = () => (globalThis.__wpSends || []).length;
const readState = (tripId) => readBlob('twize/wait-state/' + tripId + '.json');

// ============================================================ helpers
test('heldRideKey is the client llNormKey, byte for byte on known names', () => {
  assert.equal(heldRideKey('Star Wars: Rise of the Resistance'), 'star wars rise of resistance');
  assert.equal(heldRideKey("it's a small world"), 'it s small world');
  assert.equal(heldRideKey('Space Mountain'), 'space mountain');
  assert.equal(heldRideKey('Mickey & Minnie\'s Runaway Railway'), 'mickey minnie s runaway railway');
  assert.equal(heldRideKey('The Haunted Mansion (Holiday)'), 'haunted mansion');
  assert.equal(heldRideKey(''), '');
  assert.equal(heldRideKey(null), '');
});

test('itemWindowEndMin: no window in the normal shapes; explicit and range windows read', () => {
  assert.equal(itemWindowEndMin({ t: '8:30 AM', h: 'X', type: 'ride' }), -1);
  assert.equal(itemWindowEndMin({ t: '8:30 AM', ll: { t: 'multi', a: 'book a return' } }), -1);
  assert.equal(itemWindowEndMin({ t: '8:30 AM', returnEnd: '10:00 AM' }), 600);
  assert.equal(itemWindowEndMin({ t: '2:30 PM - 3:30 PM', ll: { t: 'multi' } }), 930);
  assert.equal(itemWindowEndMin({ t: '2:30 PM - 3:30 PM' }), -1, 'range counts only on LL items');
  assert.equal(itemWindowEndMin(null), -1);
});

const EL = (over) => evaluateRideEligibility(Object.assign({
  items: [], itemKeys: [], rideKey: 'space mountain', liveName: SM,
  heldReturns: [], dayIdx: 0, nowMin: 660,
}, over || {}));

test('eligibility: standby ride is done at its scheduled start, eligible before it', () => {
  const items = [rideItem(SM, 510)]; // 8:30 AM
  const keys = ['space mountain'];
  const before = EL({ items, itemKeys: keys, nowMin: 509 });
  assert.equal(before.eligible, true);
  const at = EL({ items, itemKeys: keys, nowMin: 510 });
  assert.equal(at.eligible, false, 'now >= done-at suppresses');
  assert.equal(at.doneAtMin, 510);
  assert.equal(at.via, 'schedule');
  assert.deepEqual(at.parseGaps, []);
});

test('eligibility: LL window item stays live until the window END', () => {
  const items = [{ t: '2:30 PM - 3:30 PM', h: SM, type: 'ride', ll: { t: 'multi' } }];
  const keys = ['space mountain'];
  assert.equal(EL({ items, itemKeys: keys, nowMin: 929 }).eligible, true);
  const done = EL({ items, itemKeys: keys, nowMin: 930 });
  assert.equal(done.eligible, false);
  assert.equal(done.doneAtMin, 930);
});

test('eligibility: a booked return governs over the plan item, in BOTH directions', () => {
  const held = [{ day: 0, rideKey: 'space mountain', ride: SM, returnStart: '2:30 PM', returnEnd: '3:30 PM' }];
  // Later return keeps a passed standby item live.
  const later = EL({ items: [rideItem(SM, 510)], itemKeys: ['space mountain'], heldReturns: held, nowMin: 660 });
  assert.equal(later.eligible, true);
  assert.equal(later.doneAtMin, 930);
  assert.equal(later.via, 'booked-return');
  // Earlier return ends an upcoming standby item sooner.
  const earlier = EL({
    items: [rideItem(SM, 840)], itemKeys: ['space mountain'],
    heldReturns: [{ day: 0, rideKey: 'space mountain', ride: SM, returnStart: '9:00 AM', returnEnd: '10:00 AM' }],
    nowMin: 660,
  });
  assert.equal(earlier.eligible, false);
  assert.equal(earlier.doneAtMin, 600);
  assert.equal(earlier.via, 'booked-return');
  // A return recorded for ANOTHER day does not govern today.
  const otherDay = EL({
    items: [rideItem(SM, 510)], itemKeys: ['space mountain'],
    heldReturns: [{ day: 1, rideKey: 'space mountain', ride: SM, returnStart: '2:30 PM', returnEnd: '3:30 PM' }],
    nowMin: 660,
  });
  assert.equal(otherDay.eligible, false);
  assert.equal(otherDay.via, 'schedule');
  // Name-only record (no rideKey) still matches through normName.
  const byName = EL({
    items: [rideItem(SM, 510)], itemKeys: ['space mountain'],
    heldReturns: [{ day: 0, ride: SM, returnStart: '2:30 PM', returnEnd: '3:30 PM' }],
    nowMin: 660,
  });
  assert.equal(byName.eligible, true);
  assert.equal(byName.via, 'booked-return');
});

test('eligibility: multiple occurrences -- any still-upcoming one keeps the ride eligible', () => {
  const items = [rideItem(SM, 510), rideItem(SM, 1140)]; // 8:30 AM and 7:00 PM
  const keys = ['space mountain', 'space mountain'];
  const mid = EL({ items, itemKeys: keys, nowMin: 660 });
  assert.equal(mid.eligible, true);
  assert.equal(mid.doneAtMin, 1140, 'latest done-at governs');
  assert.equal(EL({ items, itemKeys: keys, nowMin: 1200 }).eligible, false);
});

test('eligibility: unparseable item time fails OPEN and names the gap', () => {
  const items = [{ t: 'whenever', h: SM, type: 'ride' }];
  const ev = EL({ items, itemKeys: ['space mountain'], nowMin: 660 });
  assert.equal(ev.eligible, true, 'cannot prove it passed -> the alert flows');
  assert.equal(ev.via, 'unparsed');
  assert.equal(ev.parseGaps.length, 1);
  assert.match(ev.parseGaps[0].ref, /whenever/);
  // A broken held return is named too, and the plan still decides.
  const heldGap = EL({
    items: [rideItem(SM, 510)], itemKeys: ['space mountain'],
    heldReturns: [{ day: 0, rideKey: 'space mountain', ride: SM, returnStart: '2:30 PM', returnEnd: 'soon' }],
    nowMin: 660,
  });
  assert.equal(heldGap.eligible, false, 'falls back to the parseable plan item');
  assert.equal(heldGap.via, 'schedule');
  assert.equal(heldGap.parseGaps.length, 1);
  assert.match(heldGap.parseGaps[0].ref, /held return/);
  // Ride absent from the day: eligible, silently (not a parse gap).
  const absent = EL({ items: [], itemKeys: [], nowMin: 660 });
  assert.equal(absent.eligible, true);
  assert.equal(absent.via, 'not-in-day');
  assert.deepEqual(absent.parseGaps, []);
});

test('gateCandidateList filters ineligible candidates and collects their names', () => {
  const suppressed = [];
  const out = gateCandidateList(
    [{ name: 'A Ride' }, { name: 'B Ride' }, { name: 'C Ride' }],
    (c) => c.name,
    (key) => ({ eligible: key !== 'B Ride' }),
    suppressed);
  assert.deepEqual(out.map(c => c.name), ['A Ride', 'C Ride']);
  assert.deepEqual(suppressed, ['B Ride']);
});

test('recordAlertParseGap appends once per (day, ride, ref) and stays bounded', () => {
  const state = {};
  const rec = { kind: 'alert-time-unparsed', ymd: '2026-10-23', tripId: 't', ride: SM, ref: 'item "Space Mountain" t="whenever"', atMin: 660 };
  assert.equal(recordAlertParseGap(state, rec), true);
  assert.equal(recordAlertParseGap(state, rec), false, 'same day + ride + ref dedupes');
  assert.equal(state.alertParseGaps.length, 1);
  assert.equal(recordAlertParseGap(state, Object.assign({}, rec, { ref: 'item "Space Mountain" t="later"' })), true);
  assert.equal(state.alertParseGaps.length, 2);
  for (let i = 0; i < 20; i++) recordAlertParseGap(state, { kind: 'alert-time-unparsed', ymd: '2026-10-23', ride: 'Ride ' + i, ref: 'r' + i });
  assert.equal(state.alertParseGaps.length, 14, 'capped like the divergence log');
});

test('recordAlertSuppression accumulates per day and rolls over cleanly', () => {
  const state = {};
  assert.equal(recordAlertSuppression(state, '2026-10-23', [SM]), true);
  assert.deepEqual(state.alertSuppressions, { ymd: '2026-10-23', count: 1, rides: [SM] });
  assert.equal(recordAlertSuppression(state, '2026-10-23', [SM, INDY]), true);
  assert.deepEqual(state.alertSuppressions, { ymd: '2026-10-23', count: 3, rides: [SM, INDY] },
    'count grows per suppressed ride per sweep; names dedupe');
  assert.equal(recordAlertSuppression(state, '2026-10-24', [INDY]), true);
  assert.deepEqual(state.alertSuppressions, { ymd: '2026-10-24', count: 1, rides: [INDY] }, 'a new day replaces the record');
  assert.equal(recordAlertSuppression(state, '2026-10-24', []), false, 'empty sweep writes nothing');
});

// ============================================================ handler
test('handler: spike for a PASSED standby ride is suppressed; the crossing is still recorded', async () => {
  resetStore();
  const { tripId } = seedTrip({ items: [rideItem(SM, PAST)] });
  globalThis.__liveDL = [liveRide(SM, 20)];
  await sweep();
  globalThis.__liveDL = [liveRide(SM, 50)];
  await sweep();
  assert.equal(wpCount(), 0, 'no send to any role for a done ride');
  const st = readState(tripId);
  assert.equal(st.rides['space mountain'].wait, 50, 'state machine recorded the crossing anyway (gate is emission-only)');
  assert.equal(typeof st.rides['space mountain'].lastAlertMin, 'number', 'crossing bookkeeping untouched');
  assert.deepEqual(st.alertSuppressions, { ymd: ptNow().ymd, count: 1, rides: [SM] });
  if (DROP_OK) {
    // A later drop candidate for the same done ride is suppressed too,
    // and the trace counts it as a second evaluation.
    globalThis.__liveDL = [liveRide(SM, 10)];
    await sweep();
    assert.equal(wpCount(), 0);
    assert.equal(readState(tripId).alertSuppressions.count, 2);
  }
});

test('handler: spike for an UPCOMING ride fires normally', async () => {
  resetStore();
  const { tripId } = seedTrip({ items: [rideItem(SM, FUTURE)] });
  globalThis.__liveDL = [liveRide(SM, 20)];
  await sweep();
  globalThis.__liveDL = [liveRide(SM, 55)];
  await sweep();
  assert.equal(wpCount(), 1);
  const st = readState(tripId);
  assert.equal(st.alertSuppressions, undefined, 'no suppression recorded');
  assert.equal(st.rides['space mountain'].fireCounts.spike, 1);
});

test('handler: drop for a passed ride is suppressed; for an upcoming ride it fires', async (t) => {
  if (!DROP_OK) { t.skip('drop class is past its 9 PM park cutoff right now'); return; }
  resetStore();
  let seeded = seedTrip({ items: [rideItem(INDY, PAST)] });
  globalThis.__liveDL = [liveRide(INDY, 60)];
  await sweep();
  globalThis.__liveDL = [liveRide(INDY, 10)];
  await sweep();
  assert.equal(wpCount(), 0, 'passed ride: drop suppressed');
  assert.deepEqual(readState(seeded.tripId).alertSuppressions.rides, [INDY]);

  resetStore();
  seeded = seedTrip({ items: [rideItem(INDY, FUTURE)] });
  globalThis.__liveDL = [liveRide(INDY, 55)]; // below the 60-min high threshold so only the drop can fire
  await sweep();
  globalThis.__liveDL = [liveRide(INDY, 10)];
  await sweep();
  assert.equal(wpCount(), 1, 'upcoming ride: drop fires');
});

test('handler: high-wait nudge is gated the same way', async () => {
  resetStore();
  let seeded = seedTrip({ items: [rideItem(MATT, PAST)] });
  globalThis.__liveDL = [liveRide(MATT, 70)];
  await sweep();
  assert.equal(wpCount(), 0, 'passed ride at 70 min: no high nudge');
  assert.deepEqual(readState(seeded.tripId).alertSuppressions.rides, [MATT]);

  resetStore();
  seeded = seedTrip({ items: [rideItem(MATT, FUTURE)] });
  globalThis.__liveDL = [liveRide(MATT, 70)];
  await sweep();
  assert.equal(wpCount(), 1, 'upcoming ride at 70 min: high nudge fires');
});

test('handler: down episode inside the past-grace is suppressed once the ride is done', async () => {
  resetStore();
  const { tripId } = seedTrip({ items: [rideItem(SM, PAST15)] });
  globalThis.__liveDL = [liveRide(SM, null, 'DOWN')];
  await sweep();
  assert.equal(wpCount(), 0, 'ride done 15 minutes ago: down alert suppressed');
  assert.deepEqual(readState(tripId).alertSuppressions.rides, [SM]);

  resetStore();
  const seeded = seedTrip({ items: [rideItem(SM, FUTURE)] });
  globalThis.__liveDL = [liveRide(SM, null, 'DOWN')];
  await sweep();
  assert.equal(wpCount(), 1, 'upcoming ride down: alert fires');
  assert.equal(readState(seeded.tripId).rides['space mountain'].downAlerted, true);
});

test('handler: back-up for a done ride is suppressed and consumes nothing', async () => {
  const ymd = ptNow().ymd;
  const downState = {
    ymd: ymd, lastHighAlertMin: -99999,
    rides: { 'space mountain': { status: 'DOWN', downAlerted: true, wait: null, lastDownAlertMin: NOW - 60 } },
  };
  resetStore();
  let seeded = seedTrip({ items: [rideItem(SM, PAST)], state: downState });
  globalThis.__liveDL = [liveRide(SM, 15)];
  await sweep();
  assert.equal(wpCount(), 0, 'back-up for a done ride: suppressed');
  let st = readState(seeded.tripId);
  assert.equal(st.rides['space mountain'].downAlerted, true, 'suppression does not close the episode record');
  assert.deepEqual(st.alertSuppressions.rides, [SM]);

  resetStore();
  seeded = seedTrip({ items: [rideItem(SM, FUTURE)], state: downState });
  globalThis.__liveDL = [liveRide(SM, 15)];
  await sweep();
  assert.equal(wpCount(), 1, 'back-up for an upcoming ride: fires');
  st = readState(seeded.tripId);
  assert.equal(st.rides['space mountain'].downAlerted, false, 'a sent back-up closes the episode as before');
});

test('handler: a booked return overrides the plan item in both directions', async () => {
  // Later return: standby moment long past, return window still open.
  resetStore();
  let seeded = seedTrip({
    items: [rideItem(SM, PAST)],
    heldReturns: [{ day: 0, rideKey: 'space mountain', ride: SM, returnStart: fmtMin(NOW + 30), returnEnd: fmtMin(NOW + 90), bookedAt: 'x' }],
  });
  globalThis.__liveDL = [liveRide(SM, 20)];
  await sweep();
  globalThis.__liveDL = [liveRide(SM, 50)];
  await sweep();
  assert.equal(wpCount(), 1, 'booked return still open -> spike fires despite the passed plan item');
  assert.equal(readState(seeded.tripId).alertSuppressions, undefined);

  // Earlier return: plan item still upcoming, but the asserted return already ended.
  resetStore();
  seeded = seedTrip({
    items: [rideItem(SM, FUTURE)],
    heldReturns: [{ day: 0, rideKey: 'space mountain', ride: SM, returnStart: fmtMin(Math.max(0, NOW - 90)), returnEnd: fmtMin(Math.max(0, NOW - 30)), bookedAt: 'x' }],
  });
  globalThis.__liveDL = [liveRide(SM, 20)];
  await sweep();
  globalThis.__liveDL = [liveRide(SM, 50)];
  await sweep();
  assert.equal(wpCount(), 0, 'booked return already over -> spike suppressed despite the upcoming plan item');
  assert.deepEqual(readState(seeded.tripId).alertSuppressions.rides, [SM]);
});

test('handler: a rework that moves the ride later revives its alerts on the next crossing', async () => {
  resetStore();
  const seeded = seedTrip({ items: [rideItem(SM, PAST)] });
  globalThis.__liveDL = [liveRide(SM, 20)];
  await sweep();
  globalThis.__liveDL = [liveRide(SM, 25)];
  await sweep();
  assert.equal(wpCount(), 0);
  // The rework lands: same trip, the ride now sits in the evening.
  seedBlob('twize/trip_' + seeded.tripId + '.json', {
    tripConfig: {
      days: [{ date: longDate(ptNow().ymd), park: 'Disneyland' }],
      schedule: { days: [{ park: 'Disneyland', items: [rideItem(SM, FUTURE)] }] },
      heldReturns: [],
    },
  });
  globalThis.__liveDL = [liveRide(SM, 55)];
  await sweep();
  assert.equal(wpCount(), 1, 'crossing after the rework fires immediately through the normal spike logic');
});

test('handler: still-spiked ride re-planned later alerts through the high class', async () => {
  resetStore();
  const seeded = seedTrip({ items: [rideItem(SM, PAST)] });
  globalThis.__liveDL = [liveRide(SM, 20)];
  await sweep();
  globalThis.__liveDL = [liveRide(SM, 50)];
  await sweep();
  assert.equal(wpCount(), 0, 'crossing while done: suppressed, but recorded');
  seedBlob('twize/trip_' + seeded.tripId + '.json', {
    tripConfig: {
      days: [{ date: longDate(ptNow().ymd), park: 'Disneyland' }],
      schedule: { days: [{ park: 'Disneyland', items: [rideItem(SM, FUTURE)] }] },
      heldReturns: [],
    },
  });
  globalThis.__liveDL = [liveRide(SM, 65)];
  await sweep();
  assert.equal(wpCount(), 1, 'wait still over the high threshold: the high nudge fires on the next sweep');
});

test('handler: unparseable item time fails open AND records the parse gap once', async () => {
  resetStore();
  const seeded = seedTrip({ items: [{ t: 'whenever', h: SM, type: 'ride', n: '', land: '' }, rideItem(INDY, FUTURE)] });
  globalThis.__liveDL = [liveRide(SM, 20), liveRide(INDY, 25)];
  await sweep();
  globalThis.__liveDL = [liveRide(SM, 50), liveRide(INDY, 55)];
  await sweep();
  const st = readState(seeded.tripId);
  assert.equal(st.alertParseGaps.length, 1, 'one gap record for the broken item');
  assert.equal(st.alertParseGaps[0].kind, 'alert-time-unparsed');
  assert.equal(st.alertParseGaps[0].ride, SM);
  assert.match(st.alertParseGaps[0].ref, /whenever/);
  assert.equal(wpCount(), 1, 'both rides crossed; the ladder still sends one, and neither was suppressed');
  assert.equal(st.alertSuppressions, undefined);
});

test('handler: a reshuffle sweep that revives several rides still sends at most one ride alert', async () => {
  resetStore();
  const seeded = seedTrip({ items: [rideItem(SM, PAST), rideItem(INDY, PAST), rideItem(MATT, PAST)] });
  globalThis.__liveDL = [liveRide(SM, 20), liveRide(INDY, 25), liveRide(MATT, 15)];
  await sweep();
  globalThis.__liveDL = [liveRide(SM, 50), liveRide(INDY, 55), liveRide(MATT, 48)];
  await sweep();
  assert.equal(wpCount(), 0, 'all three crossings suppressed while the rides are done');
  assert.equal(readState(seeded.tripId).alertSuppressions.count, 3);
  assert.equal(readState(seeded.tripId).alertSuppressions.rides.length, 3);
  // One rework moves all three to the evening; all three are still hot.
  seedBlob('twize/trip_' + seeded.tripId + '.json', {
    tripConfig: {
      days: [{ date: longDate(ptNow().ymd), park: 'Disneyland' }],
      schedule: { days: [{ park: 'Disneyland', items: [rideItem(SM, FUTURE), rideItem(INDY, FUTURE), rideItem(MATT, FUTURE)] }] },
      heldReturns: [],
    },
  });
  globalThis.__liveDL = [liveRide(SM, 65), liveRide(INDY, 70), liveRide(MATT, 62)];
  await sweep();
  assert.equal(wpCount(), 1, 'three eligible rides, one sweep: the existing ladder sends exactly one');
  const st = readState(seeded.tripId);
  const highAlerted = [SM, INDY, MATT].filter(n => st.rides[n.toLowerCase()] && st.rides[n.toLowerCase()].highAlerted);
  assert.equal(highAlerted.length, 1, 'only the sent ride consumed its once-a-day high flag');
});

test('handler: yesterday\'s suppression trace does not leak into today', async () => {
  resetStore();
  const seeded = seedTrip({
    items: [rideItem(SM, PAST)],
    state: { ymd: '2000-01-01', rides: {}, lastHighAlertMin: -99999, alertSuppressions: { ymd: '2000-01-01', count: 7, rides: ['Old Ride'] } },
  });
  globalThis.__liveDL = [liveRide(SM, 20)];
  await sweep();
  globalThis.__liveDL = [liveRide(SM, 50)];
  await sweep();
  const st = readState(seeded.tripId);
  assert.deepEqual(st.alertSuppressions, { ymd: ptNow().ymd, count: 1, rides: [SM] },
    'day rollover replaced the stale trace');
});
