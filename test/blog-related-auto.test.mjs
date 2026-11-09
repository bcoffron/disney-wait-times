// Related-posts auto-build suite (Claude's related-auto design,
// Nov 9, 2026): related lists build themselves by default
// (api/lib/related.js IDF scorer), a human editor edit freezes a
// list as 'manual' and manual sticks, the agent can never change
// provenance, legacy posts (no relatedSource) are preserved until
// the backfill, the daily reconcile sweep refreshes automatic lists
// only, and the renderer shows the stored list filtered/refreshed
// against the index.
//
// Run with Node's built-in runner:  node --test test/blog-related-auto.test.mjs
// @vercel/blob and jsonwebtoken are redirected to test/stubs/ via
// test/stub-hooks.mjs (the JWT stub accepts exactly 'valid-test-
// token'); blob downloads are served by a stubbed global fetch, the
// same pattern as test/blog-images-delete.test.mjs. Seeded blobs are
// future-dated so lib/blob.js's last-write memo classifies a fresh
// seed as a later visible write rather than unexplained state.
import { register } from 'node:module';
register('./stub-hooks.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

process.env.BLOG_AGENT_TOKEN = 'test-agent-token-0123456789abcdef';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.BLOG_RECONCILE_LAG_MS = '0';

const { computeRelated, explainRelated, validateManualRelated, resolveRelated, normalizeTags, RELATED_LIST_LENGTH } =
  await import('../api/lib/related.js');
const { readBlobJson } = await import('../api/lib/blob.js');

// ---------------- fixtures ----------------

const ENTRY = (slug, over = {}) => ({
  slug, title: 'Title ' + slug, park: 'dl', category: 'Disneyland · Guide',
  tagLabel: 'Disneyland', heroImage: 'https://img/' + slug + '.jpg', heroAlt: '',
  intro: 'Intro ' + slug, readTime: '5',
  publishedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  published: true, tags: [], ...over
});

// The scoring corpus (index entries). Hand-computed expectations for
// a dl/Guide source with tags ['rare-a', 'rope drop'] (P = 5):
//   idf('rare-a') = ln(5/2) = 0.916291; idf('rope drop') = ln(5/4) = 0.223144
//   alpha 2.639435 (2 shared, park +1, cat +0.5, newest of the tie)
//   beta  2.639435 (2 shared, park +1, cat +0.5)
//   gamma 1.223144 (1 shared, park +1, dining category)
//   epsilon 1.0 (0 shared, park 'both' +1)
//   delta -0.776856 (1 shared, wdw park -1)
const CANDIDATES = [
  ENTRY('alpha', { tags: ['rope drop', 'lightning lane', 'rare-a'], publishedAt: '2026-01-05T00:00:00.000Z' }),
  ENTRY('beta', { tags: ['rope drop', 'rare-a'], publishedAt: '2026-01-04T00:00:00.000Z' }),
  ENTRY('gamma', { category: 'Disneyland · Dining', tags: ['rope drop', 'dining'], publishedAt: '2026-01-03T00:00:00.000Z' }),
  ENTRY('delta', { park: 'wdw', category: 'Walt Disney World · Guide', tags: ['rope drop'], publishedAt: '2026-01-02T00:00:00.000Z' }),
  ENTRY('epsilon', { park: 'both', category: 'Planning', tags: ['lightning lane'], publishedAt: '2026-01-01T00:00:00.000Z' })
];
const SOURCE = { slug: 'source-new', park: 'dl', category: 'Disneyland · Guide', tags: ['rare-a', 'rope drop'] };
const relEntry = (slug, over = {}) => {
  const e = CANDIDATES.find(c => c.slug === slug) || ENTRY(slug);
  return { slug: e.slug, park: e.park, title: e.title, heroImage: e.heroImage, ...over };
};
const POST = (slug, over = {}) => ({
  ...ENTRY(slug), body: '<p>Body of ' + slug + '</p>', faqs: [], related: [], ...over
});

// ---------------- blob store seeding ----------------

function seed(posts, indexEntries) {
  const st = (globalThis.__blobState = { blobs: new Map(), delCalls: [] });
  const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const add = (pathname, json) => st.blobs.set(pathname, {
    pathname, url: 'https://blob.test/' + pathname,
    downloadUrl: 'stub://blob/' + pathname, uploadedAt: future, json
  });
  if (indexEntries) add('blog/posts/index', indexEntries);
  for (const p of posts) add('blog/posts/' + p.slug, p);
  globalThis.fetch = async (u) => {
    const key = String(u).replace('stub://blob/', '').replace('https://blob.test/', '');
    if (typeof globalThis.__onFetch === 'function') globalThis.__onFetch(key);
    const b = globalThis.__blobState.blobs.get(key);
    if (!b) return new Response('not found', { status: 404 });
    const text = b.body != null ? b.body : JSON.stringify(b.json);
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
const storedPost = (slug) => readBlobJson('blog/posts/' + slug, 'test.readback', { expected: false });

// ---------------- handler call helpers ----------------

let caseN = 0;
async function callSave(body, token) {
  const { default: handler } = await import('../api/blog-save.js?case=' + (++caseN));
  const req = {
    method: 'POST', url: '/api/blog-save',
    headers: { 'x-admin-key': token, 'content-length': '100' },
    body, socket: { remoteAddress: '127.0.0.1' }
  };
  const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler(req, res);
  return res;
}
const SESSION = 'valid-test-token';
const AGENT = process.env.BLOG_AGENT_TOKEN;
const savePayload = (over = {}) => ({
  slug: 'source-new', title: 'Source New', park: 'dl', category: 'Disneyland · Guide',
  tagLabel: 'Disneyland', heroImage: '', heroAlt: '', intro: 'Intro', readTime: '5',
  published: true, publishedAt: '2026-02-01T00:00:00.000Z', body: '<p>hi</p>', faqs: [],
  tags: ['rare-a', 'rope drop'], related: [], ...over
});

// ---------------- scorer units ----------------

test('normalizeTags: lowercase, trim, collapse, straighten curly apostrophes, dedupe', () => {
  assert.deepEqual(normalizeTags(['  Rope   Drop ', 'rope drop', 'It’s Here', "it's here", '']), ['rope drop', "it's here"]);
});

test('compute: fresh source gets the hand-computed top 2', () => {
  const list = computeRelated(SOURCE, CANDIDATES);
  assert.equal(RELATED_LIST_LENGTH, 2);
  assert.deepEqual(list.map(r => r.slug), ['alpha', 'beta']);
  assert.deepEqual(list[0], relEntry('alpha'));
});

test('compute: deterministic, including under shuffled corpus order', () => {
  const a = computeRelated(SOURCE, CANDIDATES);
  const shuffled = [CANDIDATES[3], CANDIDATES[0], CANDIDATES[4], CANDIDATES[1], CANDIDATES[2]];
  assert.deepEqual(computeRelated(SOURCE, shuffled), a);
  assert.deepEqual(computeRelated(SOURCE, [...CANDIDATES].reverse()), a);
  assert.deepEqual(computeRelated(SOURCE, CANDIDATES), a);
});

test('explain: parts sum to scores, ranking matches the stored order, idf values are the hand-computed ones', () => {
  const explained = explainRelated(SOURCE, CANDIDATES);
  assert.deepEqual(explained.map(c => c.slug), ['alpha', 'beta', 'gamma', 'epsilon', 'delta']);
  for (const c of explained) {
    const sum = Math.round((c.parts.tagScore + c.parts.park + c.parts.category) * 1e6) / 1e6;
    assert.equal(sum, c.score, c.slug + ': parts must sum to the score');
    const tagSum = Math.round(c.parts.tags.reduce((s, t) => s + t.idf, 0) * 1e6) / 1e6;
    assert.equal(tagSum, c.parts.tagScore, c.slug + ': tag parts must sum to tagScore');
  }
  const alpha = explained[0];
  assert.deepEqual(alpha.parts.tags, [{ tag: 'rare-a', idf: 0.916291 }, { tag: 'rope drop', idf: 0.223144 }]);
  assert.equal(alpha.score, 2.639435);
  assert.equal(explained.find(c => c.slug === 'delta').parts.park, -1.0, 'dl source vs wdw candidate is the -1.0 park case');
  assert.deepEqual(explainRelated(SOURCE, CANDIDATES).slice(0, 2).map(c => c.slug), computeRelated(SOURCE, CANDIDATES).map(r => r.slug));
});

test('compute: unpublished candidates and the source itself are excluded', () => {
  const corpus = [...CANDIDATES, ENTRY('draft-twin', { tags: ['rare-a', 'rope drop'], published: false, publishedAt: '2026-01-06T00:00:00.000Z' })];
  const list = computeRelated(SOURCE, corpus);
  assert.ok(!list.some(r => r.slug === 'draft-twin'), 'an unpublished post is never computed in');
  const selfList = computeRelated(CANDIDATES[0], CANDIDATES);
  assert.ok(!selfList.some(r => r.slug === 'alpha'), 'no self-reference');
});

test('validateManualRelated: fills park/title from the index; drafts are known slugs', () => {
  const corpus = [...CANDIDATES, ENTRY('draft-pick', { published: false })];
  const v = validateManualRelated([{ slug: 'gamma' }, { slug: 'draft-pick' }], 'some-post', corpus);
  assert.equal(v.ok, true);
  assert.deepEqual(v.list, [relEntry('gamma'), relEntry('draft-pick')]);
});

test('validateManualRelated: unknown, self, duplicate, and >6 are named errors', () => {
  assert.match(validateManualRelated([{ slug: 'nope' }], 'some-post', CANDIDATES).error, /Unknown related post: "nope"/);
  assert.match(validateManualRelated([{ slug: 'some-post' }], 'some-post', CANDIDATES).error, /cannot list itself/);
  assert.match(validateManualRelated([{ slug: 'alpha' }, { slug: 'alpha' }], 'some-post', CANDIDATES).error, /Duplicate related post: "alpha"/);
  const seven = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'a2', 'a3'].map(slug => ({ slug }));
  const corpus = [...CANDIDATES, ENTRY('a2'), ENTRY('a3')];
  assert.match(validateManualRelated(seven, 'some-post', corpus).error, /maximum is 6/);
});

test('resolveRelated precedence (unit): agent rows on a manual post are ignored entirely', () => {
  const stored = POST('m', { related: [relEntry('gamma')], relatedSource: 'manual' });
  const incoming = { slug: 'm', tags: [], park: 'dl', category: 'X', related: [relEntry('alpha')], relatedSource: 'auto' };
  const r = resolveRelated(incoming, stored, 'agent', CANDIDATES);
  assert.equal(r.relatedSource, 'manual');
  assert.deepEqual(r.related, [relEntry('gamma')]);
});

// ---------------- blog-save handler ----------------

test('fresh save: computes the auto list, stamps relatedSource auto, returns both', async () => {
  seed([], CANDIDATES.map(c => ({ ...c })));
  const res = await callSave(savePayload(), SESSION);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.relatedSource, 'auto');
  assert.deepEqual(res.body.related.map(r => r.slug), ['alpha', 'beta']);
  const stored = await storedPost('source-new');
  assert.equal(stored.relatedSource, 'auto');
  assert.deepEqual(stored.related.map(r => r.slug), ['alpha', 'beta']);
});

test('manual set via editor, then survives an agent save with different rows and an untouched-editor save', async () => {
  const legacy = POST('manual-post', { tags: ['rope drop'], related: [relEntry('beta')] });
  seed([legacy], [...CANDIDATES, ENTRY('manual-post', { tags: ['rope drop'] })]);
  // Editor save: rows changed from the loaded snapshot -> 'manual'.
  let res = await callSave(savePayload({ slug: 'manual-post', tags: ['rope drop'], related: [{ slug: 'gamma' }], relatedSource: 'manual' }), SESSION);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  let stored = await storedPost('manual-post');
  assert.equal(stored.relatedSource, 'manual');
  assert.deepEqual(stored.related, [relEntry('gamma')], 'manual list stored with index-filled fields');
  // Agent save with different rows and a 'manual' claim: ignored.
  res = await callSave(savePayload({ slug: 'manual-post', tags: ['rope drop'], related: [{ slug: 'alpha' }], relatedSource: 'manual', body: '<p>agent edit</p>' }), AGENT);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  stored = await storedPost('manual-post');
  assert.equal(stored.relatedSource, 'manual');
  assert.deepEqual(stored.related, [relEntry('gamma')], 'agent cannot move a manual list');
  // Untouched-editor save (loaded source sent, rows identical): still manual.
  res = await callSave(savePayload({ slug: 'manual-post', tags: ['rope drop'], related: [{ slug: 'gamma' }], relatedSource: 'manual' }), SESSION);
  assert.equal(res.code, 200);
  stored = await storedPost('manual-post');
  assert.equal(stored.relatedSource, 'manual');
  assert.deepEqual(stored.related, [relEntry('gamma')]);
});

test('agent cannot set provenance in either direction', async () => {
  // agent 'auto' claim on a manual post: provenance + list unchanged.
  const manual = POST('m2', { tags: ['rope drop'], related: [relEntry('gamma')], relatedSource: 'manual' });
  const auto = POST('a2', { tags: ['rare-a', 'rope drop'], related: [relEntry('delta')], relatedSource: 'auto' });
  seed([manual, auto], [...CANDIDATES, ENTRY('m2', { tags: ['rope drop'] }), ENTRY('a2', { tags: ['rare-a', 'rope drop'] })]);
  let res = await callSave(savePayload({ slug: 'm2', tags: ['rope drop'], related: [], relatedSource: 'auto' }), AGENT);
  assert.equal(res.code, 200);
  let stored = await storedPost('m2');
  assert.equal(stored.relatedSource, 'manual');
  assert.deepEqual(stored.related, [relEntry('gamma')]);
  // agent rows + 'manual' claim on an auto post: recomputed, stays auto.
  res = await callSave(savePayload({ slug: 'a2', tags: ['rare-a', 'rope drop'], related: [{ slug: 'gamma' }], relatedSource: 'manual' }), AGENT);
  assert.equal(res.code, 200);
  stored = await storedPost('a2');
  assert.equal(stored.relatedSource, 'auto');
  assert.deepEqual(stored.related.map(r => r.slug), ['alpha', 'beta'], 'recomputed, not the agent rows');
});

test('return to automatic: session save with relatedSource auto recomputes a manual post', async () => {
  const manual = POST('m3', { tags: ['rope drop'], related: [relEntry('gamma')], relatedSource: 'manual' });
  seed([manual], [...CANDIDATES, ENTRY('m3', { tags: ['rope drop'] })]);
  const res = await callSave(savePayload({ slug: 'm3', tags: ['rope drop'], related: [{ slug: 'gamma' }], relatedSource: 'auto' }), SESSION);
  assert.equal(res.code, 200);
  const stored = await storedPost('m3');
  assert.equal(stored.relatedSource, 'auto');
  assert.deepEqual(stored.related.map(r => r.slug), ['alpha', 'beta']);
});

test('open-and-save stays auto (loaded source sent, and legacy no-source shape)', async () => {
  const auto = POST('a3', { tags: ['rare-a', 'rope drop'], related: [relEntry('alpha'), relEntry('beta')], relatedSource: 'auto' });
  seed([auto], [...CANDIDATES, ENTRY('a3', { tags: ['rare-a', 'rope drop'] })]);
  let res = await callSave(savePayload({ slug: 'a3', related: [relEntry('alpha'), relEntry('beta')], relatedSource: 'auto' }), SESSION);
  assert.equal(res.code, 200);
  let stored = await storedPost('a3');
  assert.equal(stored.relatedSource, 'auto');
  // A pre-deploy cached editor sends no relatedSource at all.
  res = await callSave(savePayload({ slug: 'a3', related: [relEntry('delta')] }), SESSION);
  assert.equal(res.code, 200);
  stored = await storedPost('a3');
  assert.equal(stored.relatedSource, 'auto');
  assert.deepEqual(stored.related.map(r => r.slug), ['alpha', 'beta'], 'recomputed; rows sent without provenance are ignored');
});

test('tag change on save recomputes the post\'s own list', async () => {
  const taggy = POST('taggy', { category: 'Disneyland · Dining', tags: ['dining'], related: [relEntry('gamma')], relatedSource: 'auto' });
  seed([taggy], [...CANDIDATES, ENTRY('taggy', { category: 'Disneyland · Dining', tags: ['dining'] })]);
  const res = await callSave(savePayload({ slug: 'taggy', category: 'Disneyland · Dining', tags: ['rare-a', 'rope drop'], related: [] }), SESSION);
  assert.equal(res.code, 200);
  const stored = await storedPost('taggy');
  assert.deepEqual(stored.related.map(r => r.slug), ['alpha', 'beta']);
});

test('legacy post: agent save and untouched-editor save preserve the list and write NO relatedSource', async () => {
  const legacyList = [relEntry('alpha')];
  const legacy = POST('legacy-post', { tags: ['rope drop'], related: legacyList });
  seed([legacy], [...CANDIDATES, ENTRY('legacy-post', { tags: ['rope drop'] })]);
  let res = await callSave(savePayload({ slug: 'legacy-post', tags: ['rope drop'], related: [{ slug: 'beta' }], body: '<p>agent</p>' }), AGENT);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  let stored = await storedPost('legacy-post');
  assert.deepEqual(stored.related, legacyList, 'stored list rides verbatim, payload rows ignored');
  assert.ok(!('relatedSource' in stored), 'no relatedSource written for a legacy post');
  res = await callSave(savePayload({ slug: 'legacy-post', tags: ['rope drop'], related: [{ slug: 'alpha' }] }), SESSION);
  assert.equal(res.code, 200);
  stored = await storedPost('legacy-post');
  assert.deepEqual(stored.related, legacyList);
  assert.ok(!('relatedSource' in stored), 'untouched editor save must not stamp provenance on a legacy post');
});

test('invalid manual lists refuse the save with a named 400 and write nothing', async () => {
  const existing = POST('victim', { tags: [], related: [relEntry('beta')], relatedSource: 'auto' });
  seed([existing], [...CANDIDATES, ENTRY('victim', {})]);
  const cases = [
    { related: [{ slug: 'nope' }], pattern: /Unknown related post: "nope"/ },
    { related: [{ slug: 'victim' }], pattern: /cannot list itself/ },
    { related: [{ slug: 'alpha' }, { slug: 'alpha' }], pattern: /Duplicate related post/ },
    { related: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'victim-2', 'victim-3'].map(slug => ({ slug })), pattern: /maximum is 6/ }
  ];
  for (const c of cases) {
    const res = await callSave(savePayload({ slug: 'victim', related: c.related, relatedSource: 'manual' }), SESSION);
    assert.equal(res.code, 400, JSON.stringify(res.body));
    assert.match(res.body.error, c.pattern);
    const stored = await storedPost('victim');
    assert.deepEqual(stored.related, [relEntry('beta')], 'a refused save writes nothing');
    assert.equal(stored.relatedSource, 'auto');
  }
});

