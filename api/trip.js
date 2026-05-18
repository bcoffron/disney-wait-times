// api/trip.js - Trip code registry handler
const { put, list } = require('@vercel/blob');

const REGISTRY_KEY = 'twize/trip_registry.json';

async function readRegistry() {
  try {
    const { blobs } = await list({ prefix: REGISTRY_KEY });
    if (!blobs || blobs.length === 0) return {};
    const resp = await fetch(blobs[0].url);
    if (!resp.ok) return {};
    return await resp.json();
  } catch (e) {
    console.error('trip registry read error', e.message);
    return {};
  }
}

async function writeRegistry(data) {
  await put(REGISTRY_KEY, JSON.stringify(data), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json'
  });
}

async function readTripBlob(tripId) {
  try {
    const key = 'twize/trip_' + tripId + '.json';
    const { blobs } = await list({ prefix: key });
    if (!blobs || blobs.length === 0) return null;
    const resp = await fetch(blobs[0].url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) { return null; }
}

async function writeTripBlob(tripId, tripData) {
  const key = 'twize/trip_' + tripId + '.json';
  await put(key, JSON.stringify(tripData), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json'
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_KEY = (process.env.ADMIN_KEY || 'CWdis2026admin').toLowerCase();

  if (req.method === 'GET') {
    const code = (req.query.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const registry = await readRegistry();
    const entry = registry[code];
    if (!entry) return res.status(404).json({ error: 'Code not found', valid: false });

    // Check status
    if (entry.status !== 'active') return res.status(403).json({ error: 'Code inactive', valid: false });

    // Check expiry
    if (entry.expires) {
      const expDate = new Date(entry.expires + 'T23:59:59Z');
      if (expDate < new Date()) return res.status(403).json({ error: 'Code expired', valid: false });
    }

    // Check if tripData exists (either inline or in trip blob)
    let hasTrip = false;
    let tripData = entry.tripData || null;

    if (!tripData) {
      // Try the shared trip blob
      tripData = await readTripBlob(entry.tripId);
    }

    hasTrip = !!tripData;

    return res.status(200).json({
      valid: true,
      role: entry.role,
      tripId: entry.tripId,
      status: entry.status,
      expires: entry.expires,
      hasTrip,
      tripData: hasTrip ? tripData : null
    });
  }

  if (req.method === 'POST') {
    const sentKey = (req.headers['x-admin-key'] || '').toLowerCase();
    if (sentKey !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });

    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { code, tripData } = body;
      if (!code || !tripData) return res.status(400).json({ error: 'Missing code or tripData' });

      const registry = await readRegistry();
      const entry = registry[code];
      if (!entry) return res.status(404).json({ error: 'Code not found' });

      // Save to shared trip blob (accessible by both admin + guest codes)
      await writeTripBlob(entry.tripId, tripData);

      // Update registry entry
      registry[code].tripData = null; // pointer only, actual data in trip blob
      await writeRegistry(registry);

      return res.status(200).json({ ok: true, tripId: entry.tripId });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

module.exports.config = { maxDuration: 15 };
