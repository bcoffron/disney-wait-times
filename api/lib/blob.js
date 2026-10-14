// api/lib/blob.js - shared Vercel Blob helpers for the blog endpoints.
//
// Single home for the suffix-tolerant key matcher and the safe read pattern,
// extracted from api/blog-post.js (Step 1 of the blob exact-match audit,
// GitHub #5) so the predicate exists in exactly one place. Behavior is
// unchanged from the per-file copies this replaces; the only additions are
// the shared location and a caller label in the empty-match log, so a drift
// event names the endpoint that fired it.
import { list, put } from '@vercel/blob';
import { createHash } from 'node:crypto';

export function matchesKey(pathname, key) {
  // INVARIANT (OBSERVED, NOT guaranteed by @vercel/blob):
  // With addRandomSuffix, the server appends '-' + an alphanumeric-only suffix
  // (no '-' or '_'). Verified across 654 live blobs (all 30-char [A-Za-z0-9]).
  // The client lib only sends a boolean flag; the suffix is minted server-side,
  // so this format is NOT a documented contract. The regex below DEPENDS on it to
  // tell "key + random-suffix" apart from "key + '-' + a longer sibling slug".
  // If this invariant ever breaks, the empty-match guard in readBlobJson /
  // readBlobText (selectBlob, below) in this module will log it.
  if (pathname === key) return true;
  if (!pathname.startsWith(key + '-')) return false;
  return /^[A-Za-z0-9]+$/.test(pathname.slice(key.length + 1));
}