// ---------------- blog-batch-save ----------------

test('batch save: payload lists ignored - legacy preserved, new post computed', async () => {
  const { default: handler } = await import('../api/blog-batch-save.js?case=' + (++caseN));
  const legacyList = [relEntry('beta')];
  const legacy = POST('batch-legacy', { tags: ['rope drop'], related: legacyList });
  seed([legacy], [...CANDIDATES, ENTRY('batch-legacy', { tags: ['rope drop'] })]);
  const body = [
    { ...savePayload({ slug: 'batch-legacy', tags: ['rope drop'], related: [{ slug: 'delta' }] }), published: true },
    { ...savePayload({ slug: 'batch-new-post', tags: ['rare-a', 'rope drop'], related: [{ slug: 'delta' }] }), published: false }
  ];
  const req = { method: 'POST', url: '/api/blog-batch-save', headers: { 'x-admin-key': SESSION, 'content-length': '100' }, body, socket: { remoteAddress: '127.0.0.1' } };
  const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler(req, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const storedLegacy = await storedPost('batch-legacy');
  assert.deepEqual(storedLegacy.related, legacyList);
  assert.ok(!('relatedSource' in storedLegacy), 'batch must not stamp provenance on a legacy post');
  const storedNew = await storedPost('batch-new-post');
  assert.equal(storedNew.relatedSource, 'auto');
  assert.deepEqual(storedNew.related.map(r => r.slug), ['alpha', 'beta']);
});

// ---------------- reconcile sweep ----------------

async function callReconcile() {
  const { default: handler } = await import('../api/blog-reconcile.js?case=' + (++caseN));
  const req = { headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } };
  const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler(req, res);
  return res;
}
function postWriteCount(before) {
  let n = 0;
  for (const [k, v] of globalThis.__blobState.blobs) {
    if (!k.startsWith('blog/posts/') || k === 'blog/posts/index') continue;
    if (before.get(k) !== v) n++;
  }
  return n;
}
const corpusEntriesOf = (posts) => posts.map(p => ENTRY(p.slug, {
  title: p.title, park: p.park, category: p.category, tags: p.tags,
  published: p.published, publishedAt: p.publishedAt, heroImage: p.heroImage
}));

