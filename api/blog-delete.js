// api/blog-delete.js - POST /api/blog-delete - protected with x-admin-key
const { del, put, list } = require('@vercel/blob');
const rl = {};

async function readBlob(pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 1 });
  const blob = blobs && blobs.find(b => b.pathname === pathname);
  if (!blob) return null;
  const r = await fetch(blob.url);
  if (!r.ok) return null;
  return r.json();
}

module.exports = async (req, res) => {
  const adminKey = (process.env.ADMIN_KEY || '').toLowerCase();
  const sentKey = (req.headers['x-admin-key'] || '').toLowerCase();
  if (!sentKey || sentKey !== adminKey) return res.status(401).json({ error: 'Unauthorized' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
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
    const { blobs } = await list({ prefix: 'blog/posts/' + slug, limit: 1 });
    const postBlob = blobs && blobs.find(b => b.pathname === 'blog/posts/' + slug);
    if (postBlob) await del(postBlob.url);
    let index = (await readBlob('blog/posts/index')) || [];
    index = index.filter(p => p.slug !== slug);
    await put('blog/posts/index', JSON.stringify(index), { access: 'public', allowOverwrite: true });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('blog-delete error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};