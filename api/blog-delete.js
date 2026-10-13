import jwt from 'jsonwebtoken';
import { del, put, list } from '@vercel/blob';
import { matchesKey, readBlobJson } from './lib/blob.js';

// Reserved names under blog/posts/ that are not posts. A delete aimed at one
// of these would match its blob family: matchesKey confines matches to the
// key family, but it does not make the target sane.
const RESERVED_SLUGS = new Set(['index']);

function isValidSlug(slug) {
  if (typeof slug !== 'string' || !slug) return false;
  if (slug.includes('/') || slug.includes('\\') || slug.includes('.')) return false;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return false;
  if (RESERVED_SLUGS.has(slug)) return false;
  return true;
}

export default async function handler(req, res) {
  // Fix 5: JWT verification FIRST before any data processing
  const sentToken = req.headers['x-admin-key'] || '';
    if (!sentToken) { console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() }); return res.status(401).json({ error: 'Unauthorized' }); }
  try {
    jwt.verify(sentToken, process.env.JWT_SECRET);
  } catch (err) {
        console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const MAX_REQUEST_SIZE = 500 * 1024; // 500KB
    const contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > MAX_REQUEST_SIZE) {
          return res.status(413).json({ error: 'Request too large' });
    }
  
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const { slug, dryRun } = body || {};
  if (!slug) return res.status(400).json({ error: 'slug required' });
  if (!isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug' });

  try {
    // Suffix-tolerant target selection via the shared matcher (Security C1):
    // a post's blobs are its bare key plus any '-'-suffixed historical copies.
    // List at limit 1000 like every other read - the old limit of 10 could
    // leave copies of heavily edited posts behind while reporting success.
    const key = 'blog/posts/' + slug;
    const { blobs } = await list({ prefix: key, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
    const nameMatched = (blobs || []).filter(b => matchesKey(b.pathname, key));

    // Content verification (addition beyond the brief, flagged for review):
    // matchesKey cannot distinguish the target's own suffixed copy from a
    // BARE blob of a sibling post whose slug extends the target by one
    // alphanumeric word (key + '-pro' reads as key + suffix). No such slug
    // pair exists in the store today (checked across all 49 slugs), but a
    // delete is irreversible, so each candidate's content is parsed and only
    // blobs whose own slug field equals the target are deleted. Anything
    // else is skipped and reported, never deleted.
    const matches = [];
    const skipped = [];
    for (const b of nameMatched) {
      try {
        const r = await fetch(b.downloadUrl, { cache: 'no-store' });
        if (!r.ok) { skipped.push({ pathname: b.pathname, reason: 'fetch failed' }); continue; }
        const parsed = JSON.parse(await r.text());
        if (parsed && parsed.slug === slug) matches.push(b);
        else skipped.push({ pathname: b.pathname, reason: 'content slug is ' + JSON.stringify(parsed && parsed.slug) });
      } catch (e) {
        skipped.push({ pathname: b.pathname, reason: 'unparseable content' });
      }
    }

    if (dryRun) {
      // Report exactly what a live delete would remove. Deletes nothing and
      // leaves the index untouched.
      return res.status(200).json({
        success: true,
        dryRun: true,
        slug,
        listed: (blobs || []).length,
        matched: matches.map(b => b.pathname),
        skipped,
        count: matches.length
      });
    }

    for (const b of matches) await del(b.url);

    let index = (await readBlobJson('blog/posts/index', 'blog-delete.readBlob', { expected: true })) || [];
    index = index.filter(p => p.slug !== slug);
    await put('blog/posts/index', JSON.stringify(index), { access: 'public', allowOverwrite: true, token: process.env.BLOB_READ_WRITE_TOKEN });

    return res.status(200).json({ success: true, deleted: matches.map(b => b.pathname), skipped, count: matches.length });
  } catch (err) {
    console.error('blog-delete error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
