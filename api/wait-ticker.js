// api/wait-ticker.js
import { put, list } from '@vercel/blob';

const TICKER_CACHE_KEY = 'twize/wait_ticker_cache.json';
const TICKER_PREV_KEY = 'twize/wait_ticker_previous.json';
const CACHE_TTL_MS = 5 * 60 * 1000;

const DL_ID = '7340550b-c14d-4def-80bb-acdb51d49a66';
const DCA_ID = '832fcd51-ea19-4e77-85c7-75d5843b127c';
const MK_ID = '75ea578a-adc8-4116-a54d-dccb60765ef9';
const EPCOT_ID = '47f90d2c-e191-4239-a466-5892ef59a88b';
const HS_ID = '288747d1-8b4f-4a64-867e-ea7c9b27bad8';
const AK_ID = '1c84a229-8862-4648-9c71-378ddd2c7693';

const FETCH_TIMEOUT_MS = 30000;
const tickerRateLimit = new Map();

function applySecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function waitLevel(minutes) {
    if (minutes < 20) return 'low';
    if (minutes <= 45) return 'moderate';
    return 'high';
}

function deriveTrend(newWait, prevWait) {
    if (prevWait === null || prevWait === undefined) return 'steady';
    if (newWait > prevWait) return 'up';
    if (newWait < prevWait) return 'down';
    return 'steady';
}

async function fetchWithTimeout(url, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
    try {
          var resp = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          return resp;
    } catch (e) {
          clearTimeout(timer);
          throw e;
    }
}

