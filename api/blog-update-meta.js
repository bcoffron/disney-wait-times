import { put, list } from '@vercel/blob';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const token = req.headers['x-admin-key'];
    jwt.verify(token, process.env.JWT_SECRET);
  } catch(e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { slug, publishedAt, updatedAt } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'Invalid slug format' });

  try {
    const { blobs } = await list({ prefix: 'blog/posts/' + slug, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
    const matches = (blobs || []).filter(b => b.pathname === 'blog/posts/' + slug)
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    if (!matches.length) return res.status(404).json({ error: 'Post not found' });

    const postRes = await fetch(matches[0].downloadUrl + '?t=' + Date.now(), { cache: 'no-store' });
    if (!postRes.ok) return res.status(500).json({ error: 'Failed to fetch post' });
    const post = await postRes.json();

    if (publishedAt) post.publishedAt = publishedAt;
    if (updatedAt) post.updatedAt = updatedAt;

    await put('blog/posts/' + slug, JSON.stringify(post), {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    console.log('Fetching index...');
    const { blobs: indexBlobs } = await list({ prefix: 'blog/posts/index', limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
    const indexMatches = (indexBlobs || []).filter(b => b.pathname === 'blog/posts/index')
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    console.log('Index blobs found:', indexMatches.length);
    if (indexMatches.length) {
      const indexRes = await fetch(indexMatches[0].downloadUrl + '?t=' + Date.now(), { cache: 'no-store' });
      if (indexRes.ok) {
        const index = await indexRes.json();
        console.log('Index entries:', index.length);
        const entry = index.find(p => p.slug === slug);
        console.log('Found entry:', !!entry);
        if (entry) {
          if (publishedAt) entry.publishedAt = publishedAt;
          if (updatedAt) entry.updatedAt = updatedAt;
          await put('blog/posts/index', JSON.stringify(index), {
            access: 'public',
            allowOverwrite: true,
            contentType: 'application/json',
            token: process.env.BLOB_READ_WRITE_TOKEN
          });
          console.log('Index updated successfully');
        } else {
          console.log('Entry not found in index for slug:', slug);
        }
      } else {
        console.log('Index fetch failed:', indexRes.status);
      }
    } else {
      console.log('No index blob found');
    }

    return res.status(200).json({ success: true, slug, publishedAt, updatedAt });
  } catch(e) {
    console.error('blog-update-meta error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