test('sweep: zero post writes when every auto list is already current; manual + legacy untouched', async () => {
  const candidatePosts = CANDIDATES.map(c => POST(c.slug, { title: c.title, park: c.park, category: c.category, tags: c.tags, publishedAt: c.publishedAt, heroImage: c.heroImage }));
  const autoPost = POST('sweep-ok', { tags: ['rare-a', 'rope drop'], relatedSource: 'auto' });
  const corpus = corpusEntriesOf([...candidatePosts, autoPost]);
  autoPost.related = computeRelated(autoPost, corpus);
  const manualPost = POST('sweep-manual', { tags: ['rope drop'], related: [relEntry('delta')], relatedSource: 'manual' });
  const legacyPost = POST('sweep-legacy', { tags: ['rope drop'], related: [relEntry('delta')] });
  const posts = [...candidatePosts, autoPost, manualPost, legacyPost];
  seed(posts, corpusEntriesOf(posts));
  const before = new Map(globalThis.__blobState.blobs);
  const res = await callReconcile();
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.verdict, 'ok');
  assert.equal(res.body.relatedSweep.checked, 1, 'only the one auto post is sweep-checked');
  assert.equal(res.body.relatedSweep.changed, 0);
  assert.equal(postWriteCount(before), 0, 'nothing changed -> nothing written');
});

