// api/apns.js
// Apple Push Notification service (APNs) sender for the native iOS app
// (bundle com.lunchboxdad.themeparkcp, team 2QM8GQ4SL5). The retired web app
// used Web Push (api/push-send.js); WKWebView has no PushManager, so native
// alerts travel over APNs using a provider token (ES256 JWT) signed with an
// APNs auth key (.p8). Node built-ins only (node:http2 + node:crypto).
//
// Config (Vercel env):
//   APNS_KEY_ID     Key ID of the APNs auth key from the Developer portal.
//   APNS_KEY_P8     Full contents of the .p8 file, BEGIN/END lines included
//                   (a single-line value with literal \n escapes also works).
//   APNS_TEAM_ID    Optional; defaults to 2QM8GQ4SL5.
//   APNS_BUNDLE_ID  Optional; defaults to com.lunchboxdad.themeparkcp.
//   APNS_ENV        'production' (default; TestFlight + App Store builds) or
//                   'sandbox' (Xcode debug builds installed on a device).
// When the key env is absent, sends no-op (logged, never throw) so this code
// can ship ahead of the key. Device tokens are stored per trip by
// api/push-register.js at twize/push-devices/<tripCode>.json.

import http2 from 'node:http2';
import crypto from 'node:crypto';

export const APNS_TEAM_ID_DEFAULT = '2QM8GQ4SL5';
export const APNS_BUNDLE_ID_DEFAULT = 'com.lunchboxdad.themeparkcp';
export const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com'
};
// Apple accepts a provider token for up to 60 minutes; refresh ahead of that.
export const APNS_TOKEN_TTL_MS = 50 * 60 * 1000;

// ---- ride down / back-up episode rules (shared with cron-push-monitor) ----
// A "down episode" alerts at most once: when the ride returns to OPERATING it
// may alert "back up" once, and a later re-down must wait out the cooldown.
export const RIDE_DOWN_REALERT_COOLDOWN_MIN = 60;
// A down alert is still useful if the planned ride starts up to this many
// minutes in the past (you may be walking to it); older plans are stale news.
export const RIDE_DOWN_PAST_GRACE_MIN = 30;
export const DOWN_STATUS_NAMES = ['DOWN', 'REFURBISHMENT'];

export function getApnsConfig(env) {
  env = env || process.env;
  const keyId = (env.APNS_KEY_ID || '').trim();
  const rawKey = (env.APNS_KEY_P8 || '').trim();
  if (!keyId || !rawKey) return null;
  // Tolerate a single-line paste where newlines were stored as literal "\n".
  const privateKeyPem = rawKey.indexOf('\\n') > -1 ? rawKey.replace(/\\n/g, '\n') : rawKey;
  const teamId = (env.APNS_TEAM_ID || APNS_TEAM_ID_DEFAULT).trim();
  const bundleId = (env.APNS_BUNDLE_ID || APNS_BUNDLE_ID_DEFAULT).trim();
  const envName = (env.APNS_ENV || 'production').trim().toLowerCase();
  const host = APNS_HOSTS[envName] || APNS_HOSTS.production;
  return { keyId: keyId, teamId: teamId, bundleId: bundleId, host: host, privateKeyPem: privateKeyPem };
}

export function isApnsConfigured(env) {
  return !!getApnsConfig(env);
}

function b64url(data) {
  return Buffer.from(data).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Build (but do not cache) a provider-token JWT. Exported for unit tests.
export function buildApnsProviderToken(cfg, nowMs) {
  const now = (typeof nowMs === 'number') ? nowMs : Date.now();
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
  const claims = b64url(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(now / 1000) }));
  const signingInput = header + '.' + claims;
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: cfg.privateKeyPem, dsaEncoding: 'ieee-p1363'
  });
  return signingInput + '.' + b64url(sig);
}

let _tokenCache = { jwt: '', at: 0, keyId: '' };
export function getApnsProviderToken(env) {
  const cfg = getApnsConfig(env);
  if (!cfg) return null;
  const now = Date.now();
  if (_tokenCache.jwt && _tokenCache.keyId === cfg.keyId && (now - _tokenCache.at) < APNS_TOKEN_TTL_MS) {
    return _tokenCache.jwt;
  }
  const jwt = buildApnsProviderToken(cfg, now);
  _tokenCache = { jwt: jwt, at: now, keyId: cfg.keyId };
  return jwt;
}

