// api/blog-post.js - GET /api/blog-post?slug=... - public, cached
const { get } = require('@vercel/blob');
// Rate limit: 20 req/min/IP
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
  const { slug } = req.query;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
  try {
    const blob = await get('blog:posts:' + slug);
    if (!blob) return res.status(404).json({ error: 'Post not found' });
    const text = await blob.text();
    const post = JSON.parse(text);
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(post);
  } catch (err) {
    if (err.status === 404 || (err.message && err.message.includes('not found'))) {
      return res.status(404).json({ error: 'Post not found' });
    }
    console.error('blog-post error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};