test('sweep: a stale auto list is refreshed and updatedAt is left byte-identical', async () => {
  const candidatePosts = CANDIDATES.map(c => POST(c.slug, { title: c.title, park: c.park, category: c.category, tags: c.tags, publishedAt: c.publishedAt, heroImage: c.heroImage }));
  const stale = POST('sweep-stale', {
    tags: ['rare-a', 'rope drop'], relatedSource: 'auto',
    related: [relEntry('delta')], updatedAt: '2026-01-15T10:00:00.000Z'
  });
  const posts = [...candidatePosts, stale];
  seed(posts, corpusEntriesOf(posts));
  const res = await callReconcile();
  assert.equal(res.body.verdict, 'ok');
  assert.equal(res.body.relatedSweep.changed, 1);
  const stored = await storedPost('sweep-stale');
  assert.deepEqual(stored.related.map(r => r.slug), ['alpha', 'beta']);
  assert.equal(stored.updatedAt, '2026-01-15T10:00:00.000Z', 'a related-only sweep write must not fake freshness');
});

test('sweep: a manual list survives the full reconcile run unchanged', async () => {
  const candidatePosts = CANDIDATES.map(c => POST(c.slug, { title: c.title, park: c.park, category: c.category, tags: c.tags, publishedAt: c.publishedAt, heroImage: c.heroImage }));
  const manualPost = POST('sweep-m2', { tags: ['rare-a', 'rope drop'], related: [relEntry('gamma')], relatedSource: 'manual' });
  const posts = [...candidatePosts, manualPost];
  seed(posts, corpusEntriesOf(posts));
  const before = new Map(globalThis.__blobState.blobs);
  const res = await callReconcile();
  assert.equal(res.body.verdict, 'ok');
  assert.equal(res.body.relatedSweep.checked, 0, 'manual posts are not sweep-checked');
  assert.equal(postWriteCount(before), 0);
  const stored = await storedPost('sweep-m2');
  assert.deepEqual(stored.related, [relEntry('gamma')]);
});

