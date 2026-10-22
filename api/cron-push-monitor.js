// api/cron-push-monitor.js
// Wait-spike monitor. Runs frequently during park hours, watches every trip that
// has push subscriptions, and notifies a trip when a ride ON THAT TRIP'S SCHEDULE
// FOR TODAY spikes from low to high. Built for scale: discovers all trips, pulls
// live waits once, checks each trip's planned rides against per-trip last-known state.
//
// INTERNAL ONLY. Auth: Bearer CRON_SECRET (Vercel attaches it to cron invocations), OR admin key. The bare x-vercel-cron header stopped authenticating Oct 6, 2026 -- it is spoofable by anyone.
// Storage:
//   twize/push-subs/<tripCode>.json  -- web subscriptions (read; reuse push-send logic)
//   twize/push-devices/<tripCode>.json -- APNs device tokens (native app; api/push-register.js)
//   twize/trip_registry.json         -- code -> { tripId, status, expires }
//   twize/trip_<tripId>.json         -- tripData.tripConfig.schedule + .days[].isVip
//   twize/wait-state/<tripId>.json   -- last-known waits + per-ride alert cooldowns
//
// Spike definition mirrors the in-app toast: was <= LOW_MAX, now >= SPIKE_MIN.
// Oct 7, 2026: alerts also go to native iOS devices via APNs (api/apns.js), and
// planned rides alert on all-day DOWN episodes + back-up (evaluateRideEpisode).

import webpush from 'web-push';
import { isApnsConfigured, sendApnsToDevices, evaluateRideEpisode, apnsDetailFor } from './apns.js';
// Plan-changed debounce flusher (restoration step iv): pending
// plan-changed notifications flush on THIS sweep (no new cron).
import { flushPlanChanged } from './plan-changed.js';
// Poll-backstop episode recording (msg 94 (i)): fired episodes are also
// recorded per trip code for the client's foreground poll.
import { recordEpisode } from './push-episodes.js';
// Per-role routing (PR 2): role map + copy-variant policy.
import { buildRoleMap, variantFor } from './lib/push-routing.js';

// Secret path-prefix hardening. When BLOB_PATH_SALT is set, the registry and
// per-trip blobs live behind an unguessable path segment. Reads are salted-first
// with a bare-key fallback for migration. Subs and wait-state keys are NOT salted.
// Never log the salted key or full pathname.
const SALT = (process.env.BLOB_PATH_SALT || '').trim();

// Bare keys (also used as the transition-fallback for reads).
const registryBareKey = () => 'twize/trip_registry.json';
const tripBareKey = (tripId) => 'twize/trip_' + tripId + '.json';

// Salted keys -- salted when SALT is set, bare otherwise.
const registrySaltedKey = () => SALT ? ('twize/' + SALT + '/trip_registry.json') : 'twize/trip_registry.json';
const tripSaltedKey = (tripId) => SALT ? ('twize/' + SALT + '/trip_' + tripId + '.json') : ('twize/trip_' + tripId + '.json');

// ThemeParks.wiki entity ids -- identical to api/waittimes.js
const DL_ID = '7340550b-c14d-4def-80bb-acdb51d49a66';
const DCA_ID = '832fcd51-ea19-4e77-85c7-75d5843b127c';

// Spike thresholds (mirror client spike toast)
const LOW_MAX = 30;   // previous wait must have been <= this (spike)
const SPIKE_MIN = 45; // current wait must be >= this (spike)
const ALERT_COOLDOWN_MIN = 90; // do not re-alert the same ride within this many minutes
// Drop detection (opportunistic, sparing): ride was high, now genuinely short.
const DROP_PREV_MIN = 45; // previous wait must have been >= this
const DROP_NOW_MAX = 15;  // current wait must be <= this (genuinely short, not just lower)
const DROP_DELTA_MIN = 35; // must have dropped at least this much (avoid 50->40 noise)
const DROP_DAY_CUTOFF_MIN = 21 * 60; // do not send drop alerts after 9 PM (little day left to use it)

const LL_ORDER_CUTOFF_MIN = 12 * 60; // Item 5 (msg 574 (e)): if the day's first
// fire opportunity is already past noon PT, the morning booking window has
// effectively closed -- suppress the order push for the day rather than
// sending a confidently late instruction.
// High-wait nudge: planned ride already busy (not just a sudden spike). Once per ride per day, gated per-trip.
const HIGH_MIN = 60; // current wait must be >= this to nudge
const HIGH_COOLDOWN_MIN = 75; // per-trip: at most one high-wait nudge this often

// Ride-down nudge: a planned rope-drop ride is not operating this morning.
const ROPE_DROP_END_MIN = 10 * 60 + 30; // 10:30 AM PT -- only alert about a down ride during the morning rope-drop window
const DOWN_STATUSES = { DOWN: 1, REFURBISHMENT: 1 }; // ThemeParks.wiki statuses that mean a planned ride is unavailable

// Park hours guard (Pacific). Outside this window, skip entirely.
const PARK_OPEN_HOUR_PT = 6;   // 6 AM PT (allow early-entry pre-open ride-down / refurb alerts)
const PARK_CLOSE_HOUR_PT = 24; // midnight PT (rides can run to ~midnight)

