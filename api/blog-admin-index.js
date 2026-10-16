// api/blog-admin-index.js - GET /api/blog-admin-index - admin only (JWT)
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
import { readBlobJson } from './lib/blob.js';
const rl = {};



// Admin list shaping: latest-per-slug with NO published filter.
// (The deliberate mirror image of blog-index's toPublicIndex, which
//  filters published FIRST and then dedupes. That order is right for
//  the public feed; here it would hide the admin's own drafts. The
//  admin list shows each post's actual current condition, so the
//  newest entry per slug wins whatever its published state: a post
//  whose latest edit is an unpublished draft of a live post appears
//  here as a draft, while the public feed keeps serving the
//  published version.)
function toAdminIndex(entries) {
  var bySlug = {};
  for (var i = 0; i < (entries || []).length; i++) {
    var p = entries[i];
    if (!p || !p.slug) continue;
    var t = new Date(p.updatedAt || p.publishedAt || 0).getTime();
    var cur = bySlug[p.slug];
    if (!cur || t >= cur._t) { p._t = t; bySlug[p.slug] = p; }
  }
  var out = Object.keys(bySlug).map(function (k) { var p = bySlug[k]; delete p._t; return p; });
  out.sort(function (a, b) {
    return new Date(b.updatedAt || b.publishedAt || 0).getTime() - new Date(a.updatedAt || a.publishedAt || 0).getTime();
  });
  return out;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    // Auth verification FIRST before any data processing (Fix 5, same
    // gate as blog-delete / blog-save): this endpoint returns
    // unpublished drafts, so it sits behind the admin session and is
    // never public. /api/blog-index stays the published-only feed.
    // Two credentials are accepted on this READ endpoint:
    //   - the admin session JWT (auth: session), as before;
    //   - BLOG_AGENT_TOKEN (auth: agent), a static high-entropy bearer
    //     held in a Vercel env var, compared in constant time. It exists
    //     so reviewed agent tooling can read without holding Beau's
    //     session token. blog-save accepts the same two credentials
    //     since PR #66, with the auth kind logged on every save.
    //     Unset env var = the agent path simply never matches.
    const sentToken = req.headers['x-admin-key'] || '';
    let authKind = null;
    let agentChecked = false;
    // Shape only, never the value: three dot-separated segments reads as
    // a JWT. The failure log below records it so an operator can tell a
    // bad agent token (wrong or rotated credential) from a session
    // expiry (Beau signs in again) - different problems, different fix.
    // (Same discriminator as blog-save, PR #66.)
    const presentedShape = !sentToken ? 'none' : (/^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(sentToken) ? 'jwt' : 'other');
    if (sentToken) {
      try { jwt.verify(sentToken, process.env.JWT_SECRET); authKind = 'session'; } catch (err) { /* not a session JWT: try the agent token below */ }
      if (!authKind && process.env.BLOG_AGENT_TOKEN) {
        agentChecked = true;
        const expected = Buffer.from(process.env.BLOG_AGENT_TOKEN);
        const presented = Buffer.from(sentToken);
        if (presented.length === expected.length && timingSafeEqual(presented, expected)) authKind = 'agent';
      }
    }
    if (!authKind) { console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', agentChecked, presentedShape, time: new Date().toISOString() }); return res.status(401).json({ error: 'Unauthorized' }); }
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const now = Date.now();
    if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
    rl[ip].count++;
    if (rl[ip].count > 20) return res.status(429).json({ error: 'Rate limit exceeded' });
    try {
          const index = await readBlobJson('blog/posts/index', 'blog-admin-index.readBlob', { expected: true });
          // Authenticated read of unpublished content: never let a
          // shared cache hold it. This deliberately differs from
          // blog-index.js (public, s-maxage) - do not harmonize the
          // two: caching this response like the public feed would
          // leak drafts through shared caches.
          res.setHeader('Cache-Control', 'private, no-store');
          return res.status(200).json(toAdminIndex(index || []));
    } catch (err) {
          console.error('blog-admin-index error:', err.message);
          return res.status(500).json({ error: 'Internal server error' });
    }
};
