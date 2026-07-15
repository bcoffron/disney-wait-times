import jwt from 'jsonwebtoken';
import { put, list } from '@vercel/blob';

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

async function readBlob(pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
  const matches = (blobs || []).filter(b => b.pathname === pathname)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) return null;
  const r = await fetch(matches[0].downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.text().then(t => JSON.parse(t));
}

export default async function handler(req, res) {
  // Fix 5: JWT verification FIRST before any data processing
  const sentToken = req.headers['x-admin-key'] || '';
  if (!sentToken) { console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() }); return res.status(401).json({ error: 'Unauthorized' }); }
  try {
    jwt.verify(sentToken, process.env.JWT_SECRET);
  } catch (err) {
    console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const MAX_REQUEST_SIZE = 500 * 1024; // 500KB
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > MAX_REQUEST_SIZE) {
    return res.status(413).json({ error: 'Request too large' });
  }

  // Fix 1: Rate limiting — 30 saves per IP per hour
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 30, 60 * 60 * 1000)) {
    console.warn('[SECURITY] Rate limit exceeded:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', time: new Date().toISOString() });
    return res.status(429).json({ error: 'Too many requests' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const post = body;
  if (!post || !post.slug) return res.status(400).json({ error: 'slug required' });
  if (!/^[a-z0-9-]+$/.test(post.slug)) return res.status(400).json({ error: 'Invalid slug format' });

  post.updatedAt = new Date().toISOString();

  if (post.body && typeof post.body === 'string') {
    post.body = post.body.replace(/<img([^>]*?)>/gi, function(match, attrs) {
      attrs = attrs.replace(/\s*(width|height|style)=["'][^"']*["']/gi, '');
      return '<img' + attrs + '>';
    });
  }

  try {
    await put('blog/posts/' + post.slug, JSON.stringify(post), { access: 'public', allowOverwrite: true });

    let currentIndex = (await readBlob('blog/posts/index')) || [];
    const existingEntry = currentIndex.find(p => p.slug === post.slug);
    const meta = {
      slug: post.slug, title: post.title, park: post.park,
      category: post.category, tagLabel: post.tagLabel,
      heroImage: post.heroImage, heroAlt: post.heroAlt,
      intro: post.intro, readTime: post.readTime,
      publishedAt: existingEntry && existingEntry.publishedAt
        ? existingEntry.publishedAt
        : post.publishedAt, updatedAt: post.updatedAt,
      published: post.published,
      tags: post.tags || [],
      bodySnippet: (post.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 2000)
    };
    const idx = currentIndex.findIndex(p => p.slug === post.slug);
    if (idx >= 0) currentIndex[idx] = meta; else currentIndex.push(meta);
    await put('blog/posts/index', JSON.stringify(currentIndex), { access: 'public', allowOverwrite: true, token: process.env.BLOB_READ_WRITE_TOKEN });

    return res.status(200).json({ success: true, slug: post.slug, updatedAt: post.updatedAt });
  } catch (err) {
    console.error('blog-save error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
