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
  const MAX_REQUEST_SIZE = 10000;
    if (JSON.stringify(req.body).length > MAX_REQUEST_SIZE) {
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
    const timeout = setTimeout(() => controller.abort(), 30000);
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
                       'LIGHTNING_LANE_STRATEGY', 'DINING_TIMING', 'CROWD_FLOW'],
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

      const parkIntelContext = [
              'LAND MAP:\n' + landMap,
              'WAIT PATTERNS:\n' + waitPatterns,
              'ROPE DROP STRATEGY:\n' + ropeDrop,
              'LIGHTNING LANE STRATEGY:\n' + llStrategy,
              'DINING TIMING:\n' + diningTiming,
              'CROWD FLOW:\n' + crowdFlow,
              'CURRENT CLOSURES:\n' + closures,
              'SPECIAL EVENTS:\n' + specialEvts,
              'TRIP CONTEXT:\n' + tripCtx
            ].join('\n\n');

      const charIntel = await getCharacterIntel(4000);
          const charContext = buildCharacterContext(charIntel, tripConfig, 4000);
          const charPriority = (tripConfig && tripConfig.characters && tripConfig.characters.priority) || 'niceToHave';

      let system = 'You are a Disneyland and Disney California Adventure theme park scheduling expert with deep knowledge of wait time patterns, rope drop strategies, and crowd flow. Generate detailed, realistic day schedules in valid JSON only. No markdown, no explanation, just JSON.';

      system += '\n\n=== CURRENT PARK INTELLIGENCE (use this --- do not search the web) ===\n' + parkIntelContext;

      if (charContext) {
              system += '\n\n=== ' + charContext + ' ===';
              system += '\n\nCHARACTER MEET SCHEDULING RULES:';
              system += '\n- Character priority for this trip: ' + charPriority;
              if (charPriority === 'mustDo') {
                        system += '\n- mustDo: Insert matching character meets even if a ride must be moved to accommodate. Do NOT skip any character whose category matches the trip preferences.';
              } else {
                        system += '\n- niceToHave: Insert character meets only at natural gaps (20+ min free between scheduled items). Never displace a ride entry to fit a character meet.';
              }
              system += '\n- NEVER schedule a character meet outside their typicalWindows (appearance window).';
              system += '\n- NEVER place a character meet over a dining reservation, Lightning Lane Single Pass entry, or paid experience.';
              system += '\n- One character meet per gap maximum --- never stack multiple meets back to back.';
              system += '\n- Character meet schedule entry schema: { "t": "H:MM AM", "h": "Character Name", "type": "character", "n": "Location, Land --- Window start---end", "land": "Land Name", "typicalWait": 25, "vipAccessible": true, "disclaimer": true }';
              system += '\n- The "n" field must combine location and appearance window as one string.';
              system += '\n- Set disclaimer: true on all character entries so the app shows the schedule-change warning.';
      }

      if (ridePrefsContext) {
              system += '\n\nGUEST RIDE PREFERENCES:';
              if (mustDo.length) {
                        system += '\n\n=== MUST-DO RIDES (NON-NEGOTIABLE ANCHORS) ===';
                        system += '\nEvery must-do ride MUST appear in the schedule. Cannot be removed.';
                        system += '\nMust Do: ' + mustDo.join(', ');
                        system += '\nWant To Do (if time allows): ' + (wantToDo.length ? wantToDo.join(', ') : 'all others');
                        system += '\nSkip (NEVER schedule): ' + (skipRides.length ? skipRides.join(', ') : 'none');
                        const riseInMust = mustDo.includes('Rise of the Resistance');
                        const peterInMust = mustDo.includes("Peter Pan's Flight");
                        let ropeDropGuide = '';
                        if (riseInMust && peterInMust) {
                                    ropeDropGuide = 'Rise of the Resistance rope drop first. Peter Pan in 4-6 PM lull.';
                        } else if (riseInMust) {
                                    ropeDropGuide = "Rope drop Galaxy's Edge: Rise of the Resistance first, Smugglers Run second.";
                        } else if (peterInMust) {
                                    ropeDropGuide = "Rope drop Fantasyland: Peter Pan's Flight first.";
                        } else {
                                    ropeDropGuide = 'Rope drop toward land with highest concentration of must-do rides.';
                        }
                        system += '\nROPE DROP FOR THIS GROUP: ' + ropeDropGuide;
              } else if (skipRides.length) {
                        system += '\nSkip list (NEVER schedule): ' + skipRides.join(', ');
              }
      }
          system += '\n\n=== STRICT CONTENT RULES --- NEVER VIOLATE ===';
          system += '\n1. Only schedule activities that are: (a) explicitly in the trip config, (b) real attractions verified in the park_intel cache, or (c) standard park activities (rides, dining, shows, photo ops, snack stops, tip cards, restroom breaks).';
          system += '\n2. NEVER invent tour packages, special experiences, or paid add-ons not in the trip config.';
          system += '\n3. NEVER schedule behind-the-scenes experiences, private tours, or special-access events that the user did not select during onboarding.';
          system += '\n4. When uncertain, schedule a standard ride, dining suggestion, or tip card --- never invent a special experience.';

      system += '\n\n=== CURRENT RIDE CLOSURES --- DO NOT SCHEDULE ===';
          system += '\nThe following attractions are currently closed for refurbishment. NEVER schedule them as ride cards:';
          system += '\n- Pirates of the Caribbean (DL) - closed for refurbishment, reopens TBD';
          system += '\n- Buzz Lightyear Astro Blasters (DL) - closed since April 2025';
          system += '\n- Inside Out Emotional Whirlwind (DCA) - closed for refurbishment';
          system += '\n- Silly Symphony Swings (DCA) - closed since April 27 2025';
          system += "\nRIDE RENAME: Splash Mountain no longer exists. It is now Tiana's Bayou Adventure and is fully open. Never reference Splash Mountain anywhere in the schedule.";
          system += '\nThe CURRENT CLOSURES section above contains a full updated list of all closed attractions. Every ride listed there is unavailable. NEVER schedule a closed ride even if the user selected it as a must-do. Instead, insert a tip card explaining it is closed and suggesting the best alternative.';

      system += '\n\n=== CONFIRMED RESERVATION ANCHOR RULE --- STRICTLY ENFORCED ===';
          system += '\nConfirmed reservations from tripConfig.dining.reservations MUST appear in the schedule as type:"dining" cards at the exact time specified.';

      system += '\n\n=== NOTE QUALITY STANDARD --- EVERY CARD MUST MEET THIS BAR ===';
          system += '\nEvery card note (field "n") must include: (1) WHY this activity at this specific time, (2) GROUP-SPECIFIC CONTEXT, (3) PRACTICAL DETAIL. At least 2-3 sentences.';

      const confirmedRestaurants = (tripConfig && tripConfig.dining && tripConfig.dining.reservations
                                          ? tripConfig.dining.reservations : [])
            .map(function(r) { return r && r.name ? r.name : null; })
            .filter(Boolean);
          console.log('[generateschedule] confirmedRestaurants:', JSON.stringify(confirmedRestaurants));
          console.log('[generateschedule] tripConfig.dining:', JSON.stringify(tripConfig && tripConfig.dining));

      if (tripConfig && !tripConfig._usedQuickService) tripConfig._usedQuickService = [];
          const usedQS = (tripConfig && tripConfig._usedQuickService) || [];

      system += '\n\n=== DINING SYSTEM RULES --- NEVER VIOLATE ===';
          system += '\n\nCONFIRMED RESERVATIONS --- FIXED ANCHORS:';
          system += '\nConfirmed: ' + (confirmedRestaurants.join(', ') || 'none');
          system += '\n\nQUICK SERVICE SUGGESTIONS (type: "quickservice"):';
          system += '\nAll AI-generated dining slots must use quick service restaurants ONLY.';
          system += '\nRULES:';
          system += '\n1. Never use the same restaurant more than once across the entire trip';
          system += '\n2. Never use any restaurant in the confirmed list above';
          system += '\n3. Never use table service restaurants as primary recommendations';
          system += '\n4. Always pick from quick service options in the DINING TIMING section of the cache';
          system += '\n5. You MAY mention a table service restaurant once per trip in a note line only --- one sentence maximum';
          system += '\n6. Already used quick service restaurants this trip: ' + (usedQS.join(', ') || 'none');
          system += "\n7. PARK-SPECIFIC RULE: Only suggest restaurants physically located in the park the guest is currently in.";
          system += '\n8. NO REPEAT RULE (ABSOLUTE): Never use the same restaurant or snack location more than once across the ENTIRE trip.';
          system += '\n\nQUICK SERVICE CARD SCHEMA: { t: "12:00 PM", h: "Rancho del Zocalo Restaurante", type: "quickservice", n: "Counter service Mexican food in Frontierland.", topPick: "Carne Asada Platter", veg: "Cheese Enchiladas", kids: "Kids Cheese Quesadilla", land: "Frontierland" }';
          system += '\n\nSNACK STOPS (type: "snack"):';
          system += '\nSNACK FREQUENCY RULES (ABSOLUTE):\n- Maximum ONE snack stop in the morning (before noon) per day\n- Maximum ONE snack stop in the afternoon (after noon) per day\n- NEVER place two snack cards consecutively with less than 2 hours between them';
          system += '\nSame no-repeat rule --- never the same snack location twice per trip.';
          system += '\nSNACK CARD SCHEMA: { t: "2:30 PM", h: "Afternoon Snack: Dole Whip", type: "snack", n: "Pineapple Dole Whip at the Tiki Juice Bar near the Enchanted Tiki Room.", land: "Adventureland" }';
          system += '\nCRITICAL: Snack cards MUST NOT include topPick, veg, or kids fields.';
          system += '\n\nAFTERNOON BREAK CARDS (type: "break"):';
          system += '\nAfternoon break notes should mention that this is also a good time for shopping.';

      system += '\n\n=== PARK ARRIVAL RULE ===';
          system += '\nAlways schedule guests to arrive 60 minutes (1 hour) before official park opening.';

      system += '\n\n=== MORNING RHYTHM RULES --- REQUIRED ON ALL DAYS ===';
          system += '\nEvery day must include: (1) Arrival tip 60 min before open, (2) Rope drop / Lightning Lane tip, (3) First 2-3 rides, (4) MORNING SNACK between 9:00 AM and 10:30 AM, (5) RESTROOM BREAK (type: "break") before 10:30 AM, (6) Continue mid-morning rides.';

      system += '\n\n=== VIP TOUR HOURS RULE ===';
          system += '\nOn VIP days, the guide handles ALL attractions from vipStart to vipEnd.';
          system += '\nFor Day 2 (VIP day, 10:00 AM to 5:00 PM tour):';
          system += '\nDURING TOUR HOURS (10:00 AM to 5:00 PM): Do NOT schedule any ride cards. DO include a single VIP tour block entry at 10:00 AM: { t: "10:00 AM", h: "VIP Tour Begins", type: "vip", n: "Your guide takes over. Skip-the-line access for all major attractions.", land: "Disneyland" }';

      system += '\n\n=== SCHEDULE COMPLETENESS RULE - STRICTLY ENFORCED ===';
          system += '\nEvery day MUST have schedule entries from arrival time through actual park closing time.';
          system += '\nNOTE LENGTH RULE (ABSOLUTE): Keep all note fields (n) under 80 characters. One concise sentence only.';
          system += '\nCHARACTER ENCODING RULE: NEVER use special symbols, emoji, checkmarks, bullets, stars, or any non-ASCII characters in card titles (h field) or notes (n field). Use plain ASCII only.';

      if (tripConfig && tripConfig.parkHopping) {
              system += '\n\n=== PARK HOPPING RULE ===';
              system += '\nThis group has park hopper tickets. Build the schedule to include a second park visit in the afternoon or evening.';
              system += '\nDay 1 (starts Disneyland): hop to DCA after 5:00 PM.';
              system += '\nDay 3 (starts DCA): hop to Disneyland around 3:00-4:00 PM.';
              system += '\nDay 2 (VIP Tour): no park hop needed.';
      }
          console.log('[generateschedule] mode:', mode || 'default', 'char_priority:', charPriority);

      system += '\n\n=== NO GAPS RULE (ABSOLUTE) ===';
          system += '\nNever leave a gap longer than 45 minutes between consecutive schedule items.';

      system += '\n\n=== DINING PEAK HOURS RULE (ABSOLUTE) ===';
          system += '\nNever schedule any QS meal between 12:00 PM and 1:00 PM. Lunch: schedule at 11:00-11:45 AM or 1:15-2:00 PM only.\n\nTIME BOUNDS RULE (ABSOLUTE):\nNever schedule any item before 7:00 AM or after park close.\n\nLIGHTNING LANE REMINDER CARDS (REQUIRED):\nEvery schedule must include Lightning Lane reminder tip cards throughout the day. Include:\n1. Opening LL tip (7:00-7:30 AM)\n2. Second booking reminder (~10:00 AM)\n3. Afternoon check (~1:30-2:00 PM)\n4. Final window (~4:00 PM)';
          system += '\n\nLIGHTNING LANE CARD SCHEMA (REQUIRED): Every LL booking tip card MUST include the ll field. Use this schema: { "t": "9:00 AM", "h": "Book [Ride Name] via Lightning Lane", "type": "tip", "land": "[Land Name]", "n": "Book now - return window typically X:XX PM", "ll": { "t": "multi", "a": "Book [Ride] LLMP now - return ~X:XX PM" }, "ride": "[Exact Ride Name]" }';
          system += '\nFor paid Individual Lightning Lane: use ll.t = "single". For LLMP: use ll.t = "multi".';
          system += '\nIf tripConfig shows hasLL: false or no Lightning Lane for this day, do NOT generate LL cards and do NOT include ll fields on any item.';

      // -- B: Model is hardcoded — never use req.body.model or any client value
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
                        const singleDaySchedule = { days: [{ items: parsed, park: (safeConfig.days && safeConfig.days[0] && safeConfig.days[0].park) || 'Disneyland' }] };
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

handler.config = { maxDuration: 30 };
