// api/blog-reset-confirm.js — POST /api/blog-reset-confirm — verify token and set new password
import { put, list } from '@vercel/blob';
import bcrypt from 'bcryptjs';

const PASSWORD_KEY = 'blog:admin:password';
const RESET_TOKEN_KEY = 'blog:admin:reset-token';

async function getBlob(key) {
  try {
    const { blobs } = await list({ prefix: key, limit: 10, token: process.env.BLOB_READ_WRITE_TOKEN });
    const match = blobs.filter(b => b.pathname === key)
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    if (!match.length) return null;
    const res = await fetch(match[0].downloadUrl + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const MAX_REQUEST_SIZE = 1 * 1024;
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > MAX_REQUEST_SIZE) {
    return res.status(413).json({ error: 'Request too large' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { token, newPassword } = body || {};
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const resetData = await getBlob(RESET_TOKEN_KEY);
  if (!resetData || !resetData.token || resetData.token !== token) {
    console.warn('[SECURITY] Invalid reset token attempt at', new Date().toISOString());
    return res.status(401).json({ error: 'Invalid or expired reset token' });
  }
  if (Date.now() > resetData.expiresAt) {
    return res.status(401).json({ error: 'Reset token has expired' });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await put(PASSWORD_KEY, JSON.stringify({ hash, updatedAt: new Date().toISOString() }), {
    access: 'public',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: 'application/json',
    token: process.env.BLOB_READ_WRITE_TOKEN
  });

  // Invalidate reset token (one-time use)
  await put(RESET_TOKEN_KEY, JSON.stringify({ token: '', expiresAt: 0 }), {
    access: 'public',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: 'application/json',
    token: process.env.BLOB_READ_WRITE_TOKEN
  });

  console.log('[SECURITY] Admin password reset successfully at', new Date().toISOString());
  return res.status(200).json({ success: true });
}
