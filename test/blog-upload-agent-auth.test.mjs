import './upload/hooks.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';

// Agent-token parity for api/blog-upload-image.js (Claude ruling,
// Nov 9, 2026): the handler accepts the admin session JWT exactly as
// before, and additionally BLOG_AGENT_TOKEN (constant-time compare,
// mirroring blog-save.js) so reviewed agent tooling can upload a
// post's images without holding Beau's session token. Agent callers
// are restricted further: their own 60/hour rate-limit bucket and a
// 1MB size cap, and every agent upload is audit-logged.
//
// The jsonwebtoken stub accepts only 'good-token' as a JWT; the agent
// token below is deliberately NOT a JWT, exactly like production.
// The handler reads process.env per request, so the suite can set /
// unset BLOG_AGENT_TOKEN between calls. Each case uses its own IP so
// the module-level rate-limit buckets never leak across cases.
const AGENT_TOKEN = 'test-agent-token-0123456789abcdef';
process.env.BLOG_AGENT_TOKEN = AGENT_TOKEN;

const handler = (await import('../api/blog-upload-image.js')).default;

function jpegOfSize(n) {
  return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(Math.max(0, n - 4), 7)]);
}
const JPEG = jpegOfSize(100);
const PNG_MAGIC_AS_JPEG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(92, 7)]);

function mockReq({ ip, token = AGENT_TOKEN, body = JPEG, contentType = 'image/jpeg', contentLength } = {}) {
  const req = Readable.from([body]);
  req.method = 'POST';
  req.url = '/api/blog-upload-image';
  req.headers = {
    'x-forwarded-for': ip,
    'content-type': contentType,
    'x-filename': 'test.jpg',
    'content-length': String(contentLength ?? body.length),
  };
  if (token !== null) req.headers['x-admin-key'] = token;
  req.socket = { remoteAddress: ip };
  return req;
}
function mockRes() {
  return {
    code: null, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function call(opts) {
  const res = mockRes();
  await handler(mockReq(opts), res);
  return res;
}
function captureConsole() {
  const warns = [], logs = [];
  const ow = console.warn, ol = console.log;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  console.log = (...a) => logs.push(a.map(String).join(' '));
  return { warns, logs, restore() { console.warn = ow; console.log = ol; } };
}
const securityLines = (cap) => cap.warns.filter(w => w.includes('[SECURITY]'));

test('no credentials -> 401', async () => {
  const res = await call({ ip: '10.1.0.1', token: null });
  assert.equal(res.code, 401);
  assert.equal(res.body.error, 'Unauthorized');
});

test('valid session JWT behaves exactly as before', async () => {
  const res = await call({ ip: '10.1.0.2', token: 'good-token' });
  assert.equal(res.code, 200);
  assert.ok(res.body.url && res.body.url.includes('blog-images/'), 'returns the blob url');
  assert.ok(res.body.filename && res.body.filename.endsWith('.jpg'), 'returns the stored filename');
  assert.ok(res.body.uploadedAt, 'returns uploadedAt');
});

test('valid agent token passes, audit-logs once, and writes no [SECURITY] line for the expected JWT miss', async () => {
  const cap = captureConsole();
  let res;
  try { res = await call({ ip: '10.1.0.3' }); } finally { cap.restore(); }
  assert.equal(res.code, 200);
  assert.ok(res.body.url, 'agent upload returns a blob url');
  assert.equal(cap.logs.filter(l => l.includes('agent upload')).length, 1, 'exactly one audit log line');
  assert.equal(securityLines(cap).length, 0, 'the JWT miss the agent branch satisfies must not log');
});

test('wrong token -> 401, logged exactly once at the final rejection', async () => {
  const cap = captureConsole();
  let res;
  try { res = await call({ ip: '10.1.0.4', token: 'forged-token' }); } finally { cap.restore(); }
  assert.equal(res.code, 401);
  assert.equal(securityLines(cap).length, 1, 'one [SECURITY] line, not one per credential tried');
});

test('any token is rejected while BLOG_AGENT_TOKEN is unset (fail closed)', async () => {
  delete process.env.BLOG_AGENT_TOKEN;
  try {
    const res = await call({ ip: '10.1.0.5', token: AGENT_TOKEN });
    assert.equal(res.code, 401);
  } finally {
    process.env.BLOG_AGENT_TOKEN = AGENT_TOKEN;
  }
});

test('wrong-length tokens -> 401 without throwing (timingSafeEqual length guard)', async () => {
  const short = await call({ ip: '10.1.0.6', token: 'short' });
  assert.equal(short.code, 401);
  const long = await call({ ip: '10.1.0.6', token: AGENT_TOKEN + '-with-a-long-suffix' });
  assert.equal(long.code, 401);
});

test('agent upload of a non-image is rejected (validation applies to both auth kinds)', async () => {
  const spoofed = await call({ ip: '10.1.0.7', body: PNG_MAGIC_AS_JPEG, contentType: 'image/jpeg' });
  assert.equal(spoofed.code, 400, 'magic bytes are checked for agent uploads too');
  const plain = await call({ ip: '10.1.0.7', body: Buffer.from('hello'), contentType: 'text/plain', contentLength: 5 });
  assert.equal(plain.code, 400, 'content-type allowlist is checked for agent uploads too');
});

test('agent uploads are capped at 1MB; the session 4MB ceiling is untouched', async () => {
  const big = jpegOfSize(Math.floor(1.5 * 1024 * 1024));
  const agentRes = await call({ ip: '10.1.0.8', body: big });
  assert.equal(agentRes.code, 413);
  assert.equal(agentRes.body.error, 'File too large. Maximum 1MB.');
  const sessionRes = await call({ ip: '10.1.0.9', token: 'good-token', body: jpegOfSize(2 * 1024 * 1024) });
  assert.equal(sessionRes.code, 200, 'a 2MB session upload still fits the unchanged 4MB ceiling');
});

test('two different images back-to-back as agent both succeed (duplicate guard needs no JWT identity)', async () => {
  const a = await call({ ip: '10.1.0.10', body: jpegOfSize(100) });
  const b = await call({ ip: '10.1.0.10', body: jpegOfSize(240) });
  assert.equal(a.code, 200);
  assert.equal(b.code, 200);
  assert.notEqual(a.body.url, b.body.url);
});

test('agent rate bucket is separate from the admin bucket and capped at 60/hour', async () => {
  const ip = '10.1.0.11';
  let last = null;
  for (let i = 0; i < 61; i++) last = await call({ ip });
  assert.equal(last.code, 429, 'agent request 61 within the hour exceeds the agent bucket');
  const session = await call({ ip, token: 'good-token' });
  assert.equal(session.code, 200, 'the same IP still has its full session bucket: the buckets are separate');
});

test('code inspection: agent bucket cap, kind-keyed limiter, identity-free duplicate guard', async () => {
  const src = await readFile(new URL('../api/blog-upload-image.js', import.meta.url), 'utf8');
  assert.match(src, /AGENT_UPLOAD_LIMIT = 60/, 'agent bucket cap is 60/hour');
  assert.match(src, /authKind \+ ':' \+ ip/, 'limiter key is prefixed by auth kind');
  assert.match(src, /AGENT_MAX_SIZE = 1 \* 1024 \* 1024/, 'agent size cap is 1MB');
  assert.match(src, /b\.size === fileBuffer\.length/, 'duplicate guard keys on file size only, never on caller identity');
});
