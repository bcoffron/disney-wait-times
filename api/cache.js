import { list } from '@vercel/blob';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const VALID_KEYS = ['park_intel','dining_intel','events_intel','park_hours_intel'];

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = req.query.key;

  // Debug: list all blobs
  if (req.method === 'GET' && req.query.debug === '1') {
    try {
      const { blobs } = await list({ prefix: 'twize/' });
      return res.json({ blobs: blobs.map(b => ({ path: b.pathname, size: b.size, url: b.url })) });
    } catch(e) {
      return res.json({ error: e.message });
    }
  }

  if (!key || !VALID_KEYS.includes(key)) {
    return res.status(400).json({ error: 'Invalid key' });
  }

  // GET — read from blob store
  if (req.method === 'GET') {
    try {
      const { blobs } = await list({ prefix: 'twize/' + key + '.json' });
      if (!blobs || blobs.length === 0) return res.json({ hit: false, reason: 'no_blobs' });
      const blob = blobs[0];
      const dataResp = await fetch(blob.url);
      if (!dataResp.ok) return res.json({ hit: false, reason: 'fetch_failed', blobUrl: blob.url.substring(0,40) });
      const text = await dataResp.text();
      const parsed = JSON.parse(text);
      return res.json({ hit: true, data: parsed.data, ts: parsed.ts });
    } catch(e) {
      return res.json({ hit: false, error: e.message });
    }
  }

  // POST — delegate to cron-cache which handles blob writes correctly
  if (req.method === 'POST') {
    const adminKey = (req.headers['x-admin-key'] || req.headers['authorization'] || '').replace('Bearer ','');
    const validAdmin = adminKey.toLowerCase() === (process.env.ADMIN_KEY||'').toLowerCase();
    const validCron = adminKey === process.env.CRON_SECRET;
    if (!validAdmin && !validCron) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Trigger cron to rebuild this key
    const cronUrl = 'https://' + req.headers.host + '/api/cron-cache?key=' + key;
    const cronResp = await fetch(cronUrl, {
      headers: { 'Authorization': 'Bearer ' + process.env.CRON_SECRET }
    });
    const cronData = await cronResp.json();
    return res.json(cronData);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
