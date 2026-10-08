// api/plan-changed.js
// Plan-changed awareness pushes (restoration step iv; Claude msg 82 spec,
// Oct 8, 2026). When a leader's save MATERIALLY changes a stored day's card
// sequence (membership, order, or times), every OTHER device on the trip
// gets one awareness push: the plan changed, here is the day -- never a
// decision ask (guest-bucket framing, msg 82 §11).
//
// Seams:
//   - api/trip.js POST is the single persistence seam (generateschedule and
//     reoptimize return data; the client persists via POST /api/trip). The
//     trip handler diffs the stored days against the final post-merge-guard
//     days with diffScheduleDays below, stamps the schedule version (see
//     trip.js), and calls notePlanChange after a successful write.
//   - Debounce: per trip, at most one plan-changed push per WINDOW_MS
//     (3 minutes). A material change inside the window merges into a
//     pending record (latest version, union of changed days, latest
//     originator); the pending record flushes as ONE coalesced push once
//     the window has elapsed, via flushPlanChanged -- called from the
//     existing 5-minute cron-push-monitor sweep (no new cron). Worst-case
//     delivery delay while the sweep runs: window + sweep ~= 8 minutes.
//   - Marker discipline: lastSentAt / lastSentVersion update ONLY on a
//     successful send (or when there is provably nobody else to notify).
//     A failed send leaves the pending record for the next flush.
//   - Originating-device exclusion: the client sends its own push device
//     token with trip writes (localStorage 'tpcp_push_token', stashed by
//     the push-register flow); the token rides the save into
//     notePlanChange and the send excludes that device across BOTH pair
//     buckets. A write with no token (older client) notifies everyone.
//   - Sending goes through fireTripPush (cron-booking-alerts.js), the
//     shared real path, on both channels (Web Push + APNs) as the other
//     payload classes do.
//
// State: twize/plan-changed/<tripId>.json =
//   { tripId, lastSentAt, lastSentVersion,
//     pending: null | { version, days: [1-based day numbers],
//                       originToken, queuedAt } }

import { list, put } from '@vercel/blob';
import { fireTripPush } from './cron-booking-alerts.js';
import { isApnsConfigured } from './apns.js';

export const PLAN_CHANGED_WINDOW_MS = 3 * 60 * 1000;
const _AUTH_SALT = process.env.BLOB_PATH_SALT || '';

// Trip-code floor (Claude msg 72): 3-40 chars. This regex used to require
// 8-40, which silently excluded every 6-char code (BEAU01) from push.
// Mirrors kept in sync: push-register.js, push-test.js, push-send.js,
// push-subscribe.js, cron-push-monitor.js, cron-booking-alerts.js.
export function safeTripCode(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{3,40}$/.test(v) ? v : null;
}

// APNs device-token shape (64+ hex chars). Mirror of push-register.js /
// push-test.js; kept in sync.
export function safeDeviceToken(v) {
  return typeof v === 'string' && /^[0-9a-fA-F]{64,200}$/.test(v.trim()) ? v.trim() : '';
}

