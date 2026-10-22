// api/generateschedule.js
// Routes generateFromSetup and aiChooseRides through Vercel with new two-cache section injection
import { list } from '@vercel/blob';

// --- Registry-backed trip-code validation (Oct 2026 lockdown) ---
// A trip code is valid only if it was actually issued (present in the trip
// registry) — the old shape-only check accepted any string of N+ chars.
// Same salted-first/bare-fallback registry read as api/trip.js, 60s cache.
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

async function _isRegisteredTripCode(code) {
  if (!code || typeof code !== 'string') return false;
  const _reg = await _readAuthRegistry();
  return !!(_reg && _reg[code]);
}

// --- Validated trip session (restoration step ii, Oct 8, 2026) -------------
// Role is resolved SERVER-SIDE from the registry entry: the registry is the
// source of role, and the presented code is only the lookup key. The code
// string's suffix is NEVER parsed for role, and a client-sent role is never
// trusted. The session every endpoint enforces on is:
// { code, tripId, role, status, expires, expired } -- null = no session.
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

// Leader session: the registry's admin role on an active, unexpired entry --
// the same test api/trip.js applies to trip saves.
function _isLeaderSession(s) {
  return !!s && s.role === 'admin' && s.status === 'active' && !s.expired;
}

import { validateSchedule, parseClosedFromCache, landToPark, normPark } from './validate-schedule.js';
import { buildSkeleton, buildFillPrompt, applyFills, verifyScaffold, closedNamesForDate, closedNamesFromProse, buildCatalogIndex, parseCatalogVenues, deterministicBackfill, verifyTripParams, enforceTripParams, pickRopeDropRide, pickMorningRides, pickCharacterMeet, normName, normParkName, rideGroupKey, canonicalVenueKey, scanProseVenueFlags, correctVenueServices, normalizeLLAssignments, planCoverageReservations, planReservationAnchors, shortestHeightInches, thrillModeFor, parseDiningIntelDetails, correctPhotoSpotProse, computeLLSequence } from './scaffold.js';

// --------- Per-IP daily AI cap (50 requests per IP per 24 hours) -----------
const aiDailyLimit = new Map();

function checkAILimit(ip) {
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000;
    const max = 50;
    if (!aiDailyLimit.has(ip)) {
          aiDailyLimit.set(ip, { count: 1, resetAt: now + windowMs });
          return true;
    }
    const record = aiDailyLimit.get(ip);
    if (now > record.resetAt) {
          aiDailyLimit.set(ip, { count: 1, resetAt: now + windowMs });
          return true;
    }
    if (record.count >= max) return false;
    record.count++;
    return true;
}

// --------- buildCacheContext ----------------------------
// Park-hours helpers (Oct 20, 2026 -- Claude msg 562 ruling): the
// park_hours_intel blob is a PER-DATE map {"YYYY-MM-DD": {dl:{open,close},
// dca:{open,close}}} (24h "HH:MM"), written by api/cron-cache.js and by the
// clients. The scaffold must use the entry FOR THE DAY BEING GENERATED --
// never another date's hours. A "24:00" close is midnight (formats as
// 12:00 AM, which the line parser maps to 1440); the previous formatter
// rendered it "12:00 PM", collapsing every Disneyland day to a noon close.
function tpcpFmtHour(hhmm) { const p = String(hhmm || '').split(':'); if (p.length < 2) return ''; const h = parseInt(p[0], 10); if (isNaN(h)) return ''; const ap = (h === 24 || h < 12) ? 'AM' : 'PM'; let h12 = h % 12; if (h12 === 0) h12 = 12; return h12 + ':' + p[1] + ' ' + ap; }
// Returns { entry } for the requested date (or the flat entry when the blob
// is genuinely in the legacy flat shape), or { missing: true } when a
// per-date map has no entry for the date -- the caller then omits the
// PARK_HOURS section (generic fallback hours) instead of borrowing a
// different date's hours.
function tpcpResolveParkHoursEntry(ph, parkDateISO) {
  if (!ph || typeof ph !== 'object') return { missing: true };
  if (ph.dl || ph.dca) return { entry: ph };
  if (parkDateISO && ph[parkDateISO] && (ph[parkDateISO].dl || ph[parkDateISO].dca)) return { entry: ph[parkDateISO] };
  return { missing: true };
}
async function buildCacheContext(sectionNames, includeDynamic = false, parkDateISO = null) {
    const results = {};
    const dynamicSections = ['CURRENT_CLOSURES', 'CLOSURES', 'DINING_CLOSURES', 'TRIP_CONTEXT', 'CURRENT_LL_PRICING', 'SPECIAL_EVENTS', 'SHOWS'];

  try {
        const { blobs: sb } = await list({ prefix: 'twize/park_intel_dl_stable.json' });
        if (sb && sb.length) {
                const fetchUrl = sb[0].downloadUrl || sb[0].url;
                const stableData = await fetch(fetchUrl).then(r => r.json());
                const sections = stableData.data.sections || {};
                sectionNames.forEach(name => {
                          if (sections[name]) {
                                      results[name] = typeof sections[name] === 'string'
                                        ? sections[name]
                                                    : JSON.stringify(sections[name]);
                          }
                });
        }
  } catch (e) {
        console.error('[cache] stable read error:', e.message);
  }

  if (includeDynamic) {
        try {
                const { blobs: db } = await list({ prefix: 'twize/park_intel_dl_dynamic.json' });
                if (db && db.length) {
                          const fetchUrl = db[0].downloadUrl || db[0].url;
                          const dynamicData = await fetch(fetchUrl).then(r => r.json());
                          const sections = dynamicData.data.sections || {};
                          dynamicSections.forEach(name => {
                                      if (sections[name]) {
                                                    results[name] = typeof sections[name] === 'string'
                                                      ? sections[name]
                                                                    : JSON.stringify(sections[name]);
                                      }
                          });
                }
        } catch (e) {
                console.error('[cache] dynamic read error:', e.message);
        }
  }


  // --------- DINING_INTEL: dedicated restaurant list cache (Issue 1) -----------
  // Prefer new DL-scoped key; fall back to legacy dining_intel during transition.
  try {
    let diKey = 'twize/dining_intel_dl.json';
    let { blobs: dib } = await list({ prefix: diKey });
    if (!dib || !dib.length) {
      diKey = 'twize/dining_intel.json';
      ({ blobs: dib } = await list({ prefix: diKey }));
    }
    if (dib && dib.length) {
      const fetchUrl = dib[0].downloadUrl || dib[0].url;
      const diData = await fetch(fetchUrl).then(r => r.json());
      results['DINING_INTEL'] = typeof diData.data === 'string'
        ? diData.data
        : JSON.stringify(diData.data || diData);
    }
  } catch (e) {
    console.error('[cache] dining_intel_dl/dining_intel read error:', e.message);
  }

  // --------- PARK_HOURS: no cache section carries it. The live hours live in the
  // park_hours_intel blob, a PER-DATE map (see tpcpResolveParkHoursEntry above).
  // Format one line per park FOR THE DAY BEING GENERATED (parkDateISO) for the
  // consumers' line parser (first time on the park's line = open, last = close).
  // Without this, cacheCtx.PARK_HOURS is empty and generators fall back to
  // generic close times (days ending early).
  try {
    const { blobs: phb } = await list({ prefix: 'twize/park_hours_intel.json' });
    // Blob selection mirrors api/cache.js: exact pathname or a suffixed
    // sibling, newest by uploadedAt -- never a bare blobs[0].
    const _phMatches = (phb || []).filter(b => b.pathname === 'twize/park_hours_intel.json' || /^twize\/park_hours_intel-[a-zA-Z0-9]+\.json$/.test(b.pathname || ''));
    const _phBlob = _phMatches.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    if (_phBlob) {
      const phData = await fetch(_phBlob.downloadUrl || _phBlob.url).then(r => r.json());
      const ph = (phData && phData.data) ? phData.data : phData;
      const _res = tpcpResolveParkHoursEntry(ph, parkDateISO);
      if (_res.missing) {
        console.error('[SECURITY] park_hours_intel: no hours entry for trip date ' + (parkDateISO || '(none provided)') + ' in blob twize/park_hours_intel.json -- PARK_HOURS section omitted; generators use generic fallback hours rather than another date\'s hours');
      } else {
        const entry = _res.entry;
        const _phLines = [];
        if (entry.dl && entry.dl.open && entry.dl.close) _phLines.push('Disneyland: ' + tpcpFmtHour(entry.dl.open) + ' - ' + tpcpFmtHour(entry.dl.close));
        if (entry.dca && entry.dca.open && entry.dca.close) _phLines.push('Disney California Adventure: ' + tpcpFmtHour(entry.dca.open) + ' - ' + tpcpFmtHour(entry.dca.close));
        if (_phLines.length) results['PARK_HOURS'] = _phLines.join('\n');
      }
    }
  } catch (e) {
    console.error('[cache] park_hours_intel read error:', e.message);
  }

  const expectedSections = sectionNames.concat(includeDynamic ? dynamicSections : []);
  const missingSections = expectedSections.filter(name => !results[name]);
  if (missingSections.length) {
    console.error('[cache] MISSING SECTIONS:', missingSections.join(','), '| present:', Object.keys(results).join(','));
  }
  return results;
}

