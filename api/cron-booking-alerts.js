// api/cron-booking-alerts.js
// Dining BOOKING-WINDOW alerts. Once a day, early morning Pacific, this cron
// checks every registered trip: when one of the trip's days is exactly
// BOOKING_WINDOW_DAYS (60) out, that day's Disneyland dining booking window
// opens that morning -- so we push the trip's devices ONE alert naming the
// restaurants the guest said they want for that day, with a tap-through link
// into Disney's OFFICIAL booking pages.
//
// CATCH-UP (Beau's rule, Claude msg 72, Oct 8, 2026): a trip built INSIDE
// the 60-day window -- or an opens-today send that was missed -- would
// otherwise never alert for days whose windows are already open. Days
// strictly inside the window (today < day < today+60) with alertable
// wishes and no dedupe marker are catch-up candidates; the cron fires at
// most ONE per trip per run (soonest park day first) with 'already open'
// wording. Markers share the opens-today per-day namespace, so a day is
// alerted exactly once across both paths, ever. Wishes whose venue the
// guest already holds as a confirmed reservation never alert on either
// path -- a booking alert for a table already booked is a nag.
//
// PERMITTED BY DESIGN (Beau's ruling, Oct 7, 2026): this feature does NO
// availability polling, calls NO Disney endpoint, and holds NO credentials.
// The only outbound calls are Vercel Blob storage and the push services
// (Web Push + APNs, same dual-channel send path as cron-push-monitor).
// Disney appears only as a link string inside the notification payload.
// The scraping-based dining-alert variant was spiked and rejected on
// permission grounds (see dining_alerts_spike.md in the debug workspace).
//
// INTERNAL ONLY. Auth: Bearer CRON_SECRET (Vercel attaches it to cron
// invocations), OR admin key -- same pattern as cron-push-monitor.
// Storage:
//   twize/push-subs/<tripCode>.json        -- web subscriptions (read)
//   twize/push-devices/<tripCode>.json     -- APNs device tokens (read)
//   twize/trip_registry.json               -- code -> { tripId, status, expires }
//   twize/trip_<tripId>.json               -- tripData.tripConfig (days, wishes)
//   twize/booking-alert-state/<tripCode>.json -- per-trip sent markers (dedupe)
//
// Schedule (vercel.json): "30 12 * * *" UTC. Vercel cron times are UTC and do
// NOT follow DST: 12:30 UTC = 05:30 PT during daylight time (Mar-Nov, peak
// season) and 04:30 PT during standard time. ASSUMPTION: Disneyland dining
// inventory for a newly-opened date appears around 6:00 AM PT (Disney help /
// planDisney wording: openings "usually appear around 6:00 a.m. Pacific";
// WDWNT, Jan 2026: "Reservations typically open at 6 a.m. PT"). So in DST the
// alert lands ~30 min BEFORE the release; in standard time ~90 min before --
// either way it is in the guest's pocket that morning, ahead of the drop,
// never after it. If the release assumption is wrong, the alert still lands
// the same morning and the date math below is unaffected.
//
// Dry run: ?dryRun=1 (auth still required) computes matches and reports what
// WOULD be sent, but sends nothing and writes no state.

import webpush from 'web-push';
import { isApnsConfigured, sendApnsToDevices } from './apns.js';

// Disneyland dining reservations open 60 days before the dining date.
export const BOOKING_WINDOW_DAYS = 60;

// Secret path-prefix hardening -- identical to cron-push-monitor. When
// BLOB_PATH_SALT is set, the registry and per-trip blobs live behind an
// unguessable path segment. Reads are salted-first with a bare-key fallback.
// Subs, devices and state keys are NOT salted. Never log the salted key.
const SALT = (process.env.BLOB_PATH_SALT || '').trim();
const registryBareKey = () => 'twize/trip_registry.json';
const tripBareKey = (tripId) => 'twize/trip_' + tripId + '.json';
const registrySaltedKey = () => SALT ? ('twize/' + SALT + '/trip_registry.json') : 'twize/trip_registry.json';
const tripSaltedKey = (tripId) => SALT ? ('twize/' + SALT + '/trip_' + tripId + '.json') : ('twize/trip_' + tripId + '.json');
const bookingStateKey = (tripCode) => 'twize/booking-alert-state/' + tripCode + '.json';

