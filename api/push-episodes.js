// api/push-episodes.js
// Poll-backstop episode recording (Claude msg 94 rulings (i) + (iv),
// Oct 8, 2026). The plugin event (pushNotificationReceived) stays the
// instant foreground fast path, but Beau's installed Build 8 shell never
// hands foreground alerts to that listener -- and a foreground-consumed
// alert leaves no Notification Center / delivered-list trace, so the
// delivered-list sweep could never see the failing case (retired, msg 94
// (ii)). The guaranteed floor is the channel the client already runs:
// every episode fired to a trip is ALSO recorded here, per trip code, at
// twize/push-episodes/<tripCode>.json, and GET /api/trip returns the
// list on the response the client's ~10s foreground blob poll already
// fetches. The client feeds unpresented episodes through the SAME
// foreground handler and the SAME session dedupe set as the event path:
// one detector, one handler, one dedupe namespace -- the event marks
// presented episodes and the poll drops them; where the event never
// fires, the poll presents within one poll cycle (~10s, accepted).
//
// Retention (msg 94 (iv)): BOTH bounds, shorter wins -- at most the last
// EPISODE_MAX_PER_TRIP episodes per trip AND nothing older than
// EPISODE_TTL_MS. The read side additionally returns only episodes whose
// ymd is TODAY in Pacific time (the park day the episode fired on);
// the client enforces the same rule before rendering.
//
// Recording discipline mirrors the crons' marker discipline: callers
// record ONLY after a send actually reached at least one device
// (sent > 0), so a failed send leaves no phantom episode for the poll
// to present, and a retry records the episode once, at its real fire.

import { list, put } from '@vercel/blob';

export const EPISODE_TTL_MS = 24 * 60 * 60 * 1000;
export const EPISODE_MAX_PER_TRIP = 20;

// Trip-code floor (Claude msg 72): 3-40 chars. Mirror discipline with
// push-register.js / cron-push-monitor.js / cron-booking-alerts.js.
export function safeEpisodeTripCode(v) {
  return typeof v === 'string' && /^[A-Za-z0-9-]{3,40}$/.test(v) ? v : null;
}

// Pacific (park-local) YYYY-MM-DD for a timestamp -- the day an episode
// belongs to. Server-side mirror of the monitor's pacificParts ymd.
export function pacificYmd(nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(now));
}

// Normalize a fired payload into its recorded episode. Returns null when
// the payload carries no episodeId -- without the shared dedupe identity
// there is nothing safe to record (the poll could never dedupe it).
export function episodeRecordFromPayload(payload, nowMs) {
  if (!payload || typeof payload.episodeId !== 'string' || !payload.episodeId) return null;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const rec = {
    episodeId: payload.episodeId,
    class: typeof payload.class === 'string' ? payload.class : '',
    tag: typeof payload.tag === 'string' ? payload.tag : '',
    title: typeof payload.title === 'string' ? payload.title : '',
    body: typeof payload.body === 'string' ? payload.body : '',
    ymd: pacificYmd(now),
    firedAt: now
  };
  if (payload.schedVersion != null) rec.schedVersion = payload.schedVersion;
  if (typeof payload.url === 'string' && payload.url) rec.url = payload.url;
  return rec;
}

// The retention rule, pure: drop malformed entries, drop anything older
// than the TTL, order oldest-first, keep only the newest MAX.
export function pruneEpisodes(list, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const arr = (Array.isArray(list) ? list : []).filter(function (e) {
    return e && typeof e.episodeId === 'string' && typeof e.firedAt === 'number'
      && (now - e.firedAt) <= EPISODE_TTL_MS;
  });
  arr.sort(function (a, b) { return a.firedAt - b.firedAt; });
  return arr.slice(-EPISODE_MAX_PER_TRIP);
}

// Append one record to an existing list under the retention rule. A
// re-record of the same episodeId replaces the earlier copy (a retried
// send is one episode, presented once).
export function mergeEpisode(list, rec, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const base = pruneEpisodes(list, now).filter(function (e) { return e.episodeId !== rec.episodeId; });
  base.push(rec);
  return pruneEpisodes(base, now);
}

function episodesKey(tripCode) { return 'twize/push-episodes/' + tripCode + '.json'; }

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

// Record one fired episode for a trip code. Never throws: a recording
// failure must never break the send path that already delivered the push
// (the banner/event presentations still happened). Returns true when the
// episode was recorded.
export async function recordEpisode(tripCode, payload, nowMs) {
  try {
    const code = safeEpisodeTripCode(tripCode);
    if (!code) return false;
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const rec = episodeRecordFromPayload(payload, now);
    if (!rec) return false;
    const key = episodesKey(code);
    const cur = await readBlobJson(key);
    const episodes = mergeEpisode(cur && cur.episodes, rec, now);
    await writeJsonBlob(key, { tripCode: code, episodes: episodes, updated: new Date(now).toISOString() });
    return true;
  } catch (e) {
    console.warn('[push-episodes] record failed', e && e.message);
    return false;
  }
}

