// Tests for the remainder-scope guard in api/reoptimize.js
// (Claude ruling, Oct 22, 2026; defect 1 of the build-48 device test).
//
// The defect: the client's in-trip test never fired for real stored
// trips (non-ISO day dates -> Invalid Date), so episode Rework and
// banner Optimize sent the WHOLE day to the endpoint, and at 9:21 PM
// on Oct 22, 2026 a rework re-timed five already-past items and the
// leader's Accept wrote them to the stored plan. The fix enforces the
// settled remainder rule AT THE ENDPOINT: when the reworked day is
// today at the park, a proposal that moves/drops a past item (or moves
// anything into the past window) is refused -- the input plan is
// returned unchanged with named conflicts, the held-LL-return guard's
// shape. The cutoff clock is park-local, computed server-side.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/reoptimize-scope.test.mjs
// @vercel/blob is redirected to an inline stub via module.register
// hooks (the blog suites' pattern); global fetch is stubbed for blob
// reads + the Anthropic call; the wall clock is frozen at
// 2026-10-23T01:20:00Z = 6:20 PM at Disneyland (PDT) = 9:20 PM at
// Walt Disney World (EDT) on Oct 22, 2026.
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const blobStubSrc = [
  'export async function list({ prefix } = {}) {',
  '  const table = globalThis.__scopeBlobTable || {};',
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

// ---------------------------------------------------------------- setup
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.ADMIN_KEY;

const DL_ITEMS = [
  { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: 'Arrive early.' },
  { t: '8:05 AM', h: 'Space Mountain', type: 'ride', n: '' },
  { t: '11:55 AM', h: 'Buzz Lightyear Astro Blasters', type: 'ride', n: '' },
  { t: '12:52 PM', h: 'Jungle Cruise', type: 'ride', n: '' },
  { t: '1:00 PM', h: 'Afternoon Snack & Shopping', type: 'snack', n: '' },
  { t: '5:40 PM', h: "it's a small world", type: 'ride', n: '' },
  { t: '8:02 PM', h: 'Mad Tea Party', type: 'ride', n: '' },
  { t: '10:25 PM', h: 'King Arthur Carrousel', type: 'ride', n: '' },
];
const WDW_ITEMS = [
  { t: '9:00 AM', h: 'Rope Drop at Magic Kingdom', type: 'tip', n: '' },
  { t: '7:30 PM', h: 'Seven Dwarfs Mine Train', type: 'ride', n: '' },
  { t: '9:00 PM', h: 'Magic Kingdom Fireworks', type: 'show', n: '' },
];

globalThis.__scopeBlobTable = {
  'twize/trip_registry.json': {
    TESTDL: { tripId: 'dl-trip', role: 'admin', status: 'active' },
    TESTWDW: { tripId: 'wdw-trip', role: 'admin', status: 'active' },
  },
  'twize/park_intel_dl_stable.json': {
    data: { sections: { LAND_MAP: 'lands', WAIT_PATTERNS: 'waits', CROWD_FLOW: 'crowds', WALKING_ROUTES: 'walks' } },
  },
  'twize/park_intel_dl_dynamic.json': { data: { sections: { CURRENT_CLOSURES: 'none' } } },
  'twize/trip_dl-trip.json': {
    tripConfig: {
      location: 'Disneyland',
      days: [
        { date: 'Oct 22, 2026', park: 'Disneyland' },
        { date: 'Oct 23, 2026', park: 'Disneyland' },
      ],
    },
  },
  'twize/trip_wdw-trip.json': {
    tripConfig: {
      location: 'Walt Disney World',
      days: [{ date: 'Oct 22, 2026', park: 'Magic Kingdom' }],
    },
  },
};

let proposal = null; // entries the stubbed model returns
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://blob.test/')) {
    const key = decodeURIComponent(u.slice('https://blob.test/'.length));
    const payload = globalThis.__scopeBlobTable[key];
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

// Freeze the wall clock: 2026-10-23T01:20:00Z.
const RealDate = Date;
const FIXED_MS = RealDate.UTC(2026, 9, 23, 1, 20, 0);
class FixedDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [FIXED_MS])); }
  static now() { return FIXED_MS; }
  static parse(s) { return RealDate.parse(s); }
  static UTC(...a) { return RealDate.UTC(...a); }
}
globalThis.Date = FixedDate;
console.log = () => {}; // the handler is chatty; keep TAP readable

const mod = await import('../api/reoptimize.js');
const handler = mod.default;