// ---- name -> booking link map -------------------------------------------
// Per-restaurant links use Disney's own public restaurant page form:
//   https://disneyland.disney.go.com/dine-res/restaurant/{facilityId}
// (the same "Book now" URL printed by Disney's restaurant index tooling).
// facilityIds below come from Disney's published restaurant index as
// enumerated by the dine-at-disney CLI `list` output (mirrored in its npm
// README) and cross-checked against the Oct 7, 2026 feasibility spike, which
// also probed the 354099 page URL live (302 trailing-slash redirect via
// Akamai -- the page exists). Venues that accept reservations but whose
// facilityId we could NOT verify fall back to the resort dining hub
// (DINING_HUB_URL) -- they are listed with facilityId: null and are counted
// as fallbacks in the run summary. Matching is normalization + bidirectional
// substring (longest key first), mirroring cron-cache classifyVenue's
// suffix-tolerant style, so 'Lamplight Lounge Dining Room' resolves to the
// Lamplight Lounge entry.
export const DINING_HUB_URL = 'https://disneyland.disney.go.com/dining/';
const DINE_RES_BASE = 'https://disneyland.disney.go.com/dine-res/restaurant/';
// Keys are normName() outputs. First block: catalog table-service + lounge
// venues (api/cron-cache.js CATALOG_TABLE_NAMES / CATALOG_LOUNGE_MAP) plus
// bookable hotel/DTD venues a guest can name in the same onboarding fields.
export const RESTAURANT_LINKS = {
  'blue bayou restaurant': { display: 'Blue Bayou Restaurant', facilityId: '354099' },
  'cafe orleans': { display: 'Cafe Orleans', facilityId: '354117' },
  'carnation cafe': { display: 'Carnation Cafe', facilityId: '354129' },
  'river belle terrace': { display: 'River Belle Terrace', facilityId: '354450' },
  'carthay circle restaurant': { display: 'Carthay Circle Restaurant', facilityId: '16515009' },
  'lamplight lounge': { display: 'Lamplight Lounge', facilityId: '19013078' },
  'goofys kitchen': { display: "Goofy's Kitchen", facilityId: '354261' },
  'gch craftsman bar': { display: 'GCH Craftsman Bar', facilityId: '19343532' },
  'catal restaurant': { display: 'Catal Restaurant', facilityId: '354132' },
  // Bookable, but facilityId unverified -> dining-hub fallback.
  'wine country trattoria': { display: 'Wine Country Trattoria', facilityId: null },
  'ogas cantina': { display: "Oga's Cantina", facilityId: null },
  'carthay circle lounge': { display: 'Carthay Circle Lounge', facilityId: null },
  'storytellers cafe': { display: 'Storytellers Cafe', facilityId: null },
  'napa rose': { display: 'Napa Rose', facilityId: null },
  'trader sams enchanted tiki bar': { display: "Trader Sam's Enchanted Tiki Bar", facilityId: null },
  'plaza inn': { display: 'Plaza Inn', facilityId: null },
  'disney princess breakfast adventures': { display: 'Disney Princess Breakfast Adventures', facilityId: null }
};
const LINK_KEYS = Object.keys(RESTAURANT_LINKS).sort((a, b) => b.length - a.length);

// Resolve a guest-typed restaurant name to a booking link.
// Returns { display, url, verified } or null when the name is not a known
// bookable (table-service / lounge / character) venue.
export function bookingLinkFor(rawName) {
  const n = normName(rawName);
  if (!n) return null;
  for (const k of LINK_KEYS) {
    if (n === k || n.indexOf(k) !== -1 || k.indexOf(n) !== -1) {
      const e = RESTAURANT_LINKS[k];
      if (e.facilityId) return { display: e.display, url: DINE_RES_BASE + e.facilityId, verified: true };
      return { display: e.display, url: DINING_HUB_URL, verified: false };
    }
  }
  return null;
}

// ---- small helpers (mirrors of cron-push-monitor, kept in sync) ----
function safeTripId(raw) {
  if (typeof raw !== 'string') return '';
  const t = raw.trim();
  if (!/^[A-Za-z0-9_-]{3,60}$/.test(t)) return '';
  return t;
}
export function safeTripCode(raw) {
  if (typeof raw !== 'string') return '';
  const t = raw.trim();
  // 3..40 (was 8..40 -- the 8-char floor silently dropped real 6-char
  // codes like BEAU01 from discovery; registry membership is the auth.
  // Oct 8, 2026 diagnosis. Keep in sync with push-register.js et al.)
  if (!/^[A-Za-z0-9-]{3,40}$/.test(t)) return '';
  return t;
}
export function normName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const MONTHS = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
                 jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
