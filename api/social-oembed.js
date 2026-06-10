// api/social-oembed.js
import jwt from 'jsonwebtoken';

const ALLOWED_ORIGIN = 'https://themeparkcopilot.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // JWT verification first -- same pattern as blog-save.js
  const sentToken = req.headers['x-admin-key'] || '';
  if (!sentToken) {
    console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    jwt.verify(sentToken, process.env.JWT_SECRET);
  } catch (err) {
    console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const MAX_REQUEST_SIZE = 500 * 1024;
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > MAX_REQUEST_SIZE) {
    return res.status(413).json({ error: 'Request too large' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { url } = body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL required' });
  }

  const trimmed = url.trim();

  // Detect platform
  let platform = null;
  if (trimmed.includes('tiktok.com')) platform = 'tiktok';
  else if (trimmed.includes('instagram.com')) platform = 'instagram';

  if (!platform) {
    return res.status(400).json({ error: 'Only TikTok and Instagram URLs are supported' });
  }

  try {
    let embedHtml = null;

    if (platform === 'tiktok') {
      const apiUrl = 'https://www.tiktok.com/oembed?url=' + encodeURIComponent(trimmed);
      const response = await fetch(apiUrl);
      if (!response.ok) {
        return res.status(400).json({ error: 'TikTok could not find that video. Make sure it is a public post.' });
      }
      const data = await response.json();
      embedHtml = data.html;
    }

    if (platform === 'instagram') {
      const igToken = process.env.META_ACCESS_TOKEN;
      if (!igToken) {
        return res.status(501).json({ error: 'Instagram embeds are not configured yet. Use TikTok or paste a YouTube embed code instead.' });
      }
      const apiUrl = 'https://graph.facebook.com/v19.0/instagram_oembed?url=' + encodeURIComponent(trimmed) + '&access_token=' + igToken;
      const response = await fetch(apiUrl);
      if (!response.ok) {
        return res.status(400).json({ error: 'Instagram could not find that post. Make sure it is a public post.' });
      }
      const data = await response.json();
      embedHtml = data.html;
    }

    if (!embedHtml) {
      return res.status(400).json({ error: 'Could not get embed HTML from that URL.' });
    }

    return res.status(200).json({ html: embedHtml });

  } catch (err) {
    console.error('social-oembed error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch embed. Try again.' });
  }
}
