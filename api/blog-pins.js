// api/blog-pins.js
// GET (public) — returns { pins: ["slug1", "slug2", ...] }
// POST (protected) — body: { pins: ["slug1", "slug2", ...] }
// Stores pinned post order in Vercel Blob under key: blog:pins

import { put } from '@vercel/blob';
import jwt from 'jsonwebtoken';
import { readBlobJson } from './lib/blob.js';

const BLOB_KEY = 'blog:pins';

// Suffix-tolerant via the shared reader (expected-class: the key is
// deliberately set and the admin displays it, so a zero-match is
// drift and logs [SECURITY]). The old exact-match read silently
// served the bare copy forever, ignoring any newer suffixed copy.
// Failures still degrade to an empty list, as before.
async function readPins() {
  try {
    const data = await readBlobJson(BLOB_KEY, 'blog-pins', { expected: true });
    return data && Array.isArray(data.pins) ? data.pins : [];
  } catch(e) {
    return [];
  }
}

export default async function handler(req, res) {
    const MAX_REQUEST_SIZE = 500 * 1024; // 500KB
    const contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > MAX_REQUEST_SIZE) {
          return res.status(413).json({ error: 'Request too large' });
    }
  if (req.method === 'GET') {
    try {
      const pins = await readPins();
      return res.status(200).json({ pins });
    } catch(e) {
      return res.status(500).json({ error: 'Failed to read pins' });
    }
  }

  if (req.method === 'POST') {
    // Fix 5: JWT verification FIRST before any data processing
    const adminKey = req.headers['x-admin-key'] || '';
    if (!adminKey) {
            console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      jwt.verify(adminKey, process.env.JWT_SECRET);
    } catch(e) {
            console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const { pins } = req.body;
      if (!Array.isArray(pins)) return res.status(400).json({ error: 'pins must be an array' });
      const limited = pins.slice(0, 12);
      await put(BLOB_KEY, JSON.stringify({ pins: limited }), {
        access: 'public',
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/json',
        token: process.env.BLOB_READ_WRITE_TOKEN
      });
      return res.status(200).json({ success: true, pins: limited });
    } catch(e) {
      return res.status(500).json({ error: 'Failed to save pins' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
