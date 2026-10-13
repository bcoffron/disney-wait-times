import { put } from '@vercel/blob';
import jwt from 'jsonwebtoken';
import { readBlobJson, updateBlobJson } from './lib/blob.js';

export default async function handler(req, res) {
  // Fix 5: JWT verification FIRST before any data processing
  const token = req.headers['x-admin-key'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch(e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).end();
  const MAX_REQUEST_SIZE = 500 * 1024; // 500KB
    const contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > MAX_REQUEST_SIZE) {
          return res.status(413).json({ error: 'Request too large' });
    }
  
  const { slug, publishedAt, updatedAt } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'Invalid slug format' });

  try {
    const post = await readBlobJson('blog/posts/' + slug, 'blog-update-meta', { expected: true });
    if (!post) return res.status(404).json({ error: 'Post not found' });

    if (publishedAt) post.publishedAt = publishedAt;
    if (updatedAt) post.updatedAt = updatedAt;

    await put('blog/posts/' + slug, JSON.stringify(post), {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    // Index entry update via the race-safe helper (api/lib/blob.js): if
    // the index changed since the read, the update is re-applied to the
    // fresh state instead of discarding the competing change.
    let entryFound = false;
    await updateBlobJson('blog/posts/index', 'blog-update-meta', (entries) => {
      if (!Array.isArray(entries)) return entries;
      const entry = entries.find(p => p.slug === slug);
      entryFound = !!entry;
      if (!entry) return entries;
      if (publishedAt) entry.publishedAt = publishedAt;
      if (updatedAt) entry.updatedAt = updatedAt;
      return entries;
    });
    console.log(entryFound ? 'Index updated successfully' : 'Entry not found in index for slug: ' + slug);

    return res.status(200).json({ success: true, slug, publishedAt, updatedAt });
  } catch(e) {
    console.error('blog-update-meta error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
