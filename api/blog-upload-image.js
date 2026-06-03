import { put } from '@vercel/blob';

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

export const config = {
  api: {
    bodyParser: false
  }
};

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

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const filename = req.headers['x-filename'] || ('upload-' + Date.now() + '.jpg');
    const contentType = req.headers['content-type'] || 'image/jpeg';

    const blob = await put('blog-images/' + filename, req, {
      access: 'public',
      contentType: contentType,
      allowOverwrite: true
    });

    return res.status(200).json({
      url: blob.url,
      filename: filename,
      uploadedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('blog-upload-image error:', err);
    return res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
}
