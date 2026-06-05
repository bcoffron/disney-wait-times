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
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

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
    const authHeader = req.headers['x-admin-key'] || '';
    try {
      jwt.verify(authHeader, process.env.JWT_SECRET);
    } catch(e) {
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
        // Store empty string to "unfeature" (blob must exist but be empty)
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
