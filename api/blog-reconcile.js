// api/blog-reconcile.js - daily index reconciliation (detect-and-alert).
//
// The posts index is a derived cache: post blobs are the source of
// truth (one key per post, so those writes never collide), and the
// index can always be rebuilt from them deterministically. The one
// residual the race guard cannot fully close is a lost update from a
// competitor invisible for an entire request - so instead of a new
// index format, this endpoint makes a clobber DETECTED within a day:
// it rebuilds the candidate from the post blobs (the same code the
// repair runs), compares it against the stored index, and records the
// verdict in a status blob that an external reader polls. Healthy runs
// are silent downstream; divergence raises an alert with the diff.
//
// This endpoint is READ-ONLY with respect to the blog: its only write
// is its own status blob. It is deliberately NOT a mode on
// blog-reindex - that file holds the hash-gated commit path, which
// stays human-run and cron-unreachable (PR #39). Repair, when needed,
// is the reviewed blog-reindex dry run + hash-gated commit.
//
// Auth: Vercel cron only - the x-vercel-cron header plus the
// CRON_SECRET bearer, the pattern hardened after the May 2026
// incident. The admin JWT is NOT accepted: nothing human calls this.
// Auth failure: 401, [SECURITY] log, and NO status write (a rejected
// call must not be able to fake a healthy status).
//
// Comparison, by entry keyed on slug. Three divergence classes:
// - missing: a post blob exists with no index entry (the clobber
//   shape). Alerts.
// - extra: an index entry with no post blob (an orphan, or a deletion
//   that half-landed). Alerts.
// - field drift: alerts ONLY when `published` differs - a published
//   mismatch means a post is visible or invisible wrongly, the
//   user-facing harm. Snippet/date/hero drift is routine (the rebuild
//   legitimately recomputes fresher values) and never alerts.
//
// Lag: the store's visibility lag (measured 30-120s) cuts both ways -
// a check running minutes after a legitimate save can see a mid-lag
// store and report a divergence that isn't one. So divergence is
// confirmed in a second pass after the lag window: BOTH the candidate
// and the stored index are rebuilt fresh (comparing a stale side
// against a fresh side would manufacture divergence). Only divergence
// present in both passes alerts; pass-one-only divergence is recorded
// as a lag artifact in the status, visible without being noisy.
import { put } from '@vercel/blob';
import { readBlobJson } from './lib/blob.js';
import { buildCandidate } from './lib/reindex-candidate.js';

const INDEX_KEY = 'blog/posts/index';
const STATUS_KEY = 'blog/reconcile/status';
// Lag confirmation window: the measured upper bound of the store's
// visibility lag. Tunable for tests; production keeps the default.
const LAG_CONFIRM_MS = parseInt(process.env.BLOG_RECONCILE_LAG_MS || '120000', 10);

function cronAuthorized(req) {
  if (!process.env.CRON_SECRET) return false;
  return req.headers['x-vercel-cron'] === '1'
    && req.headers['authorization'] === 'Bearer ' + process.env.CRON_SECRET;
}

function diffIndexes(candidate, stored) {
  const cand = new Map(candidate.map(e => [e.slug, e]));
  const stor = new Map(stored.map(e => [e.slug, e]));
  const missing = [], extra = [], publishedDrift = [];
  for (const [slug, entry] of cand) {
    if (!stor.has(slug)) missing.push(slug);
    else if (!!entry.published !== !!stor.get(slug).published) {
      publishedDrift.push({ slug, candidate: !!entry.published, stored: !!stor.get(slug).published });
    }
  }
  for (const slug of stor.keys()) if (!cand.has(slug)) extra.push(slug);
  missing.sort(); extra.sort();
  publishedDrift.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return { missing, extra, publishedDrift };
}

const hasDivergence = (d) => d.missing.length > 0 || d.extra.length > 0 || d.publishedDrift.length > 0;
const divSlugs = (d) => [...d.missing, ...d.extra, ...d.publishedDrift.map(x => x.slug)];

