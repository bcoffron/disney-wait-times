// api/generateschedule.js
// Routes generateFromSetup and aiChooseRides through Vercel with new two-cache section injection
const { list } = require('@vercel/blob');
const { validateSchedule } = require('./validate-schedule');

// âââ buildCacheContext ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function buildCacheContext(sectionNames, includeDynamic = false) {
  const results = {};

  try {
    const { blobs: sb } = await list({ prefix: 'twize/park_intel_dl_stable.json' });
    if (sb && sb.length) {
      const fetchUrl = sb[0].downloadUrl || sb[0].url;
      const stableData = await fetch(fetchUrl).then(r => r.json());
      const sections = stableData.sections || {};
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
        const sections = dynamicData.sections || {};
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

// âââ Character intel (unchanged) âââââââââââââââââââââââââââââââââââââââââââââ
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
  const full = 'CHARACTER INTEL (from cache â do not fabricate):\nDisclaimer: ' + disclaimer + '\n\nAvailable characters matching trip preferences:\n' + body;
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt, mode, maxTokens = 6000, tripConfig } = req.body || {};

// ── Build ride preferences context ───────────────────────────────────────────
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

    // ââ Build cache context from new two-cache architecture ââââââââââââââââââ
    const cacheCtx = await buildCacheContext(
      ['LAND_MAP', 'WAIT_PATTERNS', 'ROPE_DROP_STRATEGY',
       'LIGHTNING_LANE_STRATEGY', 'DINING_TIMING', 'CROWD_FLOW'],
      true // include dynamic
    );
    console.log('[generateschedule] cacheCtx sections:', Object.keys(cacheCtx));

    // ââ Slice each section to target ~6,000 chars total ââââââââââââââââââââââ
    const landMap      = (cacheCtx.LAND_MAP                || '').substring(0, 800);
    const waitPatterns = (cacheCtx.WAIT_PATTERNS           || '').substring(0, 1200);
    const ropeDrop     = (cacheCtx.ROPE_DROP_STRATEGY      || '').substring(0, 800);
    const llStrategy   = (cacheCtx.LIGHTNING_LANE_STRATEGY || '').substring(0, 600);
    const diningTiming = (cacheCtx.DINING_TIMING           || '').substring(0, 600);
    const crowdFlow    = (cacheCtx.CROWD_FLOW              || '').substring(0, 500);
    const closures     = (cacheCtx.CURRENT_CLOSURES        || '').substring(0, 400);
    const specialEvts  = (cacheCtx.SPECIAL_EVENTS          || '').substring(0, 300);
    const tripCtx      = (cacheCtx.TRIP_CONTEXT            || '').substring(0, 600);

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

    // ââ Character intel (unchanged) ââââââââââââââââââââââââââââââââââââââââââ
    const charIntel = await getCharacterIntel(4000);
    const charContext = buildCharacterContext(charIntel, tripConfig, 4000);
    const charPriority = (tripConfig && tripConfig.characters && tripConfig.characters.priority) || 'niceToHave';

    // ââ Build system prompt âââââââââââââââââââââââââââââââââââââââââââââââââââ
    let system = 'You are a Disneyland and Disney California Adventure theme park scheduling expert with deep knowledge of wait time patterns, rope drop strategies, and crowd flow. Generate detailed, realistic day schedules in valid JSON only. No markdown, no explanation, just JSON.';

    system += '\n\n=== CURRENT PARK INTELLIGENCE (use this â do not search the web) ===\n' + parkIntelContext;

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
      system += '\n- One character meet per gap maximum â never stack multiple meets back to back.';
      system += '\n- Character meet schedule entry schema: { "t": "H:MM AM", "h": "Character Name", "type": "character", "n": "Location, Land Â· Window startâend", "land": "Land Name", "typicalWait": 25, "vipAccessible": true, "disclaimer": true }';
      system += '\n- The "n" field must combine location and appearance window as one string.';
      system += '\n- Set disclaimer: true on all character entries so the app shows the schedule-change warning.';
    }

    // ── Ride preferences context injection ─────────────────────────────────────
    if (ridePrefsContext) {
      system += '\n\nGUEST RIDE PREFERENCES:';
      if (mustDo.length) {
        system += '\n\n=== MUST-DO RIDES (NON-NEGOTIABLE ANCHORS) ===';
        system += '\nEvery must-do ride MUST appear in the schedule. Cannot be removed.';
        system += '\nMust Do: ' + mustDo.join(', ');
        system += '\nWant To Do (if time allows): ' + (wantToDo.length ? wantToDo.join(', ') : 'all others');
        system += '\nSkip (NEVER schedule): ' + (skipRides.length ? skipRides.join(', ') : 'none');
        const riseInMust = mustDo.includes('Rise of the Resistance');
        const peterInMust = mustDo.includes("Peter Pan\'s Flight");
        let ropeDropGuide = '';
        if (riseInMust && peterInMust) {
          ropeDropGuide = 'Rise of the Resistance rope drop first. Peter Pan in 4-6 PM lull.';
        } else if (riseInMust) {
          ropeDropGuide = 'Rope drop Galaxy\'s Edge: Rise of the Resistance first, Smugglers Run second.';
        } else if (peterInMust) {
          ropeDropGuide = 'Rope drop Fantasyland: Peter Pan\'s Flight first.';
        } else {
          ropeDropGuide = 'Rope drop toward land with highest concentration of must-do rides.';
        }
        system += '\nROPE DROP FOR THIS GROUP: ' + ropeDropGuide;
      } else if (skipRides.length) {
        system += '\nSkip list (NEVER schedule): ' + skipRides.join(', ');
      }
    }
       system += '\n\n=== STRICT CONTENT RULES â NEVER VIOLATE ===';
    system += '\n1. Only schedule activities that are: (a) explicitly in the trip config, (b) real attractions verified in the park_intel cache, or (c) standard park activities (rides, dining, shows, photo ops, snack stops, tip cards, restroom breaks).';
    system += '\n2. NEVER invent tour packages, special experiences, or paid add-ons not in the trip config. Do not add VIP tours, bio tours, backstage tours, Keys to the Kingdom, or any paid tour product unless it appears explicitly in tripConfig.lightningLane.singlePass or tripConfig.dining.reservations.';
    system += '\n3. NEVER schedule behind-the-scenes experiences, private tours, or special-access events that the user did not select during onboarding.';
    system += '\n4. When uncertain, schedule a standard ride, dining suggestion, or tip card â never invent a special experience.';

    system += '\n\n=== CURRENT RIDE CLOSURES â DO NOT SCHEDULE ===';
    system += '\nThe following attractions are currently closed for refurbishment. NEVER schedule them as ride cards:';
    system += '\n- Pirates of the Caribbean (closed Jun 2026, reopens TBD)';
    system += '\nCheck the CURRENT CLOSURES section above for any additional closures and honor all of them.';

    system += '\n\n=== CONFIRMED RESERVATION ANCHOR RULE â STRICTLY ENFORCED ===';
    system += '\nConfirmed reservations from tripConfig.dining.reservations MUST appear in the schedule as type:\"dining\" cards at the exact time specified. This is non-negotiable. Do NOT omit them, do NOT replace them with quickservice cards, and do NOT schedule a competing dinner in the same window.';
    system += '\nFor BCDIS2026, the confirmed reservation is: Cafe Orleans, Day 3 (index 2), 6:30 PM, land: New Orleans Square.';
    system += '\nOn Day 3, the schedule MUST include: { t: \"6:30 PM\", h: \"Cafe Orleans â Confirmed Dinner Reservation\", type: \"dining\", isConfirmed: true, n: \"[warm 2-3 sentence note about Cafe Orleans]\", topPick: \"Monte Cristo Sandwich\", veg: \"Ratatouille (seasonal vegetable dish)\", kids: \"Kids Grilled Cheese with fruit\", land: \"New Orleans Square\" }';
    system += '\nNO other dinner card (quickservice or dining) should appear on Day 3 between 5:00 PM and 9:00 PM. The confirmed reservation IS the dinner.';
    system += '\nThe park hop from DCA to Disneyland must be scheduled around the reservation: DCA rides until ~5:30 PM, park hop transition tip at ~5:30 PM (15-20 min walk through Downtown Disney), arrive New Orleans Square by 6:15 PM, Cafe Orleans at 6:30 PM, Disneyland evening rides and fireworks after dinner.';

    system += '\n\n=== NOTE QUALITY STANDARD â EVERY CARD MUST MEET THIS BAR ===';
    system += '\nEvery card note (field "n") must include ALL of the following:';
    system += '\n1. WHY this activity at this specific time â what makes this time slot strategically good (wait times, crowd patterns, park flow)';
    system += '\n2. GROUP-SPECIFIC CONTEXT â reference the actual group makeup from tripConfig (9 guests, 1 under 40 inches, 2 at 40â48 inches, 6 over 48 inches, afternoon break planned). Mention height requirements, who can ride, stroller considerations where relevant.';
    system += '\n3. PRACTICAL DETAIL â what to expect, what to do, what to watch for. At least 2â3 sentences. Never a single sentence. Never vague.';
    system += '\nEXAMPLE OF A GOOD NOTE (use this as your quality benchmark):';
    system += '\n\"First ride of the day. Standby wait should be under 10 minutes at rope drop. This is one of the most consistently long-wait attractions all day â do it now. All 9 guests including your under-40-inch guest can ride (no height requirement). Enjoy the classic Neverland fly-over.\"';
    system += '\nThis standard applies to ALL card types: ride, tip, quickservice, dining, show, character, snack, photo.';

    const confirmedRestaurants = (tripConfig && tripConfig.dining && tripConfig.dining.reservations
      ? tripConfig.dining.reservations : [])
      .map(function(r) { return r && r.name ? r.name : null; })
      .filter(Boolean);
    console.log('[generateschedule] confirmedRestaurants:', JSON.stringify(confirmedRestaurants));
    console.log('[generateschedule] tripConfig.dining:', JSON.stringify(tripConfig && tripConfig.dining));

    if (tripConfig && !tripConfig._usedQuickService) tripConfig._usedQuickService = [];
    const usedQS = (tripConfig && tripConfig._usedQuickService) || [];

    system += '\n\n=== DINING SYSTEM RULES â NEVER VIOLATE ===';
    system += '\n\nCONFIRMED RESERVATIONS â FIXED ANCHORS:';
    system += '\nThe following restaurants are already booked by the guest at specific times.';
    system += '\nThey appear ONCE in the schedule at their confirmed time. Do NOT generate';
    system += '\nany other card for these restaurants anywhere in the schedule.';
    system += '\nConfirmed: ' + (confirmedRestaurants.join(', ') || 'none');
    system += '\n\nQUICK SERVICE SUGGESTIONS (type: "quickservice"):';
    system += '\nAll AI-generated dining slots must use quick service restaurants ONLY.';
    system += '\nRULES:';
    system += '\n1. Never use the same restaurant more than once across the entire trip';
    system += '\n2. Never use any restaurant in the confirmed list above';
    system += '\n3. Never use table service restaurants as primary recommendations:';
    system += '\n Blue Bayou Restaurant, Cafe Orleans, Carthay Circle Restaurant, Lamplight Lounge,';
    system += '\n Wine Country Trattoria, Napa Rose, Steakhouse 55, River Belle Terrace (table service),';
    system += "\n Rancho del Zocalo (sit-down), Plaza Inn (fried chicken sit-down), Carnation Cafe,";
    system += "\n Jolly Holiday Bakery (table service area), Storytellers Cafe, Goofy's Kitchen,";
    system += '\n Minnie & Friends Breakfast, PCH Grill, or any other sit-down table service location.';
    system += '\n4. Always pick from quick service options in the DINING TIMING section of the cache';
    system += '\n5. You MAY mention a table service restaurant once per trip in a note line only â one sentence maximum';
    system += '\n6. Already used quick service restaurants this trip: ' + (usedQS.join(', ') || 'none');
    system += '\n\nQUICK SERVICE CARD SCHEMA â use this exactly:';
    system += '\n{ t: "12:00 PM", h: "Rancho del Zocalo Restaurante", type: "quickservice", n: "Counter service Mexican food in Frontierland.", topPick: "Carne Asada Platter with rice and beans", veg: "Cheese Enchiladas with salsa verde", kids: "Kids Cheese Quesadilla with apple slices", land: "Frontierland" }';
    system += '\nCRITICAL â topPick/veg/kids field rules:';
    system += '\n- topPick MUST be a specific dish name string â NEVER the word true, NEVER false, NEVER null';
    system += '\n- veg MUST be a specific vegetarian dish name string â NEVER true, NEVER false';
    system += '\n- kids MUST be a specific kids meal name string â NEVER true, NEVER false';
    system += '\n\nSNACK STOPS (type: "snack"):';
    system += '\nSame no-repeat rule â never the same snack location twice per trip.';
    system += '\nSNACK CARD SCHEMA: { t: "2:30 PM", h: "Afternoon Snack: Dole Whip", type: "snack", n: "Pineapple Dole Whip at the Tiki Juice Bar near the Enchanted Tiki Room.", land: "Adventureland" }';
    system += '\nCRITICAL: Snack cards MUST NOT include topPick, veg, or kids fields.';
    system += '\n\nAFTERNOON BREAK CARDS (type: \"break\"):';
    system += '\nAfternoon break notes should mention that this is also a good time for shopping.';
    system += '\nFor Disneyland breaks: mention Main Street U.S.A. shops or land-specific merchandise.';
    system += '\nFor DCA breaks: mention Buena Vista Street shops or Cars Land/Pixar Pier merchandise.';
    system += '\n\nCONFIRMED RESERVATION CARDS (type: "dining"):';
    system += '\nConfirmed dining reservations from tripConfig.dining.reservations MUST be generated as type:\"dining\" cards at the exact time listed. They are NOT auto-inserted â you must include them in your output.';

    system += '\n\n=== PARK ARRIVAL RULE ===';
    system += '\nAlways schedule guests to arrive 60 minutes (1 hour) before official park opening.';
    system += '\nThe first tip card of each day must say: Arrive at the park entrance 1 hour before opening.';

    system += '\n\n=== MORNING RHYTHM RULES â REQUIRED ON ALL DAYS ===';
    system += '\nEvery day must include: (1) Arrival tip 60 min before open, (2) Rope drop / Lightning Lane tip, (3) First 2-3 rides, (4) MORNING SNACK between 9:00 AM and 10:30 AM, (5) RESTROOM BREAK (type: \"break\") before 10:30 AM, (6) Continue mid-morning rides.';
    system += '\nSNACK TIMING RULE: Never schedule a snack within 90 minutes of a meal.';
    system += '\nRESTROOM BREAK RULE: Include one restroom break before 11 AM and one between 1-4 PM.';

    system += '\n\n=== VIP DAY DINING RULE ===';
    system += '\nOn VIP tour days, never schedule dinner before 6:30 PM.';
    system += '\n\n=== VIP TOUR HOURS RULE ===';
    system += '\nOn VIP days, the guide handles ALL attractions from vipStart to vipEnd.';
    system += '\nFor Day 2 (VIP day, 10:00 AM to 5:00 PM tour):';
    system += '\nDURING TOUR HOURS (10:00 AM to 5:00 PM):';
    system += '\n- Do NOT schedule any ride cards (type: \"ride\") during this window';
    system += '\n- Do NOT schedule any quickservice or dining cards during this window';
    system += '\n- DO include a single VIP tour block entry at 10:00 AM: { t: \"10:00 AM\", h: \"VIP Tour Begins\", type: \"vip\", n: \"Your guide takes over. Skip-the-line access for all major attractions. Follow your guide lead â they know the optimal route based on today crowd patterns.\", land: \"Disneyland\" }';
    system += '\n- After that single entry, skip directly to 5:00 PM (tour end)';
    system += '\nBEFORE TOUR (before 10:00 AM on VIP day): Schedule normally â rides, tips, snacks, photo ops are all fine.';
    system += '\nAFTER TOUR (after 5:00 PM on VIP day): Schedule normally â dinner, evening rides, shows, fireworks.';

    system += '\n\n=== SCHEDULE COMPLETENESS RULE â STRICTLY ENFORCED ===';
    system += '\nEvery day MUST have schedule entries from 7:00 AM through actual park closing time. This is non-negotiable.';
    system += '\nPark closing times for this trip:';
    system += '\n- Day 1 Sun Jun 28: Disneyland closes 12:00 AM (midnight)';
    system += '\n- Day 2 Mon Jun 29: Disneyland closes 11:00 PM';
    system += '\n- Day 3 Tue Jun 30: DCA closes 10:00 PM, Disneyland closes 11:00 PM';
    system += '\nThe LAST scheduled item on each day must be timed at or after:';
    system += '\n- Day 1: 11:00 PM (with note about staying for midnight close)';
    system += '\n- Day 2: 10:30 PM';
    system += '\n- Day 3: 10:00 PM (DCA close) or 10:30 PM (Disneyland)';
    system += '\nIf there is a fireworks or nighttime show, MUST continue after with: (1) Post-show strategy tip, (2) Final evening rides with low waits, (3) Last call snack or treat, (4) Park exit strategy tip.';
    system += '\nNEVER end the schedule at 9:00 PM or 9:30 PM. Always continue through the actual park closing time.';

    console.log('[generateschedule] mode:', mode || 'default', 'char_priority:', charPriority);

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      system += '\n\n=== NO GAPS RULE (ABSOLUTE) ===';
    system += '\nNever leave a gap longer than 45 minutes between consecutive schedule items. If there is open time between rides, fill it with a snack stop, restroom break, photo opportunity, or strategy tip card. Guests should never have nothing scheduled for more than 45 minutes.';

    system += '\n\n=== DINING PEAK HOURS RULE (ABSOLUTE) ===';
    system += '\nNever schedule any QS meal between 12:00 PM and 1:00 PM. This is peak QS rush â lines are 20-40 minutes longer. Lunch: schedule at 11:00-11:45 AM or 1:15-2:00 PM only. Never at noon. Applies to both Disneyland and DCA.';
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
        const valResult = validateSchedule(singleDaySchedule, safeConfig);
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
    console.error('generateschedule error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.config = { maxDuration: 30 };
