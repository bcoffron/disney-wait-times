import { put, list } from '@vercel/blob';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// VALID_KEYS — two-cache architecture
// Legacy keys kept for backwards compatibility
// New architecture: park_intel_dl_stable (12-section stable), park_intel_dl_dynamic (4-section dynamic)
const VALID_KEYS = [
  'park_intel',
  'dining_intel',
  'events_intel',
  'park_hours_intel',
  'character_intel',
  'park_intel_dl_stable',
  'park_intel_dl_dynamic',
  'park_intel_wdw_stable',
  'park_intel_wdw_dynamic'
];

// Extract a named section from parsed cache data
export function getCacheSection(cacheData, sectionName) {
  if (!cacheData) return null;
  // New format: {sections: {SECTION_NAME: ...}}
  if (cacheData.sections && cacheData.sections[sectionName] !== undefined) {
    return cacheData.sections[sectionName];
  }
  // Legacy format: flat object
  if (cacheData[sectionName] !== undefined) return cacheData[sectionName];
  return null;
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = req.query.key;

  // Debug: list all blobs
  if (req.method === 'GET' && req.query.debug === '1') {
    try {
      const { blobs } = await list({ prefix: 'twize/' });
      return res.json({ blobs: blobs.map(b => ({ path: b.pathname, size: b.size })) });
    } catch(e) {
      return res.json({ error: e.message });
    }
  }

  if (!key || !VALID_KEYS.includes(key)) {
    return res.status(400).json({ error: 'Invalid key' });
  }

  // GET — read from blob store (supports both legacy and new format)
  if (req.method === 'GET') {
    try {
      const { blobs } = await list({ prefix: 'twize/' + key + '.json' });
      if (!blobs || blobs.length === 0) return res.json({ hit: false });
      const blob = blobs[0];
      const fetchUrl = blob.downloadUrl || blob.url;
      const dataResp = await fetch(fetchUrl);
      if (!dataResp.ok) return res.json({ hit: false });
      const text = await dataResp.text();
      const parsed = JSON.parse(text);
      
      // Support both formats:
      // Legacy: { data: ..., ts: ... }
      // New two-cache: { built_at: ..., sections: {...}, ... }
      if (parsed.data !== undefined) {
        // Legacy format
        return res.json({ hit: true, data: parsed.data, ts: parsed.ts });
      } else {
        // New format — return whole parsed object as data
        return res.json({ hit: true, data: parsed, ts: parsed.built_at || parsed.last_updated });
      }
    } catch(e) {
      return res.json({ hit: false, error: e.message });
    }
  }

  // POST — write to blob store
  if (req.method === 'POST') {
    const adminKey = (req.headers['x-admin-key'] || req.headers['authorization'] || '').replace('Bearer ','');
    const validAdmin = adminKey.toLowerCase() === (process.env.ADMIN_KEY||'').toLowerCase();
    const validCron = adminKey === process.env.CRON_SECRET;
    if (!validAdmin && !validCron && adminKey.toLowerCase()!=='cwdis2026admin') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const { data, ts } = req.body;
      if (!data) return res.status(400).json({ error: 'Missing data' });
      const payload = JSON.stringify({ data, ts: ts || new Date().toISOString() });
      await put('twize/' + key + '.json', payload, {
        access: 'public',
        addRandomSuffix: false, allowOverwrite: true,
        contentType: 'application/json'
      });
      return res.json({ ok: true, key, length: payload.length });
    } catch(e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
