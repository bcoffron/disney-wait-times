// Tests for the normalizeEntry anchor-stamp passthrough (api/reoptimize.js;
// anchor fix lane part 4, Nov 4, 2026 -- closing the gap the part 3 build
// found).
//
// Part 3's manual-edit guard keys on the anchor stamps a card carries
// (app.html tpcpIsAnchorEntry: anchor / heldReturn / reservation /
// isConfirmed === true, _preBook / _recordedInsert truthy, type 'vip').
// But normalizeEntry rebuilt every entry the model returned from
// {t, h, type, n, land} plus a few type-specific fields, DROPPING all six
// stamps -- so an anchor card that passed through a reoptimize round-trip
// reached the client flag-less and the edit guard could not see it until
// the next regeneration re-seated it from its record. (The invariant
// itself held throughout: parts 1-2 key on the RECORDS, not the stamps.)
// The fix is a passthrough of exactly those six fields in normalizeEntry,
// copied as present; nothing else about normalization changes.
//
// Cases:
//   (a) unit -- an entry carrying each stamp survives normalizeEntry with
//       all six intact and exact (including _preBook's {idx, item} stash
//       object and an explicit anchor:false, which stays false).
//   (b) end-to-end -- a stored day whose anchor cards carry stamps, run
//       through the reoptimize handler with a fixture plan that keeps
//       every anchor, ships entries that still carry the stamps -- and
//       the REAL client predicate, extracted from app.html, fires on
//       each shipped anchor card.
//   (c) a stamp-less normal entry gains NO stamps -- neither from
//       normalizeEntry nor through the handler round-trip -- and
//       unrelated non-stamp fields (ll, returnStart) are still dropped,
//       pinning that normalization is otherwise unchanged.
//
// Negative controls (run against pre-part-4 main 22ee95ba, recorded in
// the lane's build log): (a) and (b) FAIL there -- normalizeEntry strips
// the stamps and the predicate does not fire on the shipped cards. (c)
// passes on both trees by design: it pins the absence of false anchors.
//
// PART 7 ADDITION (flag 6): generation now stamps the VIP tour card
// (anchor:true + vip:true), so vip joins the passthrough list -- case
// (d). Against pre-part-7 main (089fc566) the vip half of (d) fails:
// normalizeEntry drops the field the predicate now keys on.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/reoptimize-anchor-stamps.test.mjs
// Handler harness mirrors test/reoptimize-anchor-verify.test.mjs:
// @vercel/blob is redirected to an inline stub via module.register hooks,
// global fetch serves blob reads + the Anthropic call, and the wall
// clock is frozen at 2026-11-04 (weeks before the fixture trip, so the
// remainder-scope guard stays silent).
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const STAMPS = ['anchor', 'heldReturn', 'reservation', 'isConfirmed', '_preBook', '_recordedInsert'];
const clone = (x) => JSON.parse(JSON.stringify(x));

// ------------------------------------------------------------ extraction
// Pull a top-level function's exact source out of a file (brace-counted,
// so nested blocks are safe) and eval it -- the suites' established
// pattern for testing shipped code without changing export surfaces.
function extractFn(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start !== -1, 'function signature found: ' + signature);
  let depth = 0;
  let j = src.indexOf('{', start);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(start, j);
}
const reoptSrc = readFileSync(new URL('../api/reoptimize.js', import.meta.url), 'utf8');
const appSrc = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const normalizeEntry = new Function(extractFn(reoptSrc, 'function normalizeEntry(e)') + '\nreturn normalizeEntry;')();
const tpcpIsAnchorEntry = new Function(extractFn(appSrc, 'function tpcpIsAnchorEntry(entry)') + '\nreturn tpcpIsAnchorEntry;')();

