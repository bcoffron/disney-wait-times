import { put } from '@vercel/blob';
import { readBlobJson, updateBlobJson } from './lib/blob.js';

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
  // Stamps for the posts this run flips, mirrored into the index at the
  // end via the race-safe helper (the in-memory index read at the start
  // of the run is stale by then - the run is the longest read-to-write
  // span of any index writer).
  const publishMap = new Map();

  try {
    // Read the index
    const index = await readBlobJson('blog/posts/index', 'cron-publish', { expected: true });
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
        const post = await readBlobJson('blog/posts/' + meta.slug, 'cron-publish', { expected: true });
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

        // Record the flip for the end-of-run index update
        publishMap.set(post.slug, { publishedAt: post.publishedAt, updatedAt: post.updatedAt });

        published++;
        console.log('[cron-publish] Published: ' + post.slug);
      } catch(e) {
        errors.push('Error publishing ' + meta.slug + ': ' + e.message);
        console.error('[cron-publish] Error:', meta.slug, e.message);
      }
    }

    // Save updated index via the race-safe helper (api/lib/blob.js): the
    // flips are applied to the freshest index state at write time, so a
    // save that landed during this run is merged, never discarded. If
    // the write still fails after retries, the flipped post blobs are
    // live without index entries - log the exact slugs so the reindex
    // lane can reconcile them, then let the error surface.
    if (published > 0) {
      try {
        await updateBlobJson('blog/posts/index', 'cron-publish', (entries) => {
          if (!Array.isArray(entries)) return entries;
          for (const [slug, stamps] of publishMap) {
            const entry = entries.find(p => p.slug === slug);
            if (entry) {
              entry.published = true;
              delete entry.scheduledAt;
              entry.publishedAt = stamps.publishedAt;
              entry.updatedAt = stamps.updatedAt;
            }
          }
          entries.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
          return entries;
        });
      } catch (e) {
        console.error('[cron-publish] [SECURITY] index write failed after publishing; post blobs live without index updates for slugs: ' + [...publishMap.keys()].join(', ') + ' - ' + e.message);
        throw e;
      }
    }
    // The reindex trigger is DISCONNECTED (reindex Deliverable 2): the
    // rebuild's write path is a reviewed, human-gated operation and an
    // unattended caller must not be able to reach it. Reconnect only
    // once the rebuild is proven, as a dry-run report - never as a
    // commit. (Previously this fetched /api/blog-reindex after
    // publishing, when that endpoint still wrote in the same request.)

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