export function normDate(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const s = raw.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  const hm = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (hm) {
    const mo = MONTHS[hm[1].slice(0, 3).toLowerCase()];
    if (mo) return hm[3] + '-' + mo + '-' + (hm[2].length === 1 ? '0' + hm[2] : hm[2]);
  }
  return '';
}
// ---- Pacific-time helpers (Disneyland local) ----
export function pacificParts(now) {
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
// Calendar-date arithmetic in YMD space (UTC noon anchor -- DST-proof: the
// only Pacific input is "today", everything after is pure calendar math).
export function addDaysYmd(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return '';
  const t = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12) + n * 86400000;
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}
// "Thu, Dec 4, 2026" for a YMD (weekday computed on the date itself, UTC).
export function prettyDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return ymd || '';
  const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  }).format(d);
}

// ---- THE wish source (pluggable) -----------------------------------------
// extractDiningWishes(tripConfig) -> [{ name, day, source }]
//   day: 1-based trip day the wish belongs to, or null when undated.
// Reads exactly what onboarding captures TODAY (pretrip ptCollectData +
// the tripConfig normalization in pretrip.html):
//   1. tripConfig.dining.reservations -- structured objects
//      [{ name, time, day, isConfirmed }] built client-side from the
//      "dining reservations" textarea lines.
//   2. tripConfig.reservations -- the same lines as flat strings
//      ("Blue Bayou, 12:00 PM, Day 1"), parsed with the same comma-split
//      logic generateschedule.js / pretrip.html use.
//   Sources 1-2 are the sit-down channel (the onboarding copy scopes that
//   field to table-service: "Planning a sit-down (table-service) meal? Add
//   it as a reservation below"), so every name they carry is a wish; the
//   link lookup decides verified vs hub fallback per name.
//   3. tripConfig.wantedRestaurants -- a free-text string of spot names the
//   guest wants worked into the day. That field is quick-service-first, so
//   only names resolving to a known bookable venue (bookingLinkFor) are
//   kept -- a QS spot has no booking window to alert about.
// Deduped by normalized name; an entry WITH a day beats an undated duplicate.
export function extractDiningWishes(tripConfig) {
  const cfg = tripConfig || {};
  const out = [];
  const seen = {};
  const add = (name, day, source) => {
    const clean = (name || '').trim();
    if (!clean) return;
    const k = normName(clean);
    if (!k) return;
    const d = (typeof day === 'number' && day >= 1) ? day : null;
    if (seen[k]) {
      if (seen[k].day === null && d !== null) seen[k].day = d;
      return;
    }
    const w = { name: clean, day: d, source: source };
    seen[k] = w;
    out.push(w);
  };
  const structured = (cfg.dining && Array.isArray(cfg.dining.reservations)) ? cfg.dining.reservations : [];
  for (const r of structured) {
    if (r && typeof r.name === 'string') add(r.name, (typeof r.day === 'number') ? r.day : null, 'dining.reservations');
  }
  const flat = Array.isArray(cfg.reservations) ? cfg.reservations : [];
  for (const s of flat) {
    if (!s || typeof s !== 'string') continue;
    const parts = s.split(',').map((p) => p.trim());
    const dayMatch = (parts[2] || '').match(/(\d+)/);
    add(parts[0] || '', dayMatch ? parseInt(dayMatch[1], 10) : null, 'reservations');
  }
  const wanted = (typeof cfg.wantedRestaurants === 'string') ? cfg.wantedRestaurants : '';
  if (wanted.trim()) {
    for (const piece of wanted.split(/[\n,;]+/)) {
      const nm = piece.trim();
      if (nm && bookingLinkFor(nm)) add(nm, null, 'wantedRestaurants');
    }
  }
  return out;
}
// Wishes belonging to one opening day. Day-tagged wishes fire only on their
// day; undated wishes are trip-level, so they fire on the FIRST trip day's
// opening (day 1) -- the first window that could satisfy them.
export function wishesForOpeningDay(wishes, dayNum) {
  return (wishes || []).filter((w) => (w.day !== null && w.day !== undefined) ? w.day === dayNum : dayNum === 1);
}

