// Tests for the anchor verify at the POST /api/trip save seam
// (api/trip.js; anchor fix lane part 2, Nov 4, 2026 -- Claude msg 205
// section 2, call site 3).
//
// POST /api/trip is the only persistence seam, and until this part it
// performed zero anchor checks (the matrix's ABSENT column for every
// anchor class): any writer -- a manual edit dragging a reservation
// card, the pairwise swap moving a held ride, a wholesale day
// replacement -- could persist a day that drops or moves a locked
// booking, silently. The seam now runs the shared verifyAnchorDay (the
// same function the post-generation check and the reoptimize post-check
// use) on each day the write carries, against the INCOMING tripConfig's
// anchor records, and refuses the write with the anchor(s) named. It is
// a CHECK, not a rewrite: the seam still stores exactly what the client
// sent, or stores nothing -- it never edits a schedule into compliance
// (the distinction the handler's standing no-rewrite note draws).
//
// The expectation is keyed on the incoming records, so legitimate
// removals still work: a write that removes the anchor's RECORD in the
// same save (the guest used the record's Change/Remove controls) is no
// longer expected to contain the anchor -- case (b) is case (a)'s exact
// write with only the record removed, and it succeeds. Only days the
// write carries with items are judged: a partial write is judged on the
// days present (case (e)) and a schedule-less save is never refused
// here (case (f)).
//
// PART 6 AMENDMENT (Nov 4, 2026): part 2's keying left a hole -- a
// write that removed the record AND its card together passed, and any
// general save could silently delete records. The seam now carries
// stored records forward for every class the write does not declare
// in the body's anchorRecordActions marker, and judges days against
// the post-write record set. Case (b) below is therefore now sent in
// its post-part-6 shape: the same record-removal write, carrying the
// record layer's marker (anchorRecordActions: ['heldReturns']) --
// under part 6 an UNMARKED version of that write is refused, because
// the record survives by carry-forward while its card is gone. That
// new behavior is pinned in test/trip-anchor-seam-part6.test.mjs.
//
// Negative controls (run against pre-part-2 main, recorded in the
// lane's build log): cases (a), (c) and (g) FAIL there -- the dropping
// writes persist. The remaining cases pass on both trees by design:
// they pin the record-keyed expectation and the no-false-refusal
// posture, which only have meaning next to the refusals.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/trip-anchor-seam.test.mjs
// Harness mirrors test/trip-save-preserve.test.mjs: @vercel/blob and
// web-push are redirected to inline stubs via module.register hooks;
// global fetch serves blob reads from the same in-memory table the
// stub's put writes.
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const blobStubSrc = [
  'const table = () => globalThis.__seamBlobTable;',
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
const CODES = { SEAM1: 'seam-trip', BEAU01: 'beau01-seam-trip' };

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
    { name: 'Bengal Barbecue', park: DL, land: 'Adventureland', service: 'quickservice', reservationPolicy: 'walkup' },
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
  if (storedTripData) table['twize/trip_' + CODES.SEAM1 + '.json'] = JSON.stringify(storedTripData);
  globalThis.__seamBlobTable = table;
}
function storedRaw(tripId) { return globalThis.__seamBlobTable['twize/trip_' + tripId + '.json']; }
function storedTrip(tripId) { return JSON.parse(storedRaw(tripId)); }