test('sweep: provenance is re-checked at write time - a mid-sweep manual turn is never overwritten', async () => {
  const candidatePosts = CANDIDATES.map(c => POST(c.slug, { title: c.title, park: c.park, category: c.category, tags: c.tags, publishedAt: c.publishedAt, heroImage: c.heroImage }));
  const mid = POST('mid-post', { tags: ['rare-a', 'rope drop'], related: [relEntry('delta')], relatedSource: 'auto' });
  const posts = [...candidatePosts, mid];
  seed(posts, corpusEntriesOf(posts));
  let fetches = 0;
  globalThis.__onFetch = (key) => {
    if (key !== 'blog/posts/mid-post') return;
    fetches++;
    if (fetches === 2) {
      // The candidate build already read the auto version; the
      // sweep's write-time re-read now sees a human freeze.
      const b = globalThis.__blobState.blobs.get(key);
      b.json = { ...b.json, related: [relEntry('gamma')], relatedSource: 'manual' };
    }
  };
  try {
    const res = await callReconcile();
    assert.equal(res.body.verdict, 'ok');
    assert.equal(res.body.relatedSweep.skippedProvenance, 1);
    assert.equal(res.body.relatedSweep.changed, 0);
  } finally {
    globalThis.__onFetch = null;
  }
  const stored = await storedPost('mid-post');
  assert.equal(stored.relatedSource, 'manual');
  assert.deepEqual(stored.related, [relEntry('gamma')], 'the human freeze wins over the sweep');
});

