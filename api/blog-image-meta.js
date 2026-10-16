// api/blog-image-meta.js
// Read/write the per-image metadata registry (api/lib/image-meta.js).
// GET returns the whole registry; POST upserts one record
// ({ pathname, record }) or many ({ records: { pathname: record } }).
// Auth mirrors blog-save exactly: the admin session JWT, or the
// BLOG_AGENT_TOKEN agent bearer (constant-time compare) -- the seed is a
// bulk pass through the agent lane, which is what that credential exists
// for. Failure logs carry agentChecked + presentedShape, never values
// (the PR #66 / #70 log shape).
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
import { readImageMeta, upsertImageMeta, normalizeRecord, validPathname } from './lib/image-meta.js';

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

export default async function handler(req, res) {
  const sentToken = req.headers['x-admin-key'] || '';
  let authKind = null;
  let agentChecked = false;
  const presentedShape = !sentToken ? 'none' : (/^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(sentToken) ? 'jwt' : 'other');
  if (sentToken) {
    try { jwt.verify(sentToken, process.env.JWT_SECRET); authKind = 'session'; } catch (err) { /* not a session JWT: try the agent token below */ }
    if (!authKind && process.env.BLOG_AGENT_TOKEN) {
      agentChecked = true;
      const expected = Buffer.from(process.env.BLOG_AGENT_TOKEN);
      const presented = Buffer.from(sentToken);
      if (presented.length === expected.length && timingSafeEqual(presented, expected)) authKind = 'agent';
    }
  }
  if (!authKind) { console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', agentChecked, presentedShape, time: new Date().toISOString() }); return res.status(401).json({ error: 'Unauthorized' }); }

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';

  if (req.method === 'GET') {
    const meta = await readImageMeta('blog-image-meta.get');
    return res.status(200).json({ records: meta, count: Object.keys(meta).length, auth: authKind });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > 1024 * 1024) return res.status(413).json({ error: 'Request too large' });
  if (!checkRateLimit(ip, 60, 60 * 60 * 1000)) {
    console.warn('[SECURITY] Rate limit exceeded:', { endpoint: req.url, ip, time: new Date().toISOString() });
    return res.status(429).json({ error: 'Too many requests' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'JSON body required' });

  const incoming = {};
  if (body.records && typeof body.records === 'object') {
    for (const [path, rec] of Object.entries(body.records)) incoming[path] = rec;
  } else if (typeof body.pathname === 'string') {
    incoming[body.pathname] = body.record;
  } else {
    return res.status(400).json({ error: 'Provide { pathname, record } or { records }' });
  }

  const paths = Object.keys(incoming);
  if (!paths.length) return res.status(400).json({ error: 'No records provided' });
  if (paths.length > 500) return res.status(400).json({ error: 'Too many records in one request (max 500)' });

  const clean = {};
  const errors = [];
  for (const path of paths) {
    if (!validPathname(path)) { errors.push({ pathname: path, error: 'Invalid pathname' }); continue; }
    const rec = normalizeRecord(incoming[path]);
    if (!rec) { errors.push({ pathname: path, error: 'Invalid record' }); continue; }
    clean[path] = rec;
  }
  if (!Object.keys(clean).length) {
    return res.status(400).json({ error: 'No valid records', errors });
  }

  try {
    const written = await upsertImageMeta(clean, 'blog-image-meta.post');
    console.log('blog-image-meta: upserted ' + written + ' record(s) (auth: ' + authKind + ')');
    return res.status(200).json({ ok: true, written, errors, auth: authKind });
  } catch (err) {
    if (err && err.code === 'INDEX_CONFLICT') {
      return res.status(409).json({ error: 'Registry update refused (concurrent write could not be verified). Nothing was written; retry in a moment.', code: 'INDEX_CONFLICT', retryable: true });
    }
    console.error('blog-image-meta error (auth: ' + authKind + '):', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
