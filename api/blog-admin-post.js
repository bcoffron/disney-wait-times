// api/blog-admin-post.js - GET /api/blog-admin-post?slug=... - admin only (JWT)
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
import { readBlobJson } from './lib/blob.js';
const rl = {};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    // Auth verification FIRST before any data processing (Fix 5, same
    // gate as blog-delete / blog-save): this endpoint returns
    // unpublished drafts, so it sits behind the admin session and is
    // never public. /api/blog-post stays the published-only reader.
    // Two credentials are accepted on this READ endpoint:
    //   - the admin session JWT (auth: session), as before;
    //   - BLOG_AGENT_TOKEN (auth: agent), a static high-entropy bearer
    //     held in a Vercel env var, compared in constant time. It exists
    //     so reviewed agent tooling can read without holding Beau's
    //     session token. Scope is reads only: blog-save deliberately
    //     does NOT accept it (its JWT-only gate is unchanged, and a
    //     test asserts the agent token gets a 401 there). Unset env
    //     var = the agent path simply never matches.
    const sentToken = req.headers['x-admin-key'] || '';
    let authKind = null;
    if (sentToken) {
      try { jwt.verify(sentToken, process.env.JWT_SECRET); authKind = 'session'; } catch (err) { /* not a session JWT: try the agent token below */ }
      if (!authKind && process.env.BLOG_AGENT_TOKEN) {
        const expected = Buffer.from(process.env.BLOG_AGENT_TOKEN);
        const presented = Buffer.from(sentToken);
        if (presented.length === expected.length && timingSafeEqual(presented, expected)) authKind = 'agent';
      }
    }
    if (!authKind) { console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() }); return res.status(401).json({ error: 'Unauthorized' }); }
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