// Shared episode identity (Claude msg 84): one detector (this monitor), one
// dedupe namespace, two presentations (iOS banner when backgrounded, in-app
// popup when foregrounded). The episode ID IS this monitor's own marker
// identity: the per-trip daily wait-state record keyed by rideKey, whose
// per-type flags (downAlerted / lastAlertMin / lastDropMin / highAlerted)
// gate re-fires, scoped to the PT day (state resets daily). The client
// renders a given episode at most once per session under this ID.
// Format: ep:<tripId>:<rideKey>:<episodeType>:<ymd>
//
// Fire-instance discriminator (Claude msg 88): "the episode ID identifies
// one monitor fire, not one ride-type-day." The plain tuple dedupes repeated
// TRANSPORT deliveries of one fire, but it also merges distinct fires hours
// apart -- a post-cooldown re-fire of the same ride/type/day is a NEW event
// and must render again. So the re-fireable threshold types (spike / drop /
// high) carry a send-count suffix (:f<n>) sourced from THIS monitor's own
// wait-state (rec.fireCounts below), stamped here at send time --
// monitor-authoritative, never derived client-side (a client-derived value
// would give transport duplicates different IDs and double-pop). down / up
// keep the plain tuple: they are one-time state transitions per
// closure/reopening, not recurring threshold events.
// Format: ep:<tripId>:<rideKey>:<episodeType>:<ymd>:f<n>

// ---- LL ORDER PUSH (Item 5, Claude msg 574) ----
// ONE push per armed day, early: the booking ORDER from the stored
// day's llSequence. Nothing here claims knowledge of booked returns
// -- the system has none (returns live in Disney's app); the push
// carries only what llSequence actually is: an order, delivered
// when it is actionable. Per-entry nudges were ruled out: their
// trigger (the party tapping in) is unobservable, and a planned-time
// proxy fires confidently mistimed pushes when a party runs behind.
// Arming is STRICT (msg 574 (c)): the stored day's generatedWith
// stamp only -- never config intent. A pre-stamp LL day receives
// nothing until it regenerates (AI Optimize / the Item 4 toggle
// re-stamps it). Leader-only via the 'll-order' routing row.
function llOrderArmed(day) {
  if (!day || !day.generatedWith || day.generatedWith.hasLLMP !== true) return false;
  const seq = day.llSequence;
  return !!(seq && Array.isArray(seq.order) && seq.order.length > 0);
}
function llOrderBody(seq) {
  const names = (seq.order || []).filter(n => typeof n === 'string' && n.trim());
  const first = (typeof seq.bookFirst === 'string' && seq.bookFirst.trim()) ? seq.bookFirst.trim() : names[0];
  const tail = names.filter(n => n !== first);
  if (!tail.length) return 'Book ' + first + ' first \u2014 it tops today\u2019s Lightning Lane game plan.';
  // Push-copy audit Option A (Oct 22): name bookFirst + the next ride
  // only, then count the rest -- naming 4 rides clipped mid-list on
  // the lock screen. The full order still renders from llSequence in
  // the plan's game-plan card.
  return 'Book ' + first + ' first, then ' + tail[0]
    + (tail.length > 1 ? ', and ' + (tail.length - 1) + ' more' : '')
    + '.';
}
// Decide the leg for one trip-day. Pure (the harness drives this):
//   skip     -- not armed, or already settled today (sent/suppressed)
//   wait     -- armed, but the morning window has not opened yet
//   suppress -- first opportunity is already past the booking window;
//               settle the day WITHOUT sending (msg 574 (e))
//   fire     -- send the order push now
// The window opens 60 min before the day's first planned item (the
// party is up and moving; bookFirst happens at park open), with an
// 8:00 AM PT fallback when no item time parses.
function llOrderDecision(day, nowMin, firstItemMin, settled) {
  if (!llOrderArmed(day)) return { act: 'skip', why: 'not-armed' };
  if (settled) return { act: 'skip', why: 'settled' };
  const openMin = (typeof firstItemMin === 'number' && firstItemMin >= 0) ? firstItemMin - 60 : 8 * 60;
  if (nowMin < openMin) return { act: 'wait', why: 'window-not-open' };
  if (nowMin > LL_ORDER_CUTOFF_MIN) return { act: 'suppress', why: 'booking-window-closed' };
  return { act: 'fire' };
}

function episodeIdFor(tripId, rideKey, episodeType, ymd, fireCount) {
  const base = 'ep:' + tripId + ':' + rideKey + ':' + episodeType + ':' + ymd;
  return (typeof fireCount === 'number' && fireCount > 0) ? base + ':f' + fireCount : base;
}

// The instance number the NEXT fire of this episode type for this ride
// carries: the monitor's persisted send count for the episode, + 1.
// Computed at payload build; committed by commitFireCount ONLY after the
// fire actually sends (r.sent > 0), the same discipline as the per-type
// alert flags -- a failed send consumes no count, so the retry carries the
// same instance identity as the original attempt.
function nextFireCount(rec, episodeType) {
  const fc = rec && rec.fireCounts;
  const n = (fc && typeof fc[episodeType] === 'number') ? fc[episodeType] : 0;
  return n + 1;
}
function commitFireCount(state, rideKey, episodeType, n) {
  const rec = state.rides[rideKey] || {};
  if (!rec.fireCounts || typeof rec.fireCounts !== 'object') rec.fireCounts = {};
  rec.fireCounts[episodeType] = n;
  state.rides[rideKey] = rec;
}

