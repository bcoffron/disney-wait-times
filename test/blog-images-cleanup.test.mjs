// Tests for api/blog-images-cleanup.js — the allowlist-only bulk delete.
//
// The five required properties under test:
//  1. Allowlist-only: it deletes exactly the URLs in the request body's
//     `urls` array — a blob that exists in the store but is NOT listed
//     (even if smuggled in another body field) is never deleted.
//  2. Dry-run echoes the received allowlist + resolutions, deletes nothing.
//  3. Suffix-tolerant in-use backstop: a URL referenced by a post whose
//     blob lives at a RANDOM-SUFFIXED pathname is refused (the Oct 12
//     production failure shape), while other allowlisted orphans delete.
//  4. Scope guard: anything that is not an https Vercel Blob URL for a
//     single file directly under blog-images/ is rejected, never acted on.
//  5. Cap + auth: >100 URLs is a 400; missing/invalid admin token is a 401.
//
// Run: node --test test/blog-images-cleanup.test.mjs
// Same stub approach as the blog-images tests: @vercel/blob and
// jsonwebtoken are redirected to test/stubs/, blob downloads are served
// by a stubbed fetch, and the endpoint's real internals run.
import { register } from 'node:module';
register('./stub-hooks.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';

const STORE = 'https://store123.public.blob.vercel-storage.com';
const ORPHAN_1 = STORE + '/blog-images/orphan-one.jpg';
const ORPHAN_2 = STORE + '/blog-images/orphan-two.jpg';
const HERO_USED = STORE + '/blog-images/used-hero.jpg';
const MISSING = STORE + '/blog-images/never-uploaded.jpg';
const SUFFIX = 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsT';

let importCounter = 0;

function seed() {
  const st = (globalThis.__blobState = { blobs: new Map(), delCalls: [] });
  const add = function (pathname, json) {
    st.blobs.set(pathname, {
      pathname,
      url: STORE + '/' + pathname,
      downloadUrl: 'stub://blob/' + pathname,
      uploadedAt: '2026-10-12T12:00:00.000Z',
      json
    });
  };
  // Images in the store.
  add('blog-images/orphan-one.jpg', null);
  add('blog-images/orphan-two.jpg', null);
  add('blog-images/used-hero.jpg', null);
  // One published post, stored at a SUFFIXED pathname (production shape),
  // whose hero is HERO_USED.
  const post = {
    slug: 'post-a', title: 'Post A', published: true,
    heroImage: HERO_USED, body: '<p>no inline images</p>'
  };
  add('blog/posts/index', [{ slug: 'post-a' }]);
  add('blog/posts/post-a-' + SUFFIX, post);

  globalThis.fetch = async function (u) {
    const key = String(u).replace('stub://blob/', '');
    const b = globalThis.__blobState.blobs.get(key);
    if (!b) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(b.json), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}

async function callCleanup(body, token) {
  const { default: handler } = await import('../api/blog-images-cleanup.js?case=' + (++importCounter));
  const req = {
    method: 'POST',
    headers: { 'x-admin-key': token === undefined ? 'valid-test-token' : token },
    body,
    socket: { remoteAddress: '127.0.0.1' }
  };
  const res = {
    statusCode: null,
    body: null,
    status: function (c) { this.statusCode = c; return this; },
    json: function (o) { this.body = o; return this; }
  };
  await handler(req, res);
  return res;
}

function storeHas(url) {
  for (const b of globalThis.__blobState.blobs.values()) if (b.url === url) return true;
  return false;
}

test('allowlisted unreferenced URL is deleted', async function () {
  seed();
  const res = await callCleanup({ urls: [ORPHAN_1] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.deleted, [ORPHAN_1]);
  assert.deepEqual(globalThis.__blobState.delCalls, [ORPHAN_1]);
  assert.equal(storeHas(ORPHAN_1), false);
});

test('a URL NOT in the allowlist is never deleted, even if smuggled in another field', async function () {
  seed();
  const res = await callCleanup({ urls: [ORPHAN_1], extra: [ORPHAN_2], alsoDelete: ORPHAN_2 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(globalThis.__blobState.delCalls, [ORPHAN_1]);
  assert.equal(storeHas(ORPHAN_2), true);
});

test('referenced URL (suffixed post hero) is refused by the backstop; other orphans still delete', async function () {
  seed();
  const res = await callCleanup({ urls: [HERO_USED, ORPHAN_1] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.deleted, [ORPHAN_1]);
  assert.equal(res.body.skippedInUse.length, 1);
  assert.equal(res.body.skippedInUse[0].url, HERO_USED);
  assert.equal(res.body.skippedInUse[0].usedBy[0].slug, 'post-a');
  assert.deepEqual(globalThis.__blobState.delCalls, [ORPHAN_1]);
  assert.equal(storeHas(HERO_USED), true);
});

test('scope guard rejects out-of-scope entries and never acts on them', async function () {
  seed();
  const bad = [
    STORE + '/blog/posts/index',
    STORE + '/blog-images/sub/nested.jpg',
    'http://store123.public.blob.vercel-storage.com/blog-images/orphan-one.jpg',
    'https://evil.example.com/blog-images/orphan-one.jpg',
    'not a url at all'
  ];
  const res = await callCleanup({ urls: bad.concat([ORPHAN_1]) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rejected.length, bad.length);
  assert.deepEqual(res.body.deleted, [ORPHAN_1]);
  assert.deepEqual(globalThis.__blobState.delCalls, [ORPHAN_1]);
});

test('dry-run echoes the allowlist and resolutions and deletes nothing', async function () {
  seed();
  const input = [ORPHAN_1, HERO_USED, MISSING];
  const res = await callCleanup({ urls: input, dryRun: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, true);
  assert.deepEqual(res.body.allowlist, input);
  assert.deepEqual(res.body.wouldDelete, [ORPHAN_1]);
  assert.equal(res.body.skippedInUse[0].url, HERO_USED);
  assert.deepEqual(res.body.notFound, [MISSING]);
  assert.equal(res.body.resolved.length, 2);
  assert.deepEqual(globalThis.__blobState.delCalls, []);
  assert.equal(storeHas(ORPHAN_1), true);
  assert.equal(storeHas(HERO_USED), true);
});

test('cap: more than 100 URLs is a 400 and nothing is deleted', async function () {
  seed();
  const many = [];
  for (let i = 0; i < 101; i++) many.push(STORE + '/blog-images/f' + i + '.jpg');
  const res = await callCleanup({ urls: many });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(globalThis.__blobState.delCalls, []);
});

test('auth: missing or invalid token is a 401 and nothing is deleted', async function () {
  seed();
  const res1 = await callCleanup({ urls: [ORPHAN_1] }, '');
  assert.equal(res1.statusCode, 401);
  const res2 = await callCleanup({ urls: [ORPHAN_1] }, 'wrong-token');
  assert.equal(res2.statusCode, 401);
  assert.deepEqual(globalThis.__blobState.delCalls, []);
  assert.equal(storeHas(ORPHAN_1), true);
});
