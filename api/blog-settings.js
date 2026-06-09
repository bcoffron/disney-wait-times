// api/blog-settings.js
import jwt from 'jsonwebtoken';
import { put, list } from '@vercel/blob';

const DEFAULTS = {
  byline: 'By the Theme Park Co-Pilot Team',
  readTimeMode: 'auto',
  postsPerPage: 30
};

const allowedOrigins = [
  'https://themeparkcopilot.com',
  'https://www.themeparkcopilot.com',
  'https://app.themeparkcopilot.com',
  'https://disney-wait-times-lupt.vercel.app'
];

async function readBlob(pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 10, token: process.env.BLOB_READ_WRITE_TOKEN });
  const matches = (blobs || []).filter(b => b.pathname === pathname).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) return null;
  const r = await fetch(matches[0].downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  // Fix 7: Restricted CORS
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const stored = await readBlob('blog:settings');
      const settings = { ...DEFAULTS, ...(stored || {}) };
      return res.status(200).json(settings);
    } catch(err) {
      return res.status(200).json(DEFAULTS);
    }
  }

  if (req.method === 'POST') {
    // Fix 5: JWT verification FIRST before any data processing
    const sentToken = req.headers['x-admin-key'] || '';
    if (!sentToken) return res.status(401).json({ error: 'Unauthorized' });
    try {
      jwt.verify(sentToken, process.env.JWT_SECRET);
    } catch(err) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    }

    const settings = {
      byline: String(body.byline || DEFAULTS.byline).trim(),
      readTimeMode: body.readTimeMode === 'manual' ? 'manual' : 'auto',
      postsPerPage: Math.min(100, Math.max(5, parseInt(body.postsPerPage) || 30))
    };

    try {
      await put('blog:settings', JSON.stringify(settings), {
        access: 'public',
        allowOverwrite: true,
        token: process.env.BLOB_READ_WRITE_TOKEN
      });
      return res.status(200).json({ success: true, settings });
    } catch(err) {
      console.error('blog-settings save error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