async function selectBlob(key, caller, opts) {
  const { blobs } = await list({ prefix: key, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
  const matches = (blobs || []).filter(b => matchesKey(b.pathname, key)).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) {
    // Empty-match split (GitHub #6): the guard used to tag every zero-match
    // [SECURITY], but most zero-matches are prefix probes - requests for a
    // key that is a string-prefix of real keys without being one itself
    // (e.g. slug "disney-world" listing the disney-world-* posts). Those are
    // benign and attacker-shaped, so they log WITHOUT the [SECURITY] tag at
    // warn level. Callers reading a key that must exist (the posts index,
    // settings, featured, or a post slug taken from the index) pass
    // { expected: true }; for those, a zero-match is genuine drift - the
    // suffix-format tripwire - and keeps the [SECURITY] tag, including when
    // the prefix listing itself came back empty.
    if (opts && opts.expected) {
      console.error('[SECURITY] ' + (caller || 'readBlob') + ' matched 0 of ' + (blobs || []).length + ' listed blobs for expected key "' + key + '" - possible suffix-format drift.');
    } else if ((blobs || []).length > 0) {
      console.warn('[blob] ' + (caller || 'readBlob') + ' matched 0 of ' + blobs.length + ' listed blobs for key "' + key + '" - no exact or suffixed form; treating as prefix probe.');
    }
    return null;
  }
  return matches[0];
}

// Featured-post sentinel: the blob SDK rejects empty content, so "nothing
// featured" is stored as an explicit sentinel rather than ''. The sentinel
// can never be a real slug (slugs are [a-z0-9-]; this contains underscores).
// normalizeFeaturedSlug maps the sentinel, empty, and whitespace-only raw
// values - any of which may exist in older copies - to null, so every reader
// of the featured key agrees on what "unfeatured" means.
export const UNFEATURED_SENTINEL = '__unfeatured__';
export function normalizeFeaturedSlug(raw) {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim();
  if (v === '' || v === UNFEATURED_SENTINEL) return null;
  return v;
}

export async function readBlobJson(key, caller, opts) {
  const chosen = await selectBlob(key, caller, opts);
  if (!chosen) return null;
  const r = await fetch(chosen.downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  const text = await r.text();
  return JSON.parse(text);
}

export async function readBlobText(key, caller, opts) {
  const chosen = await selectBlob(key, caller, opts);
  if (!chosen) return null;
  const r = await fetch(chosen.downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.text();
}

// The index entry's bodySnippet, computed exactly as blog-save computes
// it. Extracted (reindex Deliverable 2) so the save path and the rebuild
// produce the identical field from the identical code - the rebuild's
// output shape must match the save path's field for field.
export function computeBodySnippet(body) {
  return (body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 2000);
}

// --- Race-safe read-modify-write for shared JSON blobs (write-path fix) ---
//
// The posts index is written by several endpoints as read-modify-write:
// read the whole array, change one entry, put the whole array back. The
// blob store's reads lag writes by tens of seconds, so a writer can read
// state that predates a competitor's write and silently discard that
// write when it puts its stale-based array (observed live Oct 13, 2026:
// two saves seconds apart lost the first post's index entry while its
// post blob stayed live and public).
//
// updateBlobJson narrows that window. It fingerprints the exact state it
// read (source pathname + uploadedAt + SHA-256 of the raw text), then
// re-reads immediately before writing; if the fingerprint moved, the
// mutator is re-applied to the FRESH state instead of overwriting it.
// After maxAttempts (or budgetMs — interactive callers must not hang)
// it throws an INDEX_CONFLICT error rather than writing stale state.
//
// This is advisory, NOT atomic: @vercel/blob offers no compare-and-swap.
// A competing write that is still invisible to the verification re-read
// (inside the store's visibility lag) cannot be detected at all, and the
// gap between the final verification and the put is one round trip. The
// guarantee is narrower and honest: any competing change VISIBLE by
// write time is merged, never discarded, and persistent visible
// contention fails loudly instead of losing data silently. The complete
// fix (append-only index format) is scoped to the reindex lane.
async function readRawWithFingerprint(key, caller) {
  const chosen = await selectBlob(key, caller, { expected: true });
  if (!chosen) return { value: null, fingerprint: null };
  const r = await fetch(chosen.downloadUrl, { cache: 'no-store' });
  if (!r.ok) {
    const err = new Error('fetch failed (' + r.status + ') reading "' + key + '" for update');
    err.code = 'UPDATE_READ_FAILED';
    throw err;
  }
  const text = await r.text();
  const fingerprint = chosen.pathname + '|' + chosen.uploadedAt + '|' + createHash('sha256').update(text).digest('hex');
  return { value: JSON.parse(text), fingerprint };
}

export async function updateBlobJson(key, caller, mutator, opts = {}) {
  const maxAttempts = opts.maxAttempts || 3;
  const budgetMs = opts.budgetMs || 5000;
  const started = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { value, fingerprint } = await readRawWithFingerprint(key, caller);
    const draft = value === null ? null : JSON.parse(JSON.stringify(value));
    const next = await mutator(draft);
    if (JSON.stringify(next) === JSON.stringify(value)) {
      return { changed: false, conflicted: attempt > 1, attempts: attempt };
    }
    const check = await readRawWithFingerprint(key, caller);
    if (check.fingerprint === fingerprint) {
      await put(key, JSON.stringify(next), {
        access: 'public',
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/json',
        token: process.env.BLOB_READ_WRITE_TOKEN
      });
      return { changed: true, conflicted: attempt > 1, attempts: attempt };
    }
    console.error('[SECURITY] ' + (caller || 'updateBlobJson') + ': "' + key + '" changed during update (attempt ' + attempt + ' of ' + maxAttempts + ') - re-applying on fresh state.');
    if (Date.now() - started > budgetMs) break;
  }
  console.error('[SECURITY] ' + (caller || 'updateBlobJson') + ': giving up on "' + key + '" after ' + maxAttempts + ' attempts / ' + (Date.now() - started) + 'ms - refusing to overwrite from stale state.');
  const err = new Error('Index changed repeatedly during update of "' + key + '"; refusing to overwrite from stale state.');
  err.code = 'INDEX_CONFLICT';
  throw err;
}
