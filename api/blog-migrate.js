// api/blog-migrate.js - POST /api/blog-migrate - protected, one-time use
// GET /api/blog-migrate?action=rebuild-index - rebuild index from blob store
const { put, list } = require('@vercel/blob');
const rl = {};

async function readBlob(pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 10 });
  // Sort by uploadedAt desc to get most recent, and match exact pathname
  const matches = (blobs || []).filter(b => b.pathname === pathname).sort((a,b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) return null;
  const r = await fetch(matches[0].url);
  if (!r.ok) return null;
  return r.json();
}

module.exports = async (req, res) => {
  const adminKey = (process.env.ADMIN_KEY || '').toLowerCase();
  const sentKey = (req.headers['x-admin-key'] || '').toLowerCase();
  if (!sentKey || sentKey !== adminKey) return res.status(401).json({ error: 'Unauthorized' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Rebuild index from all blog/posts/ blobs
  if (req.method === 'GET' && req.query.action === 'rebuild-index') {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const now = Date.now();
    if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
    rl[ip].count++;
    if (rl[ip].count > 20) return res.status(429).json({ error: 'Rate limit exceeded' });
    try {
      // List all blog/posts/ blobs, paginated
      let allBlobs = [], cursor;
      do {
        const result = await list({ prefix: 'blog/posts/', cursor, limit: 100 });
        allBlobs = allBlobs.concat(result.blobs);
        cursor = result.cursor;
      } while (cursor);
      
      // Deduplicate: keep most recent blob per exact pathname
      const byPathname = {};
      for (const blob of allBlobs) {
        if (blob.pathname === 'blog/posts/index') continue;
        if (blob.pathname.startsWith('blog/posts/') && blob.pathname !== 'blog/posts/index') {
          if (!byPathname[blob.pathname] || new Date(blob.uploadedAt) > new Date(byPathname[blob.pathname].uploadedAt)) {
            byPathname[blob.pathname] = blob;
          }
        }
      }
      
      const index = [];
      for (const blob of Object.values(byPathname)) {
        try {
          const r = await fetch(blob.url);
          if (!r.ok) continue;
          const post = await r.json();
          if (!post || !post.slug) continue;
          index.push({ slug: post.slug, title: post.title, park: post.park, category: post.category, tagLabel: post.tagLabel, heroImage: post.heroImage, heroAlt: post.heroAlt, intro: post.intro, readTime: post.readTime, publishedAt: post.publishedAt, updatedAt: post.updatedAt, published: post.published });
        } catch(e) { /* skip */ }
      }
      
      await put('blog/posts/index', JSON.stringify(index), { access: 'public', allowOverwrite: true });
      return res.status(200).json({ success: true, count: index.length, slugs: index.map(p => p.slug).sort() });
    } catch(err) {
      console.error('rebuild-index error:', err.message);
      return res.status(500).json({ error: 'Internal server error: ' + err.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
  rl[ip].count++;
  if (rl[ip].count > 20) return res.status(429).json({ error: 'Rate limit exceeded' });
  // One-time use lock check
  try {
    const lock = await readBlob('blog/migrate/lock');
    if (lock && lock.done) return res.status(410).json({ error: 'Gone: migration already completed' });
  } catch(e) { /* no lock = ok */ }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); } }
  const posts = Array.isArray(body) ? body : (body && Array.isArray(body.posts) ? body.posts : null);
  if (!posts) return res.status(400).json({ error: 'Body must be an array of post objects' });
  const results = { saved: [], failed: [] };
  let index = (await readBlob('blog/posts/index')) || [];
  for (const post of posts) {
    if (!post.slug || !/^[a-z0-9-]+$/.test(post.slug)) {
      results.failed.push({ slug: post.slug || '?', error: 'invalid slug' }); continue;
    }
    try {
      const postData = { ...post, updatedAt: post.updatedAt || new Date().toISOString() };
      await put('blog/posts/' + post.slug, JSON.stringify(postData), { access: 'public', allowOverwrite: true });
      const meta = { slug: post.slug, title: post.title, park: post.park, category: post.category, tagLabel: post.tagLabel, heroImage: post.heroImage, heroAlt: post.heroAlt, intro: post.intro, readTime: post.readTime, publishedAt: post.publishedAt, updatedAt: postData.updatedAt, published: post.published };
      const idx = index.findIndex(p => p.slug === post.slug);
      if (idx >= 0) index[idx] = meta; else index.push(meta);
      results.saved.push(post.slug);
    } catch(err) {
      results.failed.push({ slug: post.slug, error: err.message });
    }
  }
  await put('blog/posts/index', JSON.stringify(index), { access: 'public', allowOverwrite: true });
  return res.status(200).json({ success: true, saved: results.saved.length, failed: results.failed.length, details: results });
};