// ---------------------------------------------------------------------------
// Blob helpers (mirror of the cron-push-monitor / push-test pattern)
// ---------------------------------------------------------------------------
async function readBlobJson(pathname) {
  try {
    const { blobs } = await list({ prefix: pathname });
    const hit = blobs.find(b => b.pathname === pathname);
    if (!hit) return null;
    const res = await fetch(hit.url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}
async function writeJsonBlob(pathname, obj) {
  await put(pathname, JSON.stringify(obj), { access: 'public', addRandomSuffix: false });
}

// ---------------------------------------------------------------------------
// Registry: the single source of role + trip identity. DUAL-READ, SALTED
// FIRST, with fallback to the bare key (migration tolerance). Mirrors the
// reader in api/push-test.js / api/trip.js.
// ---------------------------------------------------------------------------
async function readRegistry() {
  const keys = _AUTH_SALT ? ['twize/' + _AUTH_SALT + '/trip_registry.json', 'twize/trip_registry.json'] : ['twize/trip_registry.json'];
  for (const key of keys) {
    const data = await readBlobJson(key);
    if (data && typeof data === 'object') return data;
  }
  return {};
}

// Every registry code sharing this tripId (the leader/guest pair), the
// presented code first. Mirror of tripCodesFor in api/push-test.js.
async function pairCodesFor(tripId, presentedCode) {
  const registry = await readRegistry();
  const codes = [];
  const pc = safeTripCode(presentedCode || '');
  if (pc && registry[pc] && registry[pc].tripId === tripId) codes.push(pc);
  for (const code of Object.keys(registry)) {
    if (codes.indexOf(code) !== -1) continue;
    const e = registry[code];
    if (e && e.tripId === tripId && safeTripCode(code)) codes.push(code);
  }
  return codes;
}

// Registered push targets across the given codes, EXCLUDING the originator
// token: native devices (counted only when the APNs channel is usable --
// an unconfigured channel can never deliver) + web subscriptions. Mirror
// of targetsForCode in api/push-test.js.
async function countTargets(codes, excludeToken) {
  let native = 0, web = 0;
  const apnsOk = isApnsConfigured();
  for (const code of codes) {
    if (apnsOk) {
      const dev = await readBlobJson('twize/push-devices/' + code + '.json');
      const devices = dev && Array.isArray(dev.devices) ? dev.devices : [];
      native += devices.filter(d => d && d.alertsEnabled !== false && d.token && d.token !== excludeToken).length;
    }
    const sub = await readBlobJson('twize/push-subs/' + code + '.json');
    const subs = sub && Array.isArray(sub.subscriptions) ? sub.subscriptions : [];
    web += subs.filter(s => s && !(excludeToken && s.token === excludeToken)).length;
  }
  return { native: native, web: web, total: native + web };
}

// ---------------------------------------------------------------------------
// The material-change diff (pure; exported for the harness).
// A day's signature is its card sequence: for each item, (type, name, time).
// Prose-only edits to a card (a note reworded, a flag flipped) do NOT move
// the sequence and are not material -- the guest's plan did not change.
// ---------------------------------------------------------------------------
function itemSignature(it) {
  if (it == null) return '';
  if (typeof it === 'string') return '|s:' + it;
  const name = it.h || it.title || it.name || '';
  const time = it.t || it.time || '';
  return String(it.type || '') + '|' + String(name) + '|' + String(time);
}
export function daySignature(day) {
  const items = day && Array.isArray(day.items) ? day.items : [];
  return items.map(itemSignature).join('\n');
}
export function diffScheduleDays(storedDays, finalDays) {
  const a = Array.isArray(storedDays) ? storedDays : [];
  const b = Array.isArray(finalDays) ? finalDays : [];
  const changedDays = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (daySignature(a[i]) !== daySignature(b[i])) changedDays.push(i + 1);
  }
  return { changed: changedDays.length > 0, changedDays: changedDays };
}

// ---------------------------------------------------------------------------
// Payload (Claude msg 82): awareness only. Title/body name the changed day
// when exactly one day changed across the (possibly coalesced) event; a
// multi-day event uses the generic plan wording -- naming one of several
// changed days would understate the change. No approve / review / action
// wording anywhere. The url follows the existing convention ('/app.html';
// the client has no day-targeting today, so the body names the day).
// ---------------------------------------------------------------------------
export function buildPlanChangedPayload(tripId, version, days) {
  const ds = Array.isArray(days) ? days.filter(d => typeof d === 'number' && d > 0) : [];
  const body = ds.length === 1
    ? 'Your Day ' + ds[0] + ' plan changed \u2014 open to see what\u2019s new.'
    : 'Your plan changed \u2014 open to see what\u2019s new.';
  return {
    title: 'Your plan changed',
    body: body,
    url: '/app.html',
    tag: 'tpcp-plan-changed',
    class: 'plan-changed',
    episodeId: 'ep:' + tripId + ':plan-changed:' + version,
    schedVersion: version
  };
}

// ---------------------------------------------------------------------------
// Debounce state
// ---------------------------------------------------------------------------
function stateKey(tripId) { return 'twize/plan-changed/' + tripId + '.json'; }
async function readState(tripId) {
  const st = await readBlobJson(stateKey(tripId));
  if (st && typeof st === 'object') {
    return {
      tripId: tripId,
      lastSentAt: typeof st.lastSentAt === 'number' ? st.lastSentAt : 0,
      lastSentVersion: typeof st.lastSentVersion === 'number' ? st.lastSentVersion : 0,
      pending: (st.pending && typeof st.pending === 'object') ? st.pending : null
    };
  }
  return { tripId: tripId, lastSentAt: 0, lastSentVersion: 0, pending: null };
}
function mergeChange(base, add) {
  if (!base) return { version: add.version, days: (add.days || []).slice(), originToken: add.originToken || '', queuedAt: add.queuedAt || 0 };
  const days = base.days.slice();
  for (const d of (add.days || [])) if (days.indexOf(d) === -1) days.push(d);
  days.sort((x, y) => x - y);
  return { version: add.version, days: days, originToken: add.originToken || '', queuedAt: base.queuedAt || add.queuedAt || 0 };
}

// One send attempt for a (possibly coalesced) change. Returns 'sent' when
// at least one device received it, 'no-targets' when there is provably
// nobody else to notify (the originator's own device, or no devices at
// all) -- both are terminal for marker purposes -- and 'failed' when
// targets exist but every send failed (retry discipline: the caller
// leaves the pending record untouched for the next flush).
async function attemptSend(tripId, presentedCode, change) {
  const codes = await pairCodesFor(tripId, presentedCode);
  if (!codes.length) return 'no-targets';
  const excludeToken = safeDeviceToken(change.originToken || '');
  const targets = await countTargets(codes, excludeToken);
  if (targets.total === 0) return 'no-targets';
  const payload = buildPlanChangedPayload(tripId, change.version, change.days);
  let sent = 0;
  for (const code of codes) {
    const r = await fireTripPush(code, payload, { excludeToken: excludeToken });
    sent += (r && r.sent) || 0;
  }
  return sent > 0 ? 'sent' : 'failed';
}

// commitSend / queueChange mutate + persist the state record.
async function commitSend(st, change, now) {
  st.lastSentAt = now;
  st.lastSentVersion = change.version;
  st.pending = null;
  await writeJsonBlob(stateKey(st.tripId), st);
}
async function queueChange(st, change) {
  st.pending = change;
  await writeJsonBlob(stateKey(st.tripId), st);
}

// Called by api/trip.js after a save that materially changed the stored
// schedule. nowMs is injectable for the harness; production omits it.
export async function notePlanChange(args) {
  const tripId = args && args.tripId;
  if (!tripId) return { skipped: 'no-trip' };
  const now = typeof args.now === 'number' ? args.now : Date.now();
  const incoming = {
    version: args.version,
    days: Array.isArray(args.changedDays) ? args.changedDays.slice() : [],
    originToken: safeDeviceToken(args.originToken || ''),
    queuedAt: now
  };
  const st = await readState(tripId);
  const change = st.pending ? mergeChange(st.pending, incoming) : incoming;
  if (now - st.lastSentAt >= PLAN_CHANGED_WINDOW_MS) {
    const outcome = await attemptSend(tripId, args.presentedCode, change);
    if (outcome === 'failed') {
      await queueChange(st, change);
      return { sent: 0, queued: true, version: change.version };
    }
    await commitSend(st, change, now);
    return { sent: outcome === 'sent' ? 1 : 0, delivered: outcome, version: change.version };
  }
  await queueChange(st, change);
  return { sent: 0, queued: true, version: change.version };
}

// Called by the cron-push-monitor sweep: flush every due pending record
// as ONE coalesced push. A failed send leaves the record for the next
// sweep; markers move only on success.
export async function flushPlanChanged(nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const out = [];
  let keys = [];
  try {
    const { blobs } = await list({ prefix: 'twize/plan-changed/' });
    keys = blobs.map(b => b.pathname);
  } catch (e) { return out; }
  for (const key of keys) {
    try {
      const tripId = key.slice('twize/plan-changed/'.length).replace(/\.json$/, '');
      if (!tripId) continue;
      const st = await readState(tripId);
      if (!st.pending) continue;
      if (now - st.lastSentAt < PLAN_CHANGED_WINDOW_MS) continue;
      const change = st.pending;
      const outcome = await attemptSend(tripId, '', change);
      if (outcome === 'failed') { out.push({ tripId: tripId, flushed: false, version: change.version }); continue; }
      await commitSend(st, change, now);
      out.push({ tripId: tripId, flushed: true, delivered: outcome, version: change.version });
    } catch (e) {
      console.warn('[plan-changed] flush failed for ' + key, e && e.message);
    }
  }
  return out;
}
