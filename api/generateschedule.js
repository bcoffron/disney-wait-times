// api/generateschedule.js
// Routes generateFromSetup and aiChooseRides through Vercel with new two-cache section injection
import { list } from '@vercel/blob';

// --- Registry-backed trip-code validation (Oct 2026 lockdown) ---
// A trip code is valid only if it was actually issued (present in the trip
// registry) — the old shape-only check accepted any string of N+ chars.
// Same salted-first/bare-fallback registry read as api/trip.js, 60s cache.
const _AUTH_SALT = (process.env.BLOB_PATH_SALT || '').trim();
let _authRegCache = null, _authRegCacheAt = 0;
async function _isRegisteredTripCode(code) {
  if (!code || typeof code !== 'string') return false;
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
  return !!(_authRegCache && _authRegCache[code]);
}

import { validateSchedule, parseClosedFromCache, landToPark, normPark } from './validate-schedule.js';
import { buildSkeleton, buildFillPrompt, applyFills, verifyScaffold, closedNamesForDate, closedNamesFromProse, buildCatalogIndex, parseCatalogVenues, deterministicBackfill, verifyTripParams, enforceTripParams, pickRopeDropRide, pickMorningRides, pickCharacterMeet, normName, normParkName, rideGroupKey, canonicalVenueKey, scanProseVenueFlags, correctVenueServices, normalizeLLAssignments, planCoverageReservations, planReservationAnchors, shortestHeightInches, thrillModeFor, parseDiningIntelDetails, correctPhotoSpotProse } from './scaffold.js';

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
async function buildCacheContext(sectionNames, includeDynamic = false) {
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
  // legacy park_hours_intel blob ({dl:{open,close}, dca:{open,close}}, 24h "HH:MM").
  // Format one line per park for the consumers' line parser (first time on the
  // park's line = open, last = close). Without this, cacheCtx.PARK_HOURS is always
  // empty and generators fall back to generic close times (days ending early).
  try {
    const { blobs: phb } = await list({ prefix: 'twize/park_hours_intel.json' });
    if (phb && phb.length) {
      const phData = await fetch(phb[0].downloadUrl || phb[0].url).then(r => r.json());
      let ph = (phData && phData.data) ? phData.data : phData;
      if (ph && !ph.dl && !ph.dca) { const _fk = Object.keys(ph).find(k => ph[k] && (ph[k].dl || ph[k].dca)); if (_fk) ph = ph[_fk]; }
      const _fmtH = (hhmm) => { const p = String(hhmm || '').split(':'); if (p.length < 2) return ''; let h = parseInt(p[0], 10); if (isNaN(h)) return ''; const ap = h < 12 ? 'AM' : 'PM'; let h12 = h % 12; if (h12 === 0) h12 = 12; return h12 + ':' + p[1] + ' ' + ap; };
      const _phLines = [];
      if (ph && ph.dl && ph.dl.open && ph.dl.close) _phLines.push('Disneyland: ' + _fmtH(ph.dl.open) + ' - ' + _fmtH(ph.dl.close));
      if (ph && ph.dca && ph.dca.open && ph.dca.close) _phLines.push('Disney California Adventure: ' + _fmtH(ph.dca.open) + ' - ' + _fmtH(ph.dca.close));
      if (_phLines.length) results['PARK_HOURS'] = _phLines.join('\n');
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
    const _isValidTrip = await _isRegisteredTripCode(_tripCode);
    if (!_isAdmin && !_isValidTrip) {
                console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
        return res.status(401).json({ error: 'Authentication required.' });
    }
    // -------------------------------------------------------------------------

  // -- D: 30-second timeout on Anthropic API calls ----------------------------------
  const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
          const { prompt, mode, maxTokens = 8000, tripConfig } = req.body || {};

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

      const cacheCtx = await buildCacheContext(
              ['LAND_MAP', 'WAIT_PATTERNS', 'ROPE_DROP_STRATEGY',
                       'LIGHTNING_LANE_STRATEGY', 'DINING_TIMING', 'CROWD_FLOW',
      'PARK_HOURS', 'PARK_HOP_STRATEGY', 'CATALOG', 'SHOW_AND_ENTERTAINMENT'],
              true
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

      let system = 'You are the genius best friend who knows Disneyland and Disney California Adventure inside out -- thinking ahead so this family does not have to. Your one rule: EVERY decision (ride order, timing, the hop, dining, character stops, Lightning Lane) must come from the CACHE DATA below -- wait-time patterns, rope-drop and hop strategy, crowd flow, park hours, the verified dining and character lists. Do NOT invent wait times, best windows, hop times, ride names, or venues. If the cache does not support a claim, do not make it. Give the best move the DATA shows, never a guess that merely sounds good. Output valid JSON only -- no markdown, just JSON.';

      system += '\n\n=== CURRENT PARK INTELLIGENCE (use this --- do not search the web) ===\n' + parkIntelContext;

      // === CHARACTER MEETS: inject the cache data + scheduling instruction (was computed but never injected) ===
      if (charContext && charContext.trim()) {
        system += '\n\n=== CHARACTER MEETS (from cache) ===\n' + charContext;
        if (charPriority === 'mustDo') {
          system += '\n\nCHARACTER SCHEDULING (MUST-DO): The group has marked character meets as a MUST-DO priority. You MUST schedule at least one character meet card on each day from the CHARACTER MEETS list above, matching the family\'s selected categories, in the correct park for that day. Use type: "character". Place each meet at a sensible time/land based on the cache windows (e.g. Galaxy\'s Edge for Star Wars, Town Square/Toontown for classic). NEVER invent a character or location not in the cache. Card schema: { t: "11:00 AM", h: "Meet [Character]", type: "character", n: "[where/tip from cache, under 180 chars]", land: "[Land]" }.';
        } else {
          system += '\n\nCHARACTER SCHEDULING (nice-to-have): Character meets are optional for this group. You MAY include one if it fits naturally near where the group already is, using type: "character" and only characters/locations from the cache above. Do not force it.';
        }
      }

// Issue 1: Inject dining intel with RESV= enforcement, dietary guard, retired blocklist
      let _diParsed = null;
      if (diningIntel && diningIntel.length > 20) {
        try { _diParsed = JSON.parse(diningIntel); } catch(e2) { _diParsed = null; }
      }
      const _diRetired = (_diParsed && _diParsed._retired) ? _diParsed._retired : [];
      const _diRules = (_diParsed && _diParsed._meta && _diParsed._meta.rules) ? _diParsed._meta.rules : [];
      const _diData = (_diParsed && _diParsed.data) ? _diParsed.data : diningIntel;
system += '\n\n=== VERIFIED DINING VENUES (AUTHORITATIVE SOURCE) ===';
      if (_diData && _diData.length > 20) {
system += '\nThe following is the ONLY authoritative list of dining venues. Use ONLY these names:';
system += '\n' + _diData;
      }
      if (_diRetired.length > 0) {
system += '\n\n=== RETIRED/CLOSED VENUES - NEVER MENTION ===';
system += '\nDo NOT suggest, name, or reference any of these venues: ' + _diRetired.join(', ');
      }
      if (_diRules.length > 0) {
system += '\n\n=== DINING RULES (MUST FOLLOW) ===';
      system += '\nMeals must be IN-PARK venues from the cache. Do not place hotel or Downtown Disney restaurants unless the trip config has a confirmed reservation there.';
system += '\n' + _diRules.join('\n');
      } else {
system += '\n\nRESV= ENFORCEMENT RULES:';
system += '\n- RESV=walkup: walk up any time. ONLY these venues fill a standard meal slot by default.';
system += '\n- RESV=required: NEVER schedule as default meal. Only include if trip config has a CONFIRMED reservation. Otherwise optional suggestion: reservation required, book ~60 days out on Disneyland app.';
system += '\n- RESV=recommended: may fill a meal slot but card must note wait risk and suggest booking ahead.';
system += '\n- RESV=never_meal: NEVER place in any meal slot. Only as optional experience if group already booked it.';
system += '\n- CACHE IS SINGLE SOURCE OF TRUTH: never name a venue or dish from training data, only from this file.';
      }
      const _hasDiet = tripConfig && tripConfig.groupProfile && tripConfig.groupProfile.dietary;
      const _dietNeeds = _hasDiet ? (Array.isArray(tripConfig.groupProfile.dietary) ? tripConfig.groupProfile.dietary : [tripConfig.groupProfile.dietary]) : [];
      if (_dietNeeds.length > 0) {
system += '\n\nDIETARY: Show VEG/VEGAN/GF ONLY for group needs: ' + _dietNeeds.join(', ') + '. Only show if venue cache entry explicitly has that field.';
      } else {
system += '\n\nDo NOT show dietary tags (VEG/VEGAN/GF) unless the group selected that dietary need.';
      }


      const _mh = (tripConfig && tripConfig.minHeight) || 'over48';
      if (_mh && _mh !== 'over48') {
        const _lbl = _mh === 'under40' ? 'under 40 inches' : (_mh === '40to46' ? '40-46 inches' : '46-48 inches');
        system += '\nGROUP HEIGHT CONSTRAINT: The shortest person in the group is ' + _lbl + '. For any attraction whose height requirement exceeds that, do NOT schedule it as a whole-group stop -- either skip it or schedule it as a rider swap and say so in the card note (n field). Never send the whole group to a ride the shortest member cannot board.';
      }

            // WDW contamination guard: rides/attractions/shows must be real Disneyland Resort ones (parallels dining governance)
      system += '\n\n=== ATTRACTION GOVERNANCE (MUST FOLLOW) ===';
      system += '\nEvery ride, attraction, and show you schedule MUST be a REAL, currently-operating Disneyland Resort attraction --- located in Disneyland Park or Disney California Adventure ONLY.';
      system += '\nNEVER schedule a Walt Disney World / Florida attraction or any attraction that does not exist at the Disneyland Resort. Do NOT invent attractions.';
      system += '\nSchedule ONLY attractions in the cache LAND MAP / WAIT PATTERNS. No Walt Disney World rides, no invented rides. Current names only (Tiana\'s Bayou Adventure, never Splash Mountain); never list the same ride twice.';
      system += '\nNEVER type a restaurant as a ride. A name like "Cinderella Royal Table", "Be Our Guest", "Blue Bayou", "Cafe Orleans" is DINING, never type:"ride". If it is a place to eat, it is a dining/quickservice/snack card, never a ride.';
      system += '\nThe LAND MAP and WAIT PATTERNS in the PARK INTELLIGENCE section above are the authoritative list of valid Disneyland Resort attractions. If an attraction is not consistent with that intelligence, do NOT schedule it.';

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

      system += '\n\n=== DINING SYSTEM RULES --- NEVER VIOLATE ===';
          system += '\n\nCONFIRMED RESERVATIONS --- FIXED ANCHORS:';
          const _resDetails = _allReservations.map(function(r) {
            if (!r || !r.name) return null;
            let d = r.name;
            if (r.time) d += ' at ' + r.time;
            if (r.day) d += ' (Day ' + r.day + ')';
            return d;
          }).filter(Boolean);
          system += '\nConfirmed: ' + (_resDetails.join('; ') || 'none');
          system += '\n\nCONFIRMED RESERVATION BLACKOUT RULE: When a confirmed dining reservation exists, that reservation IS the meal for that window. NEVER schedule any other restaurant, quick-service meal, or dining suggestion within ~2.5 hours of that reservation time. Do not offer alternatives for that meal slot. Example: if Cafe Orleans is confirmed at 7:00 PM, nothing else may be scheduled from 4:30 PM to 9:30 PM that day.';
          system += '\n\nQUICK SERVICE SUGGESTIONS (type: "quickservice"):';
          system += '\nAll AI-generated dining slots must use quick service restaurants ONLY.';
          system += '\nRULES:';
          system += '\n1. Never use the same restaurant more than once across the entire trip';
          system += '\n2. Never use any restaurant in the confirmed list above';
          system += '\n3. Never use table service restaurants as primary recommendations';
          system += '\n4. Always pick from venues in the VERIFIED DINING VENUES section above (from cache)';
          system += '\n5. You MAY mention a table service restaurant once per trip in a note line only --- one sentence maximum';
          system += '\n6. Already used dining venues this trip (DO NOT REPEAT ANY): ' + (allUsedDining.join(', ') || 'none');
          system += "\n7. PARK-SPECIFIC RULE: Only suggest restaurants physically located in the park the guest is currently in.";
          system += '\n8. NO REPEAT RULE (ABSOLUTE): Never use the same restaurant or snack location more than once across the ENTIRE trip.';
system += '\n9. CROSS-DAY CHECK: The already-used list in rule 6 contains venues from prior days. Never use any of them.';
          system += '\n\nQUICK SERVICE CARD SCHEMA: { t: "12:00 PM", h: "Rancho del Zocalo Restaurante", type: "quickservice", n: "Counter service Mexican food in Frontierland.", topPick: "Carne Asada Platter", veg: "Cheese Enchiladas", kids: "Kids Cheese Quesadilla", land: "Frontierland" }';
          system += '\n\nSNACK STOPS (type: "snack"):';
          system += '\nSNACK FREQUENCY RULES (ABSOLUTE):\n- Maximum ONE snack stop in the morning (before noon) per day\n- Maximum ONE snack stop in the afternoon (after noon) per day\n- NEVER place two snack cards consecutively with less than 2 hours between them';
          system += '\nSame no-repeat rule --- never the same snack location twice per trip.';
          system += '\nSNACK CARD SCHEMA: { t: "2:30 PM", h: "Afternoon Snack: Dole Whip", type: "snack", n: "Pineapple Dole Whip at the Tiki Juice Bar near the Enchanted Tiki Room.", land: "Adventureland" }';
          system += '\nCRITICAL: Snack cards MUST NOT include topPick, veg, or kids fields.';
          system += '\n\nAFTERNOON BREAK CARDS (type: "break"):';
          system += '\nAfternoon break notes should mention that this is also a good time for shopping.';

      system += '\n\n=== PARK ARRIVAL RULE ===';
          system += '\nArrival: 1 hour before park open (use PARK HOURS cache for exact open time).'; system += '\nPRE-OPEN HOUR IS POSITIONING ONLY: arrival, bag check/security, walk to rope-drop land, waiting at the rope. These are type: tip cards. NEVER schedule type: ride before park opens.'; system += '\nFIRST RIDE RULE (ABSOLUTE - DAYS OFTEN START TOO LATE): The first type:ride card MUST be at open-time + 5 minutes (e.g. 8:00 AM open -> first ride at 8:05 AM). Read actual open time from PARK HOURS cache. Never assume 8:00 AM. The first ride must NOT be an hour (or even 30 min) after open -- rope drop is the single most valuable low-wait window of the day and must not be wasted. After the first ride at open+5, continue rides every 15-30 min. Never place a ride before or at arrival time.'; system += '\nROPE-DROP VARIETY ACROSS DAYS (IMPORTANT): Do NOT make every day\'s rope-drop the same ride or the same strategy text. Vary the first ride by day based on the cache and which park you are in: e.g. one Disneyland day may rope-drop Rise of the Resistance, another may rope-drop Peter Pan\'s Flight or Space Mountain; a DCA day ropes Radiator Springs Racers. Each day\'s rope-drop tip must be specific to THAT day\'s park and priorities, not a copy of the previous day. If two days are in the same park, choose a different first ride or note why the same one repeats.';
          system += '\nROPE-DROP MUST BE A HEADLINER (DATA-DRIVEN): The rope-drop ride is the single most valuable low-wait window of the day -- spend it on a HIGH-DEMAND, high-wait headliner the WAIT PATTERNS cache shows builds long lines later (e.g. Rise of the Resistance, Space Mountain, Indiana Jones, Big Thunder, Radiator Springs Racers, Web Slingers, Guardians). NEVER waste rope drop on a low-wait ride like It\'s a Small World, Peter Pan can be an exception only if the cache shows it spikes early. Pick the rope-drop ride by the wait the cache reports, and make each day a DIFFERENT headliner from the prior day in that park.';
          system += '\nROPE-DROP BY PARK (EXPLICIT): On a DISNEY CALIFORNIA ADVENTURE (DCA) day, the rope-drop ride MUST be Radiator Springs Racers -- it is the single highest-demand ride at DCA and the rope-drop window saves the most time there. Do NOT rope-drop Incredicoaster or a lower-demand DCA ride. On a DISNEYLAND PARK day, the rope-drop ride should be Star Wars: Rise of the Resistance; if Rise was already the rope-drop on a prior Disneyland day, use the next-highest-demand headliner the cache shows (e.g. Space Mountain or Indiana Jones) -- not the same ride twice and not a low-wait ride.';

      system += '\n\n=== MORNING RHYTHM RULES --- REQUIRED ON ALL DAYS ===';
          system += '\nEvery day must include: (1) Arrival tip 60 min before open, (2) Rope drop / Lightning Lane tip, (3) First 2-3 rides, (4) MORNING SNACK between 9:00 AM and 10:30 AM, (5) RESTROOM BREAK (type: "break") before 10:30 AM, (6) Continue mid-morning rides.';
          system += '\nEXCEPTION (VIP DAY): The morning snack and restroom break are NOT required on a VIP day. If the VIP tour starts at or before 10:30 AM, DO NOT schedule a morning snack OR a restroom break at all -- they would land in the tour window, which is forbidden. Skip them entirely. Only schedule pre-tour rides/tips that fully complete BEFORE vipStart.';

      system += '\n\n=== VIP TOUR HOURS RULE (ABSOLUTE - OVERRIDES MORNING RHYTHM AND NO-GAPS RULES) ===';
          system += '\nOn a VIP day, the guide handles EVERYTHING from vipStart to vipEnd (read the exact times from the day config).';
          system += '\nDURING THE TOUR WINDOW (vipStart to vipEnd): schedule ABSOLUTELY NOTHING -- no rides, no meals, no snacks, no restroom breaks, no tips. The morning-rhythm rule and the no-gaps rule DO NOT APPLY inside this window. A large gap here is CORRECT and REQUIRED.';
          system += '\nInsert EXACTLY ONE card for the entire tour: { t: vipStart, h: "VIP Tour", type: "vip", n: "Your private guide handles all skip-the-line access from " + vipStart + " to " + vipEnd + ".", land: "" }. The start and end times go in the note.';
          system += '\nSTRUCTURAL RULE (self-check before returning): Across the ENTIRE day, the number of cards whose title (h) contains the word "Tour", "VIP", "Regroup", "Check-in", "Check-In", "Meet your guide", "Wrap", "Begins", "Ends", or "Complete" must be EXACTLY ONE -- the single "VIP Tour" card. If you count two or more, DELETE the extras. There is no regroup card, no check-in card, no completion card, no meet-the-guide card -- by ANY name or synonym. The tour is represented by ONE card, period.';
          system += '\nThe card at time vipEnd (or the first card after it) MUST be a real activity with type "ride", "dining", "quickservice", "snack", or "show" -- e.g. dinner or a ride. It must NOT be a tip/break/regroup card and must NOT mention the tour. Same for the card just before vipStart: a real pre-tour ride or arrival tip, not a tour-related card.';
          system += '\nBEFORE vipStart: schedule normally (arrival, rope drop, morning rides/snack) only if the park opens before the tour starts -- fit rides into that pre-tour window.';
          system += '\nAFTER vipEnd (CRITICAL - VIP DAYS UNDERFILL THE EVENING): The tour ending is NOT the end of the day. Resume FULL normal scheduling from vipEnd onward -- dinner, multiple evening rides, nighttime show, and MORE rides after the show. The SCHEDULE COMPLETENESS RULE below applies in full: the last activity must be within 30 min of actual park close. A VIP day that ends at 5 or 6 PM is WRONG -- the guest still has the whole evening in the park. Fill vipEnd-to-close exactly as densely as a normal day evening.';
          system += '\nThe single VIP card is the ONLY entry between vipStart and vipEnd. Never label meals or snacks as occurring during the VIP tour.';
          system += '\nNO CARD may have a time t that is >= vipStart AND < vipEnd, except the single VIP Tour card itself. This includes restroom breaks, snacks, hydration, regroup, and tips. A restroom break at 10:15 when the tour starts at 10:00 is a VIOLATION. The next card after the VIP Tour card must be at or after vipEnd.';

      system += '\n\n=== SCHEDULE COMPLETENESS RULE - STRICTLY ENFORCED ===';
system += '\nEvery day MUST have schedule entries from arrival time through ACTUAL PARK CLOSING TIME.';
system += '\nCheck PARK_HOURS in the TRIP CONTEXT section for the actual closing time.';
system += '\nDisneyland summer hours are typically 11:00 PM or midnight. DCA is typically 10:00 PM or 11:00 PM.';
system += '\nThe LAST scheduled activity must be within 30 minutes of park closing time.';
system += '\nAfter any nighttime show (fireworks, Fantasmic!, World of Color, Paint the Night):';
system += '\n  ALWAYS schedule 3-5 additional rides from show end until 30 min before close.';
system += '\n  NEVER end the schedule with a park exit or departure prep card while park is open 45+ more minutes.';
system += '\n  For 11 PM close: last activity must be 10:30 PM or later.';
system += '\n  For midnight close: last activity must be 11:30 PM or later.';
system += '\n  For 10 PM close: last activity must be 9:30 PM or later.';
system += '\nNEVER end a day at 8:50 PM or 9:00 PM unless that is confirmed park closing time from cache.';
          system += '\nEvery day MUST have schedule entries from arrival time through actual park closing time.';
          system += '\nNOTE LENGTH RULE (ABSOLUTE): Keep all note fields (n) under 180 characters — one or two concise sentences, and always finish the sentence (never cut off mid-word or mid-thought).';
          system += '\nCHARACTER ENCODING RULE: NEVER use special symbols, emoji, checkmarks, bullets, stars, or any non-ASCII characters in card titles (h field) or notes (n field). Use plain ASCII only.';

      // === PARK PRESENCE MODEL (ABSOLUTE - overrides Lightning Lane and ride/dining selection) ===
      system += '\n\n=== PARK PRESENCE MODEL (ABSOLUTE) ===';
      system += '\nAt every moment of the day the group is physically in EXACTLY ONE park (Disneyland Park OR Disney California Adventure). The guest cannot be in two parks at once and cannot bounce between parks for a single ride. Track the CURRENT PARK as the day progresses.';
      system += '\nEVERY ride, show, snack, dining, character meet, AND Lightning Lane booking you schedule at a given time MUST be located in the CURRENT PARK at that time. Never schedule an attraction or LL in the park the group is not currently in. Use the LAND MAP / cache to know which park each attraction and venue belongs to (e.g. Cozy Cone, Incredicoaster, Pixar Pier, Avengers Campus, Cars Land, San Fransokyo, Grizzly Peak = DCA; New Orleans Square, Fantasyland, Tomorrowland, Galaxy\'s Edge, Adventureland, Frontierland, Toontown, Main Street = Disneyland Park).';
      system += '\nLIGHTNING LANE IS SUBORDINATE TO PARK PRESENCE: only book an LL for a ride in the park the group is in (or will be in) at the LL return window. Never book an LL that would require being in the other park while the schedule has the group in this one. Park location decides the plan; LL fits around it, never the reverse.';

      if (tripConfig && tripConfig.parkHopping) {
              system += '\n\n=== PARK HOPPING (HOPPER TICKETS - CACHE-DRIVEN) ===';
              system += '\nThis group HAS park hopper tickets. Plan at least ONE hop. START at startPark and rope drop there.';
              system += '\nFIRST HOP TIMING IS DATA-DRIVEN: use the PARK HOP STRATEGY / crowd-flow cache to choose the hop window (typically when the first park\'s priority rides are done and the second park\'s waits/value are better). Do NOT invent an arbitrary time or hop on a feeling. If the cache gives no specific guidance, hop after the morning priorities (late morning / early afternoon) and say so plainly.';
              system += '\nAfter the hop, all rides/dining/LL must be in the SECOND park (per the PARK PRESENCE MODEL) until the next hop or end of day.';
              system += '\nLATE SECOND HOP (IMPORTANT): If the two parks have DIFFERENT closing times, do NOT end the night when the earlier-closing park closes. If the group is in the earlier-closing park and the OTHER park is still open 1-2 hours longer, hop back to the later-closing park and keep riding until ~30 min before ITS close. Leaving one park at night does NOT mean going home -- use the extra open hours in the other park. Use the PARK HOURS cache for both parks\' close times. This applies even if it means a second hop late in the evening.';
              system += '\nSchedule the final activity within ~30 min of the LATEST park close available to the group that day (whichever park is open latest).';
      } else {
              system += '\n\n=== SINGLE PARK (NO HOPPER) ===';
              system += '\nThis group does NOT have park hopper tickets for this day. The ENTIRE day is in startPark ONLY. Do NOT schedule any ride, show, snack, dining, character meet, or LL in the other park at any point. There is no hop. Every item from arrival to close is in startPark.';
      }
          console.log('[generateschedule] mode:', mode || 'default', 'char_priority:', charPriority);

      system += '\n\n=== NO GAPS RULE (ABSOLUTE) ===';
          system += '\nNever leave a gap longer than 45 minutes between consecutive schedule items.';

      system += '\n\n=== DINING PEAK HOURS RULE (ABSOLUTE) ===';
system += '\nNever schedule any QS meal or sit-down dining between 12:00 PM and 1:30 PM (peak lunch rush).';
system += '\nNever schedule any QS meal or sit-down dining between 5:30 PM and 7:30 PM (peak dinner rush).';
system += '\nLUNCH windows: 11:00 AM-11:45 AM (early) OR 1:30 PM-2:30 PM (late).';
system += '\nDINNER windows: 4:30 PM-5:30 PM (early) OR 7:30 PM-9:00 PM (late).';
      system += '\n\nMeal titles name the venue: "Dinner: Cafe Orleans", never a bare "Dinner" or "Early Dinner".';
system += '\nCONSISTENCY RULE (ABSOLUTE): The meal time and meal note MUST agree. If the note says to avoid the 6-7 PM rush, the card time MUST be before 5:30 PM or after 7:30 PM. Never schedule a meal at 6:15 PM with a note warning about 6 PM crowds.';
          system += '\nTIME BOUNDS RULE (ABSOLUTE):\nNever schedule any item before 7:00 AM or after park close.\n\nLIGHTNING LANE REMINDER CARDS (REQUIRED):\nEvery schedule must include Lightning Lane reminder tip cards throughout the day. Include:\n1. Opening LL tip (7:00-7:30 AM)\n2. Second booking reminder (~10:00 AM)\n3. Afternoon check (~1:30-2:00 PM)\n4. Final window (~4:00 PM)';
          system += '\n\nLIGHTNING LANE CARD SCHEMA (REQUIRED): Every LL booking tip card MUST include the ll field. Use this schema: { "t": "9:00 AM", "h": "Book [Ride Name] via Lightning Lane", "type": "tip", "land": "[Land Name]", "n": "Book now - return window typically X:XX PM", "ll": { "t": "multi", "a": "Book [Ride] LLMP now - return ~X:XX PM" }, "ride": "[Exact Ride Name]" }';
          system += '\nFor paid Individual Lightning Lane: use ll.t = "single". For LLMP: use ll.t = "multi".';
          system += '\nLL PRIORITY (DATA-DRIVEN): Spend Lightning Lane on the HIGHEST-WAIT, highest-demand rides the WAIT PATTERNS cache shows -- the headliners where LL saves the most time (e.g. the big coasters, Rise of the Resistance, Radiator Springs Racers, Indiana Jones, Web Slingers). Do NOT spend an LL on a low-wait ride the cache shows is usually a short standby (e.g. Jungle Cruise, small Fantasyland dark rides) -- those are better as walk-ons or short standby waits. Choose each LL by the actual wait the cache reports, never at random. Do not book an LL for a ride you already rope-dropped.';
          system += '\nRise of the Resistance and Radiator Springs Racers are Single Pass (ll.t="single"); every other LL ride is Multi Pass (ll.t="multi").';
          system += '\nIf tripConfig shows hasLL: false or no Lightning Lane for this day, do NOT generate LL cards and do NOT include ll fields on any item.';

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
              body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', temperature: 0, max_tokens: maxTokens, system: _system, messages: [{ role: 'user', content: 'Fill every slot in the skeleton now. Return ONLY the JSON array of slot objects, one per slot id, same order.' }] })
            });
            const d = await r.json();
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
          const _illRideKeys = (function () {
            const raw = _day.illRides;
            const names = Array.isArray(raw) ? raw.map(s => String(s || '').trim()).filter(Boolean)
              : (typeof raw === 'string' && raw.trim()) ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
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
          return res.status(200).json({ ok: true, scaffold: true, text: _r.text, parsed: _items, model: _r.model, skeletonSlots: _sk.slots.length, rideSlots: _sk.slots.filter(s => s.type === 'ride').length, report: _ap.report, verifyRemoved: _vf.removed, verifyMutations: _mutations, paramViolations: _violations, paramFixed: _enf.fixed, paramUnfixable: _enf.unfixable, paramBlocked: _enf.blocked || [], unplacedMustDos: unplacedMustDos, coverage: _coverage ? { reserved: _coverage.assignments, unreserved: _coverage.unreserved } : null, coverageInsights: _coverage ? _coverage.insights : [], reservationAnchors: _resvPlan ? _resvPlan.anchors : [], reservationConflicts: _resvPlan ? _resvPlan.conflicts : [], dietaryConflicts: _dietaryConflicts, dayConflicts: _dayConflicts, proseVenueFlags: proseVenueFlags });
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

      // ============================================================
      // LEGACY GENERATOR -- RETIRED Oct 7, 2026: UNREACHABLE.
      // The scaffold block above returns on success (200) and on error
      // (502 safe failure), so control never reaches this code. Kept
      // in-file for a later cleanup commit. Also noted for that cleanup:
      // the legacy prompt assembly ABOVE the scaffold block (system /
      // park-intel context building) still executes per request; its
      // outputs now feed nothing but this dead block.
      // ============================================================
      // -- B: Model is hardcoded --- never use req.body.model or any client value
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
              signal: controller.signal,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', temperature: 0, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt.substring(0, 8000) }] })
      });

      const data = await anthropicRes.json();
          if (data.error) return res.status(500).json({ error: data.error.message });

      let text = '';
          for (const block of (data.content || [])) {
                  if (block.type === 'text') text += block.text;
          }

      if (!text) return res.status(200).json({ error: 'Empty response', stop_reason: data.stop_reason });

      const parsed = extractJSON(text);

      if (parsed && Array.isArray(parsed)) {
              try {
                        const safeConfig = tripConfig || {};
                        const _day0 = (safeConfig.days && safeConfig.days[0]) || {};
                        const _dayPark = _day0.park || 'Disneyland';
                        // Parse close times from PARK_HOURS cache text (generic, any trip). Returns minutes-since-midnight.
                        const _toMin = (h, mm, mer) => { let hh = parseInt(h, 10); const pm = /pm/i.test(mer); if (pm && hh !== 12) hh += 12; if (!pm && hh === 12) hh = 0; return hh * 60 + (mm ? parseInt(mm, 10) : 0); };
                        const _hoursTxt = (cacheCtx.PARK_HOURS || '');
                        function _closeFor(parkRe) {
                          // find a line mentioning the park, take its closing time. Handle 'midnight' word and 12:00 AM (=end-of-day 1440).
                          const lines = _hoursTxt.split(/\n/);
                          for (const ln of lines) {
                            if (!parkRe.test(ln)) continue;
                            if (/midnight/i.test(ln)) return 24 * 60;
                            const times = [...ln.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM|noon)/gi)];
                            if (times.length) {
                              const t = times[times.length - 1];
                              if (/noon/i.test(t[3])) return 12 * 60;
                              let mins = _toMin(t[1], t[2], t[3]);
                              if (mins === 0) mins = 24 * 60; // 12:00 AM as a CLOSING time = end-of-day midnight
                              return mins;
                            }
                          }
                          return null;
                        }
                        const _dlClose = _closeFor(/disneyland|\bDL\b/i);
                        const _dcaClose = _closeFor(/california adventure|\bDCA\b/i);
                        const _isDca = /california|dca|adventure/i.test(_dayPark);
                        const _myClose = _isDca ? _dcaClose : _dlClose;
                        const _bothMax = [_dlClose, _dcaClose].filter(x => typeof x === 'number');
                        const _latest = _bothMax.length ? Math.max(..._bothMax) : null;
                        const _dayObj = { items: parsed, park: _dayPark };
                        if (typeof _myClose === 'number') _dayObj.closeMin = _myClose;
                        // latestCloseMin only matters for hoppers (late second hop to later-closing park)
                        if (safeConfig.parkHopping && typeof _latest === 'number') _dayObj.latestCloseMin = _latest;
                        if (typeof _dlClose === 'number' && _dlClose > 0) _dayObj.dlCloseMin = _dlClose;
                        if (typeof _dcaClose === 'number' && _dcaClose > 0) _dayObj.dcaCloseMin = _dcaClose;
                        console.log('[generateschedule] close times -> DL:', _dlClose, 'DCA:', _dcaClose, 'dayPark:', _dayPark, 'closeMin:', _dayObj.closeMin, 'latestCloseMin:', _dayObj.latestCloseMin);
                        const singleDaySchedule = { days: [_dayObj] };
                        const closedFromCache = parseClosedFromCache(cacheCtx.CURRENT_CLOSURES || '');
                        console.log('[generateschedule] closed from cache:', JSON.stringify(closedFromCache));
                        const valResult = validateSchedule(singleDaySchedule, safeConfig, closedFromCache, allUsedDining);
                        const validatedItems = valResult.schedule.days[0].items;
                        if (valResult.corrections && valResult.corrections.length > 0) {
                                    console.log('[generateschedule] validator corrections:', JSON.stringify(valResult.corrections));
                        }
                        if (valResult.hardViolations && valResult.hardViolations.length > 0) {
                                    console.warn('[generateschedule] validator hard violations:', JSON.stringify(valResult.hardViolations));
                        }
                        return res.status(200).json({ ok: true, text, parsed: validatedItems, model: data.model });
              } catch (valErr) {
                        console.error('[generateschedule] validator error:', valErr.message);
              }
      }
          return res.status(200).json({ ok: true, text, parsed, model: data.model });

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