// ------------------------------------------------------------ (a) + (c) unit
test('(a) normalizeEntry passes all six anchor stamps through exactly', () => {
  const preBook = { idx: 3, item: { t: '2:00 PM', h: 'Space Mountain', type: 'ride', n: 'original' } };
  const stamped = {
    t: '2:00 PM', h: 'Space Mountain', type: 'ride', n: 'note', land: 'Tomorrowland',
    anchor: true, heldReturn: true, reservation: true, isConfirmed: true,
    _preBook: preBook, _recordedInsert: true,
  };
  const out = normalizeEntry(clone(stamped));
  for (const k of STAMPS) assert.deepEqual(out[k], stamped[k], 'stamp survives: ' + k);
  // Each stamp alone, on a plain entry of another type.
  for (const k of STAMPS) {
    const one = { t: '9:00 AM', h: 'Jungle Cruise', type: 'ride', n: '', land: '' };
    one[k] = k === '_preBook' ? clone(preBook) : true;
    const o = normalizeEntry(one);
    assert.deepEqual(o[k], one[k], 'stamp survives alone: ' + k);
  }
  // Exactness, not coercion: an explicit false stays false (and the
  // client predicate, which tests === true, correctly stays silent).
  const falsy = normalizeEntry({ t: '9:00 AM', h: 'Jungle Cruise', type: 'ride', n: '', anchor: false });
  assert.equal(falsy.anchor, false);
  assert.equal(tpcpIsAnchorEntry(falsy), false);
});

test('(d) part 7 (flag 6): normalizeEntry passes the vip stamp through; a stamp-less tour card gains none', () => {
  const tour = { t: '10:00 AM', h: 'VIP Tour', type: 'vip', n: 'Your private guide handles all skip-the-line access.', land: '', anchor: true, vip: true };
  const out = normalizeEntry(clone(tour));
  assert.equal(out.anchor, true, 'the shared anchor stamp survives');
  assert.equal(out.vip, true, 'the vip class marker survives');
  assert.equal(tpcpIsAnchorEntry(out), true, 'the client predicate fires on the round-tripped tour card');
  const bare = normalizeEntry({ t: '10:00 AM', h: 'VIP Tour', type: 'vip', n: '', land: '' });
  assert.ok(!('vip' in bare) && !('anchor' in bare), 'a stamp-less tour card gains no stamp here (pin: passes on both trees)');
  assert.equal(tpcpIsAnchorEntry(bare), true, 'the predicate still sees it via the documented type fallback (pin)');
});

test('(c) a stamp-less entry gains no stamps, and non-stamp extras still drop', () => {
  const plain = { t: '1:00 PM', h: 'Jungle Cruise', type: 'ride', n: '', land: 'Adventureland', ll: 'multi', returnStart: '2:00 PM', returnEnd: '3:00 PM' };
  const out = normalizeEntry(clone(plain));
  for (const k of STAMPS) assert.ok(!(k in out), 'no stamp appears: ' + k);
  assert.ok(!('ll' in out) && !('returnStart' in out) && !('returnEnd' in out), 'normalization otherwise unchanged');
  assert.equal(tpcpIsAnchorEntry(out), false, 'the client predicate stays silent on a normal card');
});

