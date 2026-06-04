import { put, list } from '@vercel/blob';

// POST /api/blog-schedule
// Body: { slug, scheduledAt } — scheduledAt can be ISO string or null to cancel
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // JWT / token auth
  const authHeader = req.headers['x-admin-key'] || '';
  const expectedToken = process.env.ADMIN_JWT_SECRET || process.env.ADMIN_PASSWORD;
  if (!authHeader || authHeader !== expectedToken) {
    // Try JWT decode if it's a token
    try {
      const jwt = require('jsonwebtoken');
      jwt.verify(authHeader, process.env.ADMIN_JWT_SECRET);
    } catch(e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const { slug, scheduledAt } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  try {
    // Find the post blob
    const { blobs } = await list({ prefix: 'blog/posts/' + slug });
    const postBlob = blobs.find(b => b.pathname === 'blog/posts/' + slug + '.json' || b.pathname.includes(slug));
    if (!postBlob) return res.status(404).json({ error: 'Post not found: ' + slug });

    const r = await fetch(postBlob.url);
    if (!r.ok) return res.status(500).json({ error: 'Failed to fetch post' });
    const post = await r.json();

    // Update scheduledAt
    if (scheduledAt === null || scheduledAt === undefined || scheduledAt === '') {
      delete post.scheduledAt;
    } else {
      post.scheduledAt = scheduledAt;
    }
    post.updatedAt = new Date().toISOString();

    // Save back
    await put('blog/posts/' + slug + '.json', JSON.stringify(post), {
      access: 'public',
      contentType: 'application/json',
      allowOverwrite: true
    });

    // Update index
    await updateIndex(slug, post);

    return res.status(200).json({ success: true, slug, scheduledAt: post.scheduledAt || null });
  } catch(e) {
    console.error('blog-schedule error:', e);
    return res.status(500).json({ error: e.message });
  }
}

async function updateIndex(slug, post) {
  try {
    const { blobs } = await list({ prefix: 'blog/posts/index' });
    const indexBlob = blobs.find(b => b.pathname.includes('index'));
    if (!indexBlob) return;
    const r = await fetch(indexBlob.url);
    if (!r.ok) return;
    let index = await r.json();
    if (!Array.isArray(index)) return;
    const idx = index.findIndex(p => p.slug === slug);
    const entry = {
      slug: post.slug,
      title: post.title,
      park: post.park,
      heroImage: post.heroImage,
      published: post.published,
      scheduledAt: post.scheduledAt || null,
      updatedAt: post.updatedAt,
      publishedAt: post.publishedAt
    };
    if (idx >= 0) { index[idx] = { ...index[idx], ...entry }; }
    else { index.unshift(entry); }
    await put('blog/posts/index.json', JSON.stringify(index), {
      access: 'public',
      contentType: 'application/json',
      allowOverwrite: true
    });
  } catch(e) {
    console.error('updateIndex error:', e);
  }
}
