// api/blog-batch-save.js - batch post save for the admin's Batch ZIP
// import: write every post blob first, then update the posts index
// exactly once.
//
// Why this exists (batch/memo track, Oct 14, 2026): the batch import
// used to loop over /api/blog-save, and each save ran its own
// read-modify-write of the index. The blob store's reads lag writes by
// 30-120s, so a save seconds after the previous one could base its
// index update on pre-batch bytes and silently discard the earlier
// posts' entries - fixture-proven: two sequential saves inside the
// window dropped the first entry, both returning 200. Writing all the
// post blobs first (single-key writes never collide) and mutating the
// index once at the end removes the repeated read-modify-write
// entirely - the same shape the one-time blog-migrate importer arrived
// at independently. This is deliberately a separate endpoint rather
// than a skip-the-index flag on blog-save: a flag would sit on the
// single-save path forever, available to any future caller who doesn't
// know why it exists.
//
// Semantics:
// - Auth (JWT) and the PR #49 slug guards mirror blog-save: 'index' is
//   reserved, and a NEW slug may not differ from an existing slug by
//   exactly one dash-word. The guard here ALSO checks within the batch
//   (a colliding pair inside one batch is invisible to per-post checks
//   against the existing index) and refuses later duplicates of a slug.
// - Refusals are PER POST, not per batch: a 20-post import failing
//   wholesale over one bad slug is harsher than the harm. Refused and
//   failed posts are reported individually and excluded from the index
//   update; the index reflects exactly the posts that landed.
// - If the single index update itself conflicts (INDEX_CONFLICT), the
//   response says so (indexUpdated: false) - the post blobs are live,
//   the entries are missing, and the daily reconciliation check will
//   flag it; the operator can re-run the import or the reviewed
//   reindex repair.
import jwt from 'jsonwebtoken';
import { put } from '@vercel/blob';
import { updateBlobJson, computeBodySnippet, readBlobJson } from './lib/blob.js';
import { resolvePublishedAt } from './lib/publish-date.js';

const rateLimit = new Map();

