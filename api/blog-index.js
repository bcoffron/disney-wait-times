// api/blog-index.js - GET /api/blog-index - public, cached
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
  try {
    const { blobs } = await list({ prefix: 'blog/posts/index', limit: 1 });
    if (!blobs || blobs.length === 0) {
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json([]);
    }
    const blob = blobs.find(b => b.pathname === 'blog/posts/index');
    if (!blob) {
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json([]);
    }
    const r = await fetch(blob.url);
    if (!r.ok) {
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json([]);
    }
    const index = await r.json();
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(index);
  } catch (err) {
    console.error('blog-index error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};