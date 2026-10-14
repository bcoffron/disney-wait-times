// api/lib/reindex-candidate.js - build the candidate posts index from
// the post blobs. Shared by blog-reindex (the human-run repair: dry run
// + hash-gated commit) and blog-reconcile (the daily check) so the
// checker runs the SAME code the repair would run - a reimplementation
// would drift and alert on its own divergence.
//
// Rules (from the reindex brief):
// - Group by CONTENT slug, never pathname: every blob under blog/posts/
//   is fetched, keyed on its post.slug, and the newest post wins (the
//   post's own updatedAt, tie-break blob uploadedAt).
// - Entries carry blog-save's full shape, with bodySnippet from the
//   shared computeBodySnippet - same code as the save path.
// - Post blobs are authoritative for published state.
import { list } from '@vercel/blob';
import { matchesKey, computeBodySnippet } from './blob.js';

const INDEX_KEY = 'blog/posts/index';

export async function buildCandidate() {
  let allBlobs = [], cursor;
  do {
    const result = await list({ prefix: 'blog/posts/', cursor, limit: 100, token: process.env.BLOB_READ_WRITE_TOKEN });
    allBlobs = allBlobs.concat(result.blobs || []);
    cursor = result.cursor;
  } while (cursor);

  const bySlug = new Map();
  const errors = [];
  for (const blob of allBlobs) {
    if (matchesKey(blob.pathname, INDEX_KEY)) continue; // the index family is not a post
    try {
      const r = await fetch(blob.downloadUrl || blob.url, { cache: 'no-store' });
      if (!r.ok) { errors.push(blob.pathname + ': HTTP ' + r.status); continue; }
      const post = await r.json();
      if (!post || !post.slug) { errors.push(blob.pathname + ': no slug'); continue; }
      const prev = bySlug.get(post.slug);
      const wins = !prev
        || new Date(post.updatedAt || 0) > new Date(prev.post.updatedAt || 0)
        || (new Date(post.updatedAt || 0).getTime() === new Date(prev.post.updatedAt || 0).getTime()
            && new Date(blob.uploadedAt) > new Date(prev.uploadedAt));
      if (wins) bySlug.set(post.slug, { post, uploadedAt: blob.uploadedAt });
    } catch (e) {
      errors.push(blob.pathname + ': ' + e.message);
    }
  }

  const index = [...bySlug.values()].map(({ post }) => ({
    slug: post.slug,
    title: post.title,
    park: post.park,
    category: post.category,
    tagLabel: post.tagLabel,
    heroImage: post.heroImage,
    heroAlt: post.heroAlt,
    intro: post.intro,
    readTime: post.readTime,
    publishedAt: post.publishedAt,
    updatedAt: post.updatedAt,
    published: post.published,
    scheduledAt: post.scheduledAt || null,
    tags: post.tags || [],
    bodySnippet: computeBodySnippet(post.body)
  }));
  index.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  return { index, errors };
}
