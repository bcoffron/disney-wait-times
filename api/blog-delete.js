import jwt from 'jsonwebtoken';
import { del, put, list } from '@vercel/blob';

const rl = {};

async function readBlob(pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
  const matches = (blobs || []).filter(b => b.pathname === pathname)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) return null;
  const r = await fetch(matches[0].downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.text().then(t => JSON.parse(t));
}

export default async function handler(req, res) {
  const sentToken = req.headers['x-admin-key'] || '';
  try {
    jwt.verify(sentToken, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const { slug } = body || {};
  if (!slug) return res.status(400).json({ error: 'slug required' });

  try {
    const { blobs } = await list({ prefix: 'blog/posts/' + slug, limit: 10 });
    const matches = blobs.filter(b => b.pathname === 'blog/posts/' + slug);
    for (const b of matches) await del(b.url);

    let index = (await readBlob('blog/posts/index')) || [];
    index = index.filter(p => p.slug !== slug);
    await put('blog/posts/index', JSON.stringify(index), { access: 'public', allowOverwrite: true , token: process.env.BLOB_READ_WRITE_TOKEN });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('blog-delete error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
