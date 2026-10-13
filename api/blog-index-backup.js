// api/blog-index-backup.js - backup and restore for the posts index blob.
//
// Reindex lane, Deliverable 1 (see the security audit brief): the reindex
// will overwrite blog/posts/index in a single write, and reverting code
// cannot restore overwritten bytes - so a verified backup with a tested
// restore path ships BEFORE any rebuild logic exists.
//
// Backups live under blog/index-backups/<timestamp>, OUTSIDE the
// blog/posts/ prefix, so post enumeration (the rebuild's own listing
// included) can never sweep a backup into an index.
//
// Actions (JWT admin auth, x-admin-key):
//   GET                              -> list backups (key, uploadedAt, size)
//   POST { action: 'backup' }        -> copy the current index blob
//                                       byte-for-byte; re-read and verify
//                                       SHA-256 equality before reporting
//   POST { action: 'restore',
//          backupKey, confirm }      -> write the backup back to
//                                       blog/posts/index. confirm must
//                                       equal backupKey exactly. The
//                                       restored index is re-read and
//                                       hash-verified before reporting.
import { list, put } from '@vercel/blob';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { readBlobText } from './lib/blob.js';

const INDEX_KEY = 'blog/posts/index';
const BACKUP_PREFIX = 'blog/index-backups/';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export default async function handler(req, res) {
  const sentToken = req.headers['x-admin-key'] || '';
  if (!sentToken) { console.warn('[SECURITY] Auth failed:', { endpoint: 'blog-index-backup', reason: 'no_token', time: new Date().toISOString() }); return res.status(401).json({ error: 'Unauthorized' }); }
  try {
    jwt.verify(sentToken, process.env.JWT_SECRET);
  } catch (err) {
    console.warn('[SECURITY] Auth failed:', { endpoint: 'blog-index-backup', reason: 'invalid_token', time: new Date().toISOString() });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET') {
      const { blobs } = await list({ prefix: BACKUP_PREFIX, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
      const backups = (blobs || [])
        .map(b => ({ backupKey: b.pathname, uploadedAt: b.uploadedAt, size: b.size }))
        .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      return res.status(200).json({ success: true, backups });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); } }
    const action = body && body.action;

    if (action === 'backup') {
      const text = await readBlobText(INDEX_KEY, 'blog-index-backup', { expected: true });
      if (text === null) return res.status(500).json({ error: 'Index blob could not be read' });
      const backupKey = BACKUP_PREFIX + new Date().toISOString().replace(/[:.]/g, '-');
      // allowOverwrite: false is DELIBERATE here - the inversion of the
      // usual rule. A timestamp collision must fail loudly rather than
      // quietly overwrite an earlier backup. Do not "fix" this to true.
      await put(backupKey, text, {
        access: 'public',
        allowOverwrite: false,
        addRandomSuffix: false,
        contentType: 'application/json',
        token: process.env.BLOB_READ_WRITE_TOKEN
      });
      const verify = await readBlobText(backupKey, 'blog-index-backup', { expected: true });
      if (verify === null || sha256(verify) !== sha256(text)) {
        console.error('[SECURITY] blog-index-backup: backup verification FAILED for ' + backupKey);
        return res.status(500).json({ error: 'Backup verification failed', backupKey });
      }
      return res.status(200).json({ success: true, backupKey, bytes: text.length, sha256: sha256(text) });
    }

    if (action === 'restore') {
      const backupKey = body && body.backupKey;
      if (!backupKey || typeof backupKey !== 'string' || !backupKey.startsWith(BACKUP_PREFIX) || backupKey.includes('..')) {
        return res.status(400).json({ error: 'backupKey must be a blog/index-backups/ key' });
      }
      if (body.confirm !== backupKey) {
        return res.status(400).json({ error: 'confirm must equal backupKey exactly' });
      }
      const text = await readBlobText(backupKey, 'blog-index-backup', { expected: true });
      if (text === null) return res.status(404).json({ error: 'Backup not found' });
      await put(INDEX_KEY, text, {
        access: 'public',
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/json',
        token: process.env.BLOB_READ_WRITE_TOKEN
      });
      const verify = await readBlobText(INDEX_KEY, 'blog-index-backup', { expected: true });
      if (verify === null || sha256(verify) !== sha256(text)) {
        console.error('[SECURITY] blog-index-backup: restore verification FAILED from ' + backupKey);
        return res.status(500).json({ error: 'Restore verification failed', backupKey });
      }
      console.log('[blog-index-backup] restored ' + INDEX_KEY + ' from ' + backupKey + ' (sha256 ' + sha256(text) + ')');
      return res.status(200).json({ success: true, restoredFrom: backupKey, bytes: text.length, sha256: sha256(text) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('blog-index-backup error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
