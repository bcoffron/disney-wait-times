// api/trip.js - Trip code registry handler
import { put, list } from '@vercel/blob';
import { validateSchedule } from './validate-schedule.js';

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


function sanitizeJson(text) {
  const lastBrace = text.lastIndexOf('}' + '}');
  if (lastBrace > -1) return text.substring(0, lastBrace + 2);
  return text;
}

async function readTripBlob(tripId) {
  try {
    const key = 'twize/trip_' + tripId + '.json';
    const { blobs } = await list({ prefix: key });
    if (!blobs || blobs.length === 0) return null;
    const resp = await fetch(blobs[0].url + '?t=' + Date.now());
    if (!resp.ok) return null;
    const rawText = await resp.text();
    return JSON.parse(sanitizeJson(rawText));
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_KEY = (process.env.ADMIN_KEY || 'tpcp2026admin').toLowerCase();

  // GET: look up a code
  if (req.method === 'GET') {
    const code = (req.query.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const registry = await readRegistry();
    const entry = registry[code];
    if (!entry) return res.status(404).json({ error: 'Code not found', valid: false });

    if (entry.status !== 'active') return res.status(403).json({ error: 'Code inactive', valid: false });

    if (entry.expires) {
      const expDate = new Date(entry.expires + 'T23:59:59Z');
      if (expDate < new Date()) return res.status(403).json({ error: 'Code expired', expires: entry.expires, valid: false });
    }

    // Check if trip data exists
    let tripData = await readTripBlob(entry.tripId);
    const hasTrip = !!tripData;

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

  // POST: save trip data for a code (requires admin key)
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

      // Auto-stamp scheduleVersion so client caches are invalidated on every save
      if (tripData && tripData.tripConfig) {
        tripData.tripConfig.scheduleVersion = Date.now().toString();
      }
                  // Validate schedule before saving
      if (tripData && tripData.tripConfig && tripData.tripConfig.schedule) {
        try {
          const valResult = validateSchedule(
            tripData.tripConfig.schedule,
            tripData.tripConfig
          );
          if (valResult.hardViolations && valResult.hardViolations.length > 0) {
            return res.status(400).json({
              error: 'Schedule validation failed',
              violations: valResult.hardViolations
            });
          }
          tripData.tripConfig.schedule = valResult.schedule;
          if (valResult.corrections && valResult.corrections.length > 0) {
            console.log('[validator] Auto-corrections applied:', JSON.stringify(valResult.corrections));
          }
        } catch (err) {
          console.error('[validator] Error:', err.message);
          // Do not block save on validator error - log and continue
        }
      }
// Save to shared trip blob
      await writeTripBlob(entry.tripId, tripData);
    const _blobBodyLen = JSON.stringify(tripData).length;
    console.log('[ptFinish] trip blob write status: 200, bytes written: ' + _blobBodyLen + ', tripId: ' + entry.tripId);

      return res.status(200).json({ ok: true, tripId: entry.tripId });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  // PUT: admin registry management (seed codes, update registry)
  if (req.method === 'PUT') {
    const sentKey = (req.headers['x-admin-key'] || '').toLowerCase();
    if (sentKey !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });

    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      if (body.action === 'init_registry') {
        // Initialize or merge registry entries
        const registry = await readRegistry();
        const entries = body.entries || {};
        Object.assign(registry, entries);
        await writeRegistry(registry);
        return res.status(200).json({ ok: true, codes: Object.keys(registry) });
      }

      if (body.action === 'seed_trip') {
        // Seed a trip's data blob directly
        const { tripId, tripData } = body;
        if (!tripId || tripData === undefined) return res.status(400).json({ error: 'Missing tripId or tripData' });
        await writeTripBlob(tripId, tripData);
        return res.status(200).json({ ok: true, tripId });
      }

      return res.status(400).json({ error: 'Unknown action' });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

handler.config = { maxDuration: 15 };
