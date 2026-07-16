// api/blog-post.js - GET /api/blog-post?slug=... - public, cached
import { list } from '@vercel/blob';
const rl = {};

function matchesKey(pathname, key) {
  // INVARIANT (OBSERVED, NOT guaranteed by @vercel/blob):
  // With addRandomSuffix, the server appends '-' + an alphanumeric-only suffix
  // (no '-' or '_'). Verified across 654 live blobs (all 30-char [A-Za-z0-9]).
  // The client lib only sends a boolean flag; the suffix is minted server-side,
  // so this format is NOT a documented contract. The regex below DEPENDS on it to
  // tell "key + random-suffix" apart from "key + '-' + a longer sibling slug".
  // If this invariant ever breaks, the empty-match guard in readBlob will log it.
  if (pathname === key) return true;
  if (!pathname.startsWith(key + '-')) return false;
  return /^[A-Za-z0-9]+$/.test(pathname.slice(key.length + 1));
}

async function readBlob(pathname) {
    const { blobs } = await list({ prefix: pathname, limit: 1000 , token: process.env.BLOB_READ_WRITE_TOKEN});
  const matches = (blobs || []).filter(b => matchesKey(b.pathname, pathname)).sort((a,b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) {
    if ((blobs || []).length > 0) {
      console.error('[SECURITY] readBlob matched 0 of ' + blobs.length + ' listed blobs for key "' + pathname + '" - possible suffix-format drift.');
    }
    return null;
  }

              const r = await fetch(matches[0].downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.text().then(t => JSON.parse(t));
}
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
  rl[ip].count++;
  if (rl[ip].count > 20) return res.status(429).json({ error: 'Rate limit exceeded' });
  const { slug } = req.query;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
  try {
    const post = await readBlob('blog/posts/' + slug);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.published !== true) return res.status(404).json({ error: 'Post not found' });
    res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=10');
    return res.status(200).json(post);
  } catch (err) {
    console.error('blog-post error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