// Classify an APNs HTTP response. 'prune' means the device token is dead and
// the caller should delete it; 'auth-error' means our provider token/key was
// rejected (not the device's fault).
export function classifyApnsResult(status, reason) {
  if (status === 200) return 'ok';
  if (status === 410) return 'prune'; // Unregistered
  if (status === 400 && reason === 'BadDeviceToken') return 'prune';
  if (status === 403 && (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken' || reason === 'BadCertificate')) return 'auth-error';
  return 'error';
}

export function buildApnsPayload(note) {
  note = note || {};
  const payload = {
    aps: {
      alert: { title: note.title || 'Theme Park Co-Pilot', body: note.body || '' },
      sound: 'default',
      'thread-id': note.tag || 'tpcp-alerts'
    }
  };
  // Custom keys ride alongside `aps`; the Capacitor plugin surfaces them to
  // the app's notification listeners as the notification data.
  if (note.url) payload.url = note.url;
  if (note.tag) payload.tag = note.tag;
  return payload;
}

// Send one alert payload to many device tokens over a single HTTP/2 session.
// Resolves to [{ token, status, reason, verdict }] and never rejects.
export async function sendApnsToDevices(tokens, note, env) {
  const list = (Array.isArray(tokens) ? tokens : []).filter(function (t) { return typeof t === 'string' && !!t; });
  const cfg = getApnsConfig(env);
  if (!cfg) {
    if (list.length) console.log('[apns] not configured -- skipping ' + list.length + ' device send(s)');
    return list.map(function (token) { return { token: token, status: 0, reason: 'apns-not-configured', verdict: 'skipped' }; });
  }
  if (!list.length) return [];
  const jwt = getApnsProviderToken(env);
  const body = JSON.stringify(buildApnsPayload(note));
  const results = [];
  let client = null;
  let sessionError = null;
  try {
    client = http2.connect(cfg.host);
    client.on('error', function (err) { sessionError = err; });
  } catch (e) {
    sessionError = e;
  }
  for (const token of list) {
    if (!client || sessionError) {
      results.push({ token: token, status: 0, reason: sessionError ? sessionError.message : 'no session', verdict: 'error' });
      continue;
    }
    const r = await new Promise(function (resolve) {
      let settled = false;
      const done = function (v) { if (!settled) { settled = true; resolve(v); } };
      try {
        const req = client.request({
          ':method': 'POST',
          ':path': '/3/device/' + token,
          'authorization': 'bearer ' + jwt,
          'apns-topic': cfg.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json'
        });
        let status = 0;
        let data = '';
        req.on('response', function (headers) { status = headers[':status'] || 0; });
        req.on('data', function (chunk) { data += chunk; });
        req.on('end', function () {
          let reason = '';
          try { reason = (JSON.parse(data || '{}') || {}).reason || ''; } catch (e) { /* empty body on success */ }
          done({ token: token, status: status, reason: reason, verdict: classifyApnsResult(status, reason) });
        });
        req.on('error', function (err) { done({ token: token, status: 0, reason: err.message, verdict: 'error' }); });
        req.setTimeout(10000, function () {
          try { req.close(); } catch (e) { /* already closed */ }
          done({ token: token, status: 0, reason: 'timeout', verdict: 'error' });
        });
        req.end(body);
      } catch (e) {
        done({ token: token, status: 0, reason: e.message, verdict: 'error' });
      }
    });
    if (r.verdict === 'auth-error' && r.reason === 'ExpiredProviderToken') {
      _tokenCache.at = 0; // force a fresh provider token on the next send
    }
    results.push(r);
  }
  if (client) { try { client.close(); } catch (e) { /* already closed */ } }
  return results;
}

// Pure episode detector for planned-ride down / back-up alerts.
// rec: the ride's stored state ({ downAlerted, lastDownAlertMin, ... }).
// curStatus: live ThemeParks.wiki status for the ride right now.
// schedMin: the ride's planned start today (minutes since midnight, -1 if
// unknown). Returns 'down' | 'up' | null. Alert flags are committed by the
// caller only after a successful send (same pattern as the spike rules).
export function evaluateRideEpisode(rec, curStatus, nowMin, schedMin) {
  rec = rec || {};
  if (DOWN_STATUS_NAMES.indexOf(curStatus) > -1) {
    if (rec.downAlerted === true) return null; // already told them this episode
    const lastDown = (typeof rec.lastDownAlertMin === 'number') ? rec.lastDownAlertMin : -99999;
    if ((nowMin - lastDown) < RIDE_DOWN_REALERT_COOLDOWN_MIN) return null;
    if (typeof schedMin === 'number' && schedMin >= 0 && schedMin < nowMin - RIDE_DOWN_PAST_GRACE_MIN) return null;
    return 'down';
  }
  if (curStatus === 'OPERATING' && rec.downAlerted === true) return 'up';
  return null;
}
