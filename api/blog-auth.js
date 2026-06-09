// api/blog-auth.js - POST /api/blog-auth - 5 attempts/IP/hour rate limit
import jwt from 'jsonwebtoken';

const rateLimit = new Map();

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

const allowedOrigins = [
  'https://themeparkcopilot.com',
  'https://www.themeparkcopilot.com',
  'https://app.themeparkcopilot.com',
  'https://disney-wait-times-lupt.vercel.app'
];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 5, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); } }
  const { password } = body || {};
  if (!password) return res.status(400).json({ error: 'password required' });
  const adminKey = (process.env.ADMIN_KEY || '').toLowerCase();
  const sentKey = (password || '').toLowerCase();
  if (!sentKey || sentKey !== adminKey) return res.status(401).json({ error: 'Unauthorized' });
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: 'Server configuration error' });
  const token = jwt.sign({ role: 'admin', iss: 'theme-park-copilot-blog' }, secret, { expiresIn: '24h' });
  return res.status(200).json({ token });
};
