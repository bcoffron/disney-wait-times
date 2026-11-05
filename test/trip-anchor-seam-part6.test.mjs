// Tests for the save-seam record closure (api/trip.js; anchor fix
// lane part 6, Nov 4, 2026 -- Claude's anchor-lane ruling on part 2's
// seam, plus its flag 5).
//
// Part 2 keyed the seam's expectations on the INCOMING config's
// records, which left the hole this part closes: a write that lost an
// anchor RECORD and its card together passed (nothing was expected,
// nothing was missed), and any general save could silently delete
// anchor records. The closure, implemented in api/trip.js:
//   - Record-action writes declare the record class(es) they are
//     authoritative for in the top-level body field
//     `anchorRecordActions` (saveHeldReturns declares ['heldReturns'];
//     pretrip's saves declare ['reservations']).
//   - For every class a write does NOT declare, the persisted config
//     carries the STORED records forward -- the write's version of
//     that class cannot shrink the record set.
//   - Each written day is then verified against the POST-WRITE record
//     set (after carry-forward), with part 2's refusal semantics
//     (400 ANCHOR_VIOLATION, anchors named, nothing stored).
//   - A stored reservation record with a readable time but no day
//     (legacy flat shapes; structured rows shipped -- pretrip trace
//     Q4) creates NO expectation on any day, can never cause a
//     refusal, and surfaces by name in the save response's surfacing
//     channel (anchorRecordsNeedingDay) as needing a day.
//
// Negative controls (run against 38c9fbe5, pre-part-6 main, recorded
// in the lane's build log): cases (a), (e) and (f) FAIL there --
// (a)'s write succeeds and the record is gone, (e) is refused by the
// day-null expectation, (f)'s shrink persists. Cases (b), (c) and
// (d) pass on both trees by design: the pre-part-6 seam ignores the
// marker and its incoming-keyed expectation already let those shapes
// through; they pin that the marker does not break legitimate record
// actions.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/trip-anchor-seam-part6.test.mjs
// Harness mirrors test/trip-anchor-seam.test.mjs (part 2): @vercel/blob
// and web-push are redirected to inline stubs via module.register
// hooks; global fetch serves blob reads from the same in-memory table
// the stub's put writes.
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const blobStubSrc = [
  'const table = () => globalThis.__seamP6BlobTable;',
  'export async function list({ prefix } = {}) {',
  '  const t = table(); const out = [];',
  '  for (const k of Object.keys(t)) if (!prefix || k.startsWith(prefix)) out.push({ url: "https://blob.test/" + k, pathname: k });',
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
delete process.env.ADMIN_KEY;
delete process.env.BLOB_PATH_SALT;

const REG_KEY = 'twize/trip_registry.json';
const STABLE_KEY = 'twize/park_intel_dl_stable.json';
const DYNAMIC_KEY = 'twize/park_intel_dl_dynamic.json';
const CODES = { SEAMP6: 'seamp6-trip' };

const DL = 'Disneyland';
const SM = 'Space Mountain';
const BB = 'Blue Bayou Restaurant';
const BENGAL = 'Bengal Barbecue';
const CATALOG = {
  attractions: [
    { name: SM, park: DL, land: 'Tomorrowland', typicalPeakWait: 75, ropeDropValue: 'high', llKind: 'multi' },
    { name: 'Jungle Cruise', park: DL, land: 'Adventureland', typicalPeakWait: 35, ropeDropValue: '', llKind: 'none' },
    { name: 'Haunted Mansion', park: DL, land: 'New Orleans Square', typicalPeakWait: 45, ropeDropValue: '', llKind: 'multi' },
  ],
  venues: [
    { name: BB, park: DL, land: 'New Orleans Square', service: 'table', reservationPolicy: 'required' },
    { name: BENGAL, park: DL, land: 'Adventureland', service: 'quickservice', reservationPolicy: 'walkup' },
  ],
};

const CACHE_BLOBS = {
  [STABLE_KEY]: JSON.stringify({ data: { sections: { CATALOG } } }),
  [DYNAMIC_KEY]: JSON.stringify({ data: { sections: { CLOSURES: [], CURRENT_CLOSURES: 'All attractions operating today.', DINING_CLOSURES: [] } } }),
};

function seedBlob(storedTripData) {
  const table = {
    [REG_KEY]: JSON.stringify(Object.fromEntries(Object.entries(CODES).map(([code, tripId]) => [code, { tripId, role: 'admin', status: 'active' }]))),
    ...CACHE_BLOBS,
  };
  if (storedTripData) table['twize/trip_' + CODES.SEAMP6 + '.json'] = JSON.stringify(storedTripData);
  globalThis.__seamP6BlobTable = table;
}
function storedRaw(tripId) { return globalThis.__seamP6BlobTable['twize/trip_' + tripId + '.json']; }
function storedTrip(tripId) { return JSON.parse(storedRaw(tripId)); }

let handler;
test.before(async () => {
  globalThis.fetch = async (url) => {
    const s = String(url);
    const m = s.match(/^https:\/\/blob\.test\/([^?]+)/);
    if (m && Object.prototype.hasOwnProperty.call(globalThis.__seamP6BlobTable, m[1])) {
      return { ok: true, status: 200, text: async () => globalThis.__seamP6BlobTable[m[1]], json: async () => JSON.parse(globalThis.__seamP6BlobTable[m[1]]) };
    }
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };
  handler = (await import('../api/trip.js')).default;
});

async function postSave(code, tripData, extra) {
  let statusCode = 0; let payload = null;
  const res = {
    setHeader() {}, status(c) { statusCode = c; return this; },
    json(o) { payload = o; return this; }, end() { return this; },
  };
  await handler({ method: 'POST', headers: {}, query: {}, body: Object.assign({ code, tripData }, extra || {}) }, res);
  return { statusCode, payload };
}

// ---------------------------------------------------------------- fixtures
const CFG_DAYS_1 = [{ date: 'Dec 7, 2026', park: DL, isVip: false }];
const HELD_SM = [{ day: 0, rideKey: 'space mountain', ride: SM, returnStart: '2:00 PM', returnEnd: '3:00 PM', bookedAt: '2026-11-01T00:00:00.000Z', conflict: '' }];
const HELD_SM_NEW = [{ day: 0, rideKey: 'space mountain', ride: SM, returnStart: '4:00 PM', returnEnd: '5:00 PM', bookedAt: '2026-11-01T00:00:00.000Z', conflict: '' }];
const ITEMS_GOOD = [
  { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: '' },
  { t: '1:00 PM', h: 'Jungle Cruise', type: 'ride', n: '' },
  { t: '2:00 PM', h: SM, type: 'ride', n: '', anchor: true, heldReturn: true },
];
const ITEMS_DROPPED = ITEMS_GOOD.filter(e => e.h !== SM);
const ITEMS_MOVED = [
  { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: '' },
  { t: '1:00 PM', h: 'Jungle Cruise', type: 'ride', n: '' },
  { t: '4:00 PM', h: SM, type: 'ride', n: '', anchor: true, heldReturn: true },
];

function heldConfig(items, heldReturns) {
  return {
    location: 'Disneyland',
    days: CFG_DAYS_1,
    heldReturns,
    reservations: [],
    dining: { reservations: [] },
    ridePreferences: { mustDo: [], wantToDo: [], skip: [] },
    schedule: { days: [{ park: DL, items }] },
    onboardingComplete: true,
  };
}

// ---------------------------------------------------------------- (a)
test('(a) an unmarked write dropping a held-return record AND its card is refused; the record survives', async () => {
  seedBlob({ tripConfig: heldConfig(ITEMS_GOOD, HELD_SM) });
  const before = storedRaw(CODES.SEAMP6);
  // The part-2 hole, exactly: record and card leave in the same write,
  // and the write declares nothing. Carry-forward keeps the record in
  // the post-write set, so the day is judged against a record whose
  // card is gone -- and refused.
  const { statusCode, payload } = await postSave('SEAMP6', { tripConfig: heldConfig(ITEMS_DROPPED, []) });
  assert.equal(statusCode, 400, 'the record+card dropping write is refused: ' + JSON.stringify(payload));
  assert.equal(payload.code, 'ANCHOR_VIOLATION');
  assert.ok(String(payload.error).includes(SM), 'the refusal names the anchor');
  const conf = (payload.anchorConflicts || []).filter(v => v.kind === 'held-return-missing' && v.name === SM && v.day === 1);
  assert.equal(conf.length, 1, 'the named conflict is the dropped return on day 1');
  assert.equal(storedRaw(CODES.SEAMP6), before, 'nothing else persisted: the stored trip is byte-identical');
  assert.deepEqual(storedTrip(CODES.SEAMP6).tripConfig.heldReturns, HELD_SM, 'the record is carried forward in the stored config');
});

// ---------------------------------------------------------------- (b)
test('(b) a marked record-action write removing the held return succeeds, record actually gone', async () => {
  seedBlob({ tripConfig: heldConfig(ITEMS_GOOD, HELD_SM) });
  const { statusCode, payload } = await postSave('SEAMP6', { tripConfig: heldConfig(ITEMS_DROPPED, []) }, { anchorRecordActions: ['heldReturns'] });
  assert.equal(statusCode, 200, 'the declared removal succeeds: ' + JSON.stringify(payload));
  assert.equal(payload.ok, true);
  const stored = storedTrip(CODES.SEAMP6);
  assert.deepEqual(stored.tripConfig.heldReturns, [], 'the record removal persisted');
  assert.equal(stored.tripConfig.schedule.days[0].items.some(e => e.h === SM), false, 'the card-free day persisted with it');
});

// ---------------------------------------------------------------- (c)
test('(c) a marked change to a new window succeeds and the day is judged against the new window', async () => {
  seedBlob({ tripConfig: heldConfig(ITEMS_GOOD, HELD_SM) });
  // The card sits at 4:00 PM -- OUTSIDE the stored record's 2-3 PM
  // window. Judged against the old record this write would refuse
  // (held-return-moved); success proves the day was judged against
  // the marked write's new window, and the new record persists.
  const { statusCode, payload } = await postSave('SEAMP6', { tripConfig: heldConfig(ITEMS_MOVED, HELD_SM_NEW) }, { anchorRecordActions: ['heldReturns'] });
  assert.equal(statusCode, 200, 'the declared change succeeds: ' + JSON.stringify(payload));
  assert.equal(payload.ok, true);
  const stored = storedTrip(CODES.SEAMP6);
  assert.equal(stored.tripConfig.heldReturns[0].returnStart, '4:00 PM', 'the new window persisted');
  assert.equal(stored.tripConfig.heldReturns[0].returnEnd, '5:00 PM');
  assert.equal(stored.tripConfig.schedule.days[0].items.find(e => e.h === SM).t, '4:00 PM', 'the moved anchor card persisted at the new window');
});

// ---------------------------------------------------------------- (d)
test('(d) an unmarked save with records intact succeeds and leaves the record classes unchanged', async () => {
  seedBlob({ tripConfig: heldConfig(ITEMS_GOOD, HELD_SM) });
  const write = heldConfig(ITEMS_GOOD, HELD_SM);
  write.tripName = 'Renamed trip';
  const { statusCode, payload } = await postSave('SEAMP6', { tripConfig: write });
  assert.equal(statusCode, 200, 'the intact general save succeeds: ' + JSON.stringify(payload));
  const stored = storedTrip(CODES.SEAMP6);
  assert.equal(stored.tripConfig.tripName, 'Renamed trip', 'the save landed');
  assert.deepEqual(stored.tripConfig.heldReturns, HELD_SM, 'held returns unchanged in the stored config');
  assert.deepEqual(stored.tripConfig.reservations, [], 'flat reservations unchanged');
  assert.deepEqual(stored.tripConfig.dining.reservations, [], 'structured reservations unchanged');
  assert.equal(stored.tripConfig.schedule.days[0].items.length, ITEMS_GOOD.length, 'the day persisted intact');
});

// ---------------------------------------------------------------- (e)
test('(e) a stored null-day reservation refuses nothing and surfaces by name as needing a day', async () => {
  // A legacy record: venue + time, no day (the shipped Dining slide
  // always writes one; this is the pre-structured shape). The day
  // being written legitimately carries no Blue Bayou card -- the
  // record names no day, so no day owes it a card.
  const nullDayConfig = (items) => ({
    location: 'Disneyland',
    days: CFG_DAYS_1,
    heldReturns: [],
    reservations: [],
    dining: { reservations: [{ name: BB, time: '6:30 PM' }] },
    ridePreferences: { mustDo: [], wantToDo: [], skip: [] },
    schedule: { days: [{ park: DL, items }] },
    onboardingComplete: true,
  });
  const DAY_NO_BB = [
    { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: '' },
    { t: '1:00 PM', h: 'Jungle Cruise', type: 'ride', n: '' },
    { t: '2:00 PM', h: SM, type: 'ride', n: '' },
  ];
  seedBlob({ tripConfig: nullDayConfig(DAY_NO_BB) });
  const { statusCode, payload } = await postSave('SEAMP6', { tripConfig: nullDayConfig(DAY_NO_BB) });
  assert.equal(statusCode, 200, 'the null-day record must not refuse a normal day write: ' + JSON.stringify(payload));
  assert.equal(payload.ok, true);
  const nd = (payload.anchorRecordsNeedingDay || []).filter(x => x && x.name === BB);
  assert.equal(nd.length, 1, 'the record surfaces by name in the response surfacing channel');
  assert.ok(String(nd[0].detail).includes('no day'), 'the surface says why: it needs a day');
  const stored = storedTrip(CODES.SEAMP6);
  assert.deepEqual(stored.tripConfig.dining.reservations, [{ name: BB, time: '6:30 PM' }], 'the record itself is stored unedited (the guest repairs it through the editor)');
});

// ---------------------------------------------------------------- (f)
test('(f) an unmarked write attempting to shrink reservations has the stored reservations carried forward', async () => {
  const RESV_BB = { name: BB, time: '6:30 PM', day: 1 };
  const RESV_BENGAL = { name: BENGAL, time: '12:00 PM', day: 1 };
  const resvConfig = (items, diningResv) => ({
    location: 'Disneyland',
    days: CFG_DAYS_1,
    heldReturns: [],
    reservations: [],
    dining: { reservations: diningResv },
    ridePreferences: { mustDo: [], wantToDo: [], skip: [] },
    schedule: { days: [{ park: DL, items }] },
    onboardingComplete: true,
  });
  const ITEMS_BOTH = [
    { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: '' },
    { t: '12:00 PM', h: BENGAL, type: 'dining', n: '' },
    { t: '1:00 PM', h: 'Jungle Cruise', type: 'ride', n: '' },
    { t: '6:30 PM', h: BB, type: 'dining', n: '', isConfirmed: true },
  ];
  seedBlob({ tripConfig: resvConfig(ITEMS_BOTH, [RESV_BB, RESV_BENGAL]) });
  // The write drops the Bengal record but keeps both cards (a writer
  // that never knew the record existed). Unmarked: the stored record
  // set wins, the write lands, and storage still holds both records.
  const { statusCode, payload } = await postSave('SEAMP6', { tripConfig: resvConfig(ITEMS_BOTH, [RESV_BB]) });
  assert.equal(statusCode, 200, 'the write itself is legal once the record is carried forward: ' + JSON.stringify(payload));
  const stored = storedTrip(CODES.SEAMP6);
  assert.deepEqual(stored.tripConfig.dining.reservations, [RESV_BB, RESV_BENGAL], 'both stored reservations were carried forward over the shrink attempt');
});