// ------------------------------------------------------------ handler harness
const blobStubSrc = [
  'export async function list({ prefix } = {}) {',
  '  const table = globalThis.__anchorP4BlobTable || {};',
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
const HM = 'Haunted Mansion';
const HELD_SM = { day: 1, rideKey: 'space mountain', ride: SM, returnStart: '2:00 PM', returnEnd: '3:00 PM', bookedAt: '2026-11-01T00:00:00.000Z', conflict: '' };

const CATALOG = {
  attractions: [
    { name: SM, park: DL, land: 'Tomorrowland', typicalPeakWait: 75, ropeDropValue: 'high', llKind: 'multi' },
    { name: 'Jungle Cruise', park: DL, land: 'Adventureland', typicalPeakWait: 35, ropeDropValue: '', llKind: 'none' },
    { name: HM, park: DL, land: 'New Orleans Square', typicalPeakWait: 45, ropeDropValue: '', llKind: 'multi' },
  ],
  venues: [
    { name: BB, park: DL, land: 'New Orleans Square', service: 'table', reservationPolicy: 'required' },
  ],
};

// Same stored-trip shape as the part 2 suite: day 2 (index 1) carries a
// confirmed Blue Bayou reservation, a held Space Mountain return, and a
// VIP window, so the record-keyed checks run and pass on this legal plan.
globalThis.__anchorP4BlobTable = {
  'twize/trip_registry.json': {
    ANCHORP4: { tripId: 'anchor-p4-trip', role: 'admin', status: 'active' },
  },
  'twize/park_intel_dl_stable.json': {
    data: { sections: { LAND_MAP: 'lands', WAIT_PATTERNS: 'waits', CROWD_FLOW: 'crowds', WALKING_ROUTES: 'walks', CATALOG } },
  },
  'twize/park_intel_dl_dynamic.json': { data: { sections: { CURRENT_CLOSURES: 'All attractions operating today.' } } },
  'twize/trip_anchor-p4-trip.json': {
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

// The stored day, with every anchor face stamped the way the pipeline
// stamps it: generation stamps on Space Mountain (+ the client's
// _preBook stash from its one-tap booking) and Blue Bayou, the client's
// _recordedInsert on Haunted Mansion, the VIP card flag-less by design.
const ITEMS = [
  { t: '7:00 AM', h: 'Arrival & Security', type: 'tip', n: '' },
  { t: '10:00 AM', h: 'VIP Tour', type: 'vip', n: '' },
  { t: '1:00 PM', h: 'Jungle Cruise', type: 'ride', n: '' },
  { t: '2:00 PM', h: SM, type: 'ride', n: '', anchor: true, heldReturn: true, _preBook: { idx: 3, item: { t: '2:00 PM', h: SM, type: 'ride', n: '' } } },
  { t: '4:00 PM', h: HM, type: 'ride', n: '', _recordedInsert: true },
  { t: '6:30 PM', h: BB, type: 'dining', n: '', anchor: true, reservation: true, isConfirmed: true },
];

let proposal = null;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://blob.test/')) {
    const key = decodeURIComponent(u.slice('https://blob.test/'.length));
    const payload = globalThis.__anchorP4BlobTable[key];
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
    headers: { 'x-forwarded-for': '10.4.0.' + (++ipCounter) },
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
function outEntries(res) {
  return (res.payload.sections || []).flatMap(s => s.entries || []);
}

// ------------------------------------------------------------ (b) round-trip
test('(b) anchor stamps survive the reoptimize round-trip and the client guard sees them', async () => {
  // The model's plan keeps every anchor exactly where its record puts it
  // and moves only the normal Jungle Cruise card -- a legal plan that
  // ships through the success path (the normalized sections).
  proposal = clone(ITEMS);
  proposal.find(e => e.h === 'Jungle Cruise').t = '12:30 PM';
  const res = await callHandler({
    scheduleItems: clone(ITEMS), dayLabel: 'Tuesday Dec 8', tripDayDate: 'Dec 8, 2026',
    isInTrip: false, currentTime: null, liveWaits: null, tripCode: 'ANCHORP4',
    heldReturns: clone([HELD_SM]),
  });
  assert.equal(res.code, 200);
  assert.equal(res.payload.changed, true, 'the legal plan ships');
  assert.equal((res.payload.anchorConflicts || []).length, 0, 'no anchor conflicts on the legal plan');
  const out = outEntries(res);

  const sm = out.find(e => e.h === SM);
  assert.equal(sm.anchor, true, 'held card keeps anchor');
  assert.equal(sm.heldReturn, true, 'held card keeps heldReturn');
  assert.deepEqual(sm._preBook, ITEMS.find(e => e.h === SM)._preBook, 'held card keeps its _preBook stash exactly');

  const bb = out.find(e => e.h === BB);
  assert.equal(bb.anchor, true, 'reservation card keeps anchor');
  assert.equal(bb.reservation, true, 'reservation card keeps reservation');
  assert.equal(bb.isConfirmed, true, 'reservation card keeps isConfirmed');

  const hm = out.find(e => e.h === HM);
  assert.equal(hm._recordedInsert, true, 'recorded-insert card keeps _recordedInsert');

  // The point of the fix: the client's real guard predicate fires on the
  // shipped anchor cards (and stays silent on the normal one).
  for (const e of [sm, bb, hm, out.find(e => e.type === 'vip')]) {
    assert.equal(tpcpIsAnchorEntry(e), true, 'client guard fires on shipped card: ' + (e.h || e.type));
  }
  const jc = out.find(e => e.h === 'Jungle Cruise');
  for (const k of STAMPS) assert.ok(!(k in jc), 'normal card gains no stamp through the round-trip: ' + k);
  assert.equal(tpcpIsAnchorEntry(jc), false, 'client guard stays silent on the normal card');
});
