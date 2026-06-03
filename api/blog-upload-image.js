import jwt from 'jsonwebtoken';
import { put } from '@vercel/blob';

const rl = {};

export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  const sentToken = req.headers['x-admin-key'] || '';
  try {
    jwt.verify(sentToken, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
  rl[ip].count++;
  if (rl[ip].count > 20) return res.status(429).json({ error: 'Rate limit exceeded' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
