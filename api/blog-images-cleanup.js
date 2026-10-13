// api/blog-images-cleanup.js - POST /api/blog-images-cleanup - protected
//
// Purpose-built bulk delete for the blog Image Library, created for the
// Oct 12, 2026 cleanup of wrongly-uploaded images. It exists because the
// interactive DELETE /api/blog-images is the wrong vehicle for an approved
// bulk set, and api/blog-migrate.js cannot delete at all.
//
// Safety contract:
//  1. ALLOWLIST-ONLY: the only URLs this endpoint can ever delete are the
//     strings in the request body's `urls` array. There is no code path
//     that enumerates the store and deletes from it; store listing is used
//     only to RESOLVE allowlisted URLs and to build the in-use backstop.
//  2. DRY-RUN: with { dryRun: true } it echoes the allowlist it received
//     and what each URL resolves to, and deletes nothing.
//  3. IN-USE BACKSTOP: before any delete, each URL is checked against the
//     suffix-tolerant usage map (same reader as api/blog-images.js /
//     api/blog-post.js). A referenced URL is refused (skipped + reported
//     with its usedBy), never deleted. If the usage map cannot be built,
//     the request aborts with 500 and nothing is deleted.
//  4. SCOPE GUARD: every URL must be an https URL whose pathname is
//     exactly /blog-images/<filename>. Anything else is rejected.
//  5. CAP: at most MAX_URLS entries per request.
import jwt from 'jsonwebtoken';
import { list, del } from '@vercel/blob';
import { readBlobJson } from './lib/blob.js';

const rl = {};
const MAX_URLS = 100;
const MAX_BODY_BYTES = 256 * 1024;


function stripQuery(url) {
  try { return url.split('?')[0]; } catch (e) { return url; }
}

async function buildUsageMap() {
  const usageMap = new Map();
  let allPosts;
  try {
    allPosts = await readBlobJson('blog/posts/index', 'blog-images-cleanup.readPostBlob');
  } catch (e) {
    allPosts = null;
  }
  if (!Array.isArray(allPosts) || !allPosts.length) return usageMap;

  const postBodies = await Promise.all(
    allPosts.map(function(p) {
      return readBlobJson('blog/posts/' + p.slug, 'blog-images-cleanup.readPostBlob').catch(function() { return null; });
    })
  );

  postBodies.forEach(function(post) {
    if (!post) return;
    const entry = { slug: post.slug, published: !!post.published, title: post.title || post.slug };

    if (post.heroImage) {
      const clean = stripQuery(post.heroImage);
      if (!usageMap.has(clean)) usageMap.set(clean, []);
      usageMap.get(clean).push(entry);
    }

    if (post.body) {
      const re = /https:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp|gif)[^"'\s]*/gi;
      let m;
      while ((m = re.exec(post.body)) !== null) {
        const clean = stripQuery(m[0]);
        if (!usageMap.has(clean)) usageMap.set(clean, []);
        if (!usageMap.get(clean).find(function(e) { return e.slug === post.slug; })) {
          usageMap.get(clean).push(entry);
        }
      }
    }
  });

  return usageMap;
}

// Scope guard: an allowlist entry is actionable only if it is an https URL
// pointing at exactly one file directly under blog-images/.
function scopeCheck(raw) {
  if (typeof raw !== 'string' || !raw.length) return 'not a non-empty string';
  let u;
  try { u = new URL(raw); } catch (e) { return 'unparseable URL'; }
  if (u.protocol !== 'https:') return 'protocol must be https';
  if (!u.hostname.endsWith('.public.blob.vercel-storage.com')) return 'not a Vercel Blob store URL';
  if (!u.pathname.startsWith('/blog-images/')) return 'outside blog-images/ scope';
  const rest = u.pathname.slice('/blog-images/'.length);
  if (!rest || rest.indexOf('/') !== -1) return 'not a single file under blog-images/';
  return null;
}

export default async function handler(req, res) {
  const sentToken = req.headers['x-admin-key'] || '';
  try {
    jwt.verify(sentToken, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
  rl[ip].count++;
  if (rl[ip].count > 20) return res.status(429).json({ error: 'Rate limit exceeded' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_BODY_BYTES) return res.status(413).json({ error: 'Request too large' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const urls = body && body.urls;
  if (!Array.isArray(urls) || !urls.length) {
    return res.status(400).json({ error: 'urls must be a non-empty array' });
  }
  if (urls.length > MAX_URLS) {
    return res.status(400).json({ error: 'urls exceeds the per-request cap of ' + MAX_URLS });
  }
  const dryRun = !!(body && body.dryRun === true);

  // Validate + dedupe the allowlist. Only entries that pass the scope guard
  // can ever reach del().
  const rejected = [];
  const allowlist = [];
  const seen = new Set();
  for (const raw of urls) {
    const problem = scopeCheck(raw);
    if (problem) { rejected.push({ url: raw, reason: problem }); continue; }
    if (seen.has(raw)) { rejected.push({ url: raw, reason: 'duplicate entry' }); continue; }
    seen.add(raw);
    allowlist.push(raw);
  }

  // Build the in-use backstop. If it cannot be built, abort: deleting
  // unguarded is exactly the failure this endpoint exists to prevent.
  let usageMap;
  try {
    usageMap = await buildUsageMap();
  } catch (err) {
    console.error('blog-images-cleanup usage map error:', err);
    return res.status(500).json({ error: 'Could not build the in-use map; nothing was deleted' });
  }

  // Resolve allowlisted URLs against the store (resolution only — the
  // listing is never a deletion source).
  const byUrl = new Map();
  try {
    let cursor;
    do {
      const page = await list({ prefix: 'blog-images/', limit: 1000, cursor, token: process.env.BLOB_READ_WRITE_TOKEN });
      for (const b of (page.blobs || [])) {
        if (!byUrl.has(b.url)) byUrl.set(b.url, b);
        const clean = stripQuery(b.url);
        if (!byUrl.has(clean)) byUrl.set(clean, b);
      }
      cursor = page.cursor;
    } while (cursor);
  } catch (err) {
    console.error('blog-images-cleanup list error:', err);
    return res.status(500).json({ error: 'Could not list the image store; nothing was deleted' });
  }

  const resolved = [];
  const notFound = [];
  const skippedInUse = [];
  const wouldDelete = [];
  for (const url of allowlist) {
    const blob = byUrl.get(url) || byUrl.get(stripQuery(url));
    if (!blob) { notFound.push(url); continue; }
    resolved.push({ url, filename: blob.pathname.replace('blog-images/', ''), uploadedAt: blob.uploadedAt });
    const usedBy = usageMap.get(stripQuery(url)) || usageMap.get(url) || usageMap.get(stripQuery(blob.url)) || usageMap.get(blob.url);
    if (usedBy && usedBy.length) { skippedInUse.push({ url, usedBy }); continue; }
    wouldDelete.push(url);
  }

  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      received: urls.length,
      allowlist,
      resolved,
      wouldDelete,
      skippedInUse,
      notFound,
      rejected
    });
  }

  const deleted = [];
  const deleteErrors = [];
  for (const url of wouldDelete) {
    try {
      await del(url);
      deleted.push(url);
    } catch (err) {
      deleteErrors.push({ url, error: err.message });
    }
  }

  return res.status(200).json({
    dryRun: false,
    received: urls.length,
    deleted,
    skippedInUse,
    notFound,
    rejected,
    deleteErrors
  });
}
