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

// ---------------------------------------------------------------------------
// Suffixed-store fixtures: the production blob store's real shape.
// Post blobs are stored at RANDOM-SUFFIXED pathnames (put + addRandomSuffix),
// e.g. 'blog/posts/what-to-wear-to-disney-NtXoccyfza3EGgKrjBWjxin0vhX'.
// The handler's reader must still find them (bare key OR key + '-' +
// alphanumeric suffix, newest by uploadedAt). These tests FAIL against the
// old exact-pathname reader — that failure is what let an in-use hero be
// deleted in production on Oct 12, 2026.
// ---------------------------------------------------------------------------

const SUFFIX_A = 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsT';
const SUFFIX_B = 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5';

function seedSuffixed(posts, opts) {
  opts = opts || {};
  const st = (globalThis.__blobState = { blobs: new Map(), delCalls: [] });
  const add = function (pathname, json, uploadedAt) {
    st.blobs.set(pathname, {
      pathname,
      url: 'https://blob.test/' + pathname,
      downloadUrl: 'stub://blob/' + pathname,
      uploadedAt: uploadedAt || new Date().toISOString(),
      json
    });
  };
  const indexPath = 'blog/posts/index' + (opts.suffixIndex ? '-' + SUFFIX_A : '');
  add(indexPath, posts.map(function (p) { return { slug: p.slug }; }), '2026-10-01T00:00:00.000Z');
  for (const p of posts) {
    add('blog/posts/' + p.slug + '-' + (p._suffix || SUFFIX_A), p, p._uploadedAt || '2026-10-02T00:00:00.000Z');
  }

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

test('SUFFIXED store: DELETE a hero-referenced image returns 409 and does not call del (the Oct 12 prod failure)', async function () {
  seedSuffixed([POST_WITH_HERO, POST_WITH_BODY_IMAGE]);
  const res = await callDelete(HERO_URL);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'Image is in use and cannot be deleted');
  assert.equal(res.body.usedBy[0].slug, 'post-with-hero');
  assert.deepEqual(globalThis.__blobState.delCalls, []);
});

test('SUFFIXED store: DELETE a body-referenced image returns 409 and does not call del', async function () {
  seedSuffixed([POST_WITH_HERO, POST_WITH_BODY_IMAGE]);
  const res = await callDelete(BODY_URL);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.usedBy[0].slug, 'post-with-body-image');
  assert.deepEqual(globalThis.__blobState.delCalls, []);
});

test('SUFFIXED store: DELETE an unreferenced image still returns 200 and deletes', async function () {
  seedSuffixed([POST_WITH_HERO, POST_WITH_BODY_IMAGE]);
  const res = await callDelete(FREE_URL);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(globalThis.__blobState.delCalls, [FREE_URL]);
});

test('SUFFIXED store + suffixed index blob: hero delete still returns 409', async function () {
  seedSuffixed([POST_WITH_HERO, POST_WITH_BODY_IMAGE], { suffixIndex: true });
  const res = await callDelete(HERO_URL);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(globalThis.__blobState.delCalls, []);
});

test('Sibling slugs: a prefix-sibling post is not absorbed (hyphen rejection in the suffix matcher)', async function () {
  const RIDES_URL = 'https://blob.test/blog-images/rides-hero.jpg';
  const RANKED_URL = 'https://blob.test/blog-images/ranked-hero.jpg';
  const rides = {
    slug: 'disneyland-rides', title: 'Rides', published: true,
    heroImage: RIDES_URL, body: '<p>x</p>',
    _suffix: SUFFIX_A, _uploadedAt: '2026-10-02T00:00:00.000Z'
  };
  const ranked = {
    slug: 'disneyland-rides-ranked', title: 'Rides Ranked', published: true,
    heroImage: RANKED_URL, body: '<p>x</p>',
    _suffix: SUFFIX_B, _uploadedAt: '2026-10-03T00:00:00.000Z'
  };
  seedSuffixed([rides, ranked]);
  // The ranked post's blob is NEWER and shares the rides prefix; reading
  // 'disneyland-rides' must reject it ('ranked-...' continues with a hyphen),
  // and each hero must be attributed to its own post.
  const resRanked = await callDelete(RANKED_URL);
  assert.equal(resRanked.statusCode, 409);
  assert.equal(resRanked.body.usedBy[0].slug, 'disneyland-rides-ranked');
  const resRides = await callDelete(RIDES_URL);
  assert.equal(resRides.statusCode, 409);
  assert.equal(resRides.body.usedBy[0].slug, 'disneyland-rides');
  assert.deepEqual(globalThis.__blobState.delCalls, []);
});