// Parse a schedule item time like "8:00 AM" into minutes since midnight; -1 if unparseable.
function hmToMin(t) {
  if (!t) return -1;
  const m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return -1;
  let h = parseInt(m[1], 10); const mn = parseInt(m[2], 10);
  const pm = m[3].toUpperCase() === 'PM';
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return h * 60 + mn;
}

function safeTripId(raw) {
  if (typeof raw !== 'string') return '';
  const t = raw.trim();
  if (!/^[A-Za-z0-9_-]{3,60}$/.test(t)) return '';
  return t;
}
export function safeTripCode(raw) {
  if (typeof raw !== 'string') return '';
  const t = raw.trim();
  // 3..40 (was 8..40 -- see push-register.js; the 8-char floor made
  // wait-time pushes impossible for real 6-char codes like BEAU01.)
  if (!/^[A-Za-z0-9-]{3,40}$/.test(t)) return '';
  return t;
}

// ---- name normalization so schedule item.h matches the live-wait name ----
function normName(s) {
  return (s || '')
    .toLowerCase()
    // strip a leading "Rope Drop" marker the schedule prepends to some items
    .replace(/^\s*rope\s*drop\s*[-:\u2013\u2014]?\s*/i, '')
    .replace(/\s*\((?:llmp|ll|lightning lane)\s*return\)\s*/i, ' ')
    .replace(/\s*[-\u2013\u2014]\s*(?:llmp|ll|lightning lane)\s*return\s*/i, ' ')
    .replace(/\s*(?:llmp|ll|lightning lane)\s*return\s*/i, ' ')
    .replace(/[\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Aliases for rides whose schedule name and live-feed name genuinely differ
// (not just punctuation). Keys/values are normName() outputs.
const NAME_ALIASES = {
  'soarin around the world': 'soarin over california'
};

// Resolve a schedule ride name to a live-wait record. Tries, in order:
// exact normalized match, alias, then bidirectional prefix (handles live names
// with extra suffixes like "Pixar Pal-A-Round - Swinging").
function resolveLive(scheduleName, liveByName, liveKeys) {
  const k = normName(scheduleName);
  if (liveByName[k]) return liveByName[k];
  if (NAME_ALIASES[k] && liveByName[NAME_ALIASES[k]]) return liveByName[NAME_ALIASES[k]];
  // prefix match: schedule "pixar pal a round" vs live "pixar pal a round swinging"
  for (let i = 0; i < liveKeys.length; i++) {
    const lk = liveKeys[i];
    if (lk === k) return liveByName[lk];
    if (lk.indexOf(k + ' ') === 0 || k.indexOf(lk + ' ') === 0) return liveByName[lk];
  }
  return null;
}

// Parse a per-day date that may be ISO ("2026-06-28") or human ("Jun 28, 2026")
// into a normalized "YYYY-MM-DD" string for comparison. Returns '' if unparseable.
const MONTHS = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
                 jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
function normDate(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const s = raw.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  // "Jun 28, 2026" / "June 28 2026"
  const hm = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (hm) {
    const mo = MONTHS[hm[1].slice(0, 3).toLowerCase()];
    if (mo) return hm[3] + '-' + mo + '-' + (hm[2].length === 1 ? '0' + hm[2] : hm[2]);
  }
  return '';
}

// ---- Pacific-time helpers (Disneyland local) ----
function pacificParts(now) {
  // Returns { y, m, d, hour, minute } in America/Los_Angeles
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = {};
  for (const p of fmt.formatToParts(now)) { parts[p.type] = p.value; }
  return {
    ymd: parts.year + '-' + parts.month + '-' + parts.day,
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10)
  };
}

// ---- blob helpers (match house pattern, @vercel/blob 0.27.3) ----
async function readJsonBlob(key) {
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: key });
    if (!blobs || blobs.length === 0) return null;
    const resp = await fetch(blobs[0].url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.error('[push-monitor] read error', key, e.message);
    return null;
  }
}
// Meta variant of readJsonBlob (instrumentation, Claude msg 578):
// same list + blobs[0] selection as the plain read -- the SELECTION
// IS UNCHANGED -- but it also reports which blob the read resolved
// (pathname + uploadedAt + how many blobs matched the prefix), so a
// short targeted list can be attributed to the read itself.
async function readJsonBlobMeta(key) {
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: key });
    if (!blobs || blobs.length === 0) return { data: null, pathname: null, uploadedAt: null, matches: 0 };
    const resp = await fetch(blobs[0].url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!resp.ok) return { data: null, pathname: blobs[0].pathname || null, uploadedAt: blobs[0].uploadedAt || null, matches: blobs.length };
    return { data: await resp.json(), pathname: blobs[0].pathname || null, uploadedAt: blobs[0].uploadedAt || null, matches: blobs.length };
  } catch (e) {
    return { data: null, pathname: null, uploadedAt: null, matches: 0 };
  }
}

// Salted-dual read for the registry/trip blobs only: try the salted key first,
// fall back to the bare key (transition-safe). Do not log the pathname.
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
    console.error('[push-monitor] salted read error', e.message);
    return null;
  }
}
async function writeJsonBlob(key, obj) {
  const { put } = await import('@vercel/blob');
  await put(key, JSON.stringify(obj), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
}
export async function listTripCodesWithSubs() {
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: 'twize/push-subs/' });
    const codes = [];
    for (const b of (blobs || [])) {
      const m = (b.pathname || b.url || '').match(/push-subs\/([^/]+)\.json/);
      if (m) { const c = safeTripCode(m[1]); if (c) codes.push(c); }
    }
    return Array.from(new Set(codes));
  } catch (e) {
    console.error('[push-monitor] list subs error', e.message);
    return [];
  }
}

