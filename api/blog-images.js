import jwt from 'jsonwebtoken';
import { list, del } from '@vercel/blob';

const rl = {};

async function readPostBlob(pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
  const matches = (blobs || []).filter(function(b) { return b.pathname === pathname; })
    .sort(function(a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
  if (!matches.length) return null;
  const r = await fetch(matches[0].downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
      return r.text().then(function(t) { return JSON.parse(t); });
}

function stripQuery(url) {
  try { return url.split('?')[0]; } catch (e) { return url; }
}

async function buildUsageMap() {
  const usageMap = new Map();
  let allPosts;
  try {
    allPosts = await readPostBlob('blog/posts/index');
  } catch (e) {
    allPosts = null;
  }
      console.log('[blog-images] index:', Array.isArray(allPosts) ? allPosts.length : 'null');
  if (!Array.isArray(allPosts) || !allPosts.length) return usageMap;

  const postBodies = await Promise.all(
    allPosts.map(function(p) {
      return readPostBlob('blog/posts/' + p.slug).catch(function() { return null; });
    })
  );
      console.log('[blog-images] bodies:', postBodies.filter(Boolean).length, '/', postBodies.length);

  postBodies.forEach(function(post) {
    if (!post) return;
    const entry = { slug: post.slug, published: !!post.published, title: post.title || post.slug };

    if (post.heroImage) {
      const clean = stripQuery(post.heroImage);
      if (!usageMap.has(clean)) usageMap.set(clean, []);
      usageMap.get(clean).push(entry);
    }

    if (post.body) {
      const re = /https:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp|gif)[^"'\s]*/gi;
      let m;
      while ((m = re.exec(post.body)) !== null) {
        const clean = stripQuery(m[0]);
        if (!usageMap.has(clean)) usageMap.set(clean, []);
        if (!usageMap.get(clean).find(function(e) { return e.slug === post.slug; })) {
          usageMap.get(clean).push(entry);
        }
      }
    }
  });

      console.log('[blog-images] usageMap size:', usageMap.size);
  return usageMap;
}

export default async function handler(req, res) {
  const sentToken = req.headers['x-admin-key'] || '';
  try {
    jwt.verify(sentToken, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
  rl[ip].count++;
  if (rl[ip].count > 60) return res.status(429).json({ error: 'Rate limit exceeded' });

  if (req.method === 'GET') {
    try {
      const { blobs } = await list({ prefix: 'blog-images/', limit: 500 });
      let images = blobs.map(function(b) {
        return {
          url: b.url,
          filename: b.pathname.replace('blog-images/', ''),
          uploadedAt: b.uploadedAt
        };
      });
      images.sort(function(a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });

      const usageMap = await buildUsageMap();

      images = images.map(function(img) {
        const clean = stripQuery(img.url);
        return Object.assign({}, img, {
          usedBy: usageMap.get(clean) || usageMap.get(img.url) || []
        });
      });

      return res.status(200).json(images);
    } catch (err) {
      console.error('blog-images GET error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'DELETE') {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    const cleanTarget = stripQuery(url);

    try {
      let allPosts;
      try {
        allPosts = await readPostBlob('blog/posts/index');
      } catch (e) {
        allPosts = null;
      }
      if (Array.isArray(allPosts) && allPosts.length) {
        for (const p of allPosts) {
          let post;
          try {
            post = await readPostBlob('blog/posts/' + p.slug);
          } catch (e) {
            continue;
          }
          if (!post) continue;
          const heroMatch = post.heroImage && stripQuery(post.heroImage) === cleanTarget;
          const bodyMatch = post.body && post.body.includes(cleanTarget);
          if (heroMatch || bodyMatch) {
            return res.status(409).json({
              error: 'Image is still in use by "' + (post.title || post.slug) + '" (' + (post.published ? 'published' : 'draft') + '). Remove it from the post before deleting.'
            });
          }
        }
      }
    } catch (guardErr) {
      console.error('blog-images DELETE guard error:', guardErr);
      return res.status(500).json({ error: 'Internal server error' });
    }

    try {
      await del(url);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('blog-images DELETE error:', err);
      return res.status(500).json({ error: 'Delete failed: ' + err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
