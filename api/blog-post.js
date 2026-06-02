// api/blog-post.js - GET /api/blog-post?slug=... - public, cached
const { list } = require('@vercel/blob');
const rl = {};
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
  rl[ip].count++;
  if (rl[ip].count > 20) return res.status(429).json({ error: 'Rate limit exceeded' });
  const { slug } = req.query;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
  try {
    const { blobs } = await list({ prefix: 'blog/posts/' + slug, limit: 1 });
    if (!blobs || blobs.length === 0) return res.status(404).json({ error: 'Post not found' });
    const blob = blobs.find(b => b.pathname === 'blog/posts/' + slug);
    if (!blob) return res.status(404).json({ error: 'Post not found' });
    const r = await fetch(blob.url);
    if (!r.ok) return res.status(404).json({ error: 'Post not found' });
    const post = await r.json();
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(post);
  } catch (err) {
    console.error('blog-post error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};