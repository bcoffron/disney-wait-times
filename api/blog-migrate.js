// api/blog-migrate.js - POST /api/blog-migrate - protected, one-time use
// After migration is confirmed complete, returns 410 Gone
const { put, get } = require('@vercel/blob');
const rl = {};

module.exports = async (req, res) => {
  // Auth check FIRST — no exceptions
  const adminKey = (process.env.ADMIN_KEY || '').toLowerCase();
  const sentKey = (req.headers['x-admin-key'] || '').toLowerCase();
  if (!sentKey || sentKey !== adminKey) return res.status(401).json({ error: 'Unauthorized' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Rate limit 20/min/IP
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
  rl[ip].count++;
  if (rl[ip].count > 20) return res.status(429).json({ error: 'Rate limit exceeded' });
  // One-time use: check migration lock
  try {
    const lockBlob = await get('blog:migrate:lock');
    if (lockBlob) {
      const lockText = await lockBlob.text();
      if (lockText === 'done') {
        return res.status(410).json({ error: 'Gone: migration already completed' });
      }
    }
  } catch(e) { /* lock not found = ok */ }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); } }
  const posts = Array.isArray(body) ? body : (body && Array.isArray(body.posts) ? body.posts : null);
  if (!posts) return res.status(400).json({ error: 'Body must be an array of post objects' });
  const results = { saved: [], failed: [] };
  let index = [];
  // Load existing index
  try {
    const idxBlob = await get('blog:posts:index');
    if (idxBlob) { const t = await idxBlob.text(); index = JSON.parse(t); }
  } catch(e) { index = []; }
  for (const post of posts) {
    if (!post.slug) { results.failed.push({ slug: '?', error: 'missing slug' }); continue; }
    if (!/^[a-z0-9-]+$/.test(post.slug)) { results.failed.push({ slug: post.slug, error: 'invalid slug' }); continue; }
    try {
      const postData = { ...post, updatedAt: post.updatedAt || new Date().toISOString() };
      await put('blog:posts:' + post.slug, JSON.stringify(postData), { access: 'public', allowOverwrite: true });
      const meta = { slug: post.slug, title: post.title, park: post.park, category: post.category, tagLabel: post.tagLabel, heroImage: post.heroImage, heroAlt: post.heroAlt, intro: post.intro, readTime: post.readTime, publishedAt: post.publishedAt, updatedAt: postData.updatedAt, published: post.published };
      const idx = index.findIndex(p => p.slug === post.slug);
      if (idx >= 0) index[idx] = meta; else index.push(meta);
      results.saved.push(post.slug);
    } catch(err) {
      results.failed.push({ slug: post.slug, error: err.message });
    }
  }
  // Save updated index
  await put('blog:posts:index', JSON.stringify(index), { access: 'public', allowOverwrite: true });
  // Set migration lock if all saved
  if (results.failed.length === 0) {
    await put('blog:migrate:lock', 'done', { access: 'public', allowOverwrite: true });
  }
  return res.status(200).json({ success: true, saved: results.saved.length, failed: results.failed.length, details: results });
};