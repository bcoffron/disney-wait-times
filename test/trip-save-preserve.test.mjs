// Tests for day-field preservation in the POST /api/trip save handler
// (Claude ruling, Oct 23, 2026; item 12 diagnosis, item 13/14 fix).
//
// The defect: the client's general schedule save (pushSchedule) rebuilds
// every day as {park, items} only. Any leader save -- an edit, a drag,
// an episode-Rework Accept -- therefore erased the day-level generation
// state on EVERY day of the trip: generatedWith (the stamp the push
// monitor arms the LL game-plan push on), llSequence (the booking
// order) and finalPark. On Oct 22, 2026 a Rework Accept at 02:22 UTC
// stripped both days of TEST02; the next morning's ll-order leg read an
// unstamped day and skipped silently, while the app (which falls back
// to config intent) showed Multi Pass on. The fix puts the invariant at
// the persistence seam: the endpoint merges day-level fields the
// incoming day omits from the stored day. Incoming values always win;
// llSequence is NOT merged when the incoming day carries a fresh
// generatedWith stamp (a regeneration's absent order is deliberate).
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/trip-save-preserve.test.mjs
// @vercel/blob is redirected to an inline stub via module.register
// hooks (the blog suites' pattern); global fetch serves blob reads
// from the same in-memory table.
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const blobStubSrc = [
  'const table = () => globalThis.__preserveBlobTable;',
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

const TRIP_ID = 'preserve-trip';
const CODE = 'PRESERVE1';
const REG_KEY = 'twize/trip_registry.json';
const TRIP_KEY = 'twize/trip_' + TRIP_ID + '.json';

const ITEMS_A = [
  { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: '' },
  { t: '8:05 AM', h: 'Space Mountain', type: 'ride', n: '' },
];
const ITEMS_B = [
  { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: '' },
  { t: '8:10 AM', h: 'Matterhorn Bobsleds', type: 'ride', n: '' },
];
const SEQ = { bookFirst: 'Space Mountain', order: ['Space Mountain', 'Matterhorn Bobsleds'], singleSeparate: [] };
const STAMP = { hasLLMP: true, hasILL: false, illRides: [] };

function seedBlob(tripData) {
  globalThis.__preserveBlobTable = {
    [REG_KEY]: JSON.stringify({ [CODE]: { tripId: TRIP_ID, role: 'admin', status: 'active' } }),
    [TRIP_KEY]: JSON.stringify(tripData),
  };
}
function storedTrip() {
  return JSON.parse(globalThis.__preserveBlobTable[TRIP_KEY]);
}
function storedDay(i) { return storedTrip().tripConfig.schedule.days[i]; }

// The monitor's arming predicate, verbatim from
// api/cron-push-monitor.js (llOrderArmed): the strict stamp-only rule
// this fix exists to protect.
function llOrderArmed(day) {
  if (!day || !day.generatedWith || day.generatedWith.hasLLMP !== true) return false;
  const seq = day.llSequence;
  return !!(seq && Array.isArray(seq.order) && seq.order.length > 0);
}

let handler;
test.before(async () => {
  // fetch serves blob reads from the stub table; anything else 404s.
  globalThis.fetch = async (url) => {
    const s = String(url);
    const m = s.match(/^https:\/\/blob\.test\/([^?]+)/);
    if (m && Object.prototype.hasOwnProperty.call(globalThis.__preserveBlobTable, m[1])) {
      return { ok: true, status: 200, text: async () => globalThis.__preserveBlobTable[m[1]], json: async () => JSON.parse(globalThis.__preserveBlobTable[m[1]]) };
    }
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };
  handler = (await import('../api/trip.js')).default;
});

async function postSave(tripConfig) {
  let statusCode = 0; let payload = null;
  const res = {
    setHeader() {}, status(c) { statusCode = c; return this; },
    json(o) { payload = o; return this; }, end() { return this; },
  };
  await handler({ method: 'POST', headers: {}, query: {}, body: { code: CODE, tripData: { tripConfig } } }, res);
  assert.equal(statusCode, 200, 'save should succeed: ' + JSON.stringify(payload));
  return payload;
}

function baseConfig(days, scheduleDays) {
  return { days, schedule: { days: scheduleDays }, onboardingComplete: true };
}
const CFG_DAYS = [
  { num: 1, date: 'Oct 22, 2026', park: 'Disneyland', hasLL: true, hasLLMP: true, hasILL: false },
  { num: 2, date: 'Oct 23, 2026', park: 'Disneyland', hasLL: true, hasLLMP: true, hasILL: false },
];

// ---------------------------------------------------------------- (a)
test('(a) {park, items}-only save on a stamped day preserves llSequence + generatedWith + finalPark', async () => {
  seedBlob({
    tripConfig: baseConfig(CFG_DAYS, [
      { park: 'Disneyland', items: ITEMS_A, llSequence: SEQ, generatedWith: STAMP, finalPark: 'Disney California Adventure' },
      { park: 'Disneyland', items: ITEMS_B },
    ]),
  });
  // The pushSchedule shape: every day rebuilt as {park, items} only.
  await postSave(baseConfig(CFG_DAYS, [
    { park: 'Disneyland', items: ITEMS_A },
    { park: 'Disneyland', items: ITEMS_B },
  ]));
  const d1 = storedDay(0);
  assert.deepEqual(d1.llSequence, SEQ, 'llSequence carried forward');
  assert.deepEqual(d1.generatedWith, STAMP, 'generatedWith carried forward');
  assert.equal(d1.finalPark, 'Disney California Adventure', 'finalPark carried forward');
  assert.deepEqual(d1.items, ITEMS_A, 'incoming items saved');
  const d2 = storedDay(1);
  assert.equal(d2.llSequence, undefined, 'unstamped day stays unstamped');
  assert.equal(d2.generatedWith, undefined);
});

// ---------------------------------------------------------------- (b)
test('(b) regenerated day with new stamps overwrites; fresh stamp without an order removes the stored order', async () => {
  seedBlob({
    tripConfig: baseConfig(CFG_DAYS, [
      { park: 'Disneyland', items: ITEMS_A, llSequence: SEQ, generatedWith: STAMP },
      { park: 'Disneyland', items: ITEMS_B, llSequence: SEQ, generatedWith: STAMP },
    ]),
  });
  const NEW_SEQ = { bookFirst: 'Matterhorn Bobsleds', order: ['Matterhorn Bobsleds'], singleSeparate: ['Space Mountain'] };
  const NEW_STAMP = { hasLLMP: true, hasILL: true, illRides: ['Space Mountain'] };
  const OFF_STAMP = { hasLLMP: false, hasILL: false, illRides: [] };
  await postSave(baseConfig(CFG_DAYS, [
    // Day 1 regenerated WITH a new order + stamp: both win.
    { park: 'Disneyland', items: ITEMS_A, llSequence: NEW_SEQ, generatedWith: NEW_STAMP },
    // Day 2 regenerated LL-off: fresh stamp, order deliberately absent.
    { park: 'Disneyland', items: ITEMS_B, generatedWith: OFF_STAMP },
  ]));
  const d1 = storedDay(0);
  assert.deepEqual(d1.llSequence, NEW_SEQ, 'new order overwrites');
  assert.deepEqual(d1.generatedWith, NEW_STAMP, 'new stamp overwrites');
  const d2 = storedDay(1);
  assert.deepEqual(d2.generatedWith, OFF_STAMP, 'off stamp saved');
  assert.equal(d2.llSequence, undefined, 'stored order NOT resurrected under a fresh stamp');
  assert.equal(llOrderArmed(d2), false, 'LL-off regenerated day is not armed');
});

// ---------------------------------------------------------------- (c)
test('(c) flip (stamping save) -> unrelated leader save -> arming predicate still sees the stamp', async () => {
  // Stored trip generated pre-stamp (no day-level fields at all).
  seedBlob({ tripConfig: baseConfig(CFG_DAYS, [{ park: 'Disneyland', items: ITEMS_A }, { park: 'Disneyland', items: ITEMS_B }]) });
  assert.equal(llOrderArmed(storedDay(1)), false, 'pre-stamp day not armed');
  // The flip: a regeneration save posts the full stamped day object.
  await postSave(baseConfig(CFG_DAYS, [
    { park: 'Disneyland', items: ITEMS_A },
    { park: 'Disneyland', items: ITEMS_B, llSequence: SEQ, generatedWith: STAMP },
  ]));
  assert.equal(llOrderArmed(storedDay(1)), true, 'flip armed day 2');
  // An unrelated leader save (the pushSchedule {park, items} shape --
  // the Oct 22 Rework Accept) must not disarm it.
  await postSave(baseConfig(CFG_DAYS, [
    { park: 'Disneyland', items: ITEMS_A },
    { park: 'Disneyland', items: ITEMS_B },
  ]));
  assert.equal(llOrderArmed(storedDay(1)), true, 'day 2 still armed after unrelated save');
  assert.deepEqual(storedDay(1).llSequence, SEQ);
  assert.deepEqual(storedDay(1).generatedWith, STAMP);
});