test('sweep: an unpublished target drops out of auto lists at the next sweep', async () => {
  const candidatePosts = CANDIDATES.map(c => POST(c.slug, { title: c.title, park: c.park, category: c.category, tags: c.tags, publishedAt: c.publishedAt, heroImage: c.heroImage }));
  const target = POST('target-u', { tags: ['rope drop'], published: false });
  const holder = POST('holder', {
    tags: ['rope drop'], relatedSource: 'auto',
    related: [{ slug: 'target-u', park: 'dl', title: 'Title target-u', heroImage: 'https://img/target-u.jpg' }, relEntry('gamma')]
  });
  const posts = [...candidatePosts, target, holder];
  seed(posts, corpusEntriesOf(posts));
  const res = await callReconcile();
  assert.equal(res.body.verdict, 'ok');
  const stored = await storedPost('holder');
  assert.ok(!stored.related.some(r => r.slug === 'target-u'), 'unpublished target recomputed out');
  assert.deepEqual(stored.related.map(r => r.slug), ['alpha', 'beta']);
});

test('sweep: posts left with zero inbound links are reported in the status', async () => {
  const manualA = POST('link-a', { tags: [], related: [relEntry('alpha')], relatedSource: 'manual' });
  const manualB = POST('link-b', { tags: [], related: [relEntry('beta')], relatedSource: 'manual' });
  const orphan = POST('orphan-post', { park: 'wdw', category: 'Walt Disney World · Guide', tags: ['zzz-unique'], related: [], relatedSource: 'auto' });
  const posts = [...CANDIDATES.map(c => POST(c.slug, { title: c.title, park: c.park, category: c.category, tags: c.tags, publishedAt: c.publishedAt, heroImage: c.heroImage })), manualA, manualB, orphan];
  seed(posts, corpusEntriesOf(posts));
  const res = await callReconcile();
  assert.equal(res.body.verdict, 'ok');
  assert.ok(res.body.relatedSweep.zeroInbound.includes('orphan-post'), 'orphan flagged: ' + JSON.stringify(res.body.relatedSweep));
});

