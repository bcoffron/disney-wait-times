import jwt from 'jsonwebtoken';
import { put } from '@vercel/blob';
import { updateBlobJson, computeBodySnippet, readBlobJson } from './lib/blob.js';

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

export default async function handler(req, res) {
  // Fix 5: JWT verification FIRST before any data processing
  const sentToken = req.headers['x-admin-key'] || '';
  if (!sentToken) { console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() }); return res.status(401).json({ error: 'Unauthorized' }); }
  try {
    jwt.verify(sentToken, process.env.JWT_SECRET);
  } catch (err) {
    console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const MAX_REQUEST_SIZE = 500 * 1024; // 500KB
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > MAX_REQUEST_SIZE) {
    return res.status(413).json({ error: 'Request too large' });
  }

  // Fix 1: Rate limiting — 30 saves per IP per hour
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 30, 60 * 60 * 1000)) {
    console.warn('[SECURITY] Rate limit exceeded:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', time: new Date().toISOString() });
    return res.status(429).json({ error: 'Too many requests' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const post = body;
  if (!post || !post.slug) return res.status(400).json({ error: 'slug required' });
  if (!/^[a-z0-9-]+$/.test(post.slug)) return res.status(400).json({ error: 'Invalid slug format' });

  // Slug-creation guards (prevention, PR: slug guard). Post blobs live at
  // blog/posts/<slug> with no file extension, so the shared reader's suffix
  // rule cannot tell a post's own suffixed copies from a different post
  // whose slug extends it by exactly one dash-word: reading the shorter
  // slug would list both families and pick the newest. Two refusals,
  // checked against the index BEFORE any write - a refused save must
  // write nothing:
  //   1. 'index' is reserved: its blob key IS the index key, so a post
  //      with that slug would overwrite the index with a post body
  //      (blog-delete has refused it since PR #35; save never did).
  //   2. A NEW slug that differs from an existing slug by exactly one
  //      dash-word, in either direction. Multi-word differences are
  //      safe: the remainder contains a dash and the suffix rule
  //      rejects it. Updates to an existing slug are exempt.
  // The check is read-first, so two simultaneous creations of a
  // colliding pair could both pass it - the same advisory posture as
  // updateBlobJson, accepted for a single-operator admin.
  if (post.slug === 'index') {
    return res.status(400).json({ error: "Slug 'index' is reserved - it names the blog index itself. Choose another slug." });
  }
  let guardIndex = null;
  try { guardIndex = await readBlobJson('blog/posts/index', 'blog-save.slug-guard', { expected: true }); } catch (e) { guardIndex = null; }
  if (!Array.isArray(guardIndex)) {
    // The guard reads a key that must exist; if it cannot be read, refuse
    // rather than save unchecked (updateBlobJson below would fail the
    // same way). Nothing has been written yet.
    return res.status(500).json({ error: 'Slug check failed - the blog index could not be read. Nothing was saved; try again.' });
  }
  const existingSlugs = guardIndex.map(p => p && p.slug).filter(Boolean);
  if (!existingSlugs.includes(post.slug)) {
    const oneWordDiff = (a, b) => {
      // true when a === b + '-' + a single dash-free word
      if (!a.startsWith(b + '-')) return false;
      const rest = a.slice(b.length + 1);
      return rest.length > 0 && !rest.includes('-');
    };
    const conflict = existingSlugs.find(s => oneWordDiff(post.slug, s) || oneWordDiff(s, post.slug));
    if (conflict) {
      return res.status(400).json({ error: "Cannot save: a post with slug '" + conflict + "' already exists, and '" + post.slug + "' differs from it by a single word. Slugs one word apart cannot be stored separately in this system - choose a more distinct slug." });
    }
  }

  post.updatedAt = new Date().toISOString();

  // Invariant: a published post has a publishedAt. A client publish
  // path has forgotten to stamp it before (one-click publish from
  // Drafts shipped a post with publishedAt: null, which sorted
  // dateless to the bottom of every publishedAt-ordered list), so
  // the invariant is enforced here - upstream of both the blob
  // write and the index entry below, which each read
  // post.publishedAt. An existing publishedAt is never overwritten,
  // and drafts are never stamped.
  if (post.published === true && !post.publishedAt) {
    post.publishedAt = new Date().toISOString();
  }

  if (post.body && typeof post.body === 'string') {
    post.body = post.body.replace(/<img([^>]*?)>/gi, function(match, attrs) {
      attrs = attrs.replace(/\s*(width|height|style)=["'][^"']*["']/gi, '');
      return '<img' + attrs + '>';
    });
  }

  try {
    await put('blog/posts/' + post.slug, JSON.stringify(post), { access: 'public', allowOverwrite: true });

    // Index upsert via the race-safe helper (api/lib/blob.js): if the
    // index changed since the read, the upsert is re-applied to the
    // fresh state instead of discarding the competing change.
    await updateBlobJson('blog/posts/index', 'blog-save', (entries) => {
      const currentIndex = Array.isArray(entries) ? entries : [];
      const existingEntry = currentIndex.find(p => p.slug === post.slug);
      const meta = {
        slug: post.slug, title: post.title, park: post.park,
        category: post.category, tagLabel: post.tagLabel,
        heroImage: post.heroImage, heroAlt: post.heroAlt,
        intro: post.intro, readTime: post.readTime,
        publishedAt: existingEntry && existingEntry.publishedAt
          ? existingEntry.publishedAt
          : post.publishedAt, updatedAt: post.updatedAt,
        published: post.published,
        tags: post.tags || [],
        bodySnippet: computeBodySnippet(post.body)
      };
      const idx = currentIndex.findIndex(p => p.slug === post.slug);
      if (idx >= 0) currentIndex[idx] = meta; else currentIndex.push(meta);
      return currentIndex;
    });

    return res.status(200).json({ success: true, slug: post.slug, updatedAt: post.updatedAt });
  } catch (err) {
    // A refused index update (api/lib/blob.js INDEX_CONFLICT) is a
    // distinct, retryable state, not a server error: the post blob
    // above was already written, only the index entry was not
    // updated. Name the state so the operator (and the admin client,
    // which displays error) knows a retry is the remedy instead of
    // guessing at a bare 500.
    if (err && err.code === 'INDEX_CONFLICT') {
      console.error('blog-save: index update refused for "' + post.slug + '":', err.message);
      return res.status(409).json({
        error: 'Index update refused (concurrent write could not be verified). The post file was saved; retry in a moment.',
        code: 'INDEX_CONFLICT',
        retryable: true,
        state: 'blob_written_index_not_updated',
        slug: post.slug
      });
    }
    console.error('blog-save error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
