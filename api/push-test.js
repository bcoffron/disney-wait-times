// api/push-test.js
// On-demand push TEST for the trip leader (Claude msg 76, Oct 8, 2026).
// Beau's ask: pushes could only be exercised once a day by the crons, so
// a broken chain surfaced only at the next morning's firing. This
// endpoint lets the leader fire ONE unmistakably-a-test alert at will,
// through the REAL production send path, and read back an honest
// synchronous outcome. It exists to prove the chain on demand -- tonight
// it is the first real-phone proof, a day ahead of the cron's.
//
// Design (msg 76 rulings):
//   * REAL PATH, ONLY THE TRIGGER DIFFERS: sends go through
//     fireTripPush() from api/cron-booking-alerts.js -- the exact
//     dual-channel implementation (Web Push + APNs) the booking cron
//     uses, with the same dead-sub / dead-token pruning.
//   * TARGETS: ALL registered devices on the trip -- every device file /
//     subscription bucket under EVERY registry code resolving to the
//     trip (leader + guest pair). Leader-only targeting was rejected:
//     it cannot prove the pair, and the guest half is the most
//     under-tested surface in the restoration.
//   * NO MARKERS, EVER (non-negotiable): this handler never reads or
//     writes booking-alert state (twize/booking-alert-state/*) or
//     push-monitor state. A test can never consume or suppress a real
//     alert. The only blob it writes is its own rate-cap record.
//   * LEADER-ONLY, session-resolved: the caller is resolved from the
//     registry via _resolveTripSession (the restoration step-(ii)
//     chain -- registry is the source of role; the code's suffix is
//     never parsed; a client-sent role is never read). Unknown code ->
//     401; a validated non-leader session -> a REAL 403. The admin key
//     is accepted as elsewhere in the (ii) chain (it names no role --
//     the trip still resolves from the presented code's registry entry).
//   * RATE CAP: 5 test sends per trip per rolling hour, enforced
//     SERVER-side in a blob record (twize/push-test-cap/<tripId>.json).
//     Status checks and no-device sends never consume the cap.
//   * PAYLOAD: honestly self-identifying -- title 'Test alert', body
//     'Theme Park Co-Pilot notifications are working for <trip name>',
//     tap target = the trip home ('/app.html', the wait-monitor's
//     convention), tag 'tpcp-test-alert'.
//
// POST body: { tripCode, action?: 'send' | 'status', token?: '<this
// device\'s APNs token, status action only>' } -- code may also arrive
// via the x-trip-code header (the push-register convention).
// 'send' response:  { ok, sent, devices, failed?, pruned?, error? } --
//   devices = registered send targets across the trip's buckets (native
//   devices the crons would attempt + web subscriptions); sent = actual
//   deliveries. devices:0 is a STATE (ok:true, sent:0), not an error.
//   When devices>0 but nothing delivered, ok:false + error names the
//   failure class ('delivery-failed' | 'no-channel-configured').
//   Capped: 429 { ok:false, capped:true, error:'rate-capped',
//   retryAfterSec }. Device tokens NEVER appear in any response.
// 'status' response: { ok:true, registered, devices } -- registered =
//   whether THIS device's token is present in the trip's device files
//   (a boolean for that token only; no other device data is exposed).

import { list } from '@vercel/blob';
import { fireTripPush, safeTripCode } from './cron-booking-alerts.js';

export { safeTripCode };

const MAX_BODY = 16 * 1024; // a test request is tiny

// ---- rate cap ------------------------------------------------------------
export const PUSH_TEST_CAP_PER_HOUR = 5;
export const PUSH_TEST_CAP_WINDOW_MS = 60 * 60 * 1000;
const capKey = (tripId) => 'twize/push-test-cap/' + tripId + '.json';
// Keep only the send timestamps inside the rolling window, ascending.
export function pruneCapSends(sends, nowMs) {
  const arr = Array.isArray(sends) ? sends : [];
  return arr
    .filter((t) => typeof t === 'number' && isFinite(t) && nowMs - t < PUSH_TEST_CAP_WINDOW_MS && t <= nowMs)
    .sort((a, b) => a - b);
}

