// api/cache.js - Server-side cache for ThemeParkWize intelligence caches
// Stores: park_intel, dining_intel, events_intel, park_hours_intel
// Uses Vercel's /tmp directory for persistence within a deployment
// Falls back gracefully - client always has localStorage as backup

const fs = require('fs');
const path = require('path');

const CACHE_DIR = '/tmp/twcache';
const VALID_KEYS = ['park_intel', 'dining_intel', 'events_intel', 'park_hours_intel'];

function ensureDir() {
  try { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, {recursive: true}); } catch(e) {}
}

function getCacheFile(key) {
  return path.join(CACHE_DIR, key + '.json');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { key } = req.query;
  if (!key || !VALID_KEYS.includes(key)) {
    return res.status(400).json({ error: 'Invalid cache key' });
  }

  ensureDir();
  const file = getCacheFile(key);

  if (req.method === 'GET') {
    try {
      if (!fs.existsSync(file)) return res.status(200).json({ hit: false });
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return res.status(200).json({ hit: true, data: data.value, ts: data.ts, key });
    } catch(e) {
      return res.status(200).json({ hit: false });
    }
  }

  if (req.method === 'POST') {
    try {
      const { value, ts } = req.body;
      if (value === undefined) return res.status(400).json({ error: 'Missing value' });
      fs.writeFileSync(file, JSON.stringify({ value, ts: ts || Date.now(), key }));
      return res.status(200).json({ ok: true, key, ts: ts || Date.now() });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};