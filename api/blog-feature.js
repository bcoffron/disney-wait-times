// api/blog-feature.js
// GET: returns { featuredSlug }
// POST (JWT-protected): { slug } to feature, { slug: null } to unfeature
import { list, put } from '@vercel/blob';
import jwt from 'jsonwebtoken';

async function readBlob(pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
  const matches = (blobs || []).filter(b => b.pathname === pathname).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) return null;
  const r = await fetch(matches[0].downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.text();
}

export default async function handler(req, res) {
    const MAX_REQUEST_SIZE = 500 * 1024; // 500KB
    const contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > MAX_REQUEST_SIZE) {
          return res.status(413).json({ error: 'Request too large' });
    }
  // GET: return current featured slug (public)
  if (req.method === 'GET') {
    try {
      const featuredSlug = await readBlob('blog:featured');
      return res.status(200).json({ featuredSlug: featuredSlug || null });
    } catch(e) {
      return res.status(200).json({ featuredSlug: null });
    }
  }

  // POST: update featured slug (JWT-protected)
  if (req.method === 'POST') {
    // Fix 5: JWT verification FIRST before any data processing
    const authHeader = req.headers['x-admin-key'] || '';
        if (!authHeader) { console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() }); return res.status(401).json({ error: 'Unauthorized' }); }
    try {
      jwt.verify(authHeader, process.env.JWT_SECRET);
    } catch(e) {
            console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }

    const newSlug = body && body.slug ? String(body.slug).trim() : null;

    try {
      if (newSlug) {
        await put('blog:featured', newSlug, {
          access: 'public',
          allowOverwrite: true,
          contentType: 'text/plain',
          token: process.env.BLOB_READ_WRITE_TOKEN
        });
      } else {
        await put('blog:featured', '', {
          access: 'public',
          allowOverwrite: true,
          contentType: 'text/plain',
          token: process.env.BLOB_READ_WRITE_TOKEN
        });
      }
      return res.status(200).json({ success: true, featuredSlug: newSlug || null });
    } catch(e) {
      console.error('blog-feature error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
