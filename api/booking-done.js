// api/booking-done.js
// Booking-reminder done flag (Claude msg 118, Oct 9, 2026). The
// booking reminder is a nudge-until-done: "I made my reservation"
// records a fact about the TRIP (one booking serves the whole party),
// so any member's tap must silence the reminder on every device. This
// endpoint is the tiny bounded write for that fact -- one flag, one
// episode -- plus its readback. The store itself lives in
// api/push-episodes.js (twize/booking-done/<tripId>.json); the flag
// reaches every device as `done` on the episode list GET /api/trip
// already returns, so the poll renderer needs no new read path.
//
// Auth mirrors api/map-diagnostics.js / api/push-test.js exactly: the
// registry resolves the session from the presented code (salted-first
// / bare-fallback read, 60s cache); the code's suffix is never parsed
// and a client-sent role is never read. Writes require an ACTIVE,
// unexpired session -- leader OR guest (party semantics: any member
// may mark done); unknown code -> 401, known-but-inactive/expired ->
// 403. The admin key is accepted as elsewhere in the chain.
//
// The flag records a USER ASSERTION, not a verified booking -- no
// verification is attempted, by design (msg 118). This handler's only
// put target is the booking-done key; it NEVER writes the trip /
// schedule blob, the episodes record, the registry, or marker state.

import { list } from '@vercel/blob';
import { safeTripCode } from './cron-booking-alerts.js';
import { markBookingDone, readBookingDone, safeBookingEpisodeId } from './push-episodes.js';

export { safeTripCode };

// ---- Registry-backed session resolution (restoration step ii) ------------
// Identical shape to api/map-diagnostics.js: salted-first / bare-fallback
// registry read, 60s cache; role resolved SERVER-SIDE from the registry
// entry -- the presented code is only the lookup key.
const _AUTH_SALT = (process.env.BLOB_PATH_SALT || '').trim();
let _authRegCache = null, _authRegCacheAt = 0;
async function _readAuthRegistry() {
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
  return _authRegCache;
}
async function _resolveTripSession(code) {
  if (!code || typeof code !== 'string') return null;
  const _reg = await _readAuthRegistry();
  const _entry = _reg && _reg[code];
  if (!_entry) return null;
  let _expired = false;
  if (_entry.expires) {
    const _exp = new Date(_entry.expires + 'T23:59:59Z');
    if (!isNaN(_exp) && _exp < new Date()) _expired = true;
  }
  return { code: code, tripId: _entry.tripId, role: _entry.role || '', status: _entry.status || '', expires: _entry.expires || null, expired: _expired };
}
// Active session: any role (leader or guest) on an active, unexpired
// registry entry -- the test api/trip.js applies, minus any role gate.
function _isActiveSession(s) {
  return !!s && s.status === 'active' && !s.expired;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-trip-code, x-admin-key');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const _adminKey = (process.env.ADMIN_KEY || '').toLowerCase();
    const _sentAdmin = (req.headers['x-admin-key'] || '').toLowerCase();
    const _isAdmin = _adminKey.length > 0 && _sentAdmin === _adminKey;

    if (req.method === 'GET') {
      let qCode = '';
      try { qCode = new URL(req.url, 'http://localhost').searchParams.get('code') || ''; } catch (e) { qCode = ''; }
      const code = safeTripCode(qCode || req.headers['x-trip-code'] || '');
      if (!code) return res.status(400).json({ error: 'Missing or invalid trip code' });
      const session = await _resolveTripSession(code);
      if (!session) return res.status(401).json({ error: 'Unauthorized' });
      if (!_isAdmin && !_isActiveSession(session)) {
        return res.status(403).json({ error: 'Trip code is not active.', role: session.role || '', status: session.status || '' });
      }
      const done = await readBookingDone(session.tripId);
      return res.status(200).json({ ok: true, tripId: session.tripId || '', done: done });
    }

    // ---- POST: mark one booking episode done for the trip -------------
    var raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    if (raw && raw.length > 16 * 1024) return res.status(413).json({ error: 'Payload too large' });
    var body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // SESSION FIRST (the (ii) chain): registry resolves the session;
    // leader OR guest may write, but the session must be active.
    const tripCode = safeTripCode(body.tripCode || body.code || req.headers['x-trip-code'] || '');
    if (!tripCode) return res.status(400).json({ error: 'Missing or invalid trip code' });
    const session = await _resolveTripSession(tripCode);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    if (!_isAdmin && !_isActiveSession(session)) {
      return res.status(403).json({ error: 'Trip code is not active.', role: session.role || '', status: session.status || '' });
    }

    const episodeId = safeBookingEpisodeId(typeof body.episodeId === 'string' ? body.episodeId : '');
    if (!episodeId) return res.status(400).json({ error: 'Missing or invalid episodeId' });

    // The write is keyed by the RESOLVED tripId -- the flag is a trip
    // fact, so a guest's tap lands in the same store the leader's poll
    // reads. Only the booking-done blob is touched.
    const stored = await markBookingDone(session.tripId, episodeId, session.role);
    if (!stored) return res.status(500).json({ error: 'Done flag could not be stored' });
    return res.status(200).json({ ok: true, episodeId: episodeId, done: true });
  } catch (e) {
    console.error('[booking-done] error', e.message);
    return res.status(400).json({ error: e.message });
  }
}
