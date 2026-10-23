// Tests for the 7:00 AM park-local gate on the LL morning alerts
// (Beau's ruling, Oct 23, 2026; api/cron-push-monitor.js ll-order leg).
//
// The defect: the monitor's ll-order game-plan push fired on the first
// quiet sweep of the morning -- Oct 22, 2026 it fired at 6:00 AM PT
// (wait-state firedMin 360), an hour before the 7:00 AM booking window
// opens, when the party cannot act on the order yet. The fix floors
// the decision window at 7:00 AM in the TRIP'S park timezone (static
// park->tz map, the same rows as the reoptimize scope guard, PR #118)
// and runs the decision on park-local minutes derived from that map.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/ll-order-gate.test.mjs
// @vercel/blob and web-push are redirected to inline stubs via
// module.register hooks (the reoptimize-scope suite's pattern); the
// monitor module is otherwise the real shipped file.
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const blobStubSrc = [
  'export async function list() { return { blobs: [] }; }',
  'export async function put() { throw new Error("put not stubbed"); }',
  'export async function del() {}',
  'export async function get() { return null; }',
].join('\n');
const webpushStubSrc = [
  'export default {',
  '  setVapidDetails() {},',
  '  async sendNotification() { return {}; }',
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

const { parkTimezoneFor, zonedParts, llOrderDecision } =
  await import('../api/cron-push-monitor.js');

const LA = 'America/Los_Angeles';
const NY = 'America/New_York';

// ---------------------------------------------------------------- tz map
test('parkTimezoneFor resolves the static PR #118 map', () => {
  assert.equal(parkTimezoneFor('Disneyland'), LA);
  assert.equal(parkTimezoneFor('Disneyland Park'), LA);
  assert.equal(parkTimezoneFor('Disney California Adventure'), LA);
  assert.equal(parkTimezoneFor('Magic Kingdom'), NY);
  assert.equal(parkTimezoneFor('EPCOT'), NY);
  assert.equal(parkTimezoneFor("Disney's Hollywood Studios"), NY);
  assert.equal(parkTimezoneFor('Walt Disney World'), NY);
  assert.equal(parkTimezoneFor('Universal Studios Florida'), null);
  assert.equal(parkTimezoneFor(''), null);
  assert.equal(parkTimezoneFor(null), null);
  assert.equal(parkTimezoneFor(undefined), null);
});

// ------------------------------------------------------- zoned derivation
// Each pair straddles 7:00 AM park-local: one minute before must read
// 419 minutes, the next instant 420 -- on a regular date AND on both
// DST-boundary dates, in both park zones.
const BOUNDARIES = [
  // [label, tz, instant just before 7:00, instant at 7:00]
  ['PT regular (PDT)', LA, '2026-10-22T13:59:00Z', '2026-10-22T14:00:00Z'],
  ['PT standard (PST)', LA, '2026-01-15T14:59:00Z', '2026-01-15T15:00:00Z'],
  ['PT spring-forward day', LA, '2026-03-08T13:59:00Z', '2026-03-08T14:00:00Z'],
  ['PT fall-back day', LA, '2026-11-01T14:59:00Z', '2026-11-01T15:00:00Z'],
  ['ET regular (EDT)', NY, '2026-10-22T10:59:00Z', '2026-10-22T11:00:00Z'],
  ['ET standard (EST)', NY, '2026-01-15T11:59:00Z', '2026-01-15T12:00:00Z'],
  ['ET spring-forward day', NY, '2026-03-08T10:59:00Z', '2026-03-08T11:00:00Z'],
  ['ET fall-back day', NY, '2026-11-01T11:59:00Z', '2026-11-01T12:00:00Z'],
];
for (const [label, tz, beforeIso, atIso] of BOUNDARIES) {
  test('zonedParts: ' + label + ' straddles 7:00 park-local', () => {
    const before = zonedParts(new Date(beforeIso), tz);
    const at = zonedParts(new Date(atIso), tz);
    assert.equal(before.minutes, 419, label + ' before: ' + JSON.stringify(before));
    assert.equal(at.minutes, 420, label + ' at: ' + JSON.stringify(at));
    assert.equal(before.ymd, at.ymd, label + ': same park-local day');
  });
}

// ------------------------------------------------------------ the decision
const armedDay = {
  generatedWith: { hasLLMP: true },
  llSequence: { bookFirst: 'Space Mountain', order: ['Space Mountain', 'Indiana Jones Adventure'], singleSeparate: [] },
};

test('gate: 6:00 AM fire from Oct 22 is gone -- window floored at 7:00', () => {
  // First planned item 7:00 AM: the pre-gate window opened at 6:00
  // (firstItem - 60) and yesterday's push fired at firedMin 360.
  assert.deepEqual(llOrderDecision(armedDay, 360, 420, null), { act: 'wait', why: 'window-not-open' });
  assert.deepEqual(llOrderDecision(armedDay, 419, 420, null), { act: 'wait', why: 'window-not-open' });
  assert.deepEqual(llOrderDecision(armedDay, 420, 420, null), { act: 'fire' });
});

test('gate: first item 7:30 AM still fires at 7:00, not 6:30', () => {
  assert.equal(llOrderDecision(armedDay, 419, 450, null).act, 'wait');
  assert.equal(llOrderDecision(armedDay, 420, 450, null).act, 'fire');
});

test('gate: later windows unchanged (first item 9:00 -> 8:00 open)', () => {
  assert.equal(llOrderDecision(armedDay, 479, 540, null).act, 'wait');
  assert.equal(llOrderDecision(armedDay, 480, 540, null).act, 'fire');
});

test('gate: no parseable item keeps the 8:00 fallback', () => {
  assert.equal(llOrderDecision(armedDay, 479, -1, null).act, 'wait');
  assert.equal(llOrderDecision(armedDay, 480, -1, null).act, 'fire');
});

test('gate: noon cutoff still suppresses a first opportunity past it', () => {
  assert.deepEqual(llOrderDecision(armedDay, 721, 420, null), { act: 'suppress', why: 'booking-window-closed' });
});

test('dedupe: a settled day never fires twice (repeat invocations)', () => {
  const sent = { ymd: '2026-10-22', status: 'sent', firedMin: 420 };
  assert.deepEqual(llOrderDecision(armedDay, 420, 420, sent), { act: 'skip', why: 'settled' });
  assert.deepEqual(llOrderDecision(armedDay, 600, 420, sent), { act: 'skip', why: 'settled' });
  const suppressed = { ymd: '2026-10-22', status: 'suppressed', firedMin: 721 };
  assert.deepEqual(llOrderDecision(armedDay, 730, 420, suppressed), { act: 'skip', why: 'settled' });
});

test('arming untouched: LL-off / unstamped days get nothing at any hour', () => {
  assert.deepEqual(llOrderDecision({}, 600, 420, null), { act: 'skip', why: 'not-armed' });
  assert.deepEqual(llOrderDecision({ generatedWith: { hasLLMP: false }, llSequence: armedDay.llSequence }, 600, 420, null),
    { act: 'skip', why: 'not-armed' });
  assert.deepEqual(llOrderDecision({ llSequence: armedDay.llSequence }, 600, 420, null),
    { act: 'skip', why: 'not-armed' });
});

// ------------------------------------------- end-to-end: instant -> fire
test('end-to-end derivation: Disneyland trip fires at 7:00 PT, not 6:59', () => {
  const tz = parkTimezoneFor('Disneyland');
  const before = zonedParts(new Date('2026-10-22T13:59:00Z'), tz).minutes;
  const at = zonedParts(new Date('2026-10-22T14:00:00Z'), tz).minutes;
  assert.equal(llOrderDecision(armedDay, before, 420, null).act, 'wait');
  assert.equal(llOrderDecision(armedDay, at, 420, null).act, 'fire');
});

test('end-to-end derivation: Magic Kingdom trip fires at 7:00 ET, not 6:59', () => {
  const tz = parkTimezoneFor('Magic Kingdom');
  const before = zonedParts(new Date('2026-10-22T10:59:00Z'), tz).minutes;
  const at = zonedParts(new Date('2026-10-22T11:00:00Z'), tz).minutes;
  assert.equal(llOrderDecision(armedDay, before, 420, null).act, 'wait');
  assert.equal(llOrderDecision(armedDay, at, 420, null).act, 'fire');
});