// The poll read side (GET /api/trip): retention-pruned, and only today's
// (Pacific) episodes -- the client renders nothing older than the park
// day it fired on. Never throws; a read failure reads as "no episodes".
export async function readEpisodesForPoll(tripCode, nowMs) {
  try {
    const code = safeEpisodeTripCode(tripCode);
    if (!code) return [];
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const cur = await readBlobJson(episodesKey(code));
    const today = pacificYmd(now);
    return pruneEpisodes(cur && cur.episodes, now).filter(function (e) { return e.ymd === today; });
  } catch (e) { return []; }
}

// ---- Booking done flags (Claude msg 118, Oct 9, 2026) -------------------
// Beau's booking-reminder design: the reminder is a nudge-until-done
// with two stop conditions -- the trip marks it done, or a device's own
// showing budget (3) runs out. The DONE fact is the TRIP's (one booking
// serves the whole party), so it lives server-side, keyed by tripId in
// its own blob -- never inside the per-code episodes record above
// (recordEpisode rewrites that record wholesale; a done map inside it
// would be wiped by the next recorded episode) and never in the
// trip/schedule blob. The per-device count is the client's local
// courtesy (localStorage) and the server never sees it. Governing
// rule: present iff (not server-done) AND (local count < 3). The flag
// records a USER ASSERTION ("I made my reservation"), not a verified
// booking; nothing here checks Disney, by design.
// Storage: twize/booking-done/<tripId>.json =
//   { tripId, done: { <episodeId>: { at, by } }, updated }

export const BOOKING_DONE_MAX = 50;

// tripIds are slug-shaped ('beau-test-1'). The done key is built from
// the registry-resolved tripId, never from a client-sent value.
export function safeBookingTripId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v) ? v : null;
}

// Booking episodeIds are stamped ep:<tripId>:booking:<date> by the
// booking handler. The done write accepts only that shape, so the
// store can only ever name booking-class episodes.
export function safeBookingEpisodeId(v) {
  return typeof v === 'string' && /^ep:[A-Za-z0-9_-]+:booking:[A-Za-z0-9-]+$/.test(v) ? v : null;
}

function bookingDoneKey(tripId) { return 'twize/booking-done/' + tripId + '.json'; }

// Validate + bound a stored done map: keep only well-formed entries,
// newest BOOKING_DONE_MAX by `at`. Done entries for episodes past
// their retention are inert (the poll never offers those episodes
// again), so the write-side cap is the only bound the store needs.
export function pruneBookingDone(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  const entries = [];
  for (const k of Object.keys(map)) {
    const e = map[k];
    if (!safeBookingEpisodeId(k)) continue;
    if (!e || typeof e.at !== 'number') continue;
    entries.push([k, { at: e.at, by: typeof e.by === 'string' ? e.by.slice(0, 20) : '' }]);
  }
  entries.sort(function (a, b) { return a[1].at - b[1].at; });
  const keep = entries.slice(-BOOKING_DONE_MAX);
  for (const pair of keep) out[pair[0]] = pair[1];
  return out;
}

// Pure merge: set one episode's done flag on a bounded copy of the map.
export function mergeBookingDone(map, episodeId, atMs, byRole) {
  const base = pruneBookingDone(map);
  if (!safeBookingEpisodeId(episodeId)) return base;
  base[episodeId] = {
    at: typeof atMs === 'number' ? atMs : Date.now(),
    by: typeof byRole === 'string' ? byRole.slice(0, 20) : ''
  };
  return pruneBookingDone(base);
}

// Mark one booking episode done for the trip. Never throws: the write
// rides behind a user tap whose dismiss must proceed regardless.
// Returns true when the flag was stored.
export async function markBookingDone(tripId, episodeId, byRole, nowMs) {
  try {
    const tid = safeBookingTripId(tripId);
    if (!tid || !safeBookingEpisodeId(episodeId)) return false;
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const key = bookingDoneKey(tid);
    const cur = await readBlobJson(key);
    const done = mergeBookingDone(cur && cur.done, episodeId, now, byRole);
    await writeJsonBlob(key, { tripId: tid, done: done, updated: new Date(now).toISOString() });
    return true;
  } catch (e) {
    console.warn('[push-episodes] booking done write failed', e && e.message);
    return false;
  }
}

// Read the trip's done map. Never throws; any failure reads as "not
// done" ({}), so the reminder still presents and the user can act on
// it -- the flag silences a nudge, it never gates the action.
export async function readBookingDone(tripId, nowMs) {
  try {
    const tid = safeBookingTripId(tripId);
    if (!tid) return {};
    const cur = await readBlobJson(bookingDoneKey(tid));
    return pruneBookingDone(cur && cur.done);
  } catch (e) { return {}; }
}