// Set by the handler once VAPID is validated; sendToTrip no-ops without it so
// a missing VAPID config can no longer hard-fail a run APNs could have served.
let _vapidConfigured = false;

// ---- send to one trip's subscriptions (mirrors push-send) ----
async function sendToTrip(tripCode, payloadObj) {
  if (!_vapidConfigured) return { sent: 0, failed: 0, pruned: 0, skipped: true };
  const subsBlob = await readJsonBlob('twize/push-subs/' + tripCode + '.json');
  const subs = (subsBlob && Array.isArray(subsBlob.subscriptions)) ? subsBlob.subscriptions : [];
  if (!subs.length) return { sent: 0, failed: 0, pruned: 0 };
  const payload = JSON.stringify(payloadObj);
  let sent = 0, failed = 0;
  const survivors = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload);
      sent++; survivors.push(s);
    } catch (err) {
      const code = err && err.statusCode;
      failed++;
      if (code !== 404 && code !== 410) survivors.push(s); // keep on transient errors only
      console.warn('[push-monitor] send fail', code || (err && err.message));
    }
  }
  let pruned = 0;
  if (survivors.length !== subs.length) {
    pruned = subs.length - survivors.length;
    try {
      await writeJsonBlob('twize/push-subs/' + tripCode + '.json',
        { tripCode: tripCode, subscriptions: survivors, updated: new Date().toISOString() });
    } catch (e) { console.error('[push-monitor] prune write failed', e.message); }
  }
  return { sent, failed, pruned };
}

export async function listTripCodesWithDevices() {
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: 'twize/push-devices/' });
    const codes = [];
    for (const b of (blobs || [])) {
      const m = (b.pathname || b.url || '').match(/push-devices\/([^/]+)\.json/);
      if (m) { const c = safeTripCode(m[1]); if (c) codes.push(c); }
    }
    return Array.from(new Set(codes));
  } catch (e) {
    console.error('[push-monitor] list devices error', e.message);
    return [];
  }
}

// ---- send to one trip's native devices via APNs (api/apns.js) ----
// No-ops cleanly until APNs env is configured and a device registers, so the
// native channel is effectively feature-flagged OFF until tokens exist.
async function sendApnsToTrip(tripCode, payloadObj) {
  if (!isApnsConfigured()) return { sent: 0, failed: 0, pruned: 0, skipped: true, accepted: [] };
  const devMeta = await readJsonBlobMeta('twize/push-devices/' + tripCode + '.json');
  const devBlob = devMeta.data;
  const devices = (devBlob && Array.isArray(devBlob.devices)) ? devBlob.devices : [];
  const targets = devices.filter(d => d && d.platform === 'ios' && typeof d.token === 'string' && d.alertsEnabled !== false);
  if (!targets.length) return { sent: 0, failed: 0, pruned: 0, detail: apnsDetailFor(devMeta, [], []), accepted: [] };
  const results = await sendApnsToDevices(targets.map(d => d.token), payloadObj);
  const detail = apnsDetailFor(devMeta, targets.map(d => d.token), results);
  let sent = 0, failed = 0;
  const accepted = []; // raw tokens APNs accepted -- episode send evidence (hashed at record time)
  const deadTokens = new Set();
  for (const r of results) {
    if (r.verdict === 'ok') { sent++; accepted.push(r.token); }
    else {
      failed++;
      if (r.verdict === 'prune') deadTokens.add(r.token); // 410 / BadDeviceToken: token is dead
      else if (r.verdict === 'auth-error') console.warn('[push-monitor] APNs auth error', r.reason);
    }
  }
  let pruned = 0;
  if (deadTokens.size) {
    const survivors = devices.filter(d => !(d && deadTokens.has(d.token)));
    pruned = devices.length - survivors.length;
    try {
      await writeJsonBlob('twize/push-devices/' + tripCode + '.json',
        { tripCode: tripCode, devices: survivors, updated: new Date().toISOString() });
    } catch (e) { console.error('[push-monitor] apns prune write failed', e.message); }
  }
  return { sent, failed, pruned, detail, accepted };
}