// --------- Character intel (unchanged) -----------------------------------------------
async function getPhotoOpsIntel() {
    try {
          const { blobs } = await list({ prefix: 'twize/photo_ops.json' });
          if (!blobs || blobs.length === 0) return [];
          const fetchUrl = blobs[0].downloadUrl || blobs[0].url;
          const parsed = await fetch(fetchUrl).then(r => r.json());
          if (!parsed || !parsed.data) return [];
          const dataObj = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data;
          let spots = Array.isArray(dataObj && dataObj.spots) ? dataObj.spots : [];
          if (!spots.length && Array.isArray(dataObj)) spots = dataObj;
          if (!spots.length && dataObj && typeof dataObj === 'object' && dataObj.name && dataObj.shot) spots = [dataObj];
          // Photo prose corrections ride at ingestion (Item 9): a cached
          // phrase that contradicts the bundled example photo is corrected
          // here, so the fix survives weekly cache rebuilds. See
          // correctPhotoSpotProse in scaffold.js.
          return spots.filter(s => s && s.name && s.shot).map(s => correctPhotoSpotProse({
            name: String(s.name), park: String(s.park || ''), land: String(s.land || ''),
            shot: String(s.shot), bestTime: String(s.bestTime || ''),
            short: String(s.short || ''), sampleUrl: String(s.sampleUrl || '')
          }));
    } catch (e) {
          console.warn('[photo-ops] read failed:', e.message);
          return [];
    }
}

async function getCharacterIntel(maxChars = 4000) {
    try {
          const { blobs } = await list({ prefix: 'twize/character_intel.json' });
          if (!blobs || blobs.length === 0) return null;
          const fetchUrl = blobs[0].downloadUrl || blobs[0].url;
          const parsed = await fetch(fetchUrl).then(r => r.json());
          if (!parsed || !parsed.data) return null;
          const dataObj = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data;
          const disclaimer = dataObj.disclaimer || 'Character schedules are planned in advance but can change without notice. Check with a cast member on the day.';
          let characters = Array.isArray(dataObj.characters) ? dataObj.characters : [];
          // Defensive shapes (Oct 5, 2026): a bad rebuild once stored a single
          // character object as the whole dataset. Wrap a character-like
          // object (or a bare array) so meets degrade instead of vanishing.
          if (!characters.length && Array.isArray(dataObj)) characters = dataObj.filter(c => c && c.name);
          if (!characters.length && dataObj && typeof dataObj === 'object' && dataObj.name && (dataObj.location || dataObj.category)) characters = [dataObj];
          return { disclaimer, characters };
    } catch (e) {
          console.error('Character intel fetch error:', e.message);
          return null;
    }
}

function buildCharacterContext(charIntel, tripConfig, maxChars) {
    if (!charIntel) return null;
    const { disclaimer, characters } = charIntel;
    const pref = (tripConfig && tripConfig.characters) || {};
    const priority = pref.priority || 'niceToHave';
    if (priority === 'skip') return null;
    const categories = pref.categories || null;
    let filtered = characters;
    if (categories && Array.isArray(categories) && categories.length > 0) {
          filtered = characters.filter(c => categories.includes(c.category));
    }
    if (!filtered.length) filtered = characters.slice(0, 20);
    const lines = [];
    for (const c of filtered) {
          const windows = Array.isArray(c.typicalWindows) ? c.typicalWindows.join(', ') : (c.typicalWindows || '');
          lines.push('- ' + c.name + ' | ' + (c.location || '') + ' | Windows: ' + windows + ' | Typical wait: ' + (c.typicalWait || 0) + ' min' + (c.vipAccessible ? ' | VIP skip-line eligible' : ''));
    }
    const body = lines.join('\n');
    const full = 'CHARACTER INTEL (from cache --- do not fabricate):\nDisclaimer: ' + disclaimer + '\n\nAvailable characters matching trip preferences:\n' + body;
    return full.substring(0, maxChars);
}

function extractJSON(text) {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (fenceMatch) {
          try { return JSON.parse(fenceMatch[1].trim()); } catch(e) {}
    }
    try { return JSON.parse(text.trim()); } catch(e) {}
    const objMatch = text.match(/\{[\s\S]+\}|\[[\s\S]+\]/);
    if (objMatch) try { return JSON.parse(objMatch[0]); } catch(e) {}
    return null;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-trip-code');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const MAX_REQUEST_SIZE = 500 * 1024; // 500KB
      const contentLength = parseInt(req.headers['content-length'] || '0');
      if (contentLength > MAX_REQUEST_SIZE) {
              return res.status(413).json({ error: 'Request too large' });
      }
    
    // -- A: Request size limit (10k chars) -------------------------------------------
  const MAX_BODY_SIZE = 10000;
    if (JSON.stringify(req.body).length > MAX_BODY_SIZE) {
          return res.status(400).json({ error: 'Request too large' });
    }

  // -- C: Per-IP daily AI cap -------------------------------------------------------
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
    if (!checkAILimit(ip)) {
                console.warn('[SECURITY] Rate limit exceeded:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', time: new Date().toISOString() });
        return res.status(429).json({ error: 'Too many requests' });
    }

  // -- Security logging -------------------------------------------------------------
  console.log('[AI] Request:', {
        endpoint: req.url,
        ip,
        time: new Date().toISOString()
  });

  // -- AUTH CHECK -----------------------------------------------------------
  const _adminKey = (process.env.ADMIN_KEY || '').toLowerCase();
    const _sentAdmin = (req.headers['x-admin-key'] || req.body && req.body.adminKey || '').toLowerCase();
    const _tripCode = (req.body && req.body.tripCode) || req.headers['x-trip-code'] || '';
    const _isAdmin = _sentAdmin === _adminKey;
    const _session = _isAdmin ? null : await _resolveTripSession(_tripCode);
    const _isValidTrip = _isAdmin || !!_session;
    if (!_isAdmin && !_isValidTrip) {
                console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
        return res.status(401).json({ error: 'Authentication required.' });
    }
    // -- ROLE GATE (restoration step ii, Oct 8, 2026) -----------------------
    // Schedule generation is a trip-LEADER action. A validated guest
    // session (the pair's view-only code) is rejected here, server-side --
    // the hidden button was never the enforcement. Role comes from the
    // registry via the validated session above; the admin-key bypass is
    // unchanged.
    if (!_isAdmin && !_isLeaderSession(_session)) {
                console.warn('[SECURITY] Role denied:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'guest_role', time: new Date().toISOString() });
        return res.status(403).json({ error: 'View-only trip code: only the trip leader can generate a schedule.', role: (_session && _session.role) || 'guest' });
    }
    // -------------------------------------------------------------------------

  // -- D: 30-second timeout on Anthropic API calls ----------------------------------
  const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
          const { prompt, mode, maxTokens = 8000, tripConfig } = req.body || {};
          // EVAL-ONLY (scratch branch eval/haiku-5-5 -- NEVER merge to main): Haiku 5.5 A/B hooks.
          // Inert unless VERCEL_ENV=preview AND an x-eval-model header names an allowlisted model.
          const _evalHdr = (req.headers && req.headers['x-eval-model']) || '';
          const _evalActive = process.env.VERCEL_ENV === 'preview' && (_evalHdr === 'haiku55' || _evalHdr === 'haiku45');
          const _evalModel = _evalActive ? (_evalHdr === 'haiku55' ? 'claude-haiku-5-5' : 'claude-haiku-4-5-20251001') : null;
          const _evalTempProbe = _evalActive && req.headers['x-eval-temp'] === '0';
          const _evalEffortVal = (_evalActive && ['low', 'medium', 'high'].indexOf(req.headers['x-eval-effort'] || '') >= 0) ? req.headers['x-eval-effort'] : null;
          const _evalCache = _evalActive && req.headers['x-eval-cache'] === '1';
          const _evalTempSpread = (!_evalModel || _evalModel === 'claude-haiku-4-5-20251001' || _evalTempProbe) ? { temperature: 0 } : {};
          const _evalEffortSpread = (_evalModel === 'claude-haiku-5-5' && _evalEffortVal) ? { output_config: { effort: _evalEffortVal } } : {};
          const _evalUsage = [];


      const rp = (tripConfig || {}).ridePreferences || {};
          const mustDo = rp.mustDo || [];
          const wantToDo = rp.wantToDo || [];
          let skipRides = rp.skip || [];
          // avoidWater is a config-level switch with no reader of its own; the skip
          // machinery (prompt context + verifyTripParams + validator) is the
          // enforcement path, so fold the water rides into the skip list here.
          if ((tripConfig || {}).avoidWater === true) {
            const _waterRides = ["Tiana's Bayou Adventure", 'Grizzly River Run'];
            skipRides = Array.from(new Set([...skipRides, ..._waterRides]));
          }
          const _sp = (tripConfig || {}).showPreferences || {};
          const showWant = Array.isArray(_sp.want) ? _sp.want : [];
          const showSkip = Array.isArray(_sp.skip) ? _sp.skip : [];
          const priorRides = Array.isArray((tripConfig || {})._priorRides) ? tripConfig._priorRides : [];
          const _priorVenues = (tripConfig && tripConfig.dining && Array.isArray(tripConfig.dining.usedVenues)) ? tripConfig.dining.usedVenues : [];
          const ridePrefsContext = (mustDo.length || skipRides.length || showWant.length || showSkip.length || priorRides.length) ? [
                  'GUEST RIDE PREFERENCES:',
                  'Must Do (non-negotiable): ' + (mustDo.length ? mustDo.join(', ') : 'none'),
                  'Want To Do (if time allows): ' + (wantToDo.length ? wantToDo.join(', ') : 'all others'),
                  'Skip (never include): ' + (skipRides.length ? skipRides.join(', ') : 'none'),
                  ...(showWant.length ? ['Wanted shows (the wanted nighttime show should be the evening show pick): ' + showWant.join(', ')] : []),
                  ...(showSkip.length ? ['Skipped shows (never schedule): ' + showSkip.join(', ')] : []),
                  ...(priorRides.length ? ['Already scheduled on earlier days of this trip (do not repeat these rides): ' + priorRides.join(', ')] : [])
                ].join('\n') : '';
          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (!apiKey) return res.status(500).json({ error: 'No API key' });
          if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

      // The park date for THIS generation (the day being built), normalized to
      // ISO -- buildCacheContext uses it to select that date's park hours.
      const _phDayIdx = (req.body && typeof req.body.dayIndex === 'number') ? req.body.dayIndex : 0;
      const _phRawDate = (tripConfig && Array.isArray(tripConfig.days) && tripConfig.days[_phDayIdx]) ? tripConfig.days[_phDayIdx].date : null;
      const _parkDateISO = (function () { if (!_phRawDate) return null; const t = String(_phRawDate).trim(); if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10); const d = new Date(t); if (isNaN(d.getTime())) return null; return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); })();
      const cacheCtx = await buildCacheContext(
              ['LAND_MAP', 'WAIT_PATTERNS', 'ROPE_DROP_STRATEGY',
                       'LIGHTNING_LANE_STRATEGY', 'DINING_TIMING', 'CROWD_FLOW',
      'PARK_HOURS', 'PARK_HOP_STRATEGY', 'CATALOG', 'SHOW_AND_ENTERTAINMENT'],
              true, _parkDateISO
            );
          // TRIP_CONTEXT in the dynamic blob is one specific trip's context (the
          // June 28-30, 2026 family trip). Feeding it to other trips poisons their
          // prompts with wrong dates and party assumptions. Pass it only when THIS
          // trip overlaps those dates; otherwise drop it.
          if (cacheCtx.TRIP_CONTEXT) {
            const _tcNorm = (s) => { if (!s) return ''; const t = String(s).trim(); if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10); const d = new Date(t); return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); };
            const _tcCands = [];
            if (tripConfig && tripConfig.dates) { _tcCands.push(_tcNorm(tripConfig.dates.start)); _tcCands.push(_tcNorm(tripConfig.dates.end)); }
            if (tripConfig && Array.isArray(tripConfig.days)) tripConfig.days.forEach(function(dy) { if (dy && dy.date) _tcCands.push(_tcNorm(dy.date)); });
            const _tcHit = _tcCands.some(function(x) { return x >= '2026-06-28' && x <= '2026-06-30'; });
            if (!_tcHit) { delete cacheCtx.TRIP_CONTEXT; console.log('[generateschedule] TRIP_CONTEXT dropped (belongs to a different trip)'); }
          }
          console.log('[generateschedule] cacheCtx sections:', Object.keys(cacheCtx));
          const sectionCount = Object.keys(cacheCtx).length;
          console.log('cache_sections:', Object.keys(cacheCtx).join(','));
          if (sectionCount < 6) {
                  console.error('[generateschedule] CACHE EMPTY - aborting AI call. Got', sectionCount, 'sections, need 6');
                  return res.status(503).json({ error: 'Park intelligence cache unavailable. Please try again.', cache_sections: Object.keys(cacheCtx), sections_found: sectionCount });
          }

      const landMap = (cacheCtx.LAND_MAP || '').substring(0, 8000);
          const waitPatterns = (cacheCtx.WAIT_PATTERNS || '').substring(0, 1200);
          let _wpObj = null; try { _wpObj = typeof cacheCtx.WAIT_PATTERNS === 'string' ? JSON.parse(cacheCtx.WAIT_PATTERNS) : (cacheCtx.WAIT_PATTERNS || null); } catch (e) { _wpObj = null; }
          const ropeDrop = (cacheCtx.ROPE_DROP_STRATEGY || '').substring(0, 800);
          const llStrategy = (cacheCtx.LIGHTNING_LANE_STRATEGY || '').substring(0, 600);
          const diningTiming = (cacheCtx.DINING_TIMING || '').substring(0, 600);
          const crowdFlow = (cacheCtx.CROWD_FLOW || '').substring(0, 500);
          const closures = (cacheCtx.CURRENT_CLOSURES || '').substring(0, 1000);
          const specialEvts = (cacheCtx.SPECIAL_EVENTS || '').substring(0, 300);
          const tripCtx = (cacheCtx.TRIP_CONTEXT || '').substring(0, 600);