// Canonical display name for a wish: the matched venue's display name
// when the name resolves to a known bookable venue ('blue bayou' ->
// 'Blue Bayou Restaurant'), else the guest's text as-is. Payloads render
// the canonical name -- never a string-cased transformation of raw user
// text (Claude msg 72 rider).
export function displayNameFor(rawName) {
  const link = bookingLinkFor(rawName);
  return link ? link.display : (rawName || '');
}
function venueKey(rawName) { return normName(displayNameFor(rawName)); }
// Venues the guest already HOLDS as confirmed reservations, keyed by
// canonical venue. A booking alert for a table already booked is a nag,
// not a service -- excluded from BOTH planners (msg 72). Only the
// structured dining.reservations source carries isConfirmed (onboarding
// stamps it true for reservations the guest enters as already booked --
// those are anchors, not wishes).
function confirmedVenueKeys(cfg) {
  const keys = new Set();
  const structured = (cfg && cfg.dining && Array.isArray(cfg.dining.reservations)) ? cfg.dining.reservations : [];
  for (const r of structured) {
    if (r && r.isConfirmed === true && typeof r.name === 'string' && r.name.trim()) keys.add(venueKey(r.name));
  }
  return keys;
}
// One day's wishes, minus held venues, with canonical display names.
function alertableWishes(dayWishes, confirmedKeys) {
  return (dayWishes || [])
    .filter((w) => !confirmedKeys.has(venueKey(w.name)))
    .map((w) => Object.assign({}, w, { name: displayNameFor(w.name) }));
}

export function buildBookingPayload(wishes, openYmd) {
  const names = wishes.map((w) => displayNameFor(w.name));
  const first = names[0];
  const dateStr = prettyDate(openYmd);
  let body;
  if (names.length === 1) {
    body = 'Booking opens today for ' + first + ' \u2014 ' + dateStr + '. Tap to book on Disney\u2019s site.';
  } else if (names.length === 2) {
    body = 'Booking opens today for ' + names[0] + ' and ' + names[1] + ' \u2014 ' + dateStr + '. Tap to book on Disney\u2019s site.';
  } else {
    body = 'Booking opens today for ' + names[0] + ', ' + names[1] + ' and ' + (names.length - 2) + ' more of your picks \u2014 ' + dateStr + '. Tap to book on Disney\u2019s site.';
  }
  // Tap-through: the first wish with a VERIFIED per-restaurant link wins;
  // otherwise the resort dining hub (payload url when all are fallback-class).
  let url = DINING_HUB_URL;
  for (const w of wishes) {
    const link = bookingLinkFor(w.name);
    if (link && link.verified) { url = link.url; break; }
  }
  return { title: 'Dining booking opens today', body: body, url: url, tag: 'tpcp-booking-open', class: 'booking' };
}

// Pure planner (unit-tested): given a tripConfig, today's Pacific YMD, and
// the set of dates already alerted, return the alerts to fire now:
// [{ date, dayNum, wishes, payload }]. A day alerts when its date is exactly
// BOOKING_WINDOW_DAYS after today; past trips and already-sent dates yield
// nothing. Dates come from cfg.days[i].date (ISO or "Jun 28, 2026"), with
// cfg.schedule.days[i] as the fallback source -- same alignment the wait
// monitor uses.
export function planBookingAlerts(tripConfig, todayYmd, alreadySent) {
  const cfg = tripConfig || {};
  const target = addDaysYmd(todayYmd, BOOKING_WINDOW_DAYS);
  if (!target) return [];
  const sent = alreadySent || {};
  const cfgDays = Array.isArray(cfg.days) ? cfg.days : [];
  const schedDays = (cfg.schedule && Array.isArray(cfg.schedule.days)) ? cfg.schedule.days : [];
  const n = Math.max(cfgDays.length, schedDays.length);
  const wishes = extractDiningWishes(cfg);
  const confirmed = confirmedVenueKeys(cfg);
  const plan = [];
  const seenDates = {};
  for (let i = 0; i < n; i++) {
    const rawDate = (cfgDays[i] && cfgDays[i].date) ||
                    (schedDays[i] && (schedDays[i].date || schedDays[i].isoDate)) || '';
    const ymd = normDate(rawDate);
    if (!ymd || ymd !== target || seenDates[ymd]) continue;
    seenDates[ymd] = true;
    if (sent[ymd]) continue;
    const dayWishes = alertableWishes(wishesForOpeningDay(wishes, i + 1), confirmed);
    if (!dayWishes.length) continue;
    plan.push({ date: ymd, dayNum: i + 1, wishes: dayWishes, payload: buildBookingPayload(dayWishes, ymd) });
  }
  return plan;
}

