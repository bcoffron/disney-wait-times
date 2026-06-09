// api/blog-auth.js - POST /api/blog-auth - 5 attempts/IP/hour rate limit
import { list } from '@vercel/blob';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const rateLimit = new Map();
const BLOB_KEY = 'blog:admin:password';

function checkRateLimit(ip, max, windowMs) {
  const now = Date.now();
  if (!rateLimit.has(ip)) {
    rateLimit.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  const record = rateLimit.get(ip);
  if (now > record.resetAt) {
    rateLimit.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (record.count >= max) return false;
  record.count++;
  return true;
}

async function getPasswordHash() {
  try {
    const { blobs } = await list({ prefix: BLOB_KEY, limit: 10, token: process.env.BLOB_READ_WRITE_TOKEN });
    const match = blobs.filter(b => b.pathname === BLOB_KEY)
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    if (!match.length) return null;
    const res = await fetch(match[0].downloadUrl + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.hash || null;
  } catch(e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const MAX_REQUEST_SIZE = 500 * 1024; // 500KB
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > MAX_REQUEST_SIZE) {
    return res.status(413).json({ error: 'Request too large' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 5, 60 * 60 * 1000)) {
    console.warn('[SECURITY] Rate limit exceeded:', { endpoint: req.url, ip, time: new Date().toISOString() });
    return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); } }
  const { password } = body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });

  const hash = await getPasswordHash();

  // Fallback to env var during transition period
  const envPassword = process.env.ADMIN_PASSWORD || process.env.ADMIN_KEY;

  let valid = false;
  if (hash) {
    valid = await bcrypt.compare(password, hash);
  } else if (envPassword) {
    valid = password === envPassword;
  }

  if (!valid) {
    console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip, reason: 'invalid_password', time: new Date().toISOString() });
    return res.status(401).json({ error: 'Invalid password' });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: 'Server configuration error' });
  const token = jwt.sign(
    { role: 'admin', iss: 'theme-park-copilot-blog' },
    secret,
    { expiresIn: '24h' }
  );
  return res.status(200).json({ token });
}