let ipCounter = 0;
async function callHandler(body) {
  const req = {
    method: 'POST',
    url: '/api/reoptimize',
    headers: { 'x-forwarded-for': '10.0.0.' + (++ipCounter) },
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
const clone = (items) => JSON.parse(JSON.stringify(items));
function dlBody(items, extra = {}) {
  return {
    scheduleItems: items, dayLabel: 'Thursday Oct 22', tripDayDate: 'Oct 22, 2026',
    isInTrip: false, currentTime: null, liveWaits: null, tripCode: 'TESTDL', ...extra,
  };
}

// ------------------------------------------------------- handler cases
test('DL 6:20 PM PT: proposal moving a past item is refused, plan unchanged, conflict named', async () => {
  const items = clone(DL_ITEMS);
  proposal = clone(DL_ITEMS);
  proposal.find(e => e.h === 'Buzz Lightyear Astro Blasters').t = '12:10 PM';
  const res = await callHandler(dlBody(items));
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, false);
  assert.equal(res.payload.changeCount, 0);
  assert.ok(Array.isArray(res.payload.scopeConflicts), 'scopeConflicts present');
  assert.equal(res.payload.scopeConflicts.length, 1);
  assert.equal(res.payload.scopeConflicts[0].type, 'past-item-moved');
  assert.equal(res.payload.scopeConflicts[0].name, 'Buzz Lightyear Astro Blasters');
  assert.match(res.payload.explanation, /Your plan is unchanged/);
  // returned plan is the input, byte for byte on names+times
  const out = res.payload.sections[0].entries;
  assert.deepEqual(out.map(e => [e.h, e.t]), items.map(e => [e.h, e.t]));
});

test('DL 6:20 PM PT: proposal moving only an evening item passes the guard', async () => {
  const items = clone(DL_ITEMS);
  proposal = clone(DL_ITEMS);
  proposal.find(e => e.h === 'Mad Tea Party').t = '8:20 PM';
  const res = await callHandler(dlBody(items));
  assert.equal(res.code, 200);
  assert.equal(res.payload.scopeConflicts, undefined);
  assert.equal(res.payload.changed, true);
  const out = res.payload.sections.flatMap(s => s.entries);
  assert.equal(out.find(e => e.h === 'Mad Tea Party').t, '8:20 PM');
  assert.equal(out.find(e => e.h === 'Buzz Lightyear Astro Blasters').t, '11:55 AM');
});

test('DL 6:20 PM PT: proposal dropping a past item is refused and names it', async () => {
  const items = clone(DL_ITEMS);
  proposal = clone(DL_ITEMS).filter(e => e.h !== 'Jungle Cruise');
  const res = await callHandler(dlBody(items));
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, false);
  assert.ok(res.payload.scopeConflicts.some(c => c.type === 'past-item-dropped' && c.name === 'Jungle Cruise'));
  const out = res.payload.sections[0].entries;
  assert.deepEqual(out.map(e => [e.h, e.t]), items.map(e => [e.h, e.t]));
});

test('DL future day (pre-trip): whole-day proposal is NOT scope-blocked', async () => {
  const items = clone(DL_ITEMS);
  proposal = clone(DL_ITEMS);
  proposal.find(e => e.h === 'Space Mountain').t = '9:00 AM';
  const res = await callHandler(dlBody(items, { tripDayDate: 'Oct 23, 2026', dayLabel: 'Friday Oct 23' }));
  assert.equal(res.code, 200);
  assert.equal(res.payload.scopeConflicts, undefined);
  assert.equal(res.payload.changed, true);
});

test('WDW 9:20 PM ET: a 7:30 PM item is already past under the Eastern cutoff (guard fires)', async () => {
  // 7:30 PM ET = 1170 min < ET cutoff 1250 (8:50 PM). Under a Pacific
  // cutoff (1070) the same move would be legal -- firing here proves
  // the endpoint derived America/New_York for this trip.
  const items = clone(WDW_ITEMS);
  proposal = clone(WDW_ITEMS);
  proposal.find(e => e.h === 'Seven Dwarfs Mine Train').t = '7:45 PM';
  const res = await callHandler({
    scheduleItems: items, dayLabel: 'Thursday Oct 22', tripDayDate: 'Oct 22, 2026',
    isInTrip: false, currentTime: null, liveWaits: null, tripCode: 'TESTWDW',
  });
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, false);
  assert.ok(res.payload.scopeConflicts.some(c => c.type === 'past-item-moved' && c.name === 'Seven Dwarfs Mine Train'));
});

// --------------------------------------------------------- helper units
test('park -> timezone derivation for both resorts', () => {
  assert.equal(mod._scopeParkTimezone('Disneyland'), 'America/Los_Angeles');
  assert.equal(mod._scopeParkTimezone('Disney California Adventure'), 'America/Los_Angeles');
  assert.equal(mod._scopeParkTimezone('Magic Kingdom'), 'America/New_York');
  assert.equal(mod._scopeParkTimezone('EPCOT'), 'America/New_York');
  assert.equal(mod._scopeParkTimezone('Walt Disney World'), 'America/New_York');
  assert.equal(mod._scopeParkTimezone('Universal Studios'), null);
  assert.equal(mod._scopeParkTimezone(''), null);
});

test('park-local now for the frozen instant, both zones', () => {
  assert.deepEqual(mod._scopeParkNow(FIXED_MS, 'America/Los_Angeles'), { ymd: '2026-10-22', minutes: 18 * 60 + 20 });
  assert.deepEqual(mod._scopeParkNow(FIXED_MS, 'America/New_York'), { ymd: '2026-10-22', minutes: 21 * 60 + 20 });
});

test('day parsing: stored long form, ISO, year-less label, garbage', () => {
  assert.deepEqual(mod._scopeParseDay('Oct 22, 2026'), { y: 2026, m: 10, d: 22 });
  assert.deepEqual(mod._scopeParseDay('2026-10-22'), { y: 2026, m: 10, d: 22 });
  assert.deepEqual(mod._scopeParseDay('Thu Oct 22'), { y: null, m: 10, d: 22 });
  assert.equal(mod._scopeParseDay('Invalid Date'), null);
  assert.equal(mod._scopeParseDay(''), null);
});

test('day resolution against the trip record', () => {
  const cfg = { location: 'Disneyland', days: [{ date: 'Oct 22, 2026', park: 'Disneyland' }, { date: 'Oct 23, 2026', park: 'Disneyland' }] };
  assert.deepEqual(mod._scopeResolveDay(cfg, 'Invalid Date', 'Thursday Oct 22'), { ymd: '2026-10-22', park: 'Disneyland' });
  assert.deepEqual(mod._scopeResolveDay(cfg, 'Oct 23, 2026', ''), { ymd: '2026-10-23', park: 'Disneyland' });
  assert.equal(mod._scopeResolveDay(cfg, 'Invalid Date', ''), null);
});
