// api/generateschedule.js
// Routes generateFromSetup and aiChooseRides through Vercel with new two-cache section injection
import { list } from '@vercel/blob';
import { validateSchedule, parseClosedFromCache } from './validate-schedule.js';

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
                          ['CURRENT_CLOSURES', 'TRIP_CONTEXT', 'CURRENT_LL_PRICING', 'SPECIAL_EVENTS'].forEach(name => {
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

  return results;
}

// --------- Character intel (unchanged) -----------------------------------------------
async function getCharacterIntel(maxChars = 4000) {
    try {
          const { blobs } = await list({ prefix: 'twize/character_intel.json' });
          if (!blobs || blobs.length === 0) return null;
          const fetchUrl = blobs[0].downloadUrl || blobs[0].url;
          const parsed = await fetch(fetchUrl).then(r => r.json());
          if (!parsed || !parsed.data) return null;
          const dataObj = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data;
          const disclaimer = dataObj.disclaimer || 'Character schedules are planned in advance but can change without notice. Check with a cast member on the day.';
          const characters = Array.isArray(dataObj.characters) ? dataObj.characters : [];
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
  const _adminKey = (process.env.ADMIN_KEY || 'CWdis2026admin').toLowerCase();
    const _sentAdmin = (req.headers['x-admin-key'] || req.body && req.body.adminKey || '').toLowerCase();
    const _tripCode = (req.body && req.body.tripCode) || req.headers['x-trip-code'] || '';
    const _isAdmin = _sentAdmin === _adminKey;
    const _isValidTrip = _tripCode && typeof _tripCode === 'string' && _tripCode.length >= 8;
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
          const skipRides = rp.skip || [];
          const ridePrefsContext = mustDo.length || skipRides.length ? [
                  'GUEST RIDE PREFERENCES:',
                  'Must Do (non-negotiable): ' + (mustDo.length ? mustDo.join(', ') : 'none'),
                  'Want To Do (if time allows): ' + (wantToDo.length ? wantToDo.join(', ') : 'all others'),
                  'Skip (never include): ' + (skipRides.length ? skipRides.join(', ') : 'none')
                ].join('\n') : '';
          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (!apiKey) return res.status(500).json({ error: 'No API key' });
          if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

      const cacheCtx = await buildCacheContext(
              ['LAND_MAP', 'WAIT_PATTERNS', 'ROPE_DROP_STRATEGY',
                       'LIGHTNING_LANE_STRATEGY', 'DINING_TIMING', 'CROWD_FLOW',
      'PARK_HOURS', 'PARK_HOP_STRATEGY'],
              true
            );
          console.log('[generateschedule] cacheCtx sections:', Object.keys(cacheCtx));
          const sectionCount = Object.keys(cacheCtx).length;
          console.log('cache_sections:', Object.keys(cacheCtx).join(','));
          if (sectionCount < 6) {
                  console.error('[generateschedule] CACHE EMPTY - aborting AI call. Got', sectionCount, 'sections, need 6');
                  return res.status(503).json({ error: 'Park intelligence cache unavailable. Please try again.', cache_sections: Object.keys(cacheCtx), sections_found: sectionCount });
          }

      const landMap = (cacheCtx.LAND_MAP || '').substring(0, 800);
          const waitPatterns = (cacheCtx.WAIT_PATTERNS || '').substring(0, 1200);
          const ropeDrop = (cacheCtx.ROPE_DROP_STRATEGY || '').substring(0, 800);
          const llStrategy = (cacheCtx.LIGHTNING_LANE_STRATEGY || '').substring(0, 600);
          const diningTiming = (cacheCtx.DINING_TIMING || '').substring(0, 600);
          const crowdFlow = (cacheCtx.CROWD_FLOW || '').substring(0, 500);
          const closures = (cacheCtx.CURRENT_CLOSURES || '').substring(0, 1000);
          const specialEvts = (cacheCtx.SPECIAL_EVENTS || '').substring(0, 300);
          const tripCtx = (cacheCtx.TRIP_CONTEXT || '').substring(0, 600);
const parkHours = (cacheCtx.PARK_HOURS || '').substring(0, 800);
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
          system += '\n\nCHARACTER SCHEDULING (MUST-DO): The group has marked character meets as a MUST-DO priority. You MUST schedule at least one character meet card on each day from the CHARACTER MEETS list above, matching the family\'s selected categories, in the correct park for that day. Use type: "character". Place each meet at a sensible time/land based on the cache windows (e.g. Galaxy\'s Edge for Star Wars, Town Square/Toontown for classic). NEVER invent a character or location not in the cache. Card schema: { t: "11:00 AM", h: "Meet [Character]", type: "character", n: "[where/tip from cache, under 80 chars]", land: "[Land]" }.';
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
          system += '\nNOTE LENGTH RULE (ABSOLUTE): Keep all note fields (n) under 80 characters. One concise sentence only.';
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
          system += '\nRise of the Resistance and Radiator Springs Racers are Single Pass (ll.t="single"); every other LL ride is Multi Pass (ll.t="multi").';
          system += '\nIf tripConfig shows hasLL: false or no Lightning Lane for this day, do NOT generate LL cards and do NOT include ll fields on any item.';

      // -- B: Model is hardcoded --- never use req.body.model or any client value
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
              signal: controller.signal,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt.substring(0, 8000) }] })
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
                        console.log('[generateschedule] close times -> DL:', _dlClose, 'DCA:', _dcaClose, 'dayPark:', _dayPark, 'closeMin:', _dayObj.closeMin, 'latestCloseMin:', _dayObj.latestCloseMin);
                        const singleDaySchedule = { days: [_dayObj] };
                        const closedFromCache = parseClosedFromCache(cacheCtx.CURRENT_CLOSURES || '');
                        console.log('[generateschedule] closed from cache:', JSON.stringify(closedFromCache));
                        const valResult = validateSchedule(singleDaySchedule, safeConfig, closedFromCache);
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

handler.config = { maxDuration: 90 };
