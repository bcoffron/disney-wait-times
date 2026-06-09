// api/blog-reindex.js - rebuild index from post blobs
// Fix 3: Accept CRON_SECRET via header (primary) and legacy token via query param (temporary)
import { list, put } from '@vercel/blob';

export default async function handler(req, res) {
  // Fix 3: Accept new header (primary) or legacy URL param (temporary backward-compat)
  const secret = req.headers['x-reindex-secret'] || req.query.token;
  if (secret !== process.env.CRON_SECRET && secret !== 'tpcp-reindex-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const MAX_REQUEST_SIZE = 500 * 1024; // 500KB
    const contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > MAX_REQUEST_SIZE) {
          return res.status(413).json({ error: 'Request too large' });
    }
  
  try {
    let allBlobs = [], cursor;
    do {
      const result = await list({
        prefix: 'blog/posts/',
        cursor,
        limit: 100,
        token: process.env.BLOB_READ_WRITE_TOKEN
      });
      allBlobs = allBlobs.concat(result.blobs || []);
      cursor = result.cursor;
    } while (cursor);

    const byPathname = {};
    for (const blob of allBlobs) {
      if (blob.pathname === 'blog/posts/index') continue;
      if (!blob.pathname.startsWith('blog/posts/')) continue;
      if (!byPathname[blob.pathname] || new Date(blob.uploadedAt) > new Date(byPathname[blob.pathname].uploadedAt)) {
        byPathname[blob.pathname] = blob;
      }
    }

    const index = [];
    const errors = [];
    for (const blob of Object.values(byPathname)) {
      try {
        const r = await fetch(blob.downloadUrl || blob.url, { cache: 'no-store' });
        if (!r.ok) { errors.push(blob.pathname + ': HTTP ' + r.status); continue; }
        const post = await r.json();
        if (!post || !post.slug) { errors.push(blob.pathname + ': no slug'); continue; }
        index.push({
          slug: post.slug,
          title: post.title,
          park: post.park,
          category: post.category,
          tags: post.tags,
          tagLabel: post.tagLabel,
          heroImage: post.heroImage,
          heroAlt: post.heroAlt,
          intro: post.intro,
          readTime: post.readTime,
          publishedAt: post.publishedAt,
          updatedAt: post.updatedAt,
          published: post.published
        });
      } catch(e) {
        errors.push(blob.pathname + ': ' + e.message);
      }
    }

    await put('blog/posts/index', JSON.stringify(index), {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    const targets = [
      'best-restaurants-disney-world',
      'best-restaurants-disneyland',
      'best-snacks-disneyland',
      'disney-world-character-dining-guide',
      'disney-world-dining-plan-worth-it',
      'disney-world-on-site-vs-off-site-hotels'
    ];
    const introCheck = {};
    for (const p of index) {
      if (targets.includes(p.slug)) {
        introCheck[p.slug] = p.intro ? p.intro.slice(0, 80) + '...' : '(MISSING)';
      }
    }
    const missingIntros = index.filter(p => !p.intro).map(p => p.slug);
    const missingTags = index.filter(p => !p.tags || (Array.isArray(p.tags) && p.tags.length === 0)).map(p => p.slug);

    return res.status(200).json({
      success: true,
      count: index.length,
      missingIntros: missingIntros.length,
      missingIntroSlugs: missingIntros,
      missingTags: missingTags.length,
      missingTagSlugs: missingTags,
      targetIntroCheck: introCheck,
      errors: errors.length ? errors : undefined
    });
  } catch (err) {
    console.error('blog-reindex error:', err.message, err.stack);
    return res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
}
