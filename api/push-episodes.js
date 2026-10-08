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