// 'Already open' payload for the catch-up path: same verified-link
// discipline as opens-today, wording that tells the truth about the
// case -- the window is not opening, it is open, and tables go fast.
export function buildCatchUpPayload(wishes, dayYmd) {
  const names = wishes.map((w) => displayNameFor(w.name));
  const first = names[0];
  const dateStr = prettyDate(dayYmd);
  let body;
  if (names.length === 1) {
    body = 'Booking is already open for ' + first + ' \u2014 ' + dateStr + '. These tables go fast \u2014 tap to book on Disney\u2019s site.';
  } else if (names.length === 2) {
    body = 'Booking is already open for ' + names[0] + ' and ' + names[1] + ' \u2014 ' + dateStr + '. These tables go fast \u2014 tap to book on Disney\u2019s site.';
  } else {
    body = 'Booking is already open for ' + names[0] + ', ' + names[1] + ' and ' + (names.length - 2) + ' more of your picks \u2014 ' + dateStr + '. These tables go fast \u2014 tap to book on Disney\u2019s site.';
  }
  let url = DINING_HUB_URL;
  for (const w of wishes) {
    const link = bookingLinkFor(w.name);
    if (link && link.verified) { url = link.url; break; }
  }
  return { title: 'Dining booking already open', body: body, url: url, tag: 'tpcp-booking-catchup', class: 'booking' };
}

// Catch-up planner (pure, unit-tested): every park day strictly inside
// the booking window (today < day < today+60) that carries alertable
// wishes and has NO marker in the shared per-day sent namespace, ranked
// soonest park day first (then day order). The handler fires at most the
// first candidate per trip per run -- the msg-72 cap -- so a multi-day
// backlog drains one alert per morning and unmarked days stay eligible
// tomorrow (section-11 anti-nag posture). Disjoint from the opens-today
// planner by construction: that one matches exactly today+60.
export function planCatchUpAlerts(tripConfig, todayYmd, alreadySent) {
  const cfg = tripConfig || {};
  const target = addDaysYmd(todayYmd, BOOKING_WINDOW_DAYS);
  if (!target) return [];
  const sent = alreadySent || {};
  const cfgDays = Array.isArray(cfg.days) ? cfg.days : [];
  const schedDays = (cfg.schedule && Array.isArray(cfg.schedule.days)) ? cfg.schedule.days : [];
  const n = Math.max(cfgDays.length, schedDays.length);
  const wishes = extractDiningWishes(cfg);
  const confirmed = confirmedVenueKeys(cfg);
  const out = [];
  const seenDates = {};
  for (let i = 0; i < n; i++) {
    const rawDate = (cfgDays[i] && cfgDays[i].date) ||
                    (schedDays[i] && (schedDays[i].date || schedDays[i].isoDate)) || '';
    const ymd = normDate(rawDate);
    if (!ymd || seenDates[ymd]) continue;
    seenDates[ymd] = true;
    if (ymd <= todayYmd || ymd >= target) continue;
    if (sent[ymd]) continue;
    const dayWishes = alertableWishes(wishesForOpeningDay(wishes, i + 1), confirmed);
    if (!dayWishes.length) continue;
    out.push({ date: ymd, dayNum: i + 1, wishes: dayWishes, payload: buildCatchUpPayload(dayWishes, ymd), kind: 'catchup' });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.dayNum - b.dayNum));
  return out;
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
    console.error('[booking-alerts] read error', key, e.message);
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
    console.error('[booking-alerts] salted read error', e.message);
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
    console.error('[booking-alerts] list subs error', e.message);
    return [];
  }
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
    console.error('[booking-alerts] list devices error', e.message);
    return [];
  }
}

