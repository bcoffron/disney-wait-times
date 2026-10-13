// api/blog-migrate.js - POST /api/blog-migrate - protected, one-time use
// GET /api/blog-migrate?action=rebuild-index - rebuild index from blob store
import { put, list } from '@vercel/blob';
const rl = {};

async function readBlob(pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 10 });
  // Sort by uploadedAt desc to get most recent, and match exact pathname
  const matches = (blobs || []).filter(b => b.pathname === pathname).sort((a,b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) return null;
  const r = await fetch(matches[0].url);
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  const sentToken = req.headers['x-admin-key'] || '';
  try {
    require('jsonwebtoken').verify(sentToken, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // The rebuild-index action was RETIRED (reindex Deliverable 2):
  // blog-reindex is the only rebuild producer - one producer, one code
  // path. This endpoint keeps only its one-time migrate POST below.

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
  rl[ip].count++;
  if (rl[ip].count > 20) return res.status(429).json({ error: 'Rate limit exceeded' });
  // One-time use lock check
  try {
    const lock = await readBlob('blog/migrate/lock');
    if (lock && lock.done) return res.status(410).json({ error: 'Gone: migration already completed' });
  } catch(e) { /* no lock = ok */ }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); } }
  const posts = Array.isArray(body) ? body : (body && Array.isArray(body.posts) ? body.posts : null);
  if (!posts) return res.status(400).json({ error: 'Body must be an array of post objects' });
  const results = { saved: [], failed: [] };
  let index = (await readBlob('blog/posts/index')) || [];
  for (const post of posts) {
    if (!post.slug || !/^[a-z0-9-]+$/.test(post.slug)) {
      results.failed.push({ slug: post.slug || '?', error: 'invalid slug' }); continue;
    }
    try {
      const postData = { ...post, updatedAt: post.updatedAt || new Date().toISOString() };
      await put('blog/posts/' + post.slug, JSON.stringify(postData), { access: 'public', allowOverwrite: true });
      const meta = { slug: post.slug, title: post.title, park: post.park, category: post.category, tagLabel: post.tagLabel, heroImage: post.heroImage, heroAlt: post.heroAlt, intro: post.intro, readTime: post.readTime, publishedAt: post.publishedAt, updatedAt: postData.updatedAt, published: post.published };
      const idx = index.findIndex(p => p.slug === post.slug);
      if (idx >= 0) index[idx] = meta; else index.push(meta);
      results.saved.push(post.slug);
    } catch(err) {
      results.failed.push({ slug: post.slug, error: err.message });
    }
  }
  await put('blog/posts/index', JSON.stringify(index), { access: 'public', allowOverwrite: true });
  return res.status(200).json({ success: true, saved: results.saved.length, failed: results.failed.length, details: results });
};