// ---------------- renderer ----------------

test('renderer: stored list renders with unpublished targets hidden and titles refreshed from the index', async () => {
  const { default: handler } = await import('../api/blog-render-post.js?case=' + (++caseN));
  const rendered = POST('render-post', {
    relatedSource: 'manual',
    related: [
      { slug: 'alpha', park: 'dl', title: 'STALE TITLE', heroImage: 'https://img/stale.jpg' },
      { slug: 'draft-target', park: 'dl', title: 'Draft Target Title', heroImage: '' }
    ]
  });
  seed([rendered], [
    ENTRY('render-post', {}),
    ENTRY('alpha', { title: 'Fresh Alpha Title' }),
    ENTRY('draft-target', { published: false })
  ]);
  const req = { method: 'GET', query: { slug: 'render-post' }, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = {
    code: null, html: null,
    setHeader() {},
    status(c) { this.code = c; return this; },
    send(h) { this.html = h; return this; },
    json(b) { this.body = b; return this; }
  };
  await handler(req, res);
  assert.equal(res.code, 200);
  assert.ok(res.html.includes('Fresh Alpha Title'), 'the target\'s current title is shown');
  assert.ok(!res.html.includes('STALE TITLE'), 'the frozen-in title is not shown');
  assert.ok(!res.html.includes('draft-target'), 'unpublished target is hidden');
  assert.ok(!res.html.includes('Draft Target Title'));
  assert.ok(res.html.includes('related-posts'), 'the related block still renders');
});

// ---------------- drift check ----------------

test('drift: every post-blob writer routes through api/lib/related.js', async () => {
  const apiDir = new URL('../api/', import.meta.url);
  const files = (await readdir(apiDir)).filter(f => f.endsWith('.js'));
  const writers = [];
  const sources = {};
  for (const f of files) {
    const src = await readFile(new URL('../api/' + f, import.meta.url), 'utf8');
    sources[f] = src;
    if (/put\(\s*'blog\/posts\/' \+/.test(src)) writers.push(f);
  }
  assert.deepEqual(writers.sort(), [
    'blog-batch-save.js', 'blog-reconcile.js', 'blog-save.js',
    'blog-schedule.js', 'blog-update-meta.js', 'cron-publish.js'
  ].sort(), 'the post-blob writer set is exactly the adjudicated set');
  for (const f of writers) {
    assert.match(sources[f], /from '\.\/lib\/related\.js'/, f + ' imports the shared related lib');
  }
  assert.match(sources['blog-save.js'], /resolveRelated\(/, 'blog-save resolves');
  assert.match(sources['blog-batch-save.js'], /resolveRelated\(/, 'batch save resolves');
  assert.match(sources['blog-reconcile.js'], /computeRelated\(/, 'the sweep computes');
  for (const f of ['blog-schedule.js', 'blog-update-meta.js', 'cron-publish.js']) {
    assert.match(sources[f], /carryRelatedFields\(/, f + ' carries provenance explicitly');
  }
  assert.ok(!/put\(/.test(sources['blog-admin-post.js']), 'blog-admin-post is a reader - it writes nothing');
});

test('editor statics: snapshot rule, spec status lines, return-to-automatic, response re-render', async () => {
  const client = await readFile(new URL('../admin-client.js', import.meta.url), 'utf8');
  assert.match(client, /picked from shared tags, park and category/, 'auto status line (spec wording)');
  assert.match(client, /Hand-picked/, 'manual status line');
  assert.match(client, /automatic updates are off for this post/, 'manual status line (spec wording)');
  assert.match(client, /filled when you save/, 'new-post status line (spec wording)');
  assert.match(client, /Return to automatic/, 'return-to-automatic link');
  assert.match(client, /relatedLoadedSlugs/, 'rows are snapshotted at load');
  assert.match(client, /sameSlugList\(related\.map/, 'manual is sent only when rows differ from the snapshot');
  assert.match(client, /relatedReturnToAuto/, 'return-to-automatic state exists');
  assert.match(client, /data\.related/, 'rows re-render from the save response');
  assert.match(client, /hidden on the live page/, 'unpublished-target note on manual rows');
  const admin = await readFile(new URL('../api/blog-admin.js', import.meta.url), 'utf8');
  assert.match(admin, /id="related-status"/, 'the status line has a home in the editor markup');
});

// ---------------- backfill script ----------------

test('backfill: dry run writes nothing (no posts, no restore file)', async () => {
  const { runBackfill } = await import('../scripts/blog-related-backfill.mjs');
  const posts = [POST('bf-legacy', { tags: ['rare-a', 'rope drop'], related: [relEntry('delta')] })];
  let writes = 0, restores = 0;
  const result = await runBackfill({
    posts, mode: 'dry', nowIso: '2026-11-09T00:00:00.000Z',
    writePost: async () => { writes++; },
    saveRestoreFile: async () => { restores++; }
  });
  assert.equal(writes, 0);
  assert.equal(restores, 0);
  assert.equal(result.restoreSaved, false);
  assert.match(result.report, /bf-legacy/);
});

test('backfill: write mode saves the restore file BEFORE writing, writes only changed posts, stamps provenance on all of them', async () => {
  const { runBackfill } = await import('../scripts/blog-related-backfill.mjs');
  const posts = [
    POST('bf-legacy', { tags: ['rare-a', 'rope drop'], related: [relEntry('delta')], updatedAt: '2026-01-20T00:00:00.000Z' }),
    POST('bf-keep', { tags: ['rope drop'], related: [relEntry('gamma')] }),
    POST('bf-manual', { tags: [], related: [relEntry('beta')], relatedSource: 'manual' })
  ];
  const order = [];
  const written = new Map();
  const result = await runBackfill({
    posts, keeps: ['bf-keep'], mode: 'write', nowIso: '2026-11-09T00:00:00.000Z',
    saveRestoreFile: async () => { order.push('restore'); },
    writePost: async (slug, post) => { order.push('write:' + slug); written.set(slug, post); }
  });
  assert.equal(order[0], 'restore', 'restore file precedes every write');
  assert.deepEqual([...written.keys()].sort(), ['bf-keep', 'bf-legacy'], 'the already-manual post is not rewritten');
  assert.equal(written.get('bf-legacy').relatedSource, 'auto');
  assert.equal(written.get('bf-legacy').updatedAt, '2026-01-20T00:00:00.000Z', 'updatedAt untouched by the migration');
  assert.equal(written.get('bf-keep').relatedSource, 'manual');
  assert.deepEqual(written.get('bf-keep').related, [relEntry('gamma')], 'keeps hold their existing list');
  assert.deepEqual(result.wrote.sort(), ['bf-keep', 'bf-legacy']);
});

test('backfill: restore file round-trips the original lists exactly', async () => {
  const { planBackfill, buildRestoreFile, applyRestore } = await import('../scripts/blog-related-backfill.mjs');
  const posts = [
    POST('rt-legacy', { tags: ['rare-a', 'rope drop'], related: [relEntry('delta')] }),
    POST('rt-manual', { tags: [], related: [relEntry('beta')], relatedSource: 'manual' }),
    POST('rt-keep', { tags: [], related: [relEntry('gamma')] })
  ];
  const restore = buildRestoreFile(posts, '2026-11-09T00:00:00.000Z');
  const plan = planBackfill(posts, ['rt-keep']);
  const bySlug = new Map(posts.map(p => [p.slug, p]));
  const migrated = plan.entries.map(e => ({ ...bySlug.get(e.slug), related: e.newList, relatedSource: e.newSource }));
  const restored = applyRestore(migrated, restore);
  for (const orig of posts) {
    const back = restored.find(p => p.slug === orig.slug);
    assert.deepEqual(back.related, orig.related, orig.slug + ': list restored');
    assert.equal(back.relatedSource || null, orig.relatedSource || null, orig.slug + ': provenance restored');
  }
});
