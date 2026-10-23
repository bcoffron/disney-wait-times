// Tests for the monitor's LL intent-vs-stamp divergence log (Claude
// ruling, Oct 23, 2026; api/cron-push-monitor.js ll-order leg).
//
// The failure it names: config intent says Multi Pass is ON for a day
// but the stored day lost its generation stamp + booking order (a
// partial-shape save stripped them -- item 12), so the ll-order
// decision skipped as not-armed while the app's intent fallback
// showed the user an armed day, and nothing anywhere recorded the
// disagreement. The monitor now writes a NAMED record
// (kind 'll-intent-on-unstamped', trip + day ymd) onto the trip's
// wait-state when it meets that shape -- and records NOTHING for
// plain intent-off days, where not-armed is the truth.
//
// The helpers are pure and exported; this suite drives them directly
// (@vercel/blob + web-push stubbed via module.register hooks, the
// ll-order-gate suite's pattern).
// Run with Node's built-in runner (no new dependencies):
//   node --test test/ll-divergence.test.mjs
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

const { llOrderArmed, llIntentDivergence, recordLlDivergence } =
  await import('../api/cron-push-monitor.js');

const CTX = { tripId: 'test02-trip', codes: ['TEST02'], ymd: '2026-10-23', dayIdx: 1, atMin: 380 };
const UNSTAMPED = { park: 'Disneyland', items: [{ h: 'Space Mountain', t: '9:00 AM' }] };
const STAMPED = {
  park: 'Disneyland', items: [{ h: 'Space Mountain', t: '9:00 AM' }],
  generatedWith: { hasLLMP: true, hasILL: false },
  llSequence: { bookFirst: 'Space Mountain', order: ['Space Mountain'], singleSeparate: [] },
};

test('(d) intent-on + unstamped day produces the NAMED divergence record, appended once', () => {
  const rec = llIntentDivergence(UNSTAMPED, { hasLLMP: true }, CTX);
  assert.ok(rec, 'a record is produced');
  assert.equal(rec.kind, 'll-intent-on-unstamped');
  assert.equal(rec.tripId, 'test02-trip');
  assert.deepEqual(rec.codes, ['TEST02']);
  assert.equal(rec.ymd, '2026-10-23');
  assert.equal(rec.dayIdx, 1);
  assert.match(rec.detail, /generatedWith ABSENT/);
  assert.match(rec.detail, /llSequence ABSENT/);

  const state = {};
  assert.equal(recordLlDivergence(state, rec), true, 'first record appends');
  assert.equal(state.llDivergences.length, 1);
  assert.equal(recordLlDivergence(state, llIntentDivergence(UNSTAMPED, { hasLLMP: true }, CTX)), false, 'same day + kind dedupes across sweeps');
  assert.equal(state.llDivergences.length, 1);
});

test('(d) intent-off days are silent: no record, nothing appended', () => {
  assert.equal(llIntentDivergence(UNSTAMPED, { hasLLMP: false }, CTX), null);
  assert.equal(llIntentDivergence(UNSTAMPED, {}, CTX), null);
  assert.equal(llIntentDivergence(UNSTAMPED, null, CTX), null);
  const state = {};
  assert.equal(recordLlDivergence(state, llIntentDivergence(UNSTAMPED, { hasLLMP: false }, CTX)), false);
  assert.equal(state.llDivergences, undefined, 'state untouched for intent-off days');
});

test('armed days record nothing; an LL-off stamp under LL-on intent still diverges, named as such', () => {
  assert.equal(llOrderArmed(STAMPED), true);
  assert.equal(llIntentDivergence(STAMPED, { hasLLMP: true }, CTX), null, 'armed day: no divergence');

  const offStamped = { park: 'Disneyland', items: [], generatedWith: { hasLLMP: false, hasILL: false } };
  const rec = llIntentDivergence(offStamped, { hasLLMP: true }, CTX);
  assert.ok(rec, 'stamp says off while intent says on: still a divergence');
  assert.match(rec.detail, /stamp says LL off/);
});
