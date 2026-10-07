// api/push-register.js
// Registers a native app device token (APNs) for wait-time alerts on a trip.
// Sibling of api/push-subscribe.js (Web Push), but keyed by APNs device token
// instead of a web subscription, and authenticated the way the locked-down
// endpoints are (Oct 2026): the trip code must exist in the trip registry --
// the old shape-only check is not enough. Admin key also accepted.
//
// Storage: one blob per trip at twize/push-devices/<tripCode>.json holding
// { tripCode, devices: [{ token, platform, alertsEnabled, appVersion, added,
// updated }], updated }, de-duped by token. The wait-monitor
// (api/cron-push-monitor.js) discovers trips from this prefix and sends via
// api/apns.js. Web subscriptions stay in twize/push-subs/ so the two channels
// prune independently.
//
// POST body: { tripCode, platform: 'ios', token, alertsEnabled?, appVersion?,
//              action?: 'register' | 'unregister' }
// Response: { ok: true, count } -- count of devices now stored for the trip.

import { list } from '@vercel/blob';

const MAX_BODY = 16 * 1024; // a registration is tiny
export const MAX_DEVICES_PER_TRIP = 20;

// ---- Registry-backed trip-code validation (same pattern as
// api/generateschedule.js: salted-first / bare-fallback read, 60s cache) ----
const _AUTH_SALT = (process.env.BLOB_PATH_SALT || '').trim();
let _authRegCache = null, _authRegCacheAt = 0;
async function _isRegisteredTripCode(code) {
  if (!code || typeof code !== 'string') return false;
  try {
    if (!_authRegCache || Date.now() - _authRegCacheAt > 60000) {
      const _keys = _AUTH_SALT ? ['twize/' + _AUTH_SALT + '/trip_registry.json', 'twize/trip_registry.json'] : ['twize/trip_registry.json'];
      for (const _k of _keys) {
        const { blobs } = await list({ prefix: _k });
        if (blobs && blobs.length) {
          const _r = await fetch(blobs[0].url);
          if (_r.ok) { _authRegCache = await _r.json(); _authRegCacheAt = Date.now(); break; }
        }
      }
    }
  } catch (e) { /* fall through to whatever cache we have (fail closed if none) */ }
  return !!(_authRegCache && _authRegCache[code]);
}

function blobKeyFor(tripCode) {
  // tripCode already validated to a safe charset before this is called
  return 'twize/push-devices/' + tripCode + '.json';
}

function safeTripCode(raw) {
  if (typeof raw !== 'string') return '';
  var t = raw.trim();
  // allow letters, digits, dash; 8..40 chars (e.g. BCDIS2026-A)
  if (!/^[A-Za-z0-9-]{8,40}$/.test(t)) return '';
  return t;
}

// APNs device tokens are hex strings (64 chars historically, longer on newer
// iOS). Never log more than the last 4 characters of one.
function safeDeviceToken(raw) {
  if (typeof raw !== 'string') return '';
  var t = raw.trim();
  if (!/^[0-9a-fA-F]{64,200}$/.test(t)) return '';
  return t;
}

async function readDevices(tripCode) {
  try {
    const { blobs } = await list({ prefix: blobKeyFor(tripCode) });
    if (!blobs || blobs.length === 0) return [];
    const resp = await fetch(blobs[0].url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data.devices) ? data.devices : [];
  } catch (e) {
    console.error('[push-register] read error', e.message);
    return [];
  }
}

async function writeDevices(tripCode, devices) {
  const { put } = await import('@vercel/blob');
  const payload = JSON.stringify({ tripCode: tripCode, devices: devices, updated: new Date().toISOString() });
  await put(blobKeyFor(tripCode), payload, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json'
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-trip-code, x-admin-key');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    if (raw && raw.length > MAX_BODY) return res.status(413).json({ error: 'Payload too large' });
    var body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // ---- AUTH FIRST: registered trip code (registry-backed) or admin key ----
    const _adminKey = (process.env.ADMIN_KEY || '').toLowerCase();
    const sentAdmin = (req.headers['x-admin-key'] || body.adminKey || '').toLowerCase();
    const tripCode = safeTripCode(body.tripCode || req.headers['x-trip-code'] || '');
    const isAdmin = _adminKey.length > 0 && sentAdmin === _adminKey;
    if (!tripCode) return res.status(400).json({ error: 'Missing or invalid trip code' });
    if (!isAdmin && !(await _isRegisteredTripCode(tripCode))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // ---- VALIDATE ----
    const action = body.action === 'unregister' ? 'unregister' : 'register';
    const token = safeDeviceToken(body.token || '');
    if (!token) return res.status(400).json({ error: 'Invalid device token' });
    if (action === 'register' && body.platform !== 'ios') {
      return res.status(400).json({ error: 'platform must be ios' });
    }
    const alertsEnabled = body.alertsEnabled !== false; // default on
    const appVersion = (typeof body.appVersion === 'string' && body.appVersion.length <= 20) ? body.appVersion : undefined;

    // ---- STORE (de-dupe by token) ----
    var devices = await readDevices(tripCode);
    if (action === 'unregister') {
      devices = devices.filter(function (d) { return !(d && d.token === token); });
    } else {
      var now = new Date().toISOString();
      var existingIdx = devices.findIndex(function (d) { return d && d.token === token; });
      var entry = {
        token: token, platform: 'ios', alertsEnabled: alertsEnabled,
        added: existingIdx > -1 && devices[existingIdx].added ? devices[existingIdx].added : now,
        updated: now
      };
      if (appVersion) entry.appVersion = appVersion;
      if (existingIdx > -1) devices[existingIdx] = entry; else devices.push(entry);
      if (devices.length > MAX_DEVICES_PER_TRIP) devices = devices.slice(-MAX_DEVICES_PER_TRIP);
    }
    await writeDevices(tripCode, devices);

    console.log('[push-register] ' + action + ' trip', tripCode, '| token ...' + token.slice(-4), '| total', devices.length);
    return res.status(200).json({ ok: true, count: devices.length });
  } catch (e) {
    console.error('[push-register] error', e.message);
    return res.status(400).json({ error: e.message });
  }
}
