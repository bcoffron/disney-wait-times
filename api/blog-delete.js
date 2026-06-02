// api/blog-delete.js - POST /api/blog-delete - protected with x-admin-key
const { del, get, put } = require('@vercel/blob');
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
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); } }
  const { slug } = body || {};
  if (!slug) return res.status(400).json({ error: 'slug required' });
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'Invalid slug format' });
  try {
    // Delete post blob
    const postBlob = await get('blog:posts:' + slug);
    if (postBlob) await del(postBlob.url);
    // Remove from index
    let index = [];
    try {
      const idxBlob = await get('blog:posts:index');
      if (idxBlob) { const t = await idxBlob.text(); index = JSON.parse(t); }
    } catch(e) { index = []; }
    index = index.filter(p => p.slug !== slug);
    await put('blog:posts:index', JSON.stringify(index), { access: 'public', allowOverwrite: true });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('blog-delete error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};