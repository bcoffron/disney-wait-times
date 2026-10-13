// api/blog-reindex.js - rebuild the posts index from post blobs.
//
// Reindex Deliverable 2: the rebuild is dry-run by default and the write
// is a separate, gated operation. The old read-and-put-in-one-request
// shape does not survive: a GET (or a POST without the commit action)
// returns the candidate index and writes NOTHING.
//
// Correctness rules (the brief):
// - Group by CONTENT slug, never pathname: every blob under blog/posts/
//   is fetched, keyed on its post.slug, and the newest post wins (the
//   post's own updatedAt, tie-break blob uploadedAt). Pathname grouping
//   is what turned one post's eight blobs into eight index entries.
// - Entries carry blog-save's full shape, with bodySnippet from the
//   shared computeBodySnippet - same code as the save path, so a rebuild
//   cannot strip snippets or scheduledAt the way the old rebuild did.
// - Post blobs are authoritative for published state.
//
// Commit gate: POST { action: 'commit', confirm: 'COMMIT-REINDEX',
// expectedSha256 } rebuilds the candidate and writes it ONLY if its
// SHA-256 matches the reviewed dry run's hash - if the store changed
// since the review, the commit refuses and a fresh dry run is required.
// Before writing, the current index is backed up to
// blog/index-backups/<timestamp>-pre-reindex and verified (the D1
// mechanism), so the write is recoverable even outside the reviewed
// backup.
//
// Auth: the cron secret header (server callers) OR a JWT admin token
// (admin-session callers - the dry run and commit are operated by a
// human through the admin session; the commit additionally requires
// the confirm string and the reviewed hash).
import { list, put } from '@vercel/blob';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { matchesKey, readBlobText, computeBodySnippet } from './lib/blob.js';

const INDEX_KEY = 'blog/posts/index';
const BACKUP_PREFIX = 'blog/index-backups/';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function authorized(req) {
  const secret = req.headers['x-reindex-secret'];
  if (process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  const token = req.headers['x-admin-key'] || '';
  if (!token) return false;
  try { jwt.verify(token, process.env.JWT_SECRET); return true; } catch (e) { return false; }
}

async function buildCandidate() {
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

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const MAX_REQUEST_SIZE = 500 * 1024;
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > MAX_REQUEST_SIZE) return res.status(413).json({ error: 'Request too large' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const isCommit = req.method === 'POST' && body && body.action === 'commit';

  try {
    const { index, errors } = await buildCandidate();
    const candidateText = JSON.stringify(index);
    const candidateSha = sha256(candidateText);

    if (!isCommit) {
      // Dry run: the candidate is returned for review and written nowhere.
      return res.status(200).json({
        success: true,
        dryRun: true,
        count: index.length,
        sha256: candidateSha,
        slugs: index.map(p => p.slug),
        candidate: index,
        errors: errors.length ? errors : undefined
      });
    }

    // Commit gate: explicit action, explicit confirm, and the candidate
    // must hash to the reviewed dry run's hash.
    if (body.confirm !== 'COMMIT-REINDEX') {
      return res.status(400).json({ error: 'confirm must be COMMIT-REINDEX' });
    }
    if (!body.expectedSha256 || body.expectedSha256 !== candidateSha) {
      return res.status(409).json({
        error: 'Candidate changed since the reviewed dry run - re-run the dry run and review the new candidate before committing.',
        sha256: candidateSha
      });
    }

    // Safety copy of the CURRENT index before the write (D1 mechanism),
    // verified before proceeding.
    const currentText = await readBlobText(INDEX_KEY, 'blog-reindex', { expected: true });
    if (currentText === null) return res.status(500).json({ error: 'Current index could not be read for the pre-commit backup' });
    const backupKey = BACKUP_PREFIX + new Date().toISOString().replace(/[:.]/g, '-') + '-pre-reindex';
    await put(backupKey, currentText, {
      access: 'public', allowOverwrite: false, addRandomSuffix: false,
      contentType: 'application/json', token: process.env.BLOB_READ_WRITE_TOKEN
    });
    const backupVerify = await readBlobText(backupKey, 'blog-reindex', { expected: true });
    if (backupVerify === null || sha256(backupVerify) !== sha256(currentText)) {
      console.error('[SECURITY] blog-reindex: pre-commit backup verification FAILED (' + backupKey + ') - commit aborted.');
      return res.status(500).json({ error: 'Pre-commit backup verification failed - commit aborted', backupKey });
    }

    await put(INDEX_KEY, candidateText, {
      access: 'public', allowOverwrite: true, addRandomSuffix: false,
      contentType: 'application/json', token: process.env.BLOB_READ_WRITE_TOKEN
    });
    const verify = await readBlobText(INDEX_KEY, 'blog-reindex', { expected: true });
    if (verify === null || sha256(verify) !== candidateSha) {
      console.error('[SECURITY] blog-reindex: post-commit verification FAILED - restore from ' + backupKey);
      return res.status(500).json({ error: 'Post-commit verification failed - restore from the pre-commit backup', backupKey });
    }
    console.log('[blog-reindex] committed rebuilt index: ' + index.length + ' entries, sha256 ' + candidateSha + ', pre-commit backup ' + backupKey);
    return res.status(200).json({ success: true, committed: true, count: index.length, sha256: candidateSha, backupKey });
  } catch (err) {
    console.error('blog-reindex error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
