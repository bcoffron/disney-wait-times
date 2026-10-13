// api/lib/blob.js - shared Vercel Blob helpers for the blog endpoints.
//
// Single home for the suffix-tolerant key matcher and the safe read pattern,
// extracted from api/blog-post.js (Step 1 of the blob exact-match audit,
// GitHub #5) so the predicate exists in exactly one place. Behavior is
// unchanged from the per-file copies this replaces; the only additions are
// the shared location and a caller label in the empty-match log, so a drift
// event names the endpoint that fired it.
import { list } from '@vercel/blob';

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