function checkRateLimit(ip, max, windowMs) {
  const now = Date.now();
  if (!rateLimit.has(ip)) {
    rateLimit.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  const record = rateLimit.get(ip);
  if (now > record.resetAt) {
    rateLimit.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (record.count >= max) return false;
  record.count++;
  return true;
}

const oneWordDiff = (a, b) => {
  // true when a === b + '-' + a single dash-free word
  if (!a.startsWith(b + '-')) return false;
  const rest = a.slice(b.length + 1);
  return rest.length > 0 && !rest.includes('-');
};

export default async function handler(req, res) {
  const sentToken = req.headers['x-admin-key'] || '';
  if (!sentToken) { console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() }); return res.status(401).json({ error: 'Unauthorized' }); }
  try {
    jwt.verify(sentToken, process.env.JWT_SECRET);
  } catch (err) {
    console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const MAX_REQUEST_SIZE = 10 * 1024 * 1024; // batches carry many post bodies; per-post cap below mirrors blog-save
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > MAX_REQUEST_SIZE) {
    return res.status(413).json({ error: 'Request too large' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 30, 60 * 60 * 1000)) {
    console.warn('[SECURITY] Rate limit exceeded:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', time: new Date().toISOString() });
    return res.status(429).json({ error: 'Too many requests' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const posts = Array.isArray(body) ? body : (body && Array.isArray(body.posts) ? body.posts : null);
  if (!posts || posts.length === 0) return res.status(400).json({ error: 'Body must be a non-empty array of posts (or { posts: [...] })' });
  if (posts.length > 100) return res.status(400).json({ error: 'Batch too large (max 100 posts)' });

  // The slug guard reads the index once for the whole batch; if it
  // cannot be read, refuse everything rather than save unchecked
  // (blog-save's posture). Nothing has been written yet.
  let guardIndex = null;
  try { guardIndex = await readBlobJson('blog/posts/index', 'blog-batch-save.slug-guard', { expected: true }); } catch (e) { guardIndex = null; }
  if (!Array.isArray(guardIndex)) {
    return res.status(500).json({ error: 'Slug check failed - the blog index could not be read. Nothing was saved; try again.' });
  }
  const existingSlugs = guardIndex.map(p => p && p.slug).filter(Boolean);

  const results = [];
  const landed = [];
    const transitionBySlug = new Map(); // slug -> publish transition flag (publish-date rule); kept off the post objects so it never reaches the blob
  const acceptedNewSlugs = [];
  for (const rawPost of posts) {
    const post = rawPost && typeof rawPost === 'object' ? { ...rawPost } : null;
    if (!post || !post.slug) { results.push({ slug: (rawPost && rawPost.slug) || '?', status: 'refused', error: 'slug required' }); continue; }
    if (!/^[a-z0-9-]+$/.test(post.slug)) { results.push({ slug: post.slug, status: 'refused', error: 'Invalid slug format' }); continue; }
    if (JSON.stringify(post).length > 500 * 1024) { results.push({ slug: post.slug, status: 'refused', error: 'Post exceeds the 500KB per-post limit' }); continue; }
    if (post.slug === 'index') { results.push({ slug: post.slug, status: 'refused', error: "Slug 'index' is reserved - it names the blog index itself. Choose another slug." }); continue; }
    if (landed.some(p => p.slug === post.slug) || results.some(r => r.slug === post.slug && r.status !== 'refused')) {
      results.push({ slug: post.slug, status: 'refused', error: 'Duplicate slug within this batch - only the first occurrence is saved.' });
      continue;
    }
    if (!existingSlugs.includes(post.slug)) {
      const conflictExisting = existingSlugs.find(s => oneWordDiff(post.slug, s) || oneWordDiff(s, post.slug));
      if (conflictExisting) {
        results.push({ slug: post.slug, status: 'refused', error: "A post with slug '" + conflictExisting + "' already exists, and '" + post.slug + "' differs from it by a single word. Slugs one word apart cannot be stored separately in this system - choose a more distinct slug." });
        continue;
      }
      const conflictBatch = acceptedNewSlugs.find(s => oneWordDiff(post.slug, s) || oneWordDiff(s, post.slug));
      if (conflictBatch) {
        results.push({ slug: post.slug, status: 'refused', error: "Slug '" + post.slug + "' differs by a single word from '" + conflictBatch + "', another new post in this batch. Slugs one word apart cannot be stored separately in this system - choose a more distinct slug." });
        continue;
      }
    }

    post.updatedAt = new Date().toISOString();
    // Publish-date rule (see api/lib/publish-date.js): batch posts
    // normally land as drafts (no stamp), but if a batch item ever
    // arrives published, the same transition semantics as blog-save
    // apply - the stored blob is the pre-image, and the index update
    // below takes the resolved value on a transition.
    let batchPreImage = null;
    try { batchPreImage = await readBlobJson('blog/posts/' + post.slug, 'blog-batch-save.publish-date', { expected: false }); } catch (e) { batchPreImage = null; }
    const bpd = resolvePublishedAt(batchPreImage, post, post.updatedAt);
    if (bpd.publishedAt) post.publishedAt = bpd.publishedAt;
    transitionBySlug.set(post.slug, bpd.transition);
    if (post.body && typeof post.body === 'string') {
      post.body = post.body.replace(/<img([^>]*?)>/gi, function (match, attrs) {
        attrs = attrs.replace(/\s*(width|height|style)=["'][^"']*["']/gi, '');
        return '<img' + attrs + '>';
      });
    }
    try {
      await put('blog/posts/' + post.slug, JSON.stringify(post), { access: 'public', allowOverwrite: true });
      landed.push(post);
      if (!existingSlugs.includes(post.slug)) acceptedNewSlugs.push(post.slug);
      results.push({ slug: post.slug, status: 'ok' });
    } catch (err) {
      results.push({ slug: post.slug, status: 'failed', error: err.message });
    }
  }

  // One index update for everything that landed.
  let indexUpdated = landed.length === 0;
  let indexError = null;
  if (landed.length > 0) {
    try {
      await updateBlobJson('blog/posts/index', 'blog-batch-save', (entries) => {
        const currentIndex = Array.isArray(entries) ? entries : [];
        for (const post of landed) {
          const existingEntry = currentIndex.find(p => p.slug === post.slug);
          const meta = {
            slug: post.slug, title: post.title, park: post.park,
            category: post.category, tagLabel: post.tagLabel,
            heroImage: post.heroImage, heroAlt: post.heroAlt,
            intro: post.intro, readTime: post.readTime,
            publishedAt: transitionBySlug.get(post.slug)
              ? post.publishedAt
              : (existingEntry && existingEntry.publishedAt
                ? existingEntry.publishedAt
                : post.publishedAt), updatedAt: post.updatedAt,
            published: post.published,
            tags: post.tags || [],
            bodySnippet: computeBodySnippet(post.body)
          };
          const idx = currentIndex.findIndex(p => p.slug === post.slug);
          if (idx >= 0) currentIndex[idx] = meta; else currentIndex.push(meta);
        }
        return currentIndex;
      });
      indexUpdated = true;
    } catch (err) {
      indexError = err.message;
      console.error('blog-batch-save index update failed:', err.message);
    }
  }

  return res.status(200).json({
    success: true,
    saved: landed.map(p => p.slug),
    results,
    indexUpdated,
    indexError: indexError || undefined
  });
}
