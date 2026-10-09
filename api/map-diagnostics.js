// api/map-diagnostics.js
// Map diagnostics beacon store (Claude msg 120, item 5, Oct 9, 2026).
// Two fix rounds failed on WKWebView while passing Chromium, and every
// instrument the client had ([map] console lines, the F4 real-error
// log) wrote to a console nobody can read on a device. This endpoint
// is the readable channel: the client POSTs ONE whitelisted telemetry
// event per full-map open (sizes, marker counts vs data-derived
// expectations, flags, a redacted error), and the events are read
// back with GET ?code= -- Muse's curl path, at parity with
// GET /api/trip?code=.
//
// Auth mirrors api/push-test.js's session discipline exactly: the
// registry resolves the session from the presented code (salted-first
// / bare-fallback read, 60s cache); the code's suffix is never
// parsed and a client-sent role is never read. Writes require an
// ACTIVE, unexpired session -- leader OR guest (both use the map);
// unknown code -> 401, known-but-inactive/expired -> 403. The admin
// key is accepted as elsewhere in the chain. GET uses the same
// resolution (the trip code is itself the credential, exactly as on
// GET /api/trip); reads merge every registry code resolving to the
// trip (the leader/guest pair), so one readback sees both buckets.
//
// Storage mirrors api/push-episodes.js's Blob pattern at
// twize/map-diagnostics/<code>.json: a ring of the last ~100 events
// AND a 7-day TTL (shorter bound wins), merged by eventId so a
// retried POST cannot duplicate. Every stored event is re-whitelisted
// server-side (unknown fields dropped even if a client sends them),
// field-capped, and hard-capped at 16 KB. This handler's only put
// target is its own diagnostics key -- it NEVER writes the trip /
// schedule blob, the registry, or any marker state.

import { list, put } from '@vercel/blob';
import { safeTripCode } from './cron-booking-alerts.js';

export { safeTripCode };

export const DIAG_MAX_EVENTS = 100;
export const DIAG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DIAG_EVENT_MAX_BYTES = 16 * 1024;
const DIAG_BODY_MAX = 96 * 1024;
const DIAG_MAX_PER_POST = 5;

// ---- Registry-backed session resolution (restoration step ii) ------------
// Identical shape to api/push-test.js: salted-first / bare-fallback
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
// registry entry -- the test api/trip.js applies, minus the leader
// role gate push-test needs for sends.
function _isActiveSession(s) {
  return !!s && s.status === 'active' && !s.expired;
}
// Every registry code resolving to this trip (the leader/guest pair),
// presented code first -- the push-test tripCodesFor shape. Codes are
// registry keys; each is re-checked against safeTripCode before it is
// ever used in a blob path.
async function tripCodesFor(session, presentedCode) {
  const reg = await _readAuthRegistry();
  const codes = [];
  if (presentedCode) codes.push(presentedCode);
  if (reg && session.tripId) {
    for (const c of Object.keys(reg)) {
      if (c === presentedCode) continue;
      if (reg[c] && reg[c].tripId === session.tripId && safeTripCode(c) === c) codes.push(c);
    }
  }
  return codes;
}