// ---- Registry-backed session resolution (restoration step ii) ------------
// Identical shape to api/ai.js / generateschedule.js / reoptimize.js:
// salted-first / bare-fallback registry read, 60s cache; role resolved
// SERVER-SIDE from the registry entry -- the presented code is only the
// lookup key, its suffix is never parsed, client-sent role never read.
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
// Leader session: the registry's admin role on an active, unexpired
// entry -- the same test api/trip.js applies to trip saves.
function _isLeaderSession(s) {
  return !!s && s.role === 'admin' && s.status === 'active' && !s.expired;
}

// ---- blob helpers (same shapes as cron-booking-alerts.js) ----------------
const SALT = (process.env.BLOB_PATH_SALT || '').trim();
const tripBareKey = (tripId) => 'twize/trip_' + tripId + '.json';
const tripSaltedKey = (tripId) => SALT ? ('twize/' + SALT + '/trip_' + tripId + '.json') : ('twize/trip_' + tripId + '.json');
async function readJsonBlob(key) {
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: key });
    if (!blobs || blobs.length === 0) return null;
    const resp = await fetch(blobs[0].url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.error('[push-test] read error', key, e.message);
    return null;
  }
}
async function readSaltedDualBlob(saltedKey, bareKey) {
  try {
    const { list } = await import('@vercel/blob');
    let { blobs } = await list({ prefix: saltedKey });
    if (!blobs || blobs.length === 0) {
      ({ blobs } = await list({ prefix: bareKey }));
    }
    if (!blobs || blobs.length === 0) return null;
    const resp = await fetch(blobs[0].url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.error('[push-test] salted read error', e.message);
    return null;
  }
}
async function writeJsonBlob(key, obj) {
  const { put } = await import('@vercel/blob');
  await put(key, JSON.stringify(obj), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
}

// ---- small validators (mirrors of the push surfaces) ----------------------
function safeTripId(raw) {
  if (typeof raw !== 'string') return '';
  const t = raw.trim();
  if (!/^[A-Za-z0-9_-]{3,60}$/.test(t)) return '';
  return t;
}
// APNs device tokens are hex strings (same check as push-register.js).
function safeDeviceToken(raw) {
  if (typeof raw !== 'string') return '';
  var t = raw.trim();
  if (!/^[0-9a-fA-F]{64,200}$/.test(t)) return '';
  return t;
}

// Every registry code resolving to this trip (the leader/guest pair),
// presented code first. Codes are registry keys; each is re-checked
// against safeTripCode before it is ever used in a blob path.
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

// Send targets in one code's buckets -- exactly what the crons attempt:
// native devices that are iOS + token-bearing + not alerts-opted-out,
// plus web subscriptions.
async function targetsForCode(code) {
  const devBlob = await readJsonBlob('twize/push-devices/' + code + '.json');
  const devices = (devBlob && Array.isArray(devBlob.devices)) ? devBlob.devices : [];
  const nativeTargets = devices.filter((d) => d && d.platform === 'ios' && typeof d.token === 'string' && d.alertsEnabled !== false).length;
  const subBlob = await readJsonBlob('twize/push-subs/' + code + '.json');
  const subs = (subBlob && Array.isArray(subBlob.subscriptions)) ? subBlob.subscriptions : [];
  return { native: nativeTargets, web: subs.length, total: nativeTargets + subs.length };
}

// Is this exact token present in any of the trip's device files?
// Presence only (an alerts-opted-out entry is still a registration).
async function tokenRegisteredForTrip(codes, token) {
  for (const code of codes) {
    const devBlob = await readJsonBlob('twize/push-devices/' + code + '.json');
    const devices = (devBlob && Array.isArray(devBlob.devices)) ? devBlob.devices : [];
    for (const d of devices) {
      if (d && d.token === token) return true;
    }
  }
  return false;
}

// The trip's real display name (tripConfig.tripName, the name the app
// header shows) when the trip blob carries one; else the presented code.
async function tripDisplayName(session, presentedCode) {
  try {
    const td = await readSaltedDualBlob(tripSaltedKey(session.tripId), tripBareKey(session.tripId));
    const name = (td && td.tripConfig && typeof td.tripConfig.tripName === 'string') ? td.tripConfig.tripName.trim() : '';
    if (name) return name.slice(0, 80);
  } catch (e) { /* fall through to the code */ }
  return presentedCode;
}

// The test payload: unmistakably a test, trip home on tap. The class field
// keys the client's foreground rendering (Claude msg 84), and the episodeId
// is this send's own identity -- minted once per send, so a transport
// re-delivery of THIS send dedupes on the client while the next deliberate
// test (a new identity) renders again.
export function buildTestPayload(tripName) {
  const name = (typeof tripName === 'string' && tripName.trim()) ? tripName.trim() : 'your trip';
  return {
    title: 'Test alert',
    body: 'Theme Park Co\u2726Pilot notifications are working for ' + name,
    url: '/app.html',
    tag: 'tpcp-test-alert',
    class: 'test',
    episodeId: 'ep:test:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 10)
  };
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

    // ---- SESSION FIRST (the (ii) chain): registry resolves the role ----
    const tripCode = safeTripCode(body.tripCode || req.headers['x-trip-code'] || '');
    if (!tripCode) return res.status(400).json({ error: 'Missing or invalid trip code' });
    const _adminKey = (process.env.ADMIN_KEY || '').toLowerCase();
    const _sentAdmin = (req.headers['x-admin-key'] || body.adminKey || '').toLowerCase();
    const _isAdmin = _adminKey.length > 0 && _sentAdmin === _adminKey;
    const session = await _resolveTripSession(tripCode);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    if (!_isAdmin && !_isLeaderSession(session)) {
      return res.status(403).json({ error: 'View-only trip code: only the trip leader can send a test alert.', role: session.role || '' });
    }
    const tripId = safeTripId(session.tripId || '');
    if (!tripId) return res.status(401).json({ error: 'Unauthorized' });

    // All of the trip's buckets (leader + guest codes) -- msg 76.
    const codes = await tripCodesFor(session, tripCode);
    const action = body.action === 'status' ? 'status' : 'send';

    // ---- status: is THIS device registered on this trip? ---------------
    if (action === 'status') {
      let devices = 0;
      for (const c of codes) devices += (await targetsForCode(c)).total;
      const token = safeDeviceToken(body.token || '');
      const registered = token ? await tokenRegisteredForTrip(codes, token) : false;
      return res.status(200).json({ ok: true, registered: registered, devices: devices });
    }

    // ---- send: rate cap (server-side, rolling hour, per trip) ----------
    const nowMs = Date.now();
    const capBlob = (await readJsonBlob(capKey(tripId))) || {};
    const recent = pruneCapSends(capBlob.sends, nowMs);
    if (recent.length >= PUSH_TEST_CAP_PER_HOUR) {
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + PUSH_TEST_CAP_WINDOW_MS - nowMs) / 1000));
      console.log('[push-test] capped trip', tripId, '| sends in window:', recent.length);
      return res.status(429).json({ ok: false, capped: true, error: 'rate-capped', retryAfterSec: retryAfterSec, sent: 0, devices: 0 });
    }

    // Registered targets across the trip's buckets.
    let devices = 0;
    for (const c of codes) devices += (await targetsForCode(c)).total;
    if (!devices) {
      // A state, not an error -- and it never consumes the cap, so the
      // leader can register a phone and immediately re-test.
      return res.status(200).json({ ok: true, sent: 0, devices: 0 });
    }

    const payload = buildTestPayload(await tripDisplayName(session, tripCode));
    let sent = 0, failed = 0, pruned = 0, channelsLive = false;
    for (const c of codes) {
      const r = await fireTripPush(c, payload);
      sent += r.sent; failed += r.failed; pruned += r.pruned;
      if (!r.web.skipped || !r.apns.skipped) channelsLive = true;
    }

    // The send executed against real targets -- it consumes the cap
    // whether or not the channel delivered (the cap bounds test sends,
    // not just successful ones).
    try {
      await writeJsonBlob(capKey(tripId), { tripId: tripId, sends: recent.concat([nowMs]), updated: new Date(nowMs).toISOString() });
    } catch (e) { console.error('[push-test] cap write failed', e.message); }

    const out = { ok: sent > 0, sent: sent, devices: devices, failed: failed, pruned: pruned };
    if (sent === 0) out.error = channelsLive ? 'delivery-failed' : 'no-channel-configured';
    console.log('[push-test] trip', tripId, '| codes', codes.length, '| sent', sent, '| failed', failed, '| devices', devices);
    return res.status(200).json(out);
  } catch (e) {
    console.error('[push-test] error', e.message);
    return res.status(400).json({ error: e.message });
  }
}
