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

async function selectBlob(key, caller) {
  const { blobs } = await list({ prefix: key, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
  const matches = (blobs || []).filter(b => matchesKey(b.pathname, key)).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) {
    if ((blobs || []).length > 0) {
      console.error('[SECURITY] ' + (caller || 'readBlob') + ' matched 0 of ' + blobs.length + ' listed blobs for key "' + key + '" - possible suffix-format drift.');
    }
    return null;
  }
  return matches[0];
}

export async function readBlobJson(key, caller) {
  const chosen = await selectBlob(key, caller);
  if (!chosen) return null;
  const r = await fetch(chosen.downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  const text = await r.text();
  return JSON.parse(text);
}

export async function readBlobText(key, caller) {
  const chosen = await selectBlob(key, caller);
  if (!chosen) return null;
  const r = await fetch(chosen.downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.text();
}
