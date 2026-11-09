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
// The CHECK above is read-only with respect to the blog: it never
// repairs the index (that stays the reviewed blog-reindex dry run +
// hash-gated commit, PR #39), and its only write is its own status
// blob. A separate STEP rides this daily run since the related-auto
// lane (Nov 9, 2026): the related sweep at the bottom of this file
// refreshes AUTOMATIC related lists (api/lib/related.js) - the
// mechanism that lands new or re-tagged posts in their siblings'
// lists without waiting for a re-save. The sweep is provenance-
// gated (it writes only posts whose stored relatedSource is 'auto',
// re-checked at write time), touches only the `related` field
// (updatedAt deliberately untouched - a related refresh must not
// fake sitemap freshness), and logs any post left with zero inbound
// links. Its summary rides the status blob; a sweep failure never
// fails the reconciliation verdict.
//
// Auth: Vercel cron only - the CRON_SECRET bearer alone, the same
// pattern as the project's working crons (cron-push-monitor,
// cron-booking-alerts). This endpoint originally ALSO required the
// x-vercel-cron header (the pattern hardened after the May 2026
// incident), but that header stopped authenticating on Oct 6, 2026
// (it is spoofable by anyone) and requiring it silently rejected
// every legitimate cron invocation from Oct 15-17, 2026: each run
// 401'd, no status record was ever written, and the external reader
// alerted on Oct 17 on the missing record. The bearer alone is
// sufficient and matches what actually runs. Fail closed: with
// CRON_SECRET unset, nothing is authorized. The admin JWT is NOT
// accepted: nothing human calls this. Auth failure: 401, [SECURITY]
// log, and NO status write (a rejected call must not be able to fake
// a healthy status).
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
import { computeRelated, relatedListsEqual } from './lib/related.js';

const INDEX_KEY = 'blog/posts/index';
const STATUS_KEY = 'blog/reconcile/status';
// Lag confirmation window: the measured upper bound of the store's
// visibility lag. Tunable for tests; production keeps the default.
const LAG_CONFIRM_MS = parseInt(process.env.BLOG_RECONCILE_LAG_MS || '120000', 10);

