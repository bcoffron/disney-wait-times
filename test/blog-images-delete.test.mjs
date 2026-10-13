// Tests for the DELETE branch of api/blog-images.js.
//
// The safety rail under test: an image still referenced by any post
// (as its heroImage or inline in its body) must NOT be deletable —
// the handler returns 409 and never calls del(). An unreferenced
// image passes the guard and is deleted (200).
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/
// The handler's external imports (@vercel/blob, jsonwebtoken) are
// redirected to stubs in test/stubs/ via test/stub-hooks.mjs, and the
// handler's blob downloads are served by a stubbed global fetch. The
// handler's own internals (readPostBlob, buildUsageMap, stripQuery)
// run for real against the seeded posts.
import { register } from 'node:module';
register('./stub-hooks.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HERO_URL = 'https://blob.test/blog-images/hero-in-use.jpg';
const BODY_URL = 'https://blob.test/blog-images/inline-in-use.jpg';
const FREE_URL = 'https://blob.test/blog-images/not-used.jpg';

let importCounter = 0;

function seed(posts) {
  const st = (globalThis.__blobState = { blobs: new Map(), delCalls: [] });
  const add = function (pathname, json) {
    st.blobs.set(pathname, {
      pathname,
      url: 'https://blob.test/' + pathname,
      downloadUrl: 'stub://blob/' + pathname,
      uploadedAt: new Date().toISOString(),
      json
    });
  };
  add('blog/posts/index', posts.map(function (p) { return { slug: p.slug }; }));
  for (const p of posts) add('blog/posts/' + p.slug, p);

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

async function callDelete(targetUrl) {
  // Fresh module per call so the handler's rate-limiter state resets.
  const { default: handler } = await import('../api/blog-images.js?case=' + (++importCounter));
  const req = {
    method: 'DELETE',
    headers: { 'x-admin-key': 'valid-test-token' },
    body: { url: targetUrl },
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

const POST_WITH_HERO = {
  slug: 'post-with-hero',
  title: 'Post With Hero',
  published: true,
  heroImage: HERO_URL,
  body: '<p>No images here.</p>'
};

const POST_WITH_BODY_IMAGE = {
  slug: 'post-with-body-image',
  title: 'Post With Body Image',
  published: true,
  heroImage: '',
  body: '<p>Text</p><img src="' + BODY_URL + '" style="width:100%"><p>More text</p>'
};

test('DELETE a hero-referenced image returns 409 and does not call del', async function () {
  seed([POST_WITH_HERO, POST_WITH_BODY_IMAGE]);
  const res = await callDelete(HERO_URL);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'Image is in use and cannot be deleted');
  assert.ok(Array.isArray(res.body.usedBy));
  assert.equal(res.body.usedBy[0].slug, 'post-with-hero');
  assert.deepEqual(globalThis.__blobState.delCalls, []);
});

test('DELETE a body-referenced image returns 409 and does not call del', async function () {
  seed([POST_WITH_HERO, POST_WITH_BODY_IMAGE]);
  const res = await callDelete(BODY_URL);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.usedBy[0].slug, 'post-with-body-image');
  assert.deepEqual(globalThis.__blobState.delCalls, []);
});

test('DELETE an unreferenced image passes the guard and returns 200', async function () {
  seed([POST_WITH_HERO, POST_WITH_BODY_IMAGE]);
  const res = await callDelete(FREE_URL);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.deepEqual(globalThis.__blobState.delCalls, [FREE_URL]);
});

test('DELETE stays suffix-tolerant: a query-suffixed URL of an in-use image still returns 409', async function () {
  seed([POST_WITH_HERO, POST_WITH_BODY_IMAGE]);
  const res = await callDelete(HERO_URL + '?v=123');
  assert.equal(res.statusCode, 409);
  assert.deepEqual(globalThis.__blobState.delCalls, []);
});