// ---- send path: mirrors cron-push-monitor's dual-channel fire() ----
let _vapidConfigured = false;
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
      console.warn('[booking-alerts] send fail', code || (err && err.message));
    }
  }
  let pruned = 0;
  if (survivors.length !== subs.length) {
    pruned = subs.length - survivors.length;
    try {
      await writeJsonBlob('twize/push-subs/' + tripCode + '.json',
        { tripCode: tripCode, subscriptions: survivors, updated: new Date().toISOString() });
    } catch (e) { console.error('[booking-alerts] prune write failed', e.message); }
  }
  return { sent, failed, pruned };
}
async function sendApnsToTrip(tripCode, payloadObj) {
  if (!isApnsConfigured()) return { sent: 0, failed: 0, pruned: 0, skipped: true };
  const devBlob = await readJsonBlob('twize/push-devices/' + tripCode + '.json');
  const devices = (devBlob && Array.isArray(devBlob.devices)) ? devBlob.devices : [];
  const targets = devices.filter(d => d && d.platform === 'ios' && typeof d.token === 'string' && d.alertsEnabled !== false);
  if (!targets.length) return { sent: 0, failed: 0, pruned: 0 };
  const results = await sendApnsToDevices(targets.map(d => d.token), payloadObj);
  let sent = 0, failed = 0;
  const deadTokens = new Set();
  for (const r of results) {
    if (r.verdict === 'ok') sent++;
    else {
      failed++;
      if (r.verdict === 'prune') deadTokens.add(r.token);
      else if (r.verdict === 'auth-error') console.warn('[booking-alerts] APNs auth error', r.reason);
    }
  }
  let pruned = 0;
  if (deadTokens.size) {
    const survivors = devices.filter(d => !(d && deadTokens.has(d.token)));
    pruned = devices.length - survivors.length;
    try {
      await writeJsonBlob('twize/push-devices/' + tripCode + '.json',
        { tripCode: tripCode, devices: survivors, updated: new Date().toISOString() });
    } catch (e) { console.error('[booking-alerts] apns prune write failed', e.message); }
  }
  return { sent, failed, pruned };
}