export function cronAuthorized(req) {
  if (!process.env.CRON_SECRET) return false;
  return req.headers['authorization'] === 'Bearer ' + process.env.CRON_SECRET;
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

// --- Related sweep ---------------------------------------------------
// Recompute every AUTOMATIC related list against the current corpus
// (the candidate build's post blobs - the source of truth, carrying
// the same fields the index would). Manual and legacy (no
// relatedSource) lists are never touched: provenance is sticky and
// only a human editor action changes it. A post is written only when
// its computed list differs from the stored one, and provenance is
// re-checked against a fresh read at write time - a list a human
// froze mid-sweep is skipped, never overwritten. The write changes
// ONLY `related`: all other fields are the fresh blob's own, and
// updatedAt is left exactly as stored.
export async function sweepRelatedPosts(posts) {
  const summary = { checked: 0, changed: 0, skippedProvenance: 0, zeroInbound: [] };
  const list = (Array.isArray(posts) ? posts : []).filter(p => p && p.slug);
  const corpus = list.map(p => ({
    slug: p.slug, title: p.title, park: p.park, category: p.category,
    heroImage: p.heroImage, published: p.published,
    publishedAt: p.publishedAt, tags: p.tags || []
  }));
  const finalLists = new Map();
  for (const post of list) {
    if (post.relatedSource !== 'auto') {
      finalLists.set(post.slug, post.related || []);
      continue;
    }
    summary.checked++;
    const computed = computeRelated(post, corpus);
    if (relatedListsEqual(computed, post.related)) {
      finalLists.set(post.slug, post.related || []);
      continue;
    }
    const fresh = await readBlobJson('blog/posts/' + post.slug, 'blog-reconcile.related-sweep', { expected: false });
    if (!fresh || fresh.relatedSource !== 'auto') {
      summary.skippedProvenance++;
      finalLists.set(post.slug, (fresh && fresh.related) || post.related || []);
      if (fresh) console.log('[blog-reconcile] related sweep: "' + post.slug + '" turned manual mid-sweep - skipped.');
      continue;
    }
    const recomputed = computeRelated(fresh, corpus);
    if (relatedListsEqual(recomputed, fresh.related)) {
      finalLists.set(post.slug, fresh.related || []);
      continue;
    }
    await put('blog/posts/' + post.slug, JSON.stringify({ ...fresh, related: recomputed }), { access: 'public', allowOverwrite: true });
    summary.changed++;
    finalLists.set(post.slug, recomputed);
    console.log('[blog-reconcile] related sweep: refreshed "' + post.slug + '" -> [' + recomputed.map(r => r.slug).join(', ') + ']');
  }
  // Inbound census over the post-sweep state: a published post no
  // list points at is an internal orphan (the DCA-guide failure this
  // system exists to prevent) - surface it in the log and the status.
  const inbound = new Map();
  for (const rel of finalLists.values()) {
    for (const r of rel || []) {
      if (r && r.slug) inbound.set(r.slug, (inbound.get(r.slug) || 0) + 1);
    }
  }
  for (const p of list) {
    if (p.published === true && !inbound.get(p.slug)) summary.zeroInbound.push(p.slug);
  }
  summary.zeroInbound.sort();
  if (summary.zeroInbound.length) {
    console.log('[blog-reconcile] related sweep: zero inbound links: ' + summary.zeroInbound.join(', '));
  }
  return summary;
}

export default async function handler(req, res) {
  if (!cronAuthorized(req)) {
    console.error('[SECURITY] blog-reconcile: unauthorized invocation rejected (no status written).');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const ranAt = new Date().toISOString();
  // Run-started marker: overwrite the status with a 'started' verdict
  // before the (potentially long) check, so a run that dies mid-flight
  // is distinguishable from one that never ran. A stale 'started'
  // record means invoked + authorized but died during execution; no
  // record at all means never invoked or rejected. Best-effort - a
  // failed marker must not abort the check. The final verdict write
  // below overwrites it as before.
  try {
    await writeStatus({ ranAt, verdict: 'started', candidateCount: null, storedCount: null, missing: [], extra: [], publishedDrift: [], lagArtifacts: [], note: 'Run started; verdict pending.' });
  } catch (e) {
    console.error('[blog-reconcile] run-started marker write failed:', e.message);
  }
  // Related sweep runner: best-effort around the verdict paths below.
  // Runs on the freshest candidate build (pass 2's when there was
  // one); a candidate without post objects (an older build shape)
  // skips cleanly, and any sweep error is recorded, never thrown -
  // the reconciliation verdict must not fail because the sweep did.
  const runSweep = async (candidate) => {
    try {
      if (!candidate || !Array.isArray(candidate.posts)) return { skipped: 'candidate posts unavailable' };
      return await sweepRelatedPosts(candidate.posts);
    } catch (e) {
      console.error('[blog-reconcile] related sweep failed:', e.message);
      return { error: String(e.message || e) };
    }
  };
  try {
    const pass1Start = Date.now();
    const c1 = await buildCandidate();
    if (c1.errors.length) throw new Error('candidate build incomplete: ' + c1.errors[0] + (c1.errors.length > 1 ? ' (+' + (c1.errors.length - 1) + ' more)' : ''));
    const s1 = await readBlobJson(INDEX_KEY, 'blog-reconcile', { expected: true });
    if (!Array.isArray(s1)) throw new Error('stored index unreadable');
    const d1 = diffIndexes(c1.index, s1);

    if (!hasDivergence(d1)) {
      const status = { ranAt, verdict: 'ok', candidateCount: c1.index.length, storedCount: s1.length, missing: [], extra: [], publishedDrift: [], lagArtifacts: [], note: null };
      status.relatedSweep = await runSweep(c1);
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
      status.relatedSweep = await runSweep(c2);
      await writeStatus(status);
      console.log('[blog-reconcile] pass-1 divergence resolved as lag artifact: ' + lagArtifacts.join(', '));
      return res.status(200).json(status);
    }

    const status = { ranAt, verdict: 'divergent', candidateCount: c2.index.length, storedCount: s2.length, missing: d2.missing, extra: d2.extra, publishedDrift: d2.publishedDrift, lagArtifacts, note: 'Divergence persisted across two passes spanning the lag window. Repair: reviewed blog-reindex dry run + hash-gated commit.' };
    status.relatedSweep = await runSweep(c2);
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
