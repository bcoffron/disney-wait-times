// api/blog-admin-post.js - GET /api/blog-admin-post?slug=... - admin only (JWT)
import jwt from 'jsonwebtoken';
import { readBlobJson } from './lib/blob.js';
const rl = {};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    // JWT verification FIRST before any data processing (Fix 5, same
    // gate as blog-delete / blog-save): this endpoint returns
    // unpublished drafts, so it sits behind the admin session and is
    // never public. /api/blog-post stays the published-only reader.
    const sentToken = req.headers['x-admin-key'] || '';
    if (!sentToken) { console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() }); return res.status(401).json({ error: 'Unauthorized' }); }
    try {
      jwt.verify(sentToken, process.env.JWT_SECRET);
    } catch (err) {
      console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const now = Date.now();
    if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
    rl[ip].count++;
    if (rl[ip].count > 20) return res.status(429).json({ error: 'Rate limit exceeded' });
    const { slug } = req.query;
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
    try {
          // NO published filter: the editor must load drafts exactly as
          // stored. blog-post.js 404s anything not published===true,
          // which is the public contract - and why drafts could not be
          // opened or published from the admin at all.
          const post = await readBlobJson('blog/posts/' + slug, 'blog-admin-post.readBlob');
          if (!post) return res.status(404).json({ error: 'Post not found' });
          // Authenticated read of unpublished content: never let a
          // shared cache hold it. This deliberately differs from
          // blog-post.js (public, s-maxage) - do not harmonize the
          // two: caching this response like the public reader would
          // leak drafts through shared caches.
          res.setHeader('Cache-Control', 'private, no-store');
          return res.status(200).json(post);
    } catch (err) {
          console.error('blog-admin-post error:', err.message);
          return res.status(500).json({ error: 'Internal server error' });
    }
};
