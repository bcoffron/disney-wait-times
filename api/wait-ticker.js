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

function isParkOpen(liveData) {
  if (!liveData || !Array.isArray(liveData)) return false;
  return liveData.some(function(r) {
    return r.entityType === 'ATTRACTION' && r.status === 'OPERATING';
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
  var [dlData, dcaData, mkData, epcotData, hsData, akData] = await Promise.all([
    fetchParkLive(DL_ID),
    fetchParkLive(DCA_ID),
    fetchParkLive(MK_ID),
    fetchParkLive(EPCOT_ID),
    fetchParkLive(HS_ID),
    fetchParkLive(AK_ID)
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
  var dlOpen = isParkOpen(dlLiveData) || isParkOpen(dcaLiveData);

  var mkLiveData = (mkData && mkData.liveData) ? mkData.liveData : [];
  var epcotLiveData = (epcotData && epcotData.liveData) ? epcotData.liveData : [];
  var hsLiveData = (hsData && hsData.liveData) ? hsData.liveData : [];
  var akLiveData = (akData && akData.liveData) ? akData.liveData : [];
  var wdwOpen = isParkOpen(mkLiveData) || isParkOpen(epcotLiveData) || isParkOpen(hsLiveData) || isParkOpen(akLiveData);

  var prevData = await readBlobJson(TICKER_PREV_KEY);
  var prevMap = (prevData && prevData.rides) ? prevData.rides : {};

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
