import './upload/hooks.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

const handler = (await import('../api/blog-upload-image.js')).default;

const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(96, 7)]);
const NOT_JPEG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.alloc(96, 7)]);

function mockReq({ ip, token = 'good-token', body = JPEG, contentType = 'image/jpeg', contentLength } = {}) {
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

test('authenticated admin can upload a 25-file batch without a 429', async () => {
  for (let i = 0; i < 25; i++) {
    const res = await call({ ip: '10.0.0.1' });
    assert.equal(res.code, 200, `upload ${i + 1} should succeed, got ${res.code}`);
    assert.ok(res.body.url, 'upload returns a blob url');
  }
});

test('unauthenticated requests are still rejected 401 before anything else', async () => {
  const noTok = await call({ ip: '10.0.0.2', token: null });
  assert.equal(noTok.code, 401);
  const badTok = await call({ ip: '10.0.0.2', token: 'forged' });
  assert.equal(badTok.code, 401);
});

test('the in-code limiter still exists: an authenticated flood is capped', async () => {
  let last = null;
  for (let i = 0; i < 601; i++) last = await call({ ip: '10.0.0.3' });
  assert.equal(last.code, 429, 'request 601 within the hour must be rate-limited');
});

test('upload security untouched: oversize header still 413', async () => {
  const res = await call({ ip: '10.0.0.4', contentLength: 5 * 1024 * 1024 });
  assert.equal(res.code, 413);
});

test('upload security untouched: magic-bytes mismatch still 400', async () => {
  const res = await call({ ip: '10.0.0.5', body: NOT_JPEG });
  assert.equal(res.code, 400);
});