// ---- shared dual-channel fire (composed for api/push-test.js) -----------
// configureWebPush(): idempotent VAPID setup for callers outside this
// cron's handler. The handler keeps its own inline setup (it resets
// _vapidConfigured each run so its kill-switch posture is unchanged);
// this helper only fills the gap for a cold module instance.
export function configureWebPush() {
  if (_vapidConfigured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT || 'mailto:hello@themeparkcopilot.com';
  if (!pub || !priv) return false;
  try { webpush.setVapidDetails(subj, pub, priv); _vapidConfigured = true; }
  catch (e) { console.warn('[booking-alerts] VAPID config invalid: ' + e.message); }
  return _vapidConfigured;
}

// fireTripPush(tripCode, payloadObj): THE dual-channel send path the
// crons use, composed -- web subscriptions (sendToTrip) + native APNs
// devices (sendApnsToTrip) for ONE trip-code bucket, with the same
// dead-sub / dead-token pruning the crons apply. Imported by
// api/push-test.js so the on-demand test exercises the REAL production
// path (Claude msg 76: only the trigger differs). Writes NO dedupe
// markers of any kind -- marker discipline belongs to the callers (the
// crons write state.sent only after a successful send; the test
// endpoint never writes markers at all).
export async function fireTripPush(tripCode, payloadObj) {
  configureWebPush();
  const w = await sendToTrip(tripCode, payloadObj);
  const a = await sendApnsToTrip(tripCode, payloadObj);
  return {
    web: w, apns: a,
    sent: (w.sent || 0) + (a.sent || 0),
    failed: (w.failed || 0) + (a.failed || 0),
    pruned: (w.pruned || 0) + (a.pruned || 0)
  };
}

export default async function handler(req, res) {
  // ---- AUTH FIRST (internal only) ----
  const secret = process.env.CRON_SECRET;
  const isAuthed = secret && req.headers.authorization === ('Bearer ' + secret);
  const _adminKey = (process.env.ADMIN_KEY || '').toLowerCase();
  const isAdmin = _adminKey.length > 0 && (req.headers['x-admin-key'] || '').toLowerCase() === _adminKey;
  if (!isAuthed && !isAdmin) {
    console.warn('[booking-alerts] unauthorized blocked');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const dryRun = !!(req.query && req.query.dryRun === '1');
  const now = new Date();
  const pt = pacificParts(now);
  const todayYmd = pt.ymd;

  // ---- Push channel config: Web Push (VAPID) and/or native APNs ----
  // Kill switch posture: with NEITHER channel configured the feature is
  // inert -- a clean, logged no-op (never a 500), matching the APNs
  // ship-dark posture. dryRun still computes matches in that state.
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT || 'mailto:hello@themeparkcopilot.com';
  _vapidConfigured = false;
  if (pub && priv) {
    try { webpush.setVapidDetails(subj, pub, priv); _vapidConfigured = true; }
    catch (e) { console.warn('[booking-alerts] VAPID config invalid: ' + e.message); }
  }
  const apnsOk = isApnsConfigured();
  if (!_vapidConfigured && !apnsOk && !dryRun) {
    console.log('[booking-alerts] no push channel configured -- inert no-op');
    return res.status(200).json({ ok: true, skipped: 'no push channel configured', today: todayYmd });
  }

  try {
    // ---- 1. discover trips with web subscriptions or native devices ----
    const subCodes = await listTripCodesWithSubs();
    const devCodes = await listTripCodesWithDevices();
    const tripCodes = Array.from(new Set(subCodes.concat(devCodes)));
    if (!tripCodes.length) {
      console.log('[booking-alerts] ' + todayYmd + ' | no subscribed trips');
      return res.status(200).json({ ok: true, trips: 0, today: todayYmd, note: 'no subscribed trips' });
    }

    // ---- 2. registry: code -> tripId (salted-first, bare-fallback) ----
    const registry = await readSaltedDualBlob(registrySaltedKey(), registryBareKey()) || {};

    const summary = [];
    for (const code of tripCodes) {
      const entry = registry[code];
      if (!entry || entry.status !== 'active') { summary.push({ code, skip: 'inactive' }); continue; }
      const tripId = safeTripId(entry.tripId || '');
      if (!tripId) { summary.push({ code, skip: 'bad tripId' }); continue; }

      const tripData = await readSaltedDualBlob(tripSaltedKey(tripId), tripBareKey(tripId));
      const cfg = tripData && tripData.tripConfig;
      if (!cfg) { summary.push({ code, skip: 'no tripConfig' }); continue; }

      const stateKey = bookingStateKey(code);
      const state = (await readJsonBlob(stateKey)) || { tripCode: code, sent: {} };
      if (!state.sent || typeof state.sent !== 'object') state.sent = {};

      const plan = planBookingAlerts(cfg, todayYmd, state.sent);
      let items = plan;
      if (!items.length) {
        // Catch-up (msg 72 cap, held firm): at most ONE catch-up alert
        // per trip per run -- the ranked soonest in-window unmarked day.
        // The rest stay unmarked and eligible tomorrow.
        const catchUp = planCatchUpAlerts(cfg, todayYmd, state.sent);
        if (catchUp.length) items = [catchUp[0]];
      }
      if (!items.length) { summary.push({ code, skip: 'no window opening today' }); continue; }

      for (const item of items) {
        if (dryRun) {
          summary.push({ code, tripId, date: item.date, dayNum: item.dayNum, kind: item.kind || 'open', dryRun: true, wouldSend: item.payload, restaurants: item.wishes.map(w => w.name) });
          continue;
        }
        // One alert per trip per opening day, both channels (monitor fire()).
        const w = await sendToTrip(code, item.payload);
        const a = await sendApnsToTrip(code, item.payload);
        const sent = w.sent + a.sent;
        if (sent > 0) {
          // Marker discipline is shared across both paths: the marker is
          // keyed by park-day date in state.sent and written ONLY after a
          // successful send, so a caught-up day can never later receive
          // an opens-today alert for the same day (and vice versa).
          state.sent[item.date] = {
            at: new Date().toISOString(),
            restaurants: item.wishes.map(x => x.name),
            web: w.sent, apns: a.sent
          };
          if (item.kind) state.sent[item.date].kind = item.kind;
          state.updated = new Date().toISOString();
          try { await writeJsonBlob(stateKey, state); }
          catch (e) { console.error('[booking-alerts] state write failed', e.message); }
        }
        summary.push({ code, tripId, date: item.date, dayNum: item.dayNum, kind: item.kind || 'open', restaurants: item.wishes.map(x => x.name), sent, web: w, apns: a });
      }
    }

    console.log('[booking-alerts] ' + todayYmd + ' PT | dryRun=' + dryRun + ' | ' + JSON.stringify(summary));
    return res.status(200).json({ ok: true, today: todayYmd, target: addDaysYmd(todayYmd, BOOKING_WINDOW_DAYS), dryRun, trips: tripCodes.length, summary });
  } catch (e) {
    console.error('[booking-alerts] error', e.message);
    return res.status(500).json({ error: e.message });
  }
}