// ---- blob helpers (the push-episodes shapes) ------------------------------
function diagKey(code) { return 'twize/map-diagnostics/' + code + '.json'; }
async function readBlobJson(pathname) {
  try {
    const { blobs } = await list({ prefix: pathname });
    const hit = (blobs || []).find(b => b.pathname === pathname);
    if (!hit) return null;
    const res = await fetch(hit.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}
async function writeJsonBlob(pathname, obj) {
  await put(pathname, JSON.stringify(obj), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
}

// ---- event whitelist (server-side; the client list is not trusted) ------
function _num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
function _numArr(v, n) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (let i = 0; i < n; i++) { const x = _num(v[i]); if (x === null) return null; out.push(x); }
  return out;
}
function _str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function _count(v) { const n = _num(v); return (n === null || n < 0) ? 0 : Math.floor(n); }

// Normalize one raw event to the stored shape. Returns null when the
// event is unusable. Field caps mirror the diagnosis spec (name 80,
// message 300, stack 500) and the stored event is hard-capped at
// DIAG_EVENT_MAX_BYTES (stack dropped first if it ever comes close).
export function sanitizeDiagEvent(raw, nowMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const e = { v: 1, type: 'map-open' };
  e.eventId = _str(raw.eventId, 80) || ('srv-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8));
  const ts = _num(raw.ts);
  e.ts = (ts && ts > 0) ? ts : now;
  e.bundle = _str(raw.bundle, 40);
  e.sessionId = _str(raw.sessionId, 60);
  e.openSeq = _count(raw.openSeq);
  e.outcome = raw.outcome === 'ok' ? 'ok' : 'fail';
  e.phases = Array.isArray(raw.phases)
    ? raw.phases.filter(p => typeof p === 'string').slice(0, 12).map(p => p.slice(0, 40))
    : [];
  e.error = null;
  if (raw.error && typeof raw.error === 'object' && !Array.isArray(raw.error)) {
    e.error = {
      name: _str(raw.error.name, 80),
      message: _str(raw.error.message, 300),
      stackTop: _str(raw.error.stackTop, 500)
    };
  }
  const sz = (raw.sizes && typeof raw.sizes === 'object' && !Array.isArray(raw.sizes)) ? raw.sizes : {};
  e.sizes = {
    viewClient: _numArr(sz.viewClient, 2),
    hostClient: _numArr(sz.hostClient, 2),
    window: _numArr(sz.window, 2),
    visualViewport: _numArr(sz.visualViewport, 3),
    map: _numArr(sz.map, 2),
    svg: _numArr(sz.svg, 2)
  };
  const vw = (raw.view && typeof raw.view === 'object' && !Array.isArray(raw.view)) ? raw.view : {};
  e.view = {
    zoom: _num(vw.zoom),
    center: _numArr(vw.center, 2),
    bounds: Array.isArray(vw.bounds) ? [_numArr(vw.bounds[0], 2), _numArr(vw.bounds[1], 2)] : null
  };
  const ct = (raw.counts && typeof raw.counts === 'object' && !Array.isArray(raw.counts)) ? raw.counts : {};
  e.counts = {
    places: _count(ct.places), rr: _count(ct.rr), svc: _count(ct.svc), se: _count(ct.se),
    always: _count(ct.always), total: _count(ct.total), expected: _count(ct.expected), tiles: _count(ct.tiles)
  };
  // Non-exact tiles at settle (Claude msg 124, C): tiles that resolved
  // to the 1x1 fallback or an ancestor substitution because their key
  // is absent from the merged pack. One flat whitelisted count -- the
  // zoom watchdog's guard cannot see absent keys; this field can.
  e.fallbackTiles = _count(raw.fallbackTiles);
  const fl = (raw.flags && typeof raw.flags === 'object' && !Array.isArray(raw.flags)) ? raw.flags : {};
  e.flags = {
    routerPresent: !!fl.routerPresent,
    leafletPresent: !!fl.leafletPresent,
    loaded: !!fl.loaded,
    buildComplete: !!fl.buildComplete
  };
  if (JSON.stringify(e).length > DIAG_EVENT_MAX_BYTES) {
    if (e.error) e.error.stackTop = '';
    if (JSON.stringify(e).length > DIAG_EVENT_MAX_BYTES) return null;
  }
  return e;
}

// The retention rule, pure: drop malformed entries, drop anything
// older than the 7-day TTL (a small future skew is tolerated),
// order oldest-first, keep only the newest DIAG_MAX_EVENTS.
export function pruneDiagEvents(listIn, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const arr = (Array.isArray(listIn) ? listIn : []).filter(function (e) {
    return e && typeof e.eventId === 'string' && typeof e.ts === 'number'
      && (now - e.ts) <= DIAG_TTL_MS && e.ts <= now + 5 * 60 * 1000;
  });
  arr.sort(function (a, b) { return a.ts - b.ts; });
  return arr.slice(-DIAG_MAX_EVENTS);
}

// Merge incoming events into a stored list under the retention rule.
// A re-POST of the same eventId replaces the earlier copy (a retried
// fire-and-forget POST is one event, stored once).
export function mergeDiagEvents(listIn, incoming, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const byId = new Map();
  for (const e of pruneDiagEvents(listIn, now)) byId.set(e.eventId, e);
  for (const e of (Array.isArray(incoming) ? incoming : [])) { if (e && e.eventId) byId.set(e.eventId, e); }
  return pruneDiagEvents(Array.from(byId.values()), now);
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
      const codes = await tripCodesFor(session, code);
      let events = [];
      for (const c of codes) {
        const cur = await readBlobJson(diagKey(c));
        if (cur && Array.isArray(cur.events)) events = events.concat(cur.events);
      }
      events = pruneDiagEvents(events, Date.now());
      return res.status(200).json({ ok: true, tripId: session.tripId || '', count: events.length, events: events });
    }

    // ---- POST: store one open's event (or a small batch) ----------------
    var raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    if (raw && raw.length > DIAG_BODY_MAX) return res.status(413).json({ error: 'Payload too large' });
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

    let incoming = [];
    if (Array.isArray(body.events)) incoming = body.events;
    else if (body.event) incoming = [body.event];
    else if (body.type) incoming = [body];
    if (incoming.length > DIAG_MAX_PER_POST) return res.status(413).json({ error: 'Too many events' });
    const nowMs = Date.now();
    const clean = incoming.map(e => sanitizeDiagEvent(e, nowMs)).filter(Boolean);
    if (!clean.length) return res.status(400).json({ error: 'No valid event' });

    const key = diagKey(tripCode);
    const cur = await readBlobJson(key);
    const merged = mergeDiagEvents(cur && cur.events, clean, nowMs);
    await writeJsonBlob(key, { tripCode: tripCode, events: merged, updated: new Date(nowMs).toISOString() });
    return res.status(200).json({ ok: true, stored: clean.length, total: merged.length });
  } catch (e) {
    console.error('[map-diagnostics] error', e.message);
    return res.status(400).json({ error: e.message });
  }
}
