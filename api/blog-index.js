// api/blog-index.js - GET /api/blog-index - public, cached
const { get } = require('@vercel/blob');
const rl = {};
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // Rate limit 20/min/IP
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
  rl[ip].count++;
  if (rl[ip].count > 20) return res.status(429).json({ error: 'Rate limit exceeded' });
  try {
    const blob = await get('blog:posts:index');
    if (!blob) {
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json([]);
    }
    const text = await blob.text();
    const index = JSON.parse(text);
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(index);
  } catch (err) {
    if (err.status === 404 || (err.message && err.message.includes('not found'))) {
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json([]);
    }
    console.error('blog-index error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};