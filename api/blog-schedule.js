import jwt from 'jsonwebtoken';
import { put, list } from '@vercel/blob';

async function readBlob(pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
  const matches = (blobs || []).filter(b => b.pathname === pathname)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) return null;
  const r = await fetch(matches[0].downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.text().then(t => JSON.parse(t));
}

// POST /api/blog-schedule
// Body: { slug, scheduledAt } — scheduledAt can be ISO string or null to cancel
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sentToken = req.headers['x-admin-key'] || '';
  try {
    jwt.verify(sentToken, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const { slug, scheduledAt } = body || {};
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'Invalid or missing slug' });

  try {
    const post = await readBlob('blog/posts/' + slug);
    if (!post) return res.status(404).json({ error: 'Post not found: ' + slug });

    // Update scheduledAt
    if (scheduledAt === null || scheduledAt === undefined || scheduledAt === '') {
      delete post.scheduledAt;
    } else {
      post.scheduledAt = scheduledAt;
    }
    post.updatedAt = new Date().toISOString();

    // Save post blob back
    await put('blog/posts/' + slug, JSON.stringify(post), {
      access: 'public',
      allowOverwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    // Update index with scheduledAt
    let index = (await readBlob('blog/posts/index')) || [];
    const idx = index.findIndex(p => p.slug === slug);
    if (idx >= 0) {
      index[idx].scheduledAt = post.scheduledAt || null;
      index[idx].updatedAt = post.updatedAt;
    }
    await put('blog/posts/index', JSON.stringify(index), {
      access: 'public',
      allowOverwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    return res.status(200).json({ success: true, slug, scheduledAt: post.scheduledAt || null });
  } catch(e) {
    console.error('blog-schedule error:', e);
    return res.status(500).json({ error: e.message });
  }
}
