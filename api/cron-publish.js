import { put, list } from '@vercel/blob';

// api/cron-publish.js â runs every hour, publishes scheduled posts whose time has passed
// Cron schedule: 0 * * * * (top of every hour)
export default async function handler(req, res) {
  // Verify this is a legitimate cron call (Vercel sets Authorization header for cron)
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  let published = 0;
  const errors = [];

  try {
    // Read the index
    const index = await readBlob('blog/posts/index');
    if (!Array.isArray(index)) {
      return res.status(200).json({ message: 'No index found', published: 0 });
    }

    // Find posts that are scheduled and whose time has passed
    const toPublish = index.filter(p =>
      p.published === false &&
      p.scheduledAt &&
      new Date(p.scheduledAt) <= now
    );

    console.log('[cron-publish] Found ' + toPublish.length + ' post(s) to publish at ' + now.toISOString());

    for (const meta of toPublish) {
      try {
        // Fetch the full post
        const post = await readBlob('blog/posts/' + meta.slug);
        if (!post) {
          errors.push('Post not found: ' + meta.slug);
          continue;
        }

        // Publish it
        post.published = true;
        post.publishedAt = new Date().toISOString();
        post.scheduledAt = null;
        post.updatedAt = new Date().toISOString();

        // Save post
        await put('blog/posts/' + post.slug, JSON.stringify(post), {
          access: 'public',
          allowOverwrite: true,
          token: process.env.BLOB_READ_WRITE_TOKEN
        });

        // Update index entry
        const idx = index.findIndex(p => p.slug === post.slug);
        if (idx >= 0) {
          index[idx].published = true;
          delete index[idx].scheduledAt;
          index[idx].publishedAt = post.publishedAt;
          index[idx].updatedAt = post.updatedAt;
        }

        published++;
        console.log('[cron-publish] Published: ' + post.slug);
      } catch(e) {
        errors.push('Error publishing ' + meta.slug + ': ' + e.message);
        console.error('[cron-publish] Error:', meta.slug, e.message);
      }
    }

    // Save updated index
    if (published > 0) {
      index.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));    await put('blog/posts/index', JSON.stringify(index), {
        access: 'public',
        allowOverwrite: true,
        token: process.env.BLOB_READ_WRITE_TOKEN
      });
    }
    if (published > 0) {
      try {
        await fetch('https://disney-wait-times-lupt.vercel.app/api/blog-reindex', {
          headers: { 'x-reindex-secret': process.env.CRON_SECRET }
        });
        console.log('[cron-publish] Reindex triggered');
      } catch(e) {
        console.log('[cron-publish] Reindex failed:', e.message);
      }
    }

    return res.status(200).json({
      success: true,
      published,
      errors,
      checkedAt: now.toISOString()
    });
  } catch(e) {
    console.error('[cron-publish] Fatal error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

async function readBlob(pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
  const matches = (blobs || []).filter(b => b.pathname === pathname)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) return null;
  const r = await fetch(matches[0].downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.text().then(t => JSON.parse(t));
}
