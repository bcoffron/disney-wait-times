// api/blog-index.js - GET /api/blog-index - public, cached
import { list } from '@vercel/blob';
const rl = {};

async function readBlob(pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 10 });
  const matches = (blobs || []).filter(b => b.pathname === pathname).sort((a,b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) return null;
  const r = await fetch(matches[0].url);
  if (!r.ok) return null;
  return r.text().then(t => JSON.parse(t));
}
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
  rl[ip].count++;
  if (rl[ip].count > 20) return res.status(429).json({ error: 'Rate limit exceeded' });
  try {
    const index = await readBlob('blog/posts/index');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(index || []);
  } catch (err) {
    console.error('blog-index error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};