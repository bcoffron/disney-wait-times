// api/blog-index.js - GET /api/blog-index - public, cached
import { list } from '@vercel/blob';
const rl = {};

async function readBlob(pathname) {
    const { blobs } = await list({
          prefix: pathname,
                  limit: 1000,
          token: process.env.BLOB_READ_WRITE_TOKEN
    });
    const matches = (blobs || []).filter(b => b.pathname === pathname)
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    if (!matches.length) return null;
        const r = await fetch(matches[0].downloadUrl, { cache: 'no-store' });
    if (!r.ok) return null;
    return r.text().then(t => JSON.parse(t));
}


// Public feed shaping: published===true FIRST, then latest-per-slug.
// (Order matters: filtering published first prevents a draft edit of a
//  published post from hiding the published version during dedupe.)
function toPublicIndex(entries) {
  var list = (entries || []).filter(function (p) { return p && p.published === true; });
  var bySlug = {};
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    var slug = p.slug;
    if (!slug) continue;
    var t = new Date(p.updatedAt || p.publishedAt || 0).getTime();
    var cur = bySlug[slug];
    if (!cur || t >= cur._t) { p._t = t; bySlug[slug] = p; }
  }
  var out = Object.keys(bySlug).map(function (k) { var p = bySlug[k]; delete p._t; return p; });
  out.sort(function (a, b) {
    return new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime();
  });
  return out;
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
    try {
          const index = await readBlob('blog/posts/index');
          res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=10');
          return res.status(200).json(toPublicIndex(index || []));
    } catch (err) {
          console.error('blog-index error:', err.message);
          return res.status(500).json({ error: 'Internal server error' });
    }
};