async function writeStatus(status) {
  await put(STATUS_KEY, JSON.stringify(status), {
    access: 'public', allowOverwrite: true, addRandomSuffix: false,
    contentType: 'application/json', token: process.env.BLOB_READ_WRITE_TOKEN
  });
}

export default async function handler(req, res) {
  if (!cronAuthorized(req)) {
    console.error('[SECURITY] blog-reconcile: unauthorized invocation rejected (no status written).');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const ranAt = new Date().toISOString();
  try {
    const pass1Start = Date.now();
    const c1 = await buildCandidate();
    if (c1.errors.length) throw new Error('candidate build incomplete: ' + c1.errors[0] + (c1.errors.length > 1 ? ' (+' + (c1.errors.length - 1) + ' more)' : ''));
    const s1 = await readBlobJson(INDEX_KEY, 'blog-reconcile', { expected: true });
    if (!Array.isArray(s1)) throw new Error('stored index unreadable');
    const d1 = diffIndexes(c1.index, s1);

    if (!hasDivergence(d1)) {
      const status = { ranAt, verdict: 'ok', candidateCount: c1.index.length, storedCount: s1.length, missing: [], extra: [], publishedDrift: [], lagArtifacts: [], note: null };
      await writeStatus(status);
      return res.status(200).json(status);
    }

    // Second pass after the lag window, both sides rebuilt fresh.
    const waitMs = Math.max(0, LAG_CONFIRM_MS - (Date.now() - pass1Start));
    if (waitMs) await new Promise(r => setTimeout(r, waitMs));
    const c2 = await buildCandidate();
    if (c2.errors.length) throw new Error('candidate build incomplete (pass 2): ' + c2.errors[0]);
    const s2 = await readBlobJson(INDEX_KEY, 'blog-reconcile', { expected: true });
    if (!Array.isArray(s2)) throw new Error('stored index unreadable (pass 2)');
    const d2 = diffIndexes(c2.index, s2);
    const d2Slugs = new Set(divSlugs(d2));
    const lagArtifacts = [...new Set(divSlugs(d1))].filter(s => !d2Slugs.has(s)).sort();

    if (!hasDivergence(d2)) {
      const status = { ranAt, verdict: 'ok', candidateCount: c2.index.length, storedCount: s2.length, missing: [], extra: [], publishedDrift: [], lagArtifacts, note: 'Pass-1 divergence did not persist past the lag window; treated as a store visibility artifact.' };
      await writeStatus(status);
      console.log('[blog-reconcile] pass-1 divergence resolved as lag artifact: ' + lagArtifacts.join(', '));
      return res.status(200).json(status);
    }

    const status = { ranAt, verdict: 'divergent', candidateCount: c2.index.length, storedCount: s2.length, missing: d2.missing, extra: d2.extra, publishedDrift: d2.publishedDrift, lagArtifacts, note: 'Divergence persisted across two passes spanning the lag window. Repair: reviewed blog-reindex dry run + hash-gated commit.' };
    await writeStatus(status);
    console.error('[blog-reconcile] DIVERGENCE confirmed: missing=[' + d2.missing.join(', ') + '] extra=[' + d2.extra.join(', ') + '] publishedDrift=[' + d2.publishedDrift.map(x => x.slug).join(', ') + ']');
    return res.status(200).json(status);
  } catch (err) {
    console.error('[blog-reconcile] check failed:', err.message);
    try {
      await writeStatus({ ranAt, verdict: 'error', candidateCount: null, storedCount: null, missing: [], extra: [], publishedDrift: [], lagArtifacts: [], note: String(err.message || err) });
    } catch (e) {
      console.error('[blog-reconcile] status write failed:', e.message);
    }
    return res.status(500).json({ error: 'Reconciliation check failed', note: String(err.message || err) });
  }
}
