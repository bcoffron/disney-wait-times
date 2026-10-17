// Tests for api/blog-reconcile.js auth + run-started marker.
//
// The bug under test: the endpoint originally required BOTH the
// x-vercel-cron header AND the CRON_SECRET bearer. The header stopped
// authenticating on Oct 6, 2026, so every legitimate cron invocation
// from Oct 15-17, 2026 was rejected 401 and no status record was ever
// written. The project's working crons (cron-push-monitor,
// cron-booking-alerts) authenticate on the bearer alone; the fix aligns
// this endpoint with them, keeping fail-closed semantics (no
// CRON_SECRET configured => nothing is authorized).
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/blog-reconcile-auth.test.mjs
// The handler's external imports (@vercel/blob and the two lib helpers)
// are redirected to inline stubs via module.register hooks, so the
// handler's real auth logic and status writes run end to end with no
// network and no blob store.
import { register } from 'node:module';

const blobStubSrc = [
  'export async function put(pathname, body) {',
  '  if (globalThis.__reconcileThrowNextPut) {',
  '    globalThis.__reconcileThrowNextPut = false;',
  "    throw new Error('stub put failure');",
  '  }',
  '  const st = globalThis.__reconcilePuts || (globalThis.__reconcilePuts = []);',
  '  st.push({ pathname: pathname, body: String(body) });',
  "  return { url: 'https://blob.test/' + pathname, pathname: pathname };",
  '}',
  'export async function list() { return { blobs: [] }; }',
  'export async function del() {}',
].join('\n');

const libBlobStubSrc =
  'export async function readBlobJson() { return globalThis.__reconcileStoredIndex; }';

const candidateStubSrc =
  'export async function buildCandidate() { return globalThis.__reconcileCandidate; }';

const hooksSrc = [
  'let stubs = {};',
  'export async function initialize(data) { stubs = data; }',
  'export async function resolve(specifier, context, nextResolve) {',
  "  const parent = context.parentURL ? String(context.parentURL) : '';",
  "  if (specifier === '@vercel/blob') {",
  '    return { url: stubs.blob, shortCircuit: true };',
  '  }',
  "  if (specifier === './lib/blob.js' && parent.endsWith('/api/blog-reconcile.js')) {",
  '    return { url: stubs.libBlob, shortCircuit: true };',
  '  }',
  "  if (specifier === './lib/reindex-candidate.js' && parent.endsWith('/api/blog-reconcile.js')) {",
  '    return { url: stubs.candidate, shortCircuit: true };',
  '  }',
  '  return nextResolve(specifier, context);',
  '}',
].join('\n');

register('data:text/javascript,' + encodeURIComponent(hooksSrc), {
  data: {
    blob: 'data:text/javascript,' + encodeURIComponent(blobStubSrc),
    libBlob: 'data:text/javascript,' + encodeURIComponent(libBlobStubSrc),
    candidate: 'data:text/javascript,' + encodeURIComponent(candidateStubSrc),
  },
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { default: handler, cronAuthorized } = await import('../api/blog-reconcile.js');

const SECRET = 'test-cron-secret';

function reqWith(headers) {
  return { headers };
}
function mockRes() {
  return {
    code: null, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function silenceConsole() {
  const orig = console.error;
  console.error = () => {};
  return () => { console.error = orig; };
}

// ---------- cronAuthorized unit cases ----------

test('correct bearer passes with NO x-vercel-cron header (the regression case)', () => {
  process.env.CRON_SECRET = SECRET;
  assert.equal(cronAuthorized(reqWith({ authorization: 'Bearer ' + SECRET })), true);
});

test('correct bearer passes WITH the x-vercel-cron header (header is irrelevant)', () => {
  process.env.CRON_SECRET = SECRET;
  assert.equal(cronAuthorized(reqWith({ authorization: 'Bearer ' + SECRET, 'x-vercel-cron': '1' })), true);
});

test('wrong bearer fails', () => {
  process.env.CRON_SECRET = SECRET;
  assert.equal(cronAuthorized(reqWith({ authorization: 'Bearer forged' })), false);
});

test('missing bearer fails (even with the x-vercel-cron header present)', () => {
  process.env.CRON_SECRET = SECRET;
  assert.equal(cronAuthorized(reqWith({ 'x-vercel-cron': '1' })), false);
});

test('CRON_SECRET unset fails closed', () => {
  delete process.env.CRON_SECRET;
  assert.equal(cronAuthorized(reqWith({ authorization: 'Bearer ' + SECRET })), false);
  assert.equal(cronAuthorized(reqWith({})), false);
});

// ---------- handler end-to-end ----------

function seedHealthyIndex() {
  const index = [{ slug: 'hello-world', published: true }];
  globalThis.__reconcileStoredIndex = index;
  globalThis.__reconcileCandidate = { index, errors: [] };
  globalThis.__reconcilePuts = [];
  globalThis.__reconcileThrowNextPut = false;
}

test('authorized run writes the run-started marker, then the ok verdict overwrites it', async () => {
  process.env.CRON_SECRET = SECRET;
  seedHealthyIndex();
  const res = mockRes();
  await handler(reqWith({ authorization: 'Bearer ' + SECRET }), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.verdict, 'ok');
  const puts = globalThis.__reconcilePuts;
  assert.equal(puts.length, 2, 'exactly the marker write and the verdict write');
  assert.equal(puts[0].pathname, 'blog/reconcile/status');
  const marker = JSON.parse(puts[0].body);
  assert.equal(marker.verdict, 'started');
  assert.equal(marker.candidateCount, null);
  assert.equal(marker.storedCount, null);
  assert.deepEqual(marker.missing, []);
  assert.deepEqual(marker.extra, []);
  assert.deepEqual(marker.publishedDrift, []);
  assert.deepEqual(marker.lagArtifacts, []);
  assert.equal(marker.note, 'Run started; verdict pending.');
  const verdict = JSON.parse(puts[1].body);
  assert.equal(verdict.verdict, 'ok');
  assert.equal(verdict.ranAt, marker.ranAt, 'marker and verdict share the run timestamp');
});

test('a failed marker write does not abort the check', async () => {
  process.env.CRON_SECRET = SECRET;
  seedHealthyIndex();
  globalThis.__reconcileThrowNextPut = true;
  const restore = silenceConsole();
  const res = mockRes();
  try {
    await handler(reqWith({ authorization: 'Bearer ' + SECRET }), res);
  } finally {
    restore();
  }
  assert.equal(res.code, 200);
  assert.equal(res.body.verdict, 'ok');
  const puts = globalThis.__reconcilePuts;
  assert.equal(puts.length, 1, 'only the verdict write landed');
  assert.equal(JSON.parse(puts[0].body).verdict, 'ok');
});

test('unauthorized invocation is 401 and writes NO status (rejection cannot fake health)', async () => {
  process.env.CRON_SECRET = SECRET;
  seedHealthyIndex();
  const restore = silenceConsole();
  const res = mockRes();
  try {
    await handler(reqWith({ authorization: 'Bearer forged' }), res);
  } finally {
    restore();
  }
  assert.equal(res.code, 401);
  assert.equal(globalThis.__reconcilePuts.length, 0);
});