async function readBlobJson(key) {
    try {
          var result = await list({ prefix: key, limit: 10, token: process.env.BLOB_READ_WRITE_TOKEN });
          var matches = (result.blobs || []).filter(function(b) { return b.pathname === key; })
            .sort(function(a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
          if (!matches.length) return null;
          var r = await fetch(matches[0].downloadUrl, { cache: 'no-store' });
          if (!r.ok) return null;
          return await r.json();
    } catch (e) {
          return null;
    }
}

async function writeBlobJson(key, data) {
    await put(key, JSON.stringify(data), {
          access: 'public',
          addRandomSuffix: false,
          contentType: 'application/json',
          allowOverwrite: true,
          token: process.env.BLOB_READ_WRITE_TOKEN
    });
}

// Layer 1 helper: fetch the /schedule endpoint for a single park entity.
// Returns the parsed JSON on success, or null on any failure.
async function fetchParkSchedule(entityId) {
    try {
          var resp = await fetchWithTimeout(
                  'https://api.themeparks.wiki/v1/entity/' + entityId + '/schedule',
                  FETCH_TIMEOUT_MS
                );
          if (!resp.ok) return null;
          return await resp.json();
    } catch (e) {
          console.error('[wait-ticker] fetchParkSchedule error for ' + entityId + ':', e.message);
          return null;
    }
}

// Layer 1: determine whether a park is currently open based on its published
// operating schedule. Returns true (open), false (closed), or null (no usable
// schedule found -- caller must fall back to attraction-status logic).
//
// Only entries with type === 'OPERATING' are considered. TICKETED_EVENT (Early
// Entry, special parties), EXTRA_HOURS, INFO, and all other types are ignored
// -- they represent paid add-ons or informational entries, not general park
// operating hours.
//
// The two-sided window check (now >= openingTime && now < closingTime) uses
// the full ISO-8601 absolute timestamps, so midnight-crossing closing times
// (e.g. "2026-06-18T00:00:00-07:00" on a date-2026-06-17 entry) are handled
// correctly without any special-casing.
function isOpenBySchedule(scheduleData) {
    if (!scheduleData || !Array.isArray(scheduleData.schedule)) return null;

  // Use the timezone reported by the API when available.
  var tz = (typeof scheduleData.timezone === 'string' && scheduleData.timezone.length > 0)
      ? scheduleData.timezone
        : 'America/New_York';

  var now = new Date();

  // Determine today's date string (YYYY-MM-DD) in the park's local timezone.
  var todayStr;
    try {
          todayStr = now.toLocaleDateString('en-CA', { timeZone: tz });
    } catch (e) {
          // en-CA locale gives YYYY-MM-DD format; fall back to UTC date if the tz
      // string is invalid for some reason.
      todayStr = now.toISOString().slice(0, 10);
    }

  // Find an OPERATING schedule entry for today.
  // Explicitly skip TICKETED_EVENT, EXTRA_HOURS, INFO, and any other type --
  // only the OPERATING entry represents the general public operating window.
  var todayEntry = null;
    for (var i = 0; i < scheduleData.schedule.length; i++) {
          var entry = scheduleData.schedule[i];
          if (entry.type === 'OPERATING' && entry.date === todayStr) {
                  todayEntry = entry;
                  break;
          }
    }

  // No OPERATING entry for today means the park is closed today.
  if (!todayEntry) return false;
    if (!todayEntry.openingTime || !todayEntry.closingTime) return null;

  var openTime = new Date(todayEntry.openingTime);
    var closeTime = new Date(todayEntry.closingTime);

  // Guard against unparseable timestamps.
  if (isNaN(openTime.getTime()) || isNaN(closeTime.getTime())) return null;

  // Current moment must be on or after opening AND strictly before closing.
  // Both bounds are required: now >= openingTime prevents pre-open false-positives.
  return now >= openTime && now < closeTime;
}

// Layer 1 primary gate: given schedule data for one or more sub-parks that
// make up a resort group (e.g. DL + DCA for Disneyland Resort), return true
// if ANY of them is currently within its OPERATING window.
//
// null-handling: a null result from isOpenBySchedule means that park's schedule
// fetch failed entirely. We treat a per-park fetch failure as "no positive
// evidence of open" rather than triggering a full fallback. Only if EVERY park
// in the resort returned null (i.e. we have zero schedule data at all) do we
// return null to signal the attraction-status fallback. A mix of false + null
// is treated as false (closed) -- a single failed fetch among several successful
// "closed" determinations must not cause the whole resort to appear open via
// the fallback path.
function isResortOpenBySchedule(scheduleResults) {
    var allNull = true;
    for (var i = 0; i < scheduleResults.length; i++) {
          var result = isOpenBySchedule(scheduleResults[i]);
          if (result === true) return true;
          if (result !== null) allNull = false;
    }
    // Return null only if every schedule fetch failed (no data at all).
  // If even one park returned false (closed), treat the resort as closed.
  return allNull ? null : false;
}

// Layer 2 fallback: check whether any ATTRACTION in the live-data array
// reports OPERATING status WITH a live numeric wait time.
//
// Requiring a non-null wait time prevents pre-park-open false-positives:
// shows, walkways, the park entity itself, and stale overnight entries all
// commonly report OPERATING status without a STANDBY queue wait time.
// Rides with active queues only report wait times once the park has opened
// and operations have started.
function isParkOpen(liveData) {
    if (!liveData || !Array.isArray(liveData)) return false;
    return liveData.some(function(r) {
          return r.entityType === 'ATTRACTION'
            && r.status === 'OPERATING'
            && r.queue != null
            && r.queue.STANDBY != null
            && typeof r.queue.STANDBY.waitTime === 'number';
    });
}

async function fetchParkLive(entityId) {
    try {
          var resp = await fetchWithTimeout(
                  'https://api.themeparks.wiki/v1/entity/' + entityId + '/live',
                  FETCH_TIMEOUT_MS
                );
          if (!resp.ok) return null;
          return await resp.json();
    } catch (e) {
          console.error('[wait-ticker] fetchParkLive error for ' + entityId + ':', e.message);
          return null;
    }
}

async function fetchLandMap(entityId) {
    try {
          var resp = await fetchWithTimeout(
                  'https://api.themeparks.wiki/v1/entity/' + entityId + '/children',
                  FETCH_TIMEOUT_MS
                );
          if (!resp.ok) return {};
          var data = await resp.json();
          var map = {};
          var children = data.children || [];
          children.forEach(function(child) {
                  if (child.entityType === 'LAND' && child.children) {
                            child.children.forEach(function(att) {
                                        if (att.entityType === 'ATTRACTION') {
                                                      map[att.id] = child.name;
                                        }
                            });
                  } else if (child.entityType === 'ATTRACTION') {
                            map[child.id] = '';
                  }
          });
          return map;
    } catch (e) {
          return {};
    }
}

async function buildTickerData() {
    // Fetch live attraction data and schedule data for all parks in parallel.
  var [
        dlData, dcaData,
        mkData, epcotData, hsData, akData,
        dlSched, dcaSched,
        mkSched, epcotSched, hsSched, akSched
      ] = await Promise.all([
        fetchParkLive(DL_ID),
        fetchParkLive(DCA_ID),
        fetchParkLive(MK_ID),
        fetchParkLive(EPCOT_ID),
        fetchParkLive(HS_ID),
        fetchParkLive(AK_ID),
        fetchParkSchedule(DL_ID),
        fetchParkSchedule(DCA_ID),
        fetchParkSchedule(MK_ID),
        fetchParkSchedule(EPCOT_ID),
        fetchParkSchedule(HS_ID),
        fetchParkSchedule(AK_ID)
      ]);

  var [dlLands, dcaLands, mkLands, epcotLands, hsLands, akLands] = await Promise.all([
        fetchLandMap(DL_ID),
        fetchLandMap(DCA_ID),
        fetchLandMap(MK_ID),
        fetchLandMap(EPCOT_ID),
        fetchLandMap(HS_ID),
        fetchLandMap(AK_ID)
      ]);

  var dlLiveData = (dlData && dlData.liveData) ? dlData.liveData : [];
    var dcaLiveData = (dcaData && dcaData.liveData) ? dcaData.liveData : [];
    var mkLiveData = (mkData && mkData.liveData) ? mkData.liveData : [];
    var epcotLiveData = (epcotData && epcotData.liveData) ? epcotData.liveData : [];
    var hsLiveData = (hsData && hsData.liveData) ? hsData.liveData : [];
    var akLiveData = (akData && akData.liveData) ? akData.liveData : [];

  // --- Layer 1: schedule-based open/closed determination (primary signal) ---
  // Disneyland Resort: DL or DCA being open means "Disneyland" is open.
  var dlScheduleResult = isResortOpenBySchedule([dlSched, dcaSched]);
    var wdwScheduleResult = isResortOpenBySchedule([mkSched, epcotSched, hsSched, akSched]);

  // --- Layer 2 fallback: attraction-status (used only when ALL schedules failed) ---
  var dlOpen, wdwOpen;

  if (dlScheduleResult === null) {
        // Every DL schedule fetch failed -- fall back to attraction-status check.
      dlOpen = isParkOpen(dlLiveData) || isParkOpen(dcaLiveData);
        console.warn('[wait-ticker] DL schedule unavailable, using attraction-status fallback');
  } else {
        dlOpen = dlScheduleResult;
  }

  if (wdwScheduleResult === null) {
        // Every WDW schedule fetch failed -- fall back to attraction-status check.
      wdwOpen = isParkOpen(mkLiveData) || isParkOpen(epcotLiveData) ||
              isParkOpen(hsLiveData) || isParkOpen(akLiveData);
        console.warn('[wait-ticker] WDW schedule unavailable, using attraction-status fallback');
  } else {
        wdwOpen = wdwScheduleResult;
  }

  var prevData = await readBlobJson(TICKER_PREV_KEY);
    var prevMap = (prevData && prevData.rides) ? prevData.rides : {};

  // Layer 2 ride list: ATTRACTION-only, OPERATING, numeric wait required.
  function extractRides(liveItems, landMap) {
        var rides = [];
        liveItems.forEach(function(r) {
                if (r.entityType !== 'ATTRACTION') return;
                if (r.status !== 'OPERATING') return;
                var wait = (r.queue && r.queue.STANDBY && r.queue.STANDBY.waitTime != null)
                  ? r.queue.STANDBY.waitTime
                          : null;
                if (wait === null || wait === undefined) return;
                var landName = landMap[r.id] || '';
                var prevWait = prevMap[r.id] != null ? prevMap[r.id] : null;
                rides.push({
                          id: r.id,
                          name: r.name,
                          land: landName,
                          wait: wait,
                          trend: deriveTrend(wait, prevWait),
                          level: waitLevel(wait)
                });
        });
        return rides;
  }

  var dlRides = extractRides(dlLiveData, dlLands).concat(extractRides(dcaLiveData, dcaLands));
    var wdwRides = extractRides(mkLiveData, mkLands)
      .concat(extractRides(epcotLiveData, epcotLands))
      .concat(extractRides(hsLiveData, hsLands))
      .concat(extractRides(akLiveData, akLands));

  var newPrevMap = {};
    dlRides.forEach(function(r) { newPrevMap[r.id] = r.wait; });
    wdwRides.forEach(function(r) { newPrevMap[r.id] = r.wait; });
    await writeBlobJson(TICKER_PREV_KEY, { rides: newPrevMap, updatedAt: new Date().toISOString() });

  function stripId(r) {
        return { name: r.name, land: r.land, wait: r.wait, trend: r.trend, level: r.level };
  }

  var allClosed = !dlOpen && !wdwOpen;
    return {
          allClosed: allClosed,
          updatedAt: new Date().toISOString(),
          parks: [
            { name: 'Disneyland', closed: !dlOpen, rides: dlOpen ? dlRides.map(stripId) : [] },
            { name: 'Walt Disney World', closed: !wdwOpen, rides: wdwOpen ? wdwRides.map(stripId) : [] }
                ]
    };
}

export default async function handler(req, res) {
    applySecurityHeaders(res);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

  var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
    var now = Date.now();
    var windowMs = 60 * 1000;
    var maxReqs = 60;
    if (!tickerRateLimit.has(ip)) {
          tickerRateLimit.set(ip, { count: 1, resetAt: now + windowMs });
    } else {
          var record = tickerRateLimit.get(ip);
          if (now > record.resetAt) {
                  tickerRateLimit.set(ip, { count: 1, resetAt: now + windowMs });
          } else if (record.count >= maxReqs) {
                  return res.status(429).json({ error: 'Rate limit exceeded' });
          } else {
                  record.count++;
          }
    }

  if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
        var cached = await readBlobJson(TICKER_CACHE_KEY);
        var cacheAge = cached && cached.cachedAt ? (now - new Date(cached.cachedAt).getTime()) : Infinity;

      if (cached && cacheAge < CACHE_TTL_MS && cached.payload) {
              res.setHeader('Cache-Control', 'public, s-maxage=300');
              res.setHeader('X-Ticker-Cache', 'HIT');
              return res.status(200).json(cached.payload);
      }

      var payload;
        try {
                payload = await buildTickerData();
        } catch (fetchErr) {
                console.error('[wait-ticker] buildTickerData failed:', fetchErr.message);
                if (cached && cached.payload) {
                          res.setHeader('Cache-Control', 'public, s-maxage=300');
                          res.setHeader('X-Ticker-Cache', 'STALE');
                          return res.status(200).json(cached.payload);
                }
                return res.status(503).json({ error: 'Wait times temporarily unavailable' });
        }

      try {
              await writeBlobJson(TICKER_CACHE_KEY, { payload: payload, cachedAt: new Date().toISOString() });
      } catch (writeErr) {
              console.warn('[wait-ticker] cache write failed:', writeErr.message);
      }

      res.setHeader('Cache-Control', 'public, s-maxage=300');
        res.setHeader('X-Ticker-Cache', 'MISS');
        return res.status(200).json(payload);
  } catch (err) {
        console.error('[wait-ticker] handler error:', err.message, err.stack);
        return res.status(500).json({ error: 'Internal server error' });
  }
}