let handler;
test.before(async () => {
  globalThis.fetch = async (url) => {
    const s = String(url);
    const m = s.match(/^https:\/\/blob\.test\/([^?]+)/);
    if (m && Object.prototype.hasOwnProperty.call(globalThis.__seamBlobTable, m[1])) {
      return { ok: true, status: 200, text: async () => globalThis.__seamBlobTable[m[1]], json: async () => JSON.parse(globalThis.__seamBlobTable[m[1]]) };
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
const ITEMS_GOOD = [
  { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: '' },
  { t: '1:00 PM', h: 'Jungle Cruise', type: 'ride', n: '' },
  { t: '2:00 PM', h: SM, type: 'ride', n: '', anchor: true, heldReturn: true },
];
const ITEMS_DROPPED = ITEMS_GOOD.filter(e => e.h !== SM);

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
function resvConfig(items) {
  return {
    location: 'Disneyland',
    days: CFG_DAYS_1,
    heldReturns: [],
    reservations: [],
    dining: { reservations: [{ name: BB, time: '6:30 PM', day: 1 }] },
    ridePreferences: { mustDo: [], wantToDo: [], skip: [] },
    schedule: { days: [{ park: DL, items }] },
    onboardingComplete: true,
  };
}
const RESV_ITEMS = [
  { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: '' },
  { t: '1:00 PM', h: 'Jungle Cruise', type: 'ride', n: '' },
  { t: '2:00 PM', h: SM, type: 'ride', n: '' },
];

// ---------------------------------------------------------------- (a)
test('(a) a day write that drops a held return whose record persists is refused, and nothing is stored', async () => {
  seedBlob({ tripConfig: heldConfig(ITEMS_GOOD, HELD_SM) });
  const before = storedRaw(CODES.SEAM1);
  const { statusCode, payload } = await postSave('SEAM1', { tripConfig: heldConfig(ITEMS_DROPPED, HELD_SM) });
  assert.equal(statusCode, 400, 'the dropping write is refused: ' + JSON.stringify(payload));
  assert.equal(payload.code, 'ANCHOR_VIOLATION');
  assert.ok(String(payload.error).includes(SM), 'the refusal names the anchor');
  const conf = (payload.anchorConflicts || []).filter(v => v.kind === 'held-return-missing' && v.name === SM && v.day === 1);
  assert.equal(conf.length, 1, 'the named conflict is the dropped return on day 1');
  assert.equal(storedRaw(CODES.SEAM1), before, 'the stored trip is byte-identical: the write did not persist');
});

// ---------------------------------------------------------------- (b)
test('(b) the record-removal write succeeds when it declares the class (part 6 marker shape)', async () => {
  seedBlob({ tripConfig: heldConfig(ITEMS_GOOD, HELD_SM) });
  const { statusCode, payload } = await postSave('SEAM1', { tripConfig: heldConfig(ITEMS_DROPPED, []) }, { anchorRecordActions: ['heldReturns'] });
  assert.equal(statusCode, 200, 'the record-removal write succeeds: ' + JSON.stringify(payload));
  assert.equal(payload.ok, true);
  const stored = storedTrip(CODES.SEAM1);
  assert.deepEqual(stored.tripConfig.heldReturns, [], 'the record removal persisted');
  assert.equal(stored.tripConfig.schedule.days[0].items.some(e => e.h === SM), false, 'the card-free day persisted with it');
});

// ---------------------------------------------------------------- (c)
test('(c) a day write that drops a reservation whose record persists is refused', async () => {
  seedBlob(null);
  const { statusCode, payload } = await postSave('SEAM1', { tripConfig: resvConfig(RESV_ITEMS) });
  assert.equal(statusCode, 400, 'the dropping write is refused: ' + JSON.stringify(payload));
  assert.equal(payload.code, 'ANCHOR_VIOLATION');
  assert.ok(String(payload.error).includes(BB), 'the refusal names the reservation');
  const conf = (payload.anchorConflicts || []).filter(v => v.kind === 'reservation-missing' && v.name === BB);
  assert.equal(conf.length, 1);
  assert.equal(storedRaw(CODES.SEAM1), undefined, 'nothing was stored');
});

// ---------------------------------------------------------------- (g)
test('(g) a day write that moves a reservation is refused', async () => {
  seedBlob(null);
  const moved = [...RESV_ITEMS, { t: '7:15 PM', h: BB, type: 'dining', n: '' }];
  const { statusCode, payload } = await postSave('SEAM1', { tripConfig: resvConfig(moved) });
  assert.equal(statusCode, 400, 'the moving write is refused: ' + JSON.stringify(payload));
  const conf = (payload.anchorConflicts || []).filter(v => v.kind === 'reservation-moved' && v.name === BB);
  assert.equal(conf.length, 1, 'the refusal names the moved reservation');
  assert.equal(storedRaw(CODES.SEAM1), undefined, 'nothing was stored');
});

// ---------------------------------------------------------------- (e)
test('(e) a partial write is judged only on the days it carries', async () => {
  seedBlob(null);
  // Records exist for BOTH days (day index 1's return has no card
  // anywhere in this write), but the write carries only day 1, which
  // honors its own anchor. Day 2 is not this write's to be judged on.
  const cfg = heldConfig(ITEMS_GOOD, [...HELD_SM, { day: 1, rideKey: 'haunted mansion', ride: 'Haunted Mansion', returnStart: '11:00 AM', returnEnd: '12:00 PM', bookedAt: '2026-11-01T00:00:00.000Z', conflict: '' }]);
  cfg.days = [...CFG_DAYS_1, { date: 'Dec 8, 2026', park: DL, isVip: false }];
  const { statusCode, payload } = await postSave('SEAM1', { tripConfig: cfg });
  assert.equal(statusCode, 200, 'the partial write succeeds: ' + JSON.stringify(payload));
  assert.equal(payload.ok, true);
});

// ---------------------------------------------------------------- (f)
test('(f) a schedule-less save is never refused here (the merge guard keeps the stored schedule)', async () => {
  seedBlob({ tripConfig: heldConfig(ITEMS_GOOD, HELD_SM) });
  const settingsOnly = heldConfig(ITEMS_GOOD, HELD_SM);
  delete settingsOnly.schedule;
  settingsOnly.tripName = 'Renamed trip';
  const { statusCode, payload } = await postSave('SEAM1', { tripConfig: settingsOnly });
  assert.equal(statusCode, 200, 'the settings save succeeds: ' + JSON.stringify(payload));
  const stored = storedTrip(CODES.SEAM1);
  assert.equal(stored.tripConfig.tripName, 'Renamed trip', 'the settings change persisted');
  assert.equal(stored.tripConfig.schedule.days[0].items.length, ITEMS_GOOD.length, 'the stored schedule was carried forward, not erased');
});

// ---------------------------------------------------------------- (d)
test('(d) a normal BEAU01-shaped write succeeds', async () => {
  seedBlob(null);
  // The real restored BEAU01 fixture: three generated days, no held
  // returns, no reservation records, no VIP days -- the shape of every
  // ordinary trip save in production today.
  const beau = JSON.parse(readFileSync('/home/hatch/workspace/tpcp-debug/beau01_restored.json', 'utf8'));
  const { statusCode, payload } = await postSave('BEAU01', beau.tripData);
  assert.equal(statusCode, 200, 'the BEAU01 save succeeds: ' + JSON.stringify(payload));
  assert.equal(payload.ok, true);
  const stored = storedTrip(CODES.BEAU01);
  assert.equal(stored.tripConfig.schedule.days.length, 3, 'all three days persisted');
});
