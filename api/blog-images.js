import { list } from '@vercel/blob';

const rateLimit = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 20;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip) || { count: 0, start: now };
  if (now - entry.start > WINDOW_MS) {
    entry.count = 1; entry.start = now;
  } else {
    entry.count++;
  }
  rateLimit.set(ip, entry);
  return entry.count <= MAX_REQUESTS;
}

export default async function handler(req, res) {
  const adminKey = (process.env.ADMIN_KEY || '').toLowerCase();
  const sentKey = (req.headers['x-admin-key'] || '').toLowerCase();
  if (!sentKey || sentKey !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { blobs } = await list({ prefix: 'blog-images/', limit: 500 });
    const images = blobs.map(b => ({
      url: b.url,
      filename: b.pathname.replace('blog-images/', ''),
      uploadedAt: b.uploadedAt
    }));
    images.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    return res.status(200).json(images);
  } catch (err) {
    console.error('blog-images error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
