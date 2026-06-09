// api/blog-setup-password.js — one-time endpoint to hash and store admin password in Vercel Blob
import { put } from '@vercel/blob';
import bcrypt from 'bcryptjs';

const BLOB_KEY = 'blog:admin:password';
const SETUP_SECRET = process.env.SETUP_SECRET || 'tpcp-setup-2026';

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const MAX_REQUEST_SIZE = 1 * 1024; // 1KB — passwords only
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > MAX_REQUEST_SIZE) {
    return res.status(413).json({ error: 'Request too large' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { secret, password } = body || {};
  if (secret !== SETUP_SECRET) {
    console.warn('[SECURITY] Setup auth failed:', { ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', time: new Date().toISOString() });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const hash = await bcrypt.hash(password, 12);

  await put(BLOB_KEY, JSON.stringify({ hash, updatedAt: new Date().toISOString() }), {
    access: 'public',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: 'application/json',
    token: process.env.BLOB_READ_WRITE_TOKEN
  });

  console.log('[SECURITY] Admin password hash stored in blob at', new Date().toISOString());
  return res.status(200).json({ success: true, message: 'Password set successfully' });
}