const parkHours = (cacheCtx.PARK_HOURS || '').substring(0, 800);
const showEnt = (cacheCtx.SHOW_AND_ENTERTAINMENT || '').substring(0, 1200);
const parkHopStrategy = (cacheCtx.PARK_HOP_STRATEGY || '').substring(0, 600);
// DINING_INTEL: verified current restaurant list from cache (Issue 1)
const diningIntel = (cacheCtx.DINING_INTEL || '').substring(0, 6000);

      const parkIntelContext = [
              'LAND MAP:\n' + landMap,
              'WAIT PATTERNS:\n' + waitPatterns,
              'ROPE DROP STRATEGY:\n' + ropeDrop,
              'LIGHTNING LANE STRATEGY:\n' + llStrategy,
              'DINING TIMING:\n' + diningTiming,
              'CROWD FLOW:\n' + crowdFlow,
              'CURRENT CLOSURES:\n' + closures,
              'SPECIAL EVENTS:\n' + specialEvts,
              'TRIP CONTEXT:\n' + tripCtx,
  'PARK HOURS:\n' + parkHours,
  'SHOWS AND ENTERTAINMENT (real show names for show slots):\n' + showEnt,
  'PARK HOP STRATEGY:\n' + parkHopStrategy
            ].join('\n\n');

      const charIntel = await getCharacterIntel(4000);
          const charContext = buildCharacterContext(charIntel, tripConfig, 4000);
          const charPriority = (tripConfig && tripConfig.characters && tripConfig.characters.priority) || 'niceToHave';

      // LEGACY PROMPT ASSEMBLY REMOVED (Oct 14, 2026): the retired legacy
      // generator's `system` string was still built here on every request and
      // fed nothing -- the scaffold path below is the only generator (legacy
      // retired Oct 7, 2026). Data prep the scaffold consumes (dietary needs,
      // reservation parsing, cross-day used dining) remains below.

      const _hasDiet = tripConfig && tripConfig.groupProfile && tripConfig.groupProfile.dietary;
      const _dietNeeds = _hasDiet ? (Array.isArray(tripConfig.groupProfile.dietary) ? tripConfig.groupProfile.dietary : [tripConfig.groupProfile.dietary]) : [];

      // Part C: Parse flat reservation strings from tripConfig.reservations
      // Merges with tripConfig.dining.reservations if structured objects exist
      const _flatResArr = (tripConfig && Array.isArray(tripConfig.reservations)) ? tripConfig.reservations : [];
      const _structuredResArr = (tripConfig && tripConfig.dining && Array.isArray(tripConfig.dining.reservations)) ? tripConfig.dining.reservations : [];
      const _parsedFlatRes = _flatResArr.map(function(s) {
        if (!s || typeof s !== 'string') return null;
        // The client's per-day encoding (pretrip _genDaySeq): the string
        // carries venue + time; the day is the day being generated, which
        // a null day already means to every consumer. Twin of
        // splitThisDayReservation in scaffold.js (finding 4a fix (a)).
        const td = s.match(/^THIS DAY['’]S CONFIRMED RESERVATION:\s*(.+)\s+at\s+(\d{1,2}:\d{2}\s*(?:[AaPp][Mm])?)\s*$/i);
        if (td) return { name: td[1].trim(), time: td[2].trim(), day: null, isConfirmed: true };
        const parts = s.split(',').map(function(p) { return p.trim(); });
        const name = parts[0] || '';
        const time = parts[1] || '';
        const dayRaw = parts[2] || '';
        const dayMatch = dayRaw.match(/(\d+)/);
        const day = dayMatch ? parseInt(dayMatch[1], 10) : null;
        return name ? { name: name, time: time, day: day, isConfirmed: true } : null;
      }).filter(Boolean);
      const _allReservations = _structuredResArr.concat(_parsedFlatRes);
      const confirmedRestaurants = _allReservations.map(function(r) { return r && r.name ? r.name : null; }).filter(Boolean);
      console.log('[generateschedule] _allReservations:', JSON.stringify(_allReservations));
      console.log('[generateschedule] confirmedRestaurants:', JSON.stringify(confirmedRestaurants));

      if (tripConfig && !tripConfig._usedQuickService) tripConfig._usedQuickService = [];
          const usedQS = (tripConfig && tripConfig._usedQuickService) || [];
// Issue 2: pull cross-day used venues from tripConfig.dining.usedVenues
const usedVenues = (tripConfig && tripConfig.dining && tripConfig.dining.usedVenues) || [];
const allUsedDining = Array.from(new Set([...usedQS, ...usedVenues]));
console.log('[generateschedule] allUsedDining (cross-day dedup):', JSON.stringify(allUsedDining));

          console.log('[generateschedule] mode:', mode || 'default', 'char_priority:', charPriority);



      // ============================================================
      // SCAFFOLD PATH -- the ONLY generator (LEGACY RETIRED Oct 7, 2026,
      // per Claude's ruling). The ?scaffold= query flag and body.scaffold
      // are inert: every request runs the scaffold, and a scaffold error
      // returns a clean safe failure (see the catch below) instead of
      // falling through to the retired legacy engine, which remains
      // in-file below, unreachable, for a later cleanup commit.
      // ============================================================
      const _body = req.body || {};
      const _useScaffold = true;
      if (_useScaffold) {
        try {
          const _cfg = tripConfig || {};
          const _di = (typeof _body.dayIndex === 'number') ? _body.dayIndex : 0;
          const _day = (_cfg.days && (_cfg.days[_di] || _cfg.days[0])) || {};
          const _park = _day.park || 'Disneyland';
          const _isDcaDay = /california|dca|adventure/i.test(_park);

          // Park hours from the PARK_HOURS cache (first time on the park's line = open, last = close).
          const _hoursTxtS = (cacheCtx.PARK_HOURS || '');
          const _sMin = (h, mm, mer) => { let hh = parseInt(h, 10); const pm = /pm/i.test(mer); if (pm && hh !== 12) hh += 12; if (!pm && hh === 12) hh = 0; return hh * 60 + (mm ? parseInt(mm, 10) : 0); };
          const _sHours = (parkRe) => {
            for (const ln of _hoursTxtS.split(/\n/)) {
              if (!parkRe.test(ln)) continue;
              const ts = [...ln.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM|noon|midnight)/gi)];
              if (!ts.length) continue;
              const f = ts[0], l = ts[ts.length - 1];
              let o = /noon/i.test(f[3]) ? 720 : (/midnight/i.test(f[3]) ? 0 : _sMin(f[1], f[2], f[3]));
              let c = /midnight/i.test(l[3]) ? 1440 : (/noon/i.test(l[3]) ? 720 : _sMin(l[1], l[2], l[3]));
              if (c === 0) c = 1440;
              return { openMin: o, closeMin: c };
            }
            return null;
          };
          const _hrs = _sHours(_isDcaDay ? /california adventure|\bDCA\b/i : /disneyland|\bDL\b/i);
          const _openMin = (_hrs && _hrs.openMin) || 480;                       // fallback 8:00 AM
          const _closeMin = (_hrs && _hrs.closeMin) || (_isDcaDay ? 1320 : 1380); // fallback 10 / 11 PM
          // Per-park closes for the headliner window (Phase 1, Oct 7, 2026):
          // the evening edge is closeMin-90 FOR THE PARK THE RIDE IS IN, so
          // a hop day's DL segment and DCA segment each get their own edge
          // instead of one hardcoded 8:30 PM fallback.
          const _dlHrs2 = _sHours(/disneyland|\bDL\b/i);
          const _dcaHrs2 = _sHours(/california adventure|\bDCA\b/i);
          const _closeByPark = { dl: (_dlHrs2 && _dlHrs2.closeMin) || 1380, dca: (_dcaHrs2 && _dcaHrs2.closeMin) || 1320 };

          // VIP tour window: time strings like "10:30 AM" on the day object.
          const _sVip = (s) => { if (typeof s !== 'string') return null; let m = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i); if (m) { let h = parseInt(m[1], 10); if (/pm/i.test(m[3]) && h !== 12) h += 12; if (/am/i.test(m[3]) && h === 12) h = 0; return h * 60 + parseInt(m[2], 10); } m = s.match(/^\s*(\d{1,2}):(\d{2})\s*$/); if (m) { const h = parseInt(m[1], 10), mn = parseInt(m[2], 10); if (h <= 23 && mn <= 59) return h * 60 + mn; } return null; };
          const _vipStart = _day.isVip ? _sVip(_day.vipStart) : null;
          const _vipEnd = _day.isVip ? _sVip(_day.vipEnd) : null;
          // LL MASTER TOGGLE (Onboarding wiring Tier 1, Oct 7, 2026 --
          // Claude's pinned formula): the day's hasLL flag is the source of
          // truth. _hasLL = hasLL === true && (llmp || ill || subtypes
          // unspecified). Master OFF means NO Lightning Lane at all, even
          // when stale subtype flags persisted from an earlier edit say
          // otherwise; master ON with no subtype named gets LL present per
          // the default product (Lightning Lane Multi Pass). Pre-fix, the
          // _llFlagsDefined check was effectively always true (the client
          // coerces hasLLMP/hasILL with === true), so the master flag was
          // ignored in BOTH directions.
          let _llmp = _day.hasLLMP === true;
          let _ill = _day.hasILL === true;
          const _llSubtypesSpecified = typeof _day.hasLLMP === 'boolean' || typeof _day.hasILL === 'boolean';
          let _hasLL;
          if (typeof _day.hasLL === 'boolean') _hasLL = _day.hasLL && (_llmp || _ill || !_llSubtypesSpecified);
          else _hasLL = _llSubtypesSpecified ? (_llmp || _ill) : (_cfg.hasLL !== false);
          if (!_hasLL) { _llmp = false; _ill = false; }
          else if (!_llmp && !_ill) { _llmp = true; }

          // Onboarding wiring context (Oct 7, 2026): every Flow P soft-
          // preference control the guest set resolves HERE, once, into the
          // exact values the scaffold seams consume below.
          const _gp = (_cfg.groupProfile && typeof _cfg.groupProfile === 'object') ? _cfg.groupProfile : {};
          const _groupSize = (typeof _gp.size === 'number' && _gp.size > 0) ? Math.floor(_gp.size)
            : (typeof _cfg.groupSize === 'number' && _cfg.groupSize > 0) ? Math.floor(_cfg.groupSize) : null;
          // HEIGHT GATE (Tier 1): legacy bracket semantics; the gate is
          // active only when the shortest rider is under 48in. A SOLO guest
          // gets hard exclusion (maxHeightInches for the pickers); a group
          // gets the rider-swap note path in verify.
          const _minH = shortestHeightInches(_cfg.minHeight);
          const _heightActive = _minH < 48;
          const _soloHeight = _groupSize === 1;
          const _maxHeightInches = (_heightActive && _soloHeight) ? _minH : null;
          const _thrillMode = thrillModeFor(_cfg.thrillLevel);
          // ACCESSIBILITY (Tier 3): chip labels map to the two consumers --
          // mobility (dezigzag / spacing / fill context) and service animal
          // (relief-area notes / fill context).
          const _accList = (Array.isArray(_cfg.accessibility) ? _cfg.accessibility : []).map(s => String(s || '').toLowerCase());
          const _mobility = _accList.some(s => s.indexOf('mobility') !== -1);
          const _serviceAnimal = _accList.some(s => s.indexOf('service') !== -1);
          // DIETARY (Tier 2): groupProfile.dietary ONLY -- the top-level
          // dietaryNeeds field is read by nothing and stays that way
          // (Claude's checklist correction).
          const _dietNeeds = Array.isArray(_gp.dietary) ? _gp.dietary.filter(s => typeof s === 'string' && s.trim()) : [];
          // PRIOR SHOWS (Tier 2): the client accumulates shows seated on
          // earlier days; absent/empty degrades to no dedup signal.
          const _priorShows = Array.isArray(_cfg._priorShows) ? _cfg._priorShows.filter(s => typeof s === 'string' && s.trim())
            : (req.body && Array.isArray(req.body._priorShows)) ? req.body._priorShows.filter(s => typeof s === 'string' && s.trim()) : [];
          console.log('[scaffold] wiring ctx: groupSize=' + _groupSize + ' minH=' + _minH + ' soloHeight=' + _soloHeight + ' thrill=' + _thrillMode + ' mobility=' + _mobility + ' serviceAnimal=' + _serviceAnimal + ' diet=' + JSON.stringify(_dietNeeds) + ' priorShows=' + _priorShows.length);

          // Character meet (must-do categories): plan the day's meet BEFORE the
          // skeleton is built so the skeleton can carry a dedicated character
          // slot. Categories rotate across days via _priorCharacters.
          let _charMeet = null;
          try {
            const _cp = _cfg.characters || {};
            if (_cp.priority !== 'skip' && ((_cp.categories || []).length || _cp.priority === 'mustDo')) {
              const _ci = await getCharacterIntel();
              if (_ci && Array.isArray(_ci.characters) && _ci.characters.length) {
                const _meetParks = [_park].concat((_day.intent && _day.intent.hop && _day.intent.hop.toPark) ? [_day.intent.hop.toPark] : []);
                _charMeet = pickCharacterMeet(_ci.characters, _cp.categories || [], _meetParks, Array.isArray(_cfg._priorCharacters) ? _cfg._priorCharacters : [], landToPark);
                // Character priority (Tier 3): the skeleton slot carries the
                // priority so niceToHave meets seat opportunistically only.
                if (_charMeet) _charMeet.priority = _cp.priority || 'niceToHave';
                if (!_charMeet) console.log('[scaffold] no character meet planned (none in today\'s parks, or every candidate already met earlier this trip -- never-twice rule)');
              }
            }
          } catch (e) { console.warn('[scaffold] character meet planning failed:', e.message); }

          // Hop day: derive start-park open + to-park close, pass hop params. Non-hop/VIP days use the original call (else).
          const _hop = (_day.intent && _day.intent.hop && _day.intent.hop.toPark) ? _day.intent.hop : null;
          // X1 (Onboarding wiring, Oct 7, 2026): a day with BOTH park
          // hopping and a VIP-tour start cannot honor the hop -- the VIP
          // branch below skips the hop skeleton entirely. That conflict
          // used to drop SILENTLY; it is now surfaced in the response as a
          // dayConflicts record (the server record; the client also hints).
          const _dayConflicts = [];
          if (_hop && _vipStart !== null) {
            _dayConflicts.push({ kind: 'hop-vip-conflict', day: _di + 1, detail: 'Park hopping to ' + _hop.toPark + ' was not scheduled because this day starts with a VIP tour -- remove one of the two in onboarding to use it.' });
            console.warn('[scaffold] hop dropped for VIP start on day', _di + 1, '-- surfaced as dayConflicts');
          }
          let _sk;
          if (_hop && _vipStart === null) {
            const _toPark = _hop.toPark;
            const _toIsDca = /california|dca|adventure/i.test(_toPark);
            const _startHrs = _sHours(_isDcaDay ? /california adventure|\bDCA\b/i : /disneyland|\bDL\b/i);
            const _toHrs = _sHours(_toIsDca ? /california adventure|\bDCA\b/i : /disneyland|\bDL\b/i);
            const _startOpen = (_startHrs && _startHrs.openMin) || 480;
            const _toClose = (_toHrs && _toHrs.closeMin) || (_toIsDca ? 1320 : 1380);
            const _startClose = (_startHrs && _startHrs.closeMin) || (_isDcaDay ? 1320 : 1380);
            // Return hop (hopper tickets only): when the START park stays open
            // at least an hour past the evening park's close, hop back near
            // that close and ride to the later one.
            const _hopCfg = { toPark: _toPark, atMin: _hop.atMin };
            if (_cfg.parkHopping !== false && _startClose >= _toClose + 60) {
              _hopCfg.returnAtMin = _toClose - 15;
              _hopCfg.returnCloseMin = _startClose;
            }
            _sk = buildSkeleton({ park: _park, openMin: _startOpen, closeMin: _toClose, hasLL: _hasLL, hop: _hopCfg, dayNum: (_di + 1), charMeet: _charMeet || undefined });
          } else {
            _sk = buildSkeleton({ park: _park, openMin: _openMin, closeMin: _closeMin, hasLL: _hasLL, vipStartMin: _vipStart, vipEndMin: _vipEnd, dayNum: (_di + 1), charMeet: _charMeet || undefined });
          }
          console.log('[scaffold] dayIndex', _di, 'park', _park, 'open', _openMin, 'close', _closeMin, 'vip', _vipStart, _vipEnd, 'hasLL', _hasLL, 'slots', _sk.slots.length, 'rides', _sk.slots.filter(s => s.type === 'ride').length);
          // Closures are computed BEFORE the rope-drop assignment so the rope
          // pick itself is closure-aware: a closed ride must never headline
          // the day (verify would strip it and backfill a weaker opener).
          let _closedS = closedNamesForDate(cacheCtx.CLOSURES, _day.date);
          // The structured CLOSURES list has shipped empty while the prose
          // CURRENT_CLOSURES section carries the real refurbishment reporting;
          // merge prose-derived closures so a ride the cache itself reports
          // closed is never scheduled (Oct 4, 2026: BEAU01 rope-dropped the
          // closed Indiana Jones Adventure).
          try {
            const _proseClosed = closedNamesFromProse(cacheCtx.CURRENT_CLOSURES, _day.date, Object.values(buildCatalogIndex(cacheCtx.CATALOG)).map(e => (e && e.name) || e).filter(Boolean));
            if (_proseClosed.length) { console.log('[scaffold] prose closures on', _day.date, ':', JSON.stringify(_proseClosed)); _closedS = [...new Set([..._closedS, ..._proseClosed])]; }
          } catch (e) { console.warn('[scaffold] prose closure parse failed:', e.message); }
          console.log('[scaffold] closures on', _day.date, ':', JSON.stringify(_closedS));
          const _closedV = closedNamesForDate(cacheCtx.DINING_CLOSURES, _day.date);
          if (_closedV.length) console.log('[scaffold] venue closures on', _day.date, ':', JSON.stringify(_closedV));

          // Rope-drop assignment: the first ride of the day is chosen by
          // strategy priority (see pickRopeDropRide), never left to chance.
          try {
            const _ropeSlot = _sk.slots.find(x => x.block === 'ropedrop');
            if (_ropeSlot) {
              const _ropePick = pickRopeDropRide(buildCatalogIndex(cacheCtx.CATALOG), _ropeSlot.park, priorRides, [...new Set([...(skipRides || []), ..._closedS])], Array.isArray(_cfg._priorRopeDrops) ? _cfg._priorRopeDrops : [], _closedS, { maxHeightInches: _maxHeightInches });
              if (_ropePick) { _ropeSlot.preferRide = _ropePick.name; console.log('[scaffold] rope drop assigned:', _ropePick.name); }
            }
          } catch (e) { console.warn('[scaffold] rope-drop assignment failed:', e.message); }
          // Coverage-first reservation (Item 3, Oct 7, 2026 -- Claude's
          // locked two-phase design, phase 1): BEFORE the morning picker and
          // the fill model see the day, reserve every seatable must-do into
          // a legal slot in its own park's window (pre-hop only on hop days)
          // via preferRide -- headliner tier first, then the rest in guest
          // order. Non-must-dos only ever see the slots left over.
          let _coverage = null;
          try {
            _coverage = planCoverageReservations(_sk, { catalog: buildCatalogIndex(cacheCtx.CATALOG), mustDoNames: mustDo, closedNames: _closedS, bannedNames: skipRides, priorRideNames: priorRides, closeMinByPark: _closeByPark, closeMin: _closeMin });
            if (_coverage.assignments.length) console.log('[scaffold] coverage reserved:', _coverage.assignments.map(a => a.name + ' @' + a.slotId + ' (' + a.tier + ')').join(', '));
            if (_coverage.unreserved.length) console.log('[scaffold] coverage unreserved:', JSON.stringify(_coverage.unreserved));
            if (_coverage.insights.length) console.log('[scaffold] coverage insights:', JSON.stringify(_coverage.insights));
          } catch (e) { console.warn('[scaffold] coverage reservation failed:', e.message); }
          // Morning block assignment: the start park's early ride slots are
          // ASSIGNED from the catalog, not left to the fill model. This wiring
          // was missing from the handler -- pickMorningRides shipped Oct 4 but
          // was never called, so the model filled mornings itself and put the
          // Disneyland Monorail at 9:38 AM on BEAU01 Day 1 (Oct 5). Assigned
          // slots carry preferRide; applyFills enforces them like the rope drop.
          try {
            const _ropeSlot2 = _sk.slots.find(x => x.block === 'ropedrop');
            if (_ropeSlot2 && _ropeSlot2.preferRide) {
              const _wsOf = (w) => Array.isArray(w[0]) ? w[0][0] : w[0];
              // Item 3: slots already carrying a coverage reservation are not
              // the morning picker's to give away, and a ride reserved
              // anywhere today (rope drop or coverage) must never be picked
              // for a second slot -- the group-level filter below replaces
              // the old rope-name-only filter.
              const _mSlots = _sk.slots.filter(x => x.type === 'ride' && x.block !== 'ropedrop' && !x.preferRide && x.park === _ropeSlot2.park && _wsOf(x.window) < (_sk.openMin || 480) + 180)
                .sort((a, b) => _wsOf(a.window) - _wsOf(b.window));
              if (_mSlots.length) {
                const _reservedGroups = new Set(_sk.slots.filter(s => s.preferRide).map(s => rideGroupKey(s.preferRide)).filter(Boolean));
                const _mPicks = pickMorningRides(buildCatalogIndex(cacheCtx.CATALOG), _ropeSlot2.park, _mSlots.length, {
                  priorNames: [...(priorRides || []), _ropeSlot2.preferRide, ...((_coverage && _coverage.reservedNames) || [])],
                  bannedNames: [...new Set([...(skipRides || []), ..._closedS])],
                  priorRopeDropNames: Array.isArray(_cfg._priorRopeDrops) ? _cfg._priorRopeDrops : [],
                  closedNames: _closedS,
                  maxHeightInches: _maxHeightInches,
                  thrillMode: _thrillMode
                }).filter(p => p && !_reservedGroups.has(rideGroupKey(p.name)));
                _mSlots.forEach((s, i) => { if (_mPicks[i]) { s.preferRide = _mPicks[i].name; } });
                console.log('[scaffold] morning assigned:', _mSlots.map(s => s.preferRide || '(model)').join(', '));
              }
            }
          } catch (e) { console.warn('[scaffold] morning assignment failed:', e.message); }
          // Dining service gate + guest reservations (Beau, Oct 6, 2026):
          // schedules are quick-service only; table/lounge venues pass only
          // when the guest noted them as reservations in onboarding.
          // Venue services keyed CANONICALLY (Phase 3, Oct 7, 2026), from
          // name-form-corrected entries: variant suffixes are stripped on
          // both sides of the table-service check, so 'Lamplight Lounge
          // Dining Room' resolves to the Lamplight Lounge lounge entry
          // instead of slipping the QS-only gate as a 'quickservice'.
          const _venuesEarly = correctVenueServices(parseCatalogVenues(cacheCtx.CATALOG));
          const _venueServices = {};
          for (const v of _venuesEarly) { if (v && v.name && v.service) _venueServices[canonicalVenueKey(v.name)] = v.service; }
          const _tableVenueNames = _venuesEarly.filter(v => v && (v.service === 'table' || v.service === 'lounge')).map(v => v.name);
          const _resvNames = [];
          try {
            const _rfl = [].concat(((_cfg || {}).reservations) || [], (((_cfg || {}).dining || {}).reservations) || []);
            for (const r of _rfl) {
              const nm = (typeof r === 'string') ? r.split(',')[0] : (r && (r.name || r.venue || r.restaurant));
              if (nm && String(nm).trim()) _resvNames.push(String(nm).trim());
            }
          } catch (e) {}
          const _reservationKeys = new Set(_resvNames.map(canonicalVenueKey).filter(Boolean));
          // WANTED QUICK-SERVICE SPOTS (Onboarding wiring Tier 2, Oct 7,
          // 2026): tripConfig.wantedRestaurants (free text, one or more
          // names) is canonical-matched against the verified venue list --
          // the same containment semantics as the reservation matching.
          // Matched venues rank FIRST in deterministic dining picks and are
          // named in the fill prompt (the item is model-gated: ranking +
          // prompt context together are the wire).
          const _wantedVenues = (function () {
            const raw = _cfg.wantedRestaurants;
            const parts = Array.isArray(raw) ? raw.map(s => String(s || ''))
              : (typeof raw === 'string' && raw.trim()) ? raw.split(/[\n,;]+/) : [];
            const names = [], keys = new Set();
            for (const part of parts) {
              const t = String(part || '').trim();
              if (!t) continue;
              const tk = canonicalVenueKey(t);
              if (!tk) continue;
              for (const v of _venuesEarly) {
                if (!v || !v.name) continue;
                const vk = canonicalVenueKey(v.name);
                if (!vk) continue;
                if (vk === tk || vk.indexOf(tk) !== -1 || (tk.length >= 4 && tk.indexOf(vk) !== -1)) {
                  if (!keys.has(vk)) { keys.add(vk); names.push(v.name); }
                  break;
                }
              }
            }
            return { names, keys };
          })();
          if (_wantedVenues.names.length) console.log('[scaffold] wanted venues matched:', JSON.stringify(_wantedVenues.names));
          // Reservation anchors (Item 4, Oct 7, 2026 -- Claude's locked
          // design): each confirmed reservation for THIS day becomes an
          // immutable anchor slot injected into the skeleton BEFORE the fill
          // prompt is built, and the day's generic meal slot for its period
          // is removed so no duplicate meal can be generated beside it.
          // Conflicts (wrong park at that time, closed venue, inside the VIP
          // window, unresolvable) are surfaced in the response, never
          // silently dropped.
          let _resvPlan = null;
          try {
            _resvPlan = planReservationAnchors(_sk, (typeof _allReservations !== 'undefined' && Array.isArray(_allReservations)) ? _allReservations : [], { venues: _venuesEarly, closedVenueNames: _closedV, vipWindow: (_vipStart !== null && _vipEnd !== null) ? [_vipStart, _vipEnd] : null, groupSize: _groupSize });
            if (_resvPlan.anchors.length) console.log('[scaffold] reservation anchors:', JSON.stringify(_resvPlan.anchors), 'suppressed:', JSON.stringify(_resvPlan.suppressed));
            if (_resvPlan.conflicts.length) console.warn('[scaffold] reservation conflicts:', JSON.stringify(_resvPlan.conflicts));
          } catch (e) { console.warn('[scaffold] reservation anchor planning failed:', e.message); }
          const _fillCtx = parkIntelContext
            + '\n\n=== VERIFIED DINING (choose venues ONLY from this list) ===\n' + diningIntel
            + ((charContext && charContext.trim()) ? '\n\n=== CHARACTER MEETS (from cache) ===\n' + charContext : '')
            + (_resvNames.length ? '\n\n=== GUEST RESERVATIONS (confirmed in onboarding) ===\n' + _resvNames.join('; ') + '\nSeat a listed venue as that meal card when its day/time matches this day, and note it is their reservation. These are the ONLY sit-down venues allowed in the schedule.' : '');
          const _heightNote = !_heightActive ? null
            : _soloHeight ? 'HEIGHT -- SOLO GUEST: this guest is traveling SOLO and the shortest rider is ' + _minH + 'in tall (onboarding bracket). Never choose a ride whose height requirement exceeds ' + _minH + 'in -- with no second adult there is no rider swap, so an over-height ride is a wasted stop.'
            : 'HEIGHT: the shortest rider in this group is ' + _minH + 'in tall (onboarding bracket). Rides with a height requirement above ' + _minH + 'in are rider-swap stops for this group -- present them that way, never as whole-group rides.';
          const _fillSys = buildFillPrompt(_sk, { usedDining: allUsedDining, usedRides: priorRides, closedNames: _closedS, closedVenueNames: _closedV, llmp: _llmp, ill: _ill, tableVenueNames: _tableVenueNames, wantedVenues: _wantedVenues.names, thrillMode: _thrillMode, dietaryNeeds: _dietNeeds, mobility: _mobility, serviceAnimal: _serviceAnimal, heightNote: _heightNote })
            + ((typeof ridePrefsContext === 'string' && ridePrefsContext) ? '\n\n' + ridePrefsContext : '')
            + '\n\n=== CURRENT PARK INTELLIGENCE (use ONLY this -- never the web) ===\n' + _fillCtx;

          // COST (Oct 5, 2026): the park-intelligence context is identical for
          // every day and every retry of a trip build, and it is the bulk of
          // the prompt -- send it as a prompt-cached block so repeat calls pay
          // ~10% for it instead of full price. _fill receives the DYNAMIC part
          // (skeleton + prefs + retry/correction suffixes); the cached static
          // block rides first on the wire.
          const _intelMarker = '\n\n=== CURRENT PARK INTELLIGENCE (use ONLY this -- never the web) ===\n';
          const _mi = _fillSys.indexOf(_intelMarker);
          const _dynSys = _mi >= 0 ? _fillSys.slice(0, _mi) : _fillSys;
          const _staticSys = _mi >= 0 ? _fillSys.slice(_mi + _intelMarker.length) : '';
          // Test mode: stubFill + the BEAU01 sample code skips the model
          // entirely -- applyFills backfills every slot deterministically, so
          // structural regression runs (the repeatability matrix) cost $0.
          const _stubFill = _body.stubFill === true && String(_tripCode || '').toUpperCase() === 'BEAU01';
          const _fill = async (sys) => {
            if (_stubFill) { console.log('[scaffold] STUB FILL -- test mode, no model call'); return { arr: [], model: 'stub', text: '' }; }
            const _system = _staticSys ? [
              { type: 'text', text: '=== CURRENT PARK INTELLIGENCE (use ONLY this -- never the web) ===\n' + _staticSys, cache_control: { type: 'ephemeral' } },
              { type: 'text', text: sys }
            ] : sys;
            const r = await fetch('https://api.anthropic.com/v1/messages', {
              signal: controller.signal, method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({ model: _evalModel || 'claude-haiku-4-5-20251001', ..._evalTempSpread, ..._evalEffortSpread, max_tokens: maxTokens, system: _system, messages: [{ role: 'user', content: 'Fill every slot in the skeleton now. Return ONLY the JSON array of slot objects, one per slot id, same order.' }] })
            });
            const d = await r.json();
            _evalUsage.push({ usage: d.usage || null, stop_reason: d.stop_reason || null, model: d.model || null });
            console.log('[scaffold] fill usage: input=' + ((d.usage && d.usage.input_tokens) ?? '?') + ' cache_creation=' + ((d.usage && d.usage.cache_creation_input_tokens) ?? 0) + ' cache_read=' + ((d.usage && d.usage.cache_read_input_tokens) ?? 0));
            if (d.error) throw new Error(d.error.message);
            let t = ''; for (const b of (d.content || [])) if (b.type === 'text') t += b.text;
            return { arr: extractJSON(t), model: d.model, text: t };
          };
          // Deterministic backfill (recommendation #3): catalog + venues are read BEFORE the
          // fill so dropped slots get real cache-verified picks -- never placeholder cards.
          const _catIdx = buildCatalogIndex(cacheCtx.CATALOG);
          console.log('[scaffold] catalog entries:', Object.keys(_catIdx).length);
          const _catList = Object.values(_catIdx);
          const _venues = correctVenueServices(parseCatalogVenues(cacheCtx.CATALOG));
          // Dining card details (Item 4): the dining intel's verified
          // menu highlights, parsed once per request; applyFills and
          // the deterministic backfill stamp them onto seated cards.
          const _diningDetails = parseDiningIntelDetails(cacheCtx.DINING_INTEL);
          // Guest-listed ILL rides (Tier 3): days[].illRides names the rides
          // the guest bought Individual Lightning Lane for. Expanded to a
          // group-aware normName key set (a listed ride covers its variant
          // siblings). Empty/absent = unspecified -- the catalog governs.
          const _illNames = (function () {
            const raw = _day.illRides;
            return Array.isArray(raw) ? raw.map(s => String(s || '').trim()).filter(Boolean)
              : (typeof raw === 'string' && raw.trim()) ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
          })();
          const _illRideKeys = (function () {
            const names = _illNames;
            if (!names.length) return null;
            const set = new Set();
            for (const n of names) {
              const k = normName(n);
              if (k) set.add(k);
              const g = rideGroupKey(n);
              if (g) { for (const ck of Object.keys(_catIdx)) { if (rideGroupKey(_catIdx[ck].name) === g) set.add(ck); } }
            }
            console.log('[scaffold] guest-listed ILL rides:', JSON.stringify([...set]));
            return set.size ? set : null;
          })();
          // Dietary intel per venue, canonical-keyed (Tier 2 surfacing).
          const _venueDietary = {};
          for (const v of _venues) { if (v && v.name && v.dietary) _venueDietary[canonicalVenueKey(v.name)] = v.dietary; }
          // Real show names for show-slot backfill (dynamic SHOWS section), with the
          // guest's wanted shows preferred. Without this the backfill can only emit
          // a generic 'Nighttime spectacular' card.
          let _showPicks = [];
          try {
            const _sd = typeof cacheCtx.SHOWS === 'string' ? JSON.parse(cacheCtx.SHOWS) : cacheCtx.SHOWS;
            const _arr = (_sd && Array.isArray(_sd.shows)) ? _sd.shows : [];
            _showPicks = _arr.filter(s => s && s.name).map(s => ({ name: String(s.name), park: (String(s.park).toUpperCase() === 'DCA' ? 'DCA' : 'DL') }));
          } catch (e) {}
          const _photoSpots = await getPhotoOpsIntel();
          const _fallbackFor = (slot, fb) => deterministicBackfill(slot, {
            catalog: _catList, venues: _venues, closedNames: _closedS, closedVenueNames: _closedV,
            usedRideKeys: fb.usedRideKeys, usedNames: fb.usedNames,
            priorRideKeys: fb.priorRideKeys, todayRideKeys: fb.todayRideKeys, encoredRideKeys: fb.encoredRideKeys, bannedKeys: fb.bannedKeys,
            closeMin: (typeof fb.closeMin === 'number') ? fb.closeMin : null, usedVenueKeys: fb.usedVenueKeys,
            shows: _showPicks, wantedShows: showWant, photoSpots: _photoSpots, nearLand: fb.nearLand, nextLand: fb.nextLand, diningDetails: _diningDetails,
            skipShows: showSkip, priorShows: _priorShows, wantedVenueKeys: _wantedVenues.keys,
            dietaryNeeds: _dietNeeds, groupSize: _groupSize,
            minHeightInches: _heightActive ? _minH : null, soloHeight: _soloHeight, thrillMode: _thrillMode
          });

          // Phase 1 plumbing (Fix 3 F3+F5): the REAL catalog + venues now
          // reach applyFills (catalogParkBad / venueBad were dead code
          // without them), and the day's closes ride along per park so the
          // headliner window uses closeMin-90 instead of the hardcoded
          // 8:30 PM fallback in both fill layers.
          const _fillOpts = { landToPark: landToPark, closedNames: _closedS, closedVenueNames: _closedV, fallbackFor: _fallbackFor, priorRides: priorRides, mustDoNames: mustDo, shows: _showPicks, priorVenues: _priorVenues, bannedKeys: new Set((skipRides || []).map(normName).filter(Boolean)), venueServices: _venueServices, reservationKeys: _reservationKeys, catalog: _catIdx, venues: _venues, closeMin: _closeMin, closeMinByPark: _closeByPark, llmp: _llmp, ill: _ill, skipShowKeys: new Set((showSkip || []).map(normName).filter(Boolean)), priorShowKeys: new Set(_priorShows.map(normName).filter(Boolean)), minHeightInches: _heightActive ? _minH : null, groupSize: _groupSize, diningDetails: _diningDetails };

          let _r = await _fill(_dynSys);
          let _ap = applyFills(_sk, Array.isArray(_r.arr) ? _r.arr : [], _fillOpts);
          if (_ap.needsRetry.length) {
            console.log('[scaffold] retry slots:', _ap.needsRetry.join(','));
            try {
              const _r2 = await _fill(_dynSys + '\n\nRETRY: your previous answer was missing, in the wrong park, a duplicate, a closed ride, or a generic activity for these slot ids: ' + _ap.needsRetry.join(', ') + '. Return the FULL array again; for those slots choose a DIFFERENT real attraction in the correct park, inside the window, not used anywhere else in the day.');
              const _ap2 = applyFills(_sk, Array.isArray(_r2.arr) ? _r2.arr : [], _fillOpts);
              if (_ap2.needsRetry.length <= _ap.needsRetry.length) { _ap = _ap2; _r = _r2; }
            } catch (e) { console.warn('[scaffold] retry failed:', e.message); }
          }

          // Verify layer -- REMOVE-ONLY safety net (replaces the heavy validateSchedule on this path;
          // the scaffold already owns structure, so no gap-fill / time-shift / evening-fill here).
          const _dayParks = (_hop && _vipStart === null) ? [_park, _hop.toPark] : [_park];
          const _vf = verifyScaffold(_ap.cards, { parks: _dayParks, landToPark: landToPark, closedNames: _closedS, closedVenueNames: _closedV, catalog: _catIdx, shows: _showPicks, hasILL: _ill, hasLLMP: _llmp, waitPatterns: _wpObj, mustDoNames: mustDo, closeMin: _closeMin, closeMinByPark: _closeByPark, bannedNames: skipRides, showSkipNames: showSkip, priorShowNames: _priorShows, minHeightInches: _heightActive ? _minH : null, groupSize: _groupSize, dietaryNeeds: _dietNeeds, venueDietary: _venueDietary, mobility: _mobility, serviceAnimal: _serviceAnimal, illRideKeys: _illRideKeys });

          // Parameter-fidelity verifier (recommendation #2): guest parameters are absolute.
          // Cite the specific failures back to the model once; deterministically enforce the rest.
          const _pvParams = { mustDo: mustDo, skip: skipRides, hasLL: _hasLL };
          let _violations = verifyTripParams(_vf.cards, _pvParams);
          let _items = _vf.cards;
          let _dietaryConflicts = Array.isArray(_vf.dietaryConflicts) ? _vf.dietaryConflicts : [];
          let _trimMustDos = Array.isArray(_vf.trimmedMustDos) ? _vf.trimmedMustDos.slice() : [];
          let _mutations = Array.isArray(_vf.mutations) ? _vf.mutations : [];
          if (_violations.length) {
            console.log('[scaffold] param violations:', JSON.stringify(_violations));
            const _missingCt = _violations.filter(function(v) { return v.kind === 'mustdo-missing'; }).length;
            const _otherCt = _violations.length - _missingCt;
            // COST: when the only problem is a long list of unplaced must-dos,
            // that is a capacity limit, not a fixable error -- a model round
            // cannot create slots, and deterministic enforcement below decides
            // the outcome. Skip the round (it fired on nearly every heavy
            // must-do day and was a top driver of test spend).
            if (_otherCt === 0 && _missingCt > 6) {
              console.log('[scaffold] param correction SKIPPED (cost): ' + _missingCt + ' unplaced must-dos = capacity limit');
            } else try {
              const _cite = _violations.map(function(v) {
                if (v.kind === 'mustdo-missing') return 'missing must-do ride "' + v.name + '" (guest marked it non-negotiable -- it MUST appear exactly once)';
                if (v.kind === 'skip-present') return 'includes "' + v.name + '" which the guest explicitly listed under Skip -- remove it entirely';
                return 'day has no Lightning Lane but "' + v.name + '" carries LL content -- remove all ll fields';
              }).join('; ');
              const _r3 = await _fill(_dynSys + '\n\nPARAMETER CORRECTION -- guest parameters are absolute, not suggestions: ' + _cite + '. Return the FULL array again, same slot ids in the same order, with every one of these fixed and nothing else broken.');
              const _ap3 = applyFills(_sk, Array.isArray(_r3.arr) ? _r3.arr : [], _fillOpts);
              const _vf3 = verifyScaffold(_ap3.cards, { parks: _dayParks, landToPark: landToPark, closedNames: _closedS, closedVenueNames: _closedV, catalog: _catIdx, shows: _showPicks, hasILL: _ill, hasLLMP: _llmp, waitPatterns: _wpObj, mustDoNames: mustDo, closeMin: _closeMin, closeMinByPark: _closeByPark, bannedNames: skipRides, showSkipNames: showSkip, priorShowNames: _priorShows, minHeightInches: _heightActive ? _minH : null, groupSize: _groupSize, dietaryNeeds: _dietNeeds, venueDietary: _venueDietary, mobility: _mobility, serviceAnimal: _serviceAnimal, illRideKeys: _illRideKeys });
              if (Array.isArray(_vf3.trimmedMustDos)) _trimMustDos = _trimMustDos.concat(_vf3.trimmedMustDos);
              const _v3 = verifyTripParams(_vf3.cards, _pvParams);
              if (_v3.length <= _violations.length) { _violations = _v3; _items = _vf3.cards; _r = _r3; if (Array.isArray(_vf3.mutations)) _mutations = _vf3.mutations; if (Array.isArray(_vf3.dietaryConflicts)) _dietaryConflicts = _vf3.dietaryConflicts; }
            } catch (e) { console.warn('[scaffold] param retry failed:', e.message); }
          }
          const _enf = enforceTripParams(_items, _violations, { catalog: _catIdx, landToPark: landToPark, closedNames: _closedS, bannedNames: skipRides, mustDoNames: mustDo, llmp: _llmp, ill: _ill, closeMin: _closeMin, closeMinByPark: _closeByPark, parks: _dayParks, venueServiceMap: _venueServices, reservationKeys: _reservationKeys, closedVenueNames: _closedV, minHeightInches: _heightActive ? _minH : null, groupSize: _groupSize, illRideKeys: _illRideKeys });
          _items = _enf.cards;
          if (_enf.blocked && _enf.blocked.length) console.warn('[scaffold] param swap BLOCKED by re-validation gate:', JSON.stringify(_enf.blocked));
          // A swap-in renames a card after LL normalization already ran:
          // re-run it so a swapped-in ride's tag is the day's canonical
          // assignment (cap respected), never a leftover (Fix 3 F1).
          if ((_enf.fixed || []).some(f => f && f.action === 'swapped-in')) {
            try {
              const _llMut = [];
              normalizeLLAssignments(_items, { llmp: _llmp, ill: _ill, catalog: _catIdx, illRideKeys: _illRideKeys }, _llMut);
              for (const m of _llMut) _mutations.push(Object.assign({ stage: 'post-enforce' }, m));
            } catch (e) { console.warn('[scaffold] post-enforce LL normalization failed:', e.message); }
          }
          // Fix 4 completeness surfacing (Oct 7, 2026): a must-do that could
          // not be placed today must NEVER vanish silently. Collect from the
          // enforcer's unfixable list (must-dos belonging to today's parks
          // only -- the list is trip-wide) and from the feasibility trim's
          // last-resort must-do removals; drop anything that nevertheless
          // ended up placed (a swap can rescue a trimmed ride); exclude
          // closed/banned must-dos, which are impossible by closure/ban, not
          // unplaced for lack of room. Surfaced in the response as
          // unplacedMustDos and logged loudly; the clients turn a non-empty
          // list into one guest-visible "couldn't fit" summary.
          const unplacedMustDos = (function () {
            const dayParkKeys = new Set((_dayParks || []).map(p => normParkName(p)).filter(Boolean));
            const closedKeysU = new Set((_closedS || []).map(normName).filter(Boolean));
            const bannedKeysU = new Set((skipRides || []).map(normName).filter(Boolean));
            const placedGroups = new Set((_items || []).filter(c => c && c.type === 'ride').map(c => rideGroupKey(c.ride || c.h)).filter(Boolean));
            const byGroup = new Map();
            const consider = (name) => {
              const nm = String(name || '').trim(); if (!nm) return;
              const k = normName(nm); if (!k) return;
              if (closedKeysU.has(k) || bannedKeysU.has(k)) return;
              const gk = rideGroupKey(nm);
              if (placedGroups.has(gk)) return;
              const ce = _catIdx[normName(nm)];
              if (ce && ce.park && dayParkKeys.size && !dayParkKeys.has(normParkName(ce.park))) return;
              if (!byGroup.has(gk)) byGroup.set(gk, nm);
            };
            for (const u of (_enf.unfixable || [])) { if (u && u.kind === 'mustdo-missing') consider(u.name); }
            _trimMustDos.forEach(consider);
            return [...byGroup.values()];
          })();
          if (unplacedMustDos.length) console.error('[scaffold] UNPLACED MUST-DOS day ' + (_di + 1) + ' (' + _dayParks.join('/') + '): ' + unplacedMustDos.join(', '));
          if (_enf.fixed.length) console.log('[scaffold] param enforced:', JSON.stringify(_enf.fixed));
          if (_enf.unfixable.length) console.warn('[scaffold] param UNFIXABLE:', JSON.stringify(_enf.unfixable));
          console.log('[scaffold] applyFills report:', JSON.stringify(_ap.report), 'needsRetry:', _ap.needsRetry.length, 'verify removed:', _vf.removed.length, JSON.stringify(_vf.removed));
          if (_mutations.length) console.log('[scaffold] verify mutations:', JSON.stringify(_mutations));
          // Prose-consistency tripwire (Oct 7, 2026): judge the day AS IT
          // SHIPS -- after every mutator and the enforcer -- for note prose
          // that names a used venue on a card that is not about that venue.
          // FLAG ONLY: proseVenueFlags is a log/response surface; it never
          // rewrites a note and never rejects a card (Claude's ruling: no
          // prose scrubber). Fail-open in a try/catch like the other
          // surfacing seams: a tripwire bug must never break generation.
          let proseVenueFlags = [];
          try { proseVenueFlags = scanProseVenueFlags(_items, { venues: _venues, priorVenues: _priorVenues }); } catch (e) { console.warn('[scaffold] prose tripwire failed:', e.message); }
          if (proseVenueFlags.length) console.log('[scaffold] prose venue flags:', JSON.stringify(proseVenueFlags));
          // LL booking sequence (LL plan-side package, Oct 8, 2026): the
          // day's deterministic Multi Pass booking order, computed from
          // the final cards and stamped on the response; the clients
          // persist it on the saved day. Fail-open like the other
          // surfacing seams -- a sequence bug never breaks generation.
          // generatedWith stamp (Item 4, Claude msg 570): what this day
          // was actually built with, from the COERCED flags -- the state
          // every LL surface arms off. Config flags are intent only;
          // llSequence stays the game-plan card's content, not a state
          // signal (it is legitimately null on some LL-built days).
          let llSequence = null;
          try { llSequence = computeLLSequence(_items, _catIdx, { llmp: _llmp === true, isVip: !!(_day && _day.isVip) }); } catch (e) { console.warn('[scaffold] LL sequence failed:', e.message); }
          return res.status(200).json({ ok: true, scaffold: true, text: _r.text, parsed: _items, model: _r.model, skeletonSlots: _sk.slots.length, rideSlots: _sk.slots.filter(s => s.type === 'ride').length, report: _ap.report, verifyRemoved: _vf.removed, verifyMutations: _mutations, paramViolations: _violations, paramFixed: _enf.fixed, paramUnfixable: _enf.unfixable, paramBlocked: _enf.blocked || [], unplacedMustDos: unplacedMustDos, coverage: _coverage ? { reserved: _coverage.assignments, unreserved: _coverage.unreserved } : null, coverageInsights: _coverage ? _coverage.insights : [], reservationAnchors: _resvPlan ? _resvPlan.anchors : [], reservationConflicts: _resvPlan ? _resvPlan.conflicts : [], dietaryConflicts: _dietaryConflicts, dayConflicts: _dayConflicts, proseVenueFlags: proseVenueFlags, generatedWith: { hasLLMP: _llmp === true, hasILL: _ill === true, illRides: _illNames }, llSequence: llSequence, evalUsage: _evalUsage, evalModel: _evalModel });
        } catch (_se) {
          // SAFE FAILURE (legacy retired Oct 7, 2026): never fall through
          // to a second engine. The shipped clients render { ok:false,
          // error } as the failed day (Tap to retry / Continue without
          // this day in pretrip; 'AI error' callback in app.html), and no
          // schedule is returned, so nothing empty can be saved as a plan.
          console.error('[scaffold] error (safe failure -- legacy retired):', _se.message);
          return res.status(502).json({ ok: false, error: "Couldn't build your schedule — try again.", code: 'GENERATION_FAILED' });
        }
      }

      // LEGACY GENERATOR BODY REMOVED (Oct 14, 2026): it was unreachable
      // since the Oct 7, 2026 retirement -- the scaffold block above returns
      // on success (200) and on error (502) -- and its prompt assembly was
      // removed in the same cleanup. The scaffold is the only generator.


    } catch (e) {
          if (e.name === 'AbortError') {
                  return res.status(504).json({ error: 'AI request timed out' });
          }
          console.error('generateschedule error:', e.message);
          return res.status(500).json({ error: e.message });
    } finally {
          clearTimeout(timeout);
    }
};

handler.config = { maxDuration: 300 }; // Day-1 scaffold generations legitimately run past 90s (Oct 6, 2026)
