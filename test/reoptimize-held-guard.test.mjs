// Tests for the held-return guard's tolerance of a held ride that is
// NOT in the day's schedule items (api/reoptimize.js; item 16 step 1,
// Claude ruling Oct 23, 2026).
//
// The new case: a leader records a Single Pass purchase for a ride the
// generator left out of the day entirely -- no llSequence entry, and no
// schedule item either. The record lands in tripConfig.heldReturns and
// the client sends it to /api/reoptimize like any other held return.
// The guard treated "ride absent from the model's output" as
// "optimize dropped the ride" and refused EVERY optimize for the rest
// of the day behind a false "would have dropped <ride>" conflict --
// the ride was never in the plan, so nothing could drop it. The fix:
// held-dropped fires only when the ride was an input item; the
// held-moved check still binds any output that places the ride outside
// its booked window, and the prompt still instructs the model to place
// the ride at its booked window.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/reoptimize-held-guard.test.mjs
// Harness mirrors test/reoptimize-scope.test.mjs: @vercel/blob is
// redirected to an inline stub via module.register hooks, global fetch
// is stubbed for blob reads + the Anthropic call, and the wall clock
// is frozen at 2026-10-23T17:00:00Z = 10:00 AM at Disneyland (PDT).
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const blobStubSrc = [
  'export async function list({ prefix } = {}) {',
  '  const table = globalThis.__heldBlobTable || {};',
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

const RISE = 'Star Wars: Rise of the Resistance';
const BASE_ITEMS = [
  { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: '' },
  { t: '11:00 AM', h: 'Space Mountain', type: 'ride', n: '' },
  { t: '1:00 PM', h: 'Jungle Cruise', type: 'ride', n: '' },
];
const HELD_RISE = [{ ride: RISE, returnStart: '10:30 AM', returnEnd: '11:30 AM', day: 1 }];

globalThis.__heldBlobTable = {
  'twize/trip_registry.json': {
    TESTDL: { tripId: 'dl-trip', role: 'admin', status: 'active' },
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
};

let proposal = null;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://blob.test/')) {
    const key = decodeURIComponent(u.slice('https://blob.test/'.length));
    const payload = globalThis.__heldBlobTable[key];
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

// Freeze the wall clock: 2026-10-23T17:00:00Z = 10:00 AM PDT.
const RealDate = Date;
const FIXED_MS = RealDate.UTC(2026, 9, 23, 17, 0, 0);
class FixedDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [FIXED_MS])); }
  static now() { return FIXED_MS; }
  static parse(s) { return RealDate.parse(s); }
  static UTC(...a) { return RealDate.UTC(...a); }
}
globalThis.Date = FixedDate;
console.log = () => {};

const mod = await import('../api/reoptimize.js');
const handler = mod.default;

let ipCounter = 0;
async function callHandler(body) {
  const req = {
    method: 'POST',
    url: '/api/reoptimize',
    headers: { 'x-forwarded-for': '10.1.0.' + (++ipCounter) },
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
function bodyFor(items) {
  return {
    scheduleItems: items, dayLabel: 'Friday Oct 23', tripDayDate: 'Oct 23, 2026',
    isInTrip: false, currentTime: null, liveWaits: null, tripCode: 'TESTDL',
    heldReturns: clone(HELD_RISE),
  };
}
function riseConflicts(res) {
  return (res.payload.heldReturnConflicts || []).filter(c => c && c.ride === RISE);
}

// ------------------------------------------------------------ the cases
test('held ride NOT an input item, proposal omits it: NOT refused as a drop', async () => {
  proposal = clone(BASE_ITEMS);
  proposal.find(e => e.h === 'Space Mountain').t = '11:15 AM';
  const res = await callHandler(bodyFor(clone(BASE_ITEMS)));
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, true, 'legal re-time goes through');
  assert.equal(riseConflicts(res).length, 0, 'no false held conflict for Rise');
});

test('held ride NOT an input item, proposal adds it OUTSIDE its window: refused (held-moved)', async () => {
  proposal = clone(BASE_ITEMS);
  proposal.push({ t: '3:00 PM', h: RISE, type: 'ride', n: '' });
  const res = await callHandler(bodyFor(clone(BASE_ITEMS)));
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, false);
  const conf = riseConflicts(res);
  assert.equal(conf.length, 1);
  assert.equal(conf[0].type, 'held-moved');
});

test('held ride NOT an input item, proposal adds it INSIDE its window: accepted as the anchor', async () => {
  proposal = clone(BASE_ITEMS);
  proposal.find(e => e.h === 'Space Mountain').t = '11:15 AM';
  proposal.push({ t: '10:45 AM', h: RISE, type: 'ride', n: '' });
  const res = await callHandler(bodyFor(clone(BASE_ITEMS)));
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, true);
  assert.equal(riseConflicts(res).length, 0);
  const out = res.payload.sections.flatMap(s => s.entries || []);
  assert.equal(out.find(e => e.h === RISE).t, '10:45 AM');
});

test('held ride IS an input item, proposal drops it: still refused (held-dropped)', async () => {
  const items = clone(BASE_ITEMS);
  items.push({ t: '10:30 AM', h: RISE, type: 'ride', n: '' });
  proposal = clone(BASE_ITEMS);
  proposal.find(e => e.h === 'Space Mountain').t = '11:15 AM';
  const res = await callHandler(bodyFor(items));
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, false);
  const conf = riseConflicts(res);
  assert.equal(conf.length, 1);
  assert.equal(conf[0].type, 'held-dropped');
});
