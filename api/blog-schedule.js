import jwt from 'jsonwebtoken';
import { put } from '@vercel/blob';
import { readBlobJson, updateBlobJson } from './lib/blob.js';

// POST /api/blog-schedule
// Body: { slug, scheduledAt } — scheduledAt can be ISO string or null to cancel
export default async function handler(req, res) {
  // Fix 5: JWT verification FIRST before any data processing
  const sentToken = req.headers['x-admin-key'] || '';
  if (!sentToken) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(sentToken, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const MAX_REQUEST_SIZE = 500 * 1024; // 500KB
    const contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > MAX_REQUEST_SIZE) {
          return res.status(413).json({ error: 'Request too large' });
    }
  
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const { slug, scheduledAt } = body || {};
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'Invalid or missing slug' });

  try {
    const post = await readBlobJson('blog/posts/' + slug, 'blog-schedule', { expected: true });
    if (!post) return res.status(404).json({ error: 'Post not found: ' + slug });

    if (scheduledAt === null || scheduledAt === undefined || scheduledAt === '') {
      delete post.scheduledAt;
    } else {
      post.scheduledAt = scheduledAt;
    }
    post.updatedAt = new Date().toISOString();

    await put('blog/posts/' + slug, JSON.stringify(post), {
      access: 'public',
      allowOverwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    // Index update via the race-safe helper (api/lib/blob.js). Two
    // properties matter here: a failed index read THROWS instead of
    // looking like an empty index (the old code defaulted a failed
    // read to [] and unconditionally wrote it back - one transient
    // fetch failure would have emptied the whole index), and when the
    // entry is absent the mutator changes nothing, so no write occurs.
    await updateBlobJson('blog/posts/index', 'blog-schedule', (entries) => {
      if (!Array.isArray(entries)) return entries;
      const idx = entries.findIndex(p => p.slug === slug);
      if (idx < 0) return entries;
      entries[idx].scheduledAt = post.scheduledAt || null;
      entries[idx].updatedAt = post.updatedAt;
      return entries;
    });

    return res.status(200).json({ success: true, slug, scheduledAt: post.scheduledAt || null });
  } catch(e) {
    console.error('blog-schedule error:', e);
    return res.status(500).json({ error: e.message });
  }
}
