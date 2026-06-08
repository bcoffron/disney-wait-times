// api/blog-pins.js
// GET  (public)  â returns { pins: ["slug1", "slug2", ...] }
// POST (protected) â body: { pins: ["slug1", "slug2", ...] }
// Stores pinned post order in Vercel Blob under key: blog:pins

import { list, put } from '@vercel/blob';
import jwt from 'jsonwebtoken';

const BLOB_KEY = 'blog:pins';

async function readPins() {
    try {
          const { blobs } = await list({ prefix: BLOB_KEY, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
          const match = (blobs || []).filter(b => b.pathname === BLOB_KEY).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
          if (!match.length) return [];
          const r = await fetch(match[0].downloadUrl + '?t=' + Date.now(), { cache: 'no-store' });
          if (!r.ok) return [];
          const data = await r.json();
          return Array.isArray(data.pins) ? data.pins : [];
    } catch(e) {
          return [];
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') {
        return res.status(200).end();
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
        // Verify admin token
      const adminKey = req.headers['x-admin-key'] || '';
        if (!adminKey) {
                return res.status(401).json({ error: 'Unauthorized' });
        }
        try {
                jwt.verify(adminKey, process.env.JWT_SECRET);
        } catch(e) {
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
