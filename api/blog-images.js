import jwt from 'jsonwebtoken';
import { list, del } from '@vercel/blob';

const rl = {};

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
    if (rl[ip].count > 60) return res.status(429).json({ error: 'Rate limit exceeded' });

  if (req.method === 'GET') {
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
                console.error('blog-images GET error:', err);
                return res.status(500).json({ error: 'Internal server error' });
        }
  }

  if (req.method === 'DELETE') {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'url required' });
        try {
                await del(url);
                return res.status(200).json({ success: true });
        } catch (err) {
                console.error('blog-images DELETE error:', err);
                return res.status(500).json({ error: 'Delete failed: ' + err.message });
        }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
