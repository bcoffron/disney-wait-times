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
//
// The candidate builder lives in api/lib/reindex-candidate.js, shared
// with api/blog-reconcile.js (the daily detect-and-alert check) so the
// checker runs the same code the repair runs.
import { put } from '@vercel/blob';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { readBlobText } from './lib/blob.js';
import { buildCandidate } from './lib/reindex-candidate.js';

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

    // Post-write verification MUST tolerate the blob store's
    // visibility lag (measured 30-120s): a read-after-write inside
    // one request is unreliable in this store, so poll with backoff
    // across ~3 minutes before concluding anything. Three outcomes:
    //  - a poll matches the candidate hash: verified success.
    //  - reads show content that is NEITHER the candidate NOR the
    //    pre-write index: a genuinely wrong state - the only case
    //    where restore advice is appropriate.
    //  - the window expires with only pre-write content visible:
    //    INCONCLUSIVE. Lag and a lost write are indistinguishable
    //    here, and the write may well have landed - do NOT advise
    //    restore; the stored bytes must be re-checked directly
    //    after the lag window. (The first production commit hit
    //    exactly this: a perfect write reported as a failure with
    //    restore advice attached.)
    const preWriteSha = sha256(currentText);
    const verifyBudgetMs = parseInt(process.env.BLOG_REINDEX_VERIFY_BUDGET_MS || '170000', 10);
    const verifyStart = Date.now();
    let verifyDelay = 2000, lastSeenSha = null, sawForeign = false;
    while (true) {
      const seen = await readBlobText(INDEX_KEY, 'blog-reindex', { expected: true });
      if (seen !== null) {
        lastSeenSha = sha256(seen);
        if (lastSeenSha === candidateSha) {
          console.log('[blog-reindex] committed rebuilt index: ' + index.length + ' entries, sha256 ' + candidateSha + ', verified after ' + (Date.now() - verifyStart) + 'ms, pre-commit backup ' + backupKey);
          return res.status(200).json({ success: true, committed: true, count: index.length, sha256: candidateSha, backupKey, verifiedAfterMs: Date.now() - verifyStart });
        }
        if (lastSeenSha !== preWriteSha) sawForeign = true;
      }
      if (Date.now() - verifyStart >= verifyBudgetMs) break;
      await new Promise(r => setTimeout(r, verifyDelay));
      verifyDelay = Math.min(Math.round(verifyDelay * 1.6), 20000);
    }
    if (sawForeign) {
      console.error('[SECURITY] blog-reindex: post-commit verification FAILED - stored index matches neither the candidate nor the pre-write state; restore from ' + backupKey);
      return res.status(500).json({ success: false, committed: true, verification: 'failed', error: 'Post-commit verification failed: the stored index matches neither the committed candidate nor the pre-write index. Restore from the pre-commit backup.', backupKey, sha256: candidateSha });
    }
    console.error('[SECURITY] blog-reindex: post-commit verification INCONCLUSIVE after ' + verifyBudgetMs + 'ms (last seen sha ' + lastSeenSha + '); backup for reference: ' + backupKey);
    return res.status(202).json({ success: false, committed: true, verification: 'inconclusive', error: 'The commit was written but is not yet visible to readers (store visibility lag). Do NOT restore. Re-check the stored index bytes directly after the lag window; the pre-commit backup key is provided for reference only.', backupKey, sha256: candidateSha });
  } catch (err) {
    console.error('blog-reindex error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
