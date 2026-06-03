// api/blog-auth.js - POST /api/blog-auth - 5 attempts/IP/hour rate limit
import jwt from 'jsonwebtoken';
const attempts = {};
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  if (!attempts[ip] || now - attempts[ip].start > hourMs) attempts[ip] = { count: 0, start: now };
  attempts[ip].count++;
  if (attempts[ip].count > 5) return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
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