export default async function handler(req, res) {
  // ---- AUTH FIRST (internal only) ----
  const secret = process.env.CRON_SECRET;
  const isAuthed = secret && req.headers.authorization === ('Bearer ' + secret);
  const _adminKey = (process.env.ADMIN_KEY || '').toLowerCase();
  const isAdmin = _adminKey.length > 0 && (req.headers['x-admin-key'] || '').toLowerCase() === _adminKey;
  if (!isAuthed && !isAdmin) {
    console.warn('[push-monitor] unauthorized blocked');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // ---- PLAN-CHANGED FLUSH (step iv) ----
  // Runs on every authenticated sweep, BEFORE the park-hours guard: a
  // leader can edit a plan at any hour, and the coalesced awareness push
  // is due once its debounce window elapses, park hours or not. The
  // cron schedule itself (*/5, 13:00-06:59 UTC) bounds when sweeps run.
  // Failure-isolated: a flush failure never affects the monitor.
  let _pcFlush = null;
  try {
    _pcFlush = await flushPlanChanged(Date.now());
    if (_pcFlush.length) console.log('[push-monitor] plan-changed flush: ' + JSON.stringify(_pcFlush));
  } catch (e) { console.warn('[push-monitor] plan-changed flush failed', e && e.message); }

  const now = new Date();
  const pt = pacificParts(now);
  const force = req.query && (req.query.force === '1'); // admin manual run bypasses hours guard

  // ---- PARK HOURS GUARD ----
  if (!force && (pt.hour < PARK_OPEN_HOUR_PT || pt.hour >= PARK_CLOSE_HOUR_PT)) {
    return res.status(200).json({ ok: true, skipped: 'outside park hours', ptHour: pt.hour, planChangedFlush: _pcFlush });
  }

  // ---- Push channel config: Web Push (VAPID) and/or native APNs ----
  // Either channel alone is enough to run; fail only when neither is usable.
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT || 'mailto:hello@themeparkcopilot.com';
  _vapidConfigured = false;
  if (pub && priv) {
    try { webpush.setVapidDetails(subj, pub, priv); _vapidConfigured = true; }
    catch (e) { console.warn('[push-monitor] VAPID config invalid: ' + e.message); }
  }
  const apnsOk = isApnsConfigured();
  if (!_vapidConfigured && !apnsOk) {
    return res.status(500).json({ error: 'No push channel configured (VAPID or APNs)' });
  }

  try {
    // ---- 1. discover trips with web subscriptions or native devices ----
    const subCodes = await listTripCodesWithSubs();
    const devCodes = await listTripCodesWithDevices();
    const tripCodes = Array.from(new Set(subCodes.concat(devCodes)));
    if (!tripCodes.length) return res.status(200).json({ ok: true, trips: 0, note: 'no subscribed trips', planChangedFlush: _pcFlush });

    // ---- 2. registry: code -> tripId (salted-first, bare-fallback) ----
    // The run's ONE registry read also builds the role map (routing
    // PR 2): each code's role resolves from its own registry entry.
    const registryRaw = await readSaltedDualBlob(registrySaltedKey(), registryBareKey());
    const registry = registryRaw || {};
    const roleMap = buildRoleMap(registryRaw);
    if (!roleMap.ok) console.error('[push-monitor] ROLE MAP UNAVAILABLE (registry read failed) -- actionable pushes suppressed this run');

    // ---- 3. live waits once (shared across all trips) ----
    const [dlResp, dcaResp] = await Promise.all([
      fetch('https://api.themeparks.wiki/v1/entity/' + DL_ID + '/live'),
      fetch('https://api.themeparks.wiki/v1/entity/' + DCA_ID + '/live')
    ]);
    const [dlData, dcaData] = await Promise.all([dlResp.json(), dcaResp.json()]);
    const liveByName = {};
    const ingest = (data) => {
      for (const r of (data.liveData || [])) {
        if (r.entityType !== 'ATTRACTION') continue;
        const w = (r.queue && r.queue.STANDBY && typeof r.queue.STANDBY.waitTime === 'number')
          ? r.queue.STANDBY.waitTime : null;
        if (w === null && !DOWN_STATUSES[r.status]) continue;
        liveByName[normName(r.name)] = { wait: w, status: r.status, name: r.name };
      }
    };
    ingest(dlData); ingest(dcaData);
    const liveKeys = Object.keys(liveByName);

    const summary = [];

    // ---- 4. group codes by trip; evaluate once per trip ----
    // (Oct 16, 2026 -- Claude routing ruling, amended section 1.) Wait-state
    // is per-TRIP, so the old per-code loop raced itself: the first code's
    // pass committed the fire markers into the shared state and the paired
    // code's pass found them set and sent nothing -- blob list order picked
    // the winner. Group the discovered codes by tripId, evaluate each trip
    // once against its per-trip state, and fan delivery out to every code
    // of the trip (see fire() below).
    const tripGroups = new Map();
    for (const code of tripCodes) {
      const entry = registry[code];
      if (!entry || entry.status !== 'active') { summary.push({ code, skip: 'inactive' }); continue; }
      const tripId = safeTripId(entry.tripId || '');
      if (!tripId) { summary.push({ code, skip: 'bad tripId' }); continue; }
      if (!tripGroups.has(tripId)) tripGroups.set(tripId, []);
      tripGroups.get(tripId).push(code);
    }
    for (const [tripId, codes] of tripGroups) {

      const tripData = await readSaltedDualBlob(tripSaltedKey(tripId), tripBareKey(tripId));
      const cfg = tripData && tripData.tripConfig;
      const schedule = cfg && cfg.schedule;
      if (!schedule || !Array.isArray(schedule.days)) { for (const c of codes) summary.push({ code: c, skip: 'no schedule' }); continue; }

      // which day index is "today" in Pacific? dates live in cfg.days[i].date
      // (human "Jun 28, 2026" or ISO), index-aligned with schedule.days[i].
      let todayIdx = -1;
      const cfgDays = Array.isArray(cfg.days) ? cfg.days : [];
      for (let i = 0; i < schedule.days.length; i++) {
        const rawDate = (cfgDays[i] && cfgDays[i].date) ||
                        (schedule.days[i] && (schedule.days[i].date || schedule.days[i].isoDate)) || '';
        if (normDate(rawDate) === pt.ymd) { todayIdx = i; break; }
      }
      if (todayIdx === -1) { for (const c of codes) summary.push({ code: c, skip: 'no day for today (' + pt.ymd + ')' }); continue; }

      // skip VIP days -- the guide handles optimization
      const isVip = cfgDays[todayIdx] && cfgDays[todayIdx].isVip === true;
      if (isVip) { for (const c of codes) summary.push({ code: c, skip: 'VIP day' }); continue; }

      const items = Array.isArray(schedule.days[todayIdx].items) ? schedule.days[todayIdx].items : [];
      const rideItems = items.filter(it => it && it.type === 'ride' && it.h);

      // load per-trip wait state (last-known waits + cooldowns)
      const stateKey = 'twize/wait-state/' + tripId + '.json';
      const state = (await readJsonBlob(stateKey)) || { ymd: pt.ymd, rides: {} };
      if (state.ymd !== pt.ymd) { state.ymd = pt.ymd; state.rides = {}; state.lastHighAlertMin = -99999; } // new day -> reset

      const nowMin = pt.hour * 60 + pt.minute;
      let firedThisTrip = 0;
      let apnsSentTrip = 0;
      const apnsDetails = [];
      const spikes = [];
      const drops = [];
      const highs = [];
      const downs = [];
      const downsAll = [];
      const backUps = [];
      const lastHigh = (typeof state.lastHighAlertMin === 'number') ? state.lastHighAlertMin : -99999;

      // One evaluated event, fanned out to every code of the trip on
      // both channels: web subscriptions + native APNs. "Delivered" for
      // cooldown/commit purposes = at least one channel sent to at
      // least one code (unchanged discipline).
      const sentByCode = {};
      for (const c of codes) sentByCode[c] = 0;
      const variantByCode = {};
      // Roles for this trip's codes, resolved once from the run's
      // single registry read. An unresolved role is a divergence: log
      // it with the code; that code receives awareness (fact)
      // variants only (fail-closed, routing ruling section 3).
      const codeRoles = codes.map((c) => {
        const role = (roleMap.byCode[c] && roleMap.byCode[c].role) || null;
        if (role === null) console.warn('[push-monitor] role unresolved for code ' + c + ' (trip ' + tripId + ') -- actionable suppressed, awareness only');
        return { code: c, role: role };
      });
      // fire(category, makePayload): makePayload(variant) builds the
      // payload for one copy variant -- 'actionable' (leader) or 'fact'
      // (guest). The episode recorded for a code mirrors the payload
      // that code was actually sent (routing decision, Oct 16, 2026).
      const fire = async (category, makePayload) => {
        let sentTotal = 0;
        for (const cr of codeRoles) {
          const variant = variantFor(category, cr.role, roleMap.ok);
          variantByCode[cr.code] = variant;
          if (variant === null) continue;
          const payload = makePayload(variant);
          const w = await sendToTrip(cr.code, payload);
          const a = await sendApnsToTrip(cr.code, payload);
          apnsSentTrip += a.sent;
          if (a && a.detail) apnsDetails.push({ code: cr.code, cat: category, d: a.detail });
          const codeSent = w.sent + a.sent;
          sentByCode[cr.code] += codeSent;
          sentTotal += codeSent;
          // Poll backstop (Claude msg 94 (i)): record every successfully
          // fired episode for the client's ~10s foreground poll, which
          // renders it in-app where the native shell never hands the push
          // to the app's listener. Recorded per code, gated on that code's
          // own delivery -- same discipline as the cooldown / fire-count
          // commits below: a failed send records nothing.
          if (codeSent > 0 && payload && payload.episodeId) {
            // Send evidence (Oct 22 ruling): the devices APNs accepted
            // for THIS code ride the record as hashes, so a device that
            // already got the push never re-presents it in-app. A
            // web-only delivery carries no evidence and still presents.
            await recordEpisode(cr.code, payload, undefined, (a && a.accepted) || []);
          }
        }
        return { sent: sentTotal };
      };

      for (const it of rideItems) {
        const live = resolveLive(it.h, liveByName, liveKeys);
        // ALL-DAY DOWN / BACK-UP episodes (any planned ride, same live feed):
        // evaluate against stored state; alert flags commit only after a send.
        if (live) {
          const ekey = normName(live.name);
          const erec = state.rides[ekey] || {};
          const ev = evaluateRideEpisode(erec, live.status, nowMin, hmToMin(it.t));
          if (ev === 'down' && !downsAll.some(d => d.key === ekey)) {
            downsAll.push({ name: live.name, key: ekey, status: live.status });
          } else if (ev === 'up' && !backUps.some(d => d.key === ekey)) {
            backUps.push({ name: live.name, key: ekey });
          }
          erec.status = live.status; // status memory for the next run
          state.rides[ekey] = erec;
        }
        // DOWN detector: a ride you planned to ride this morning is not operating (rope-drop window only,
        // once per ride per day -- state.rides resets daily). Runs before the OPERATING bail below.
        if (nowMin <= ROPE_DROP_END_MIN && live && DOWN_STATUSES[live.status]) {
          const dkey = normName(live.name);
          const schedMin = hmToMin(it.t);
          const alreadyDown = (state.rides[dkey] || {}).downAlerted === true;
          if (schedMin >= 0 && schedMin <= ROPE_DROP_END_MIN && !alreadyDown && !downs.some(d => d.key === dkey)) {
            downs.push({ name: live.name, key: dkey, status: live.status });
          }
        }
        if (!live || live.status !== 'OPERATING') continue;
        const key = normName(live.name); // key state by the stable live name
        const cur = live.wait;
        const prevRec = state.rides[key] || {};
        const prev = (typeof prevRec.wait === 'number') ? prevRec.wait : null;
        const lastAlert = (typeof prevRec.lastAlertMin === 'number') ? prevRec.lastAlertMin : -99999;
        const lastDrop = (typeof prevRec.lastDropMin === 'number') ? prevRec.lastDropMin : -99999;

        // spike: had a previous low reading, now high, and not in spike cooldown
        const isSpike = prev !== null && prev <= LOW_MAX && cur >= SPIKE_MIN
          && (nowMin - lastAlert) >= ALERT_COOLDOWN_MIN;

        // high: planned ride already busy, no low->high jump needed. Once per ride per day,
        // gated by a per-trip cooldown in the send block so busy rides don't stack alerts.
        const highDone = prevRec.highAlerted === true;
        const isHigh = !isSpike && !highDone && cur >= HIGH_MIN
          && (nowMin - lastHigh) >= HIGH_COOLDOWN_MIN;

        // drop: was high, now genuinely short, dropped a lot, day not over, not in drop cooldown.
        // Spikes take priority -- a ride can't be both (cur can't be >=45 and <=15), but guard anyway.
        const isDrop = !isSpike && !isHigh && prev !== null && cur !== null && prev >= DROP_PREV_MIN && cur <= DROP_NOW_MAX
          && (prev - cur) >= DROP_DELTA_MIN
          && nowMin < DROP_DAY_CUTOFF_MIN
          && (nowMin - lastDrop) >= ALERT_COOLDOWN_MIN;

        if (isHigh) highs.push({ name: live.name, key: key, to: cur });
        if (isSpike) {
          spikes.push({ name: live.name, from: prev, to: cur });
          state.rides[key] = { ...prevRec, wait: cur, lastAlertMin: nowMin, lastDropMin: lastDrop, highAlerted: highDone };
        } else if (isDrop) {
          drops.push({ name: live.name, from: prev, to: cur });
          state.rides[key] = { ...prevRec, wait: cur, lastAlertMin: lastAlert, lastDropMin: nowMin, highAlerted: highDone };
        } else {
          state.rides[key] = { ...prevRec, wait: cur, lastAlertMin: lastAlert, lastDropMin: lastDrop, highAlerted: highDone };
        }
      }

      // fire one notification per trip. A planned ride down wins (rope-drop
      // morning case first, then any all-day down episode); then spikes,
      // back-up good news, busy nudges, drops.
      if (downs.length) {
        const d = downs[0];
        const more = downs.length > 1 ? (' (+' + (downs.length - 1) + ' more)') : '';
        const r = await fire('ride-down', (variant) => {
          const prompt = '.';
          const body = (d.status === 'REFURBISHMENT')
            ? (d.name + ' is closed for refurbishment' + more + prompt)
            : (d.name + ' is temporarily down right now' + more + prompt);
          return {
            title: 'Planned ride is down',
            body: body,
            url: '/app.html',
            tag: 'tpcp-ride-down',
            class: 'ride-update',
            episodeId: episodeIdFor(tripId, d.key, 'down', pt.ymd)
          };
        });
        firedThisTrip = r.sent;
        if (r.sent > 0) {
          // The morning alert also covers any all-day down candidates.
          for (const dn of downs.concat(downsAll)) {
            const rec = state.rides[dn.key] || {};
            rec.downAlerted = true;
            rec.lastDownAlertMin = nowMin;
            state.rides[dn.key] = rec;
          }
        }
      } else if (downsAll.length) {
        const d = downsAll[0];
        const more = downsAll.length > 1 ? (' (+' + (downsAll.length - 1) + ' more)') : '';
        const r = await fire('ride-down', (variant) => {
          const prompt = '.';
          const body = (d.status === 'REFURBISHMENT')
            ? (d.name + ' is closed for refurbishment today' + more + prompt)
            : (d.name + ' is temporarily down' + more + prompt);
          return {
            title: 'Planned ride is down',
            body: body,
            url: '/app.html',
            tag: 'tpcp-ride-down',
            class: 'ride-update',
            episodeId: episodeIdFor(tripId, d.key, 'down', pt.ymd)
          };
        });
        firedThisTrip = r.sent;
        if (r.sent > 0) {
          for (const dn of downsAll) {
            const rec = state.rides[dn.key] || {};
            rec.downAlerted = true;
            rec.lastDownAlertMin = nowMin;
            state.rides[dn.key] = rec;
          }
        }
      } else if (spikes.length) {
        spikes.sort((a, b) => b.to - a.to);
        const worst = spikes[0];
        const more = spikes.length > 1 ? (' (+' + (spikes.length - 1) + ' more)') : '';
        const spikeKey = normName(worst.name);
        const spikeFire = nextFireCount(state.rides[spikeKey], 'spike');
        const r = await fire('wait-spike', (variant) => ({
          title: 'Wait spike on your plan',
          body: worst.name + ' just jumped to ~' + worst.to + ' min' + more + '.',
          url: '/app.html',
          tag: 'tpcp-wait-spike',
          class: 'ride-update',
          episodeId: episodeIdFor(tripId, spikeKey, 'spike', pt.ymd, spikeFire)
        }));
        firedThisTrip = r.sent;
        if (r.sent > 0) commitFireCount(state, spikeKey, 'spike', spikeFire);
      } else if (backUps.length) {
        const u = backUps[0];
        const more = backUps.length > 1 ? (' (+' + (backUps.length - 1) + ' more)') : '';
        const r = await fire('ride-back-up', (variant) => ({
          title: 'Good news \u2014 ride is back',
          body: ((variant === 'actionable') ? (u.name + ' is back' + more + ' \u2014 it\u2019s on your plan if you want to swing back.') : (u.name + ' is operating again' + more + '.')),
          url: '/app.html',
          tag: 'tpcp-ride-up',
          class: 'ride-update',
          episodeId: episodeIdFor(tripId, u.key, 'up', pt.ymd)
        }));
        firedThisTrip = r.sent;
        if (r.sent > 0) {
          for (const up of backUps) {
            const rec = state.rides[up.key] || {};
            rec.downAlerted = false; // episode closed; a re-down can alert again after the cooldown
            state.rides[up.key] = rec;
          }
        }
      } else if (highs.length) {
        highs.sort((a, b) => b.to - a.to);
        const worst = highs[0];
        const highFire = nextFireCount(state.rides[worst.key], 'high');
        const r = await fire('high-wait', (variant) => ({
          title: 'Heads up on your plan',
          body: worst.name + ' is running ~' + worst.to + ' min right now' + '.',
          url: '/app.html',
          tag: 'tpcp-wait-high',
          class: 'ride-update',
          episodeId: episodeIdFor(tripId, worst.key, 'high', pt.ymd, highFire)
        }));
        firedThisTrip = r.sent;
        if (r.sent > 0) {
          state.lastHighAlertMin = nowMin;
          if (state.rides[worst.key]) state.rides[worst.key].highAlerted = true;
          commitFireCount(state, worst.key, 'high', highFire);
        }
      } else if (drops.length) {
        // opportunistic, gentle: pick the biggest drop (lowest current wait)
        drops.sort((a, b) => a.to - b.to);
        const best = drops[0];
        const dropKey = normName(best.name);
        const dropFire = nextFireCount(state.rides[dropKey], 'drop');
        const r = await fire('wait-drop', (variant) => ({
          title: 'Short wait on your plan',
          body: best.name + ' just dropped to ~' + best.to + ' min' + ((variant === 'actionable') ? ' \u2014 want to grab it now?' : ' and it\u2019s on your plan.'),
          url: '/app.html',
          tag: 'tpcp-wait-drop',
          class: 'ride-update',
          episodeId: episodeIdFor(tripId, dropKey, 'drop', pt.ymd, dropFire)
        }));
        firedThisTrip = r.sent;
        if (r.sent > 0) commitFireCount(state, dropKey, 'drop', dropFire);
      }


      // ---- LL ORDER PUSH (Item 5, msg 574): one morning push with
      // the booking order, leader-only. Runs after the alert ladder
      // and only on a sweep the ladder left quiet -- one buzz per
      // sweep stays the discipline. Settles for the day on send OR
      // on window-closed suppression; a failed send settles nothing
      // and the next sweep retries (until the cutoff settles it).
      {
        const llDay = schedule.days[todayIdx];
        const llSettled = (state.llOrder && state.llOrder.ymd === pt.ymd && state.llOrder.status) ? state.llOrder : null;
        let firstItemMin = -1;
        for (const it of items) { const m = hmToMin(it && it.t); if (m >= 0 && (firstItemMin < 0 || m < firstItemMin)) firstItemMin = m; }
        const dec = llOrderDecision(llDay, nowMin, firstItemMin, llSettled);
        if (dec.act === 'fire') {
          const r = await fire('ll-order', () => ({
            title: 'Today\u2019s Lightning Lane game plan',
            body: llOrderBody(llDay.llSequence),
            url: '/app.html',
            tag: 'tpcp-ll-order',
            class: 'll-order',
            episodeId: episodeIdFor(tripId, 'll-order', 'll', pt.ymd)
          }));
          if (r.sent > 0) {
            state.llOrder = { ymd: pt.ymd, status: 'sent', firedMin: nowMin };
            firedThisTrip += r.sent;
          }
        } else if (dec.act === 'suppress') {
          state.llOrder = { ymd: pt.ymd, status: 'suppressed', firedMin: nowMin };
        }
        if (dec.act !== 'skip' || dec.why !== 'not-armed') summary.push({ tripId, llOrder: dec.act, why: dec.why || undefined });
      }

      await writeJsonBlob(stateKey, state);
      summary.push({ tripId, codes, variants: variantByCode, dayIdx: todayIdx, ridesChecked: rideItems.length, downs: downs.length, downsAll: downsAll.length, backUps: backUps.length, spikes: spikes.length, highs: highs.length, drops: drops.length, sent: firedThisTrip, sentByCode, apnsSent: apnsSentTrip, apnsDetail: apnsDetails.length ? apnsDetails : undefined });
    }

    console.log('[push-monitor] ' + pt.ymd + ' ' + pt.hour + ':' + pt.minute + ' PT | ' + JSON.stringify(summary));
    return res.status(200).json({ ok: true, ptHour: pt.hour, trips: tripCodes.length, summary, planChangedFlush: _pcFlush });
  } catch (e) {
    console.error('[push-monitor] error', e.message);
    return res.status(500).json({ error: e.message });
  }
}
