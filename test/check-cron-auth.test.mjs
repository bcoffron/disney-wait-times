// Tests for scripts/check-cron-auth.mjs -- the cron auth class check.
//
// The check enumerates cron endpoints from vercel.json and asserts each
// handler authenticates its cron path on the CRON_SECRET bearer alone
// (the x-vercel-cron header requirement retired Oct 6, 2026 silently
// 401'd blog-reconcile for three days -- PR #76). These tests run the
// real script against fixture repo roots and assert exit codes:
//
//   node --test test/check-cron-auth.test.mjs
//
// No network, no dependencies: fixtures are temp directories with a
// vercel.json and handler files in the shapes that matter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-cron-auth.mjs');

const BEARER = [
  'export default async function handler(req, res) {',
  '  const secret = process.env.CRON_SECRET;',
  "  const isAuthed = secret && req.headers.authorization === ('Bearer ' + secret);",
  '  if (!isAuthed) return res.status(401).json({ error: \'Unauthorized\' });',
  '  return res.status(200).json({ ok: true });',
  '}',
].join('\n');

const ADMIN = [
  '  const adminKey = (process.env.ADMIN_KEY || \'\').toLowerCase();',
  '  const isAdmin = adminKey && (req.headers[\'x-admin-key\'] || \'\').toLowerCase() === adminKey;',
].join('\n');

function withAdmin(bearerSrc) {
  // Fixtures are inspected as text by the check, never executed.
  return bearerSrc.replace('  if (!isAuthed)', ADMIN + '\n  if (!isAuthed && !isAdmin)');
}

function fixtureRoot(files, cronPaths) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-auth-'));
  fs.mkdirSync(path.join(root, 'api'), { recursive: true });
  const crons = cronPaths.map((p) => ({ path: p, schedule: '0 9 * * *' }));
  fs.writeFileSync(path.join(root, 'vercel.json'), JSON.stringify({ crons }));
  for (const [rel, src] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, rel), src);
  }
  return root;
}

function runCheck(root) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      env: { ...process.env, CRON_AUTH_ROOT: root },
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

test('clean bearer-only endpoint passes', () => {
  const root = fixtureRoot({ 'api/cron-alpha.js': BEARER }, ['/api/cron-alpha']);
  const r = runCheck(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 enumerated endpoints/);
});

test('the PR #76 shape fails: bearer PLUS an x-vercel-cron read in code', () => {
  const regressed = BEARER.replace(
    "  const isAuthed = secret && req.headers.authorization === ('Bearer ' + secret);",
    "  const isAuthed = secret && req.headers.authorization === ('Bearer ' + secret) && req.headers['x-vercel-cron'] === '1';"
  );
  const root = fixtureRoot({ 'api/cron-alpha.js': regressed }, ['/api/cron-alpha']);
  const r = runCheck(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /x-vercel-cron/);
});

test('x-vercel-cron mentioned in comments only passes (history, not code)', () => {
  const commented = '// The bare x-vercel-cron header stopped authenticating Oct 6, 2026.\n/* x-vercel-cron: retired */\n' + BEARER;
  const root = fixtureRoot({ 'api/cron-alpha.js': commented }, ['/api/cron-alpha']);
  const r = runCheck(root);
  assert.equal(r.code, 0, r.out);
});

test('x-vercel-cron in a plain string is not a read and passes', () => {
  const strMention = BEARER.replace(
    "return res.status(200).json({ ok: true });",
    "console.log('[cron] x-vercel-cron is not trusted');\n  return res.status(200).json({ ok: true });"
  );
  const root = fixtureRoot({ 'api/cron-alpha.js': strMention }, ['/api/cron-alpha']);
  const r = runCheck(root);
  assert.equal(r.code, 0, r.out);
});

test('comment stripping survives URLs in strings and slashes in regexes', () => {
  const tricky = BEARER.replace(
    "return res.status(200).json({ ok: true });",
    "const u = 'https://example.com/a//b'; const re = /x\\/\\/y/; const m = 'a'.replace(/[^a-z]+/g, ' ');\n  return res.status(200).json({ ok: true, u, m });"
  );
  const root = fixtureRoot({ 'api/cron-alpha.js': tricky }, ['/api/cron-alpha']);
  const r = runCheck(root);
  assert.equal(r.code, 0, r.out);
});

test('admin path on a sanctioned file passes; the same file unsanctioned fails', () => {
  const withAdm = withAdmin(BEARER);
  const okRoot = fixtureRoot({ 'api/cron-push-monitor.js': withAdm }, ['/api/cron-push-monitor']);
  assert.equal(runCheck(okRoot).code, 0);
  const badRoot = fixtureRoot({ 'api/cron-alpha.js': withAdm }, ['/api/cron-alpha']);
  const r = runCheck(badRoot);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ADMIN_KEY/);
});

test('sanctioned file that loses its admin path fails (allowlist rot)', () => {
  const root = fixtureRoot({ 'api/cron-push-monitor.js': BEARER }, ['/api/cron-push-monitor']);
  const r = runCheck(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /admin/i);
});

test('a cron row with no handler file fails (unknown shape)', () => {
  const root = fixtureRoot({}, ['/api/cron-ghost']);
  const r = runCheck(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no handler file/);
});

test('a handler with no bearer comparison fails', () => {
  const root = fixtureRoot({ 'api/cron-alpha.js': 'export default async function handler(req, res) { return res.status(200).end(); }' }, ['/api/cron-alpha']);
  const r = runCheck(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /bearer/);
});

test('enumeration: a seventh endpoint joins by existing (query strings ignored)', () => {
  const root = fixtureRoot(
    { 'api/cron-alpha.js': BEARER, 'api/cron-beta.js': BEARER },
    ['/api/cron-alpha', '/api/cron-beta?key=park_intel']
  );
  const r = runCheck(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 enumerated endpoints/);
});
