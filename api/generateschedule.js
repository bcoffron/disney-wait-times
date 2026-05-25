// api/generateschedule.js
// Routes generateFromSetup and aiChooseRides through Vercel with park_intel + character_intel cache context
const { list } = require('@vercel/blob');

async function getCacheSlice(key, maxChars = 4000) {
  try {
    const { blobs } = await list({ prefix: 'twize/' + key + '.json' });
    if (!blobs || blobs.length === 0) return null;
    const blob = blobs[0];
    const fetchUrl = blob.downloadUrl || blob.url;
    const dataResp = await fetch(fetchUrl);
    if (!dataResp.ok) return null;
    const text = await dataResp.text();
    const parsed = JSON.parse(text);
    if (!parsed || !parsed.data) return null;
    const raw = typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data);
    return raw.substring(0, maxChars);
  } catch (e) {
    console.error('Cache fetch error for', key, e.message);
    return null;
  }
}

async function getCharacterIntel(maxChars = 4000) {
  try {
    const { blobs } = await list({ prefix: 'twize/character_intel.json' });
    if (!blobs || blobs.length === 0) return null;
    const blob = blobs[0];
    const fetchUrl = blob.downloadUrl || blob.url;
    const dataResp = await fetch(fetchUrl);
    if (!dataResp.ok) return null;
    const text = await dataResp.text();
    const parsed = JSON.parse(text);
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
    const { prompt, mode, maxTokens = 4000, tripConfig } = req.body || {};
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    const [parkIntel, diningIntel, eventsIntel, charIntel] = await Promise.all([
      getCacheSlice('park_intel', 4000),
      getCacheSlice('dining_intel', 2000),
      getCacheSlice('events_intel', 1500),
      getCharacterIntel(4000)
    ]);

    const charContext = buildCharacterContext(charIntel, tripConfig, 4000);
    const charPriority = (tripConfig && tripConfig.characters && tripConfig.characters.priority) || 'niceToHave';

    let system = 'You are a Disneyland and Disney California Adventure theme park scheduling expert with deep knowledge of wait time patterns, rope drop strategies, and crowd flow. Generate detailed, realistic day schedules in valid JSON only. No markdown, no explanation, just JSON.';

    if (parkIntel) {
      system += '\n\n=== CURRENT PARK INTELLIGENCE (use this â do not search the web) ===\n' + parkIntel;
    }
    if (diningIntel) {
      system += '\n\n=== DINING INTELLIGENCE ===\n' + diningIntel;
    }
    if (eventsIntel) {
      system += '\n\n=== EVENTS INTELLIGENCE ===\n' + eventsIntel;
    }
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


// FIX 3: Anti-hallucination strict content rules
system += '\n\n=== STRICT CONTENT RULES â NEVER VIOLATE ===';
system += '\n1. Only schedule activities that are: (a) explicitly in the trip config, (b) real attractions verified in the park_intel cache, or (c) standard park activities (rides, dining, shows, photo ops, snack stops, tip cards, restroom breaks).';
system += '\n2. NEVER invent tour packages, special experiences, or paid add-ons not in the trip config. Do not add VIP tours, bio tours, backstage tours, Keys to the Kingdom, or any paid tour product unless it appears explicitly in tripConfig.lightningLane.singlePass or tripConfig.dining.reservations.';
system += '\n3. NEVER schedule behind-the-scenes experiences, private tours, or special-access events that the user did not select during onboarding.';
system += '\n4. When uncertain, schedule a standard ride, dining suggestion, or tip card â never invent a special experience.';

  // CURRENT RIDE CLOSURES
  system += '\n\n=== CURRENT RIDE CLOSURES — DO NOT SCHEDULE ===';
  system += '\nThe following attractions are currently closed for refurbishment. NEVER schedule them as ride cards. If they appear in your knowledge as open, ignore that — these are confirmed closed as of the trip dates (Jun 28-30, 2026):';
  system += '\n- Pirates of the Caribbean (closed Jun 2026, reopens TBD)';
  system += '\nThis list will be updated as closures change. Always check park_intel cache for the current closure list and honor it.';

  // CONFIRMED RESERVATION ANCHOR RULE (Day 3 Cafe Orleans)
  system += '\n\n=== CONFIRMED RESERVATION ANCHOR RULE — STRICTLY ENFORCED ===';
  system += '\nConfirmed reservations from tripConfig.dining.reservations MUST appear in the schedule as type:\"dining\" cards at the exact time specified. This is non-negotiable. Do NOT omit them, do NOT replace them with quickservice cards, and do NOT schedule a competing dinner in the same window.';
  system += '\nFor BCDIS2026, the confirmed reservation is: Cafe Orleans, Day 3 (index 2), 6:30 PM, land: New Orleans Square.';
  system += '\nOn Day 3, the schedule MUST include: { t: \"6:30 PM\", h: \"Cafe Orleans — Confirmed Dinner Reservation\", type: \"dining\", isConfirmed: true, n: \"[warm 2-3 sentence note about Cafe Orleans]\", topPick: \"Monte Cristo Sandwich\", veg: \"Ratatouille (seasonal vegetable dish)\", kids: \"Kids Grilled Cheese with fruit\", land: \"New Orleans Square\" }';
  system += '\nNO other dinner card (quickservice or dining) should appear on Day 3 between 5:00 PM and 9:00 PM. The confirmed reservation IS the dinner.';
  system += '\nThe park hop from DCA to Disneyland must be scheduled around the reservation: DCA rides until ~5:30 PM, park hop transition tip at ~5:30 PM (15-20 min walk through Downtown Disney), arrive New Orleans Square by 6:15 PM, Cafe Orleans at 6:30 PM, Disneyland evening rides and fireworks after dinner.';

// FIX 2: Note quality standard
system += '\n\n=== NOTE QUALITY STANDARD — EVERY CARD MUST MEET THIS BAR ===';
system += '\nEvery card note (field "n") must include ALL of the following:';
system += '\n1. WHY this activity at this specific time — what makes this time slot strategically good (wait times, crowd patterns, park flow)';
system += '\n2. GROUP-SPECIFIC CONTEXT — reference the actual group makeup from tripConfig (9 guests, 1 under 40 inches, 2 at 40–48 inches, 6 over 48 inches, afternoon break planned). Mention height requirements, who can ride, stroller considerations where relevant.';
system += '\n3. PRACTICAL DETAIL — what to expect, what to do, what to watch for. At least 2–3 sentences. Never a single sentence. Never vague.';
system += '\nEXAMPLE OF A GOOD NOTE (use this as your quality benchmark):';
system += '\n"First ride of the day. Standby wait should be under 10 minutes at rope drop. This is one of the most consistently long-wait attractions all day — do it now. All 9 guests including your under-40-inch guest can ride (no height requirement). Enjoy the classic Neverland fly-over."';
system += '\nEXAMPLE OF A BAD NOTE — never write these:';
system += '\n"Low wait at rope drop." (too short, no context)';
system += '\n"Quick succession, minimal crowds." (vague, no group info)';
system += '\n"Classic dark ride." (generic, no strategy)';
system += '\n"Thrill coaster, still short wait." (one line, no detail)';
system += '\nThis standard applies to ALL card types: ride, tip, quickservice, dining, show, character, snack, photo.';

// PART 1: Three-tier dining system
  const confirmedRestaurants = (tripConfig && tripConfig.dining && tripConfig.dining.reservations
    ? tripConfig.dining.reservations : [])
    .map(function(r) { return r && r.name ? r.name : null; })
    .filter(Boolean);
  console.log('[generateschedule] confirmedRestaurants:', JSON.stringify(confirmedRestaurants));
  console.log('[generateschedule] tripConfig.dining:', JSON.stringify(tripConfig && tripConfig.dining));

  // Track used quick service restaurants across all days to prevent repeats
  if (tripConfig && !tripConfig._usedQuickService) tripConfig._usedQuickService = [];
  const usedQS = (tripConfig && tripConfig._usedQuickService) || [];

  system += '\n\n=== DINING SYSTEM RULES — NEVER VIOLATE ===';
  system += '\n\nCONFIRMED RESERVATIONS — FIXED ANCHORS:';
  system += '\nThe following restaurants are already booked by the guest at specific times.';
  system += '\nThey appear ONCE in the schedule at their confirmed time. Do NOT generate';
  system += '\nany other card for these restaurants anywhere in the schedule. Do NOT mention';
  system += '\nthem by name as a recommendation in any other card.';
  system += '\nConfirmed: ' + (confirmedRestaurants.join(', ') || 'none');
  system += '\n\nQUICK SERVICE SUGGESTIONS (type: "quickservice"):';
  system += '\nAll AI-generated dining slots must use quick service restaurants ONLY.';
  system += '\nRULES:';
  system += '\n1. Never use the same restaurant more than once across the entire trip';
  system += '\n2. Never use any restaurant in the confirmed list above';
  system += '\n3. Never use table service restaurants as primary recommendations:';
    system += '\n   Blue Bayou Restaurant, Cafe Orleans, Carthay Circle Restaurant, Lamplight Lounge,';
  system += '\n   Wine Country Trattoria, Napa Rose, Steakhouse 55, River Belle Terrace (table service),';
  system += '\n   Rancho del Zocalo (sit-down), Plaza Inn (fried chicken sit-down), Carnation Cafe,';
  system += "\n   Jolly Holiday Bakery (table service area), Storytellers Cafe, Goofy's Kitchen,";
  system += '\n   Minnie & Friends Breakfast, PCH Grill, or any other sit-down table service location.';
  system += '\n   Quick service means ONLY: counter service, food stands, carts, walk-up windows';
  system += '\n   where you order and take your food. If a server takes your order at a table, it is table service.';
  system += '\n4. Always pick from quick service options in the dining_intel cache';
  system += '\n5. You MAY mention a table service restaurant once per trip in a note line only — one sentence maximum, never as the primary recommendation';
  system += '\n6. Already used quick service restaurants this trip: ' + (usedQS.join(', ') || 'none');
  system += '\n\nQUICK SERVICE CARD SCHEMA — use this exactly:';
  system += '\n{ t: "12:00 PM", h: "Rancho del Zocalo Restaurante", type: "quickservice", n: "Counter service Mexican food in Frontierland. Large portions, great for groups.", topPick: "Carne Asada Platter with rice and beans", veg: "Cheese Enchiladas with salsa verde", kids: "Kids Cheese Quesadilla with apple slices", land: "Frontierland" }';
  system += '\nCRITICAL — topPick/veg/kids field rules:';
  system += '\n- topPick MUST be a specific dish name string — NEVER the word true, NEVER false, NEVER null';
  system += '\n- veg MUST be a specific vegetarian dish name string — NEVER true, NEVER false';
  system += '\n- kids MUST be a specific kids meal name string — NEVER true, NEVER false';
  system += '\n- All three fields are REQUIRED on every quickservice card';
  system += '\n- Use real menu items from the dining_intel cache for this restaurant';
  system += '\n- If you do not know the exact dish name, use a reasonable approximation — never use a boolean';
  system += '\nABSOLUTE RULE: veg and kids fields must NEVER be empty strings on quickservice cards. If you do not know the exact vegetarian option, use the most reasonable approximation based on the restaurant type. If a restaurant has no kids menu, use the most appropriate small portion item for children.';
  system += '\nEXAMPLE of what is NEVER acceptable: veg: \"\" or kids: \"\" or veg: null or kids: null';
  system += '\nEXAMPLE of what is always acceptable even if approximate: veg: \"Garden salad with vinaigrette\" or kids: \"Kids grilled cheese sandwich\"';
  system += '\nEvery single quickservice card must have all three fields (topPick, veg, kids) populated with real dish name strings. No exceptions.';
  system += '\n\nSNACK STOPS (type: "snack"):';
  system += '\nSame no-repeat rule — never the same snack location twice per trip.';
  system += '\nSNACK CARD SCHEMA:';
  system += '\n{ t: "2:30 PM", h: "Afternoon Snack: Dole Whip", type: "snack", n: "Pineapple Dole Whip at the Tiki Juice Bar near the Enchanted Tiki Room.", land: "Adventureland" }';
  system += '\nCRITICAL: Snack cards MUST NOT include topPick, veg, or kids fields. They are treat stops only. One warm note sentence is sufficient.';
  system += '\n\nAFTERNOON BREAK CARDS (type: \"break\"):';
  system += '\nAfternoon break notes should always mention that this is also a good time for shopping. Include language like: This is also a great window to browse the shops on [relevant street/area], pick up souvenirs, or grab merchandise without fighting through attraction crowds.';
  system += '\nFor Disneyland breaks: mention Main Street U.S.A. shops or land-specific merchandise locations near the break area.';
  system += '\nFor DCA breaks: mention Buena Vista Street shops or Cars Land/Pixar Pier merchandise.';
  system += '\nThe shopping mention should be natural and specific to the park location — not generic.';
  system += '\n\nCONFIRMED RESERVATION CARDS (type: "dining"):';
  system += '\nConfirmed dining reservations from tripConfig.dining.reservations MUST be generated as type:\"dining\" cards at the exact time listed. They are NOT auto-inserted — you must include them in your output. See CONFIRMED RESERVATION ANCHOR RULE for the required format.';

  // FIX 3: Hardcode 60-min arrival
  system += '\n\n=== PARK ARRIVAL RULE ===';
  system += '\nPark arrival tip: Always schedule guests to arrive 60 minutes (1 hour) before official park opening.';
  system += '\nNever use 45 minutes. The arrival tip card time should be set to the park openTime minus 60 minutes.';
  system += '\nThe first tip card of each day must say: Arrive at the park entrance 1 hour before opening.';


  // FIX 4: VIP day dinner timing + schedule completeness
  system += '\n\n=== VIP DAY DINING RULE ===';
  system += '\nOn VIP tour days, never schedule dinner before 6:30 PM. The group needs transition time after the tour ends. If vipEnd is 5:00 PM, the earliest dinner slot is 6:30 PM. Quick service dinner on VIP days should be 6:30 PM or later.';
  system += '\n\n=== VIP TOUR HOURS RULE ===';
  system += '\nOn VIP days, the guide handles ALL attractions from vipStart to vipEnd.';
  system += '\nFor Day 2 (VIP day, 10:00 AM to 5:00 PM tour):';
  system += '\nDURING TOUR HOURS (10:00 AM to 5:00 PM):';
  system += '\n- Do NOT schedule any ride cards (type: "ride") during this window';
  system += '\n- Do NOT schedule any quickservice or dining cards during this window';
  system += '\n- DO include a single VIP tour block entry at 10:00 AM: { t: "10:00 AM", h: "VIP Tour Begins", type: "vip", n: "Your guide takes over. Skip-the-line access for all major attractions. Follow your guide lead — they know the optimal route based on today crowd patterns.", land: "Disneyland" }';
  system += '\n- After that single entry, skip directly to 5:00 PM (tour end)';
  system += '\nBEFORE TOUR (before 10:00 AM on VIP day): Schedule normally — rides, tips, snacks, photo ops are all fine. The group should arrive at 7:00 AM for rope drop and get in 2 hours of independent riding before the guide arrives.';
  system += '\nAFTER TOUR (after 5:00 PM on VIP day): Schedule normally — dinner, evening rides, shows, fireworks. The group is free again after 5:00 PM.';
  system += '\n\n=== SCHEDULE COMPLETENESS RULE — STRICTLY ENFORCED ===';
  system += '\nEvery day MUST have schedule entries from 7:00 AM through actual park closing time. This is non-negotiable.';
  system += '\nPark closing times for this trip:';
  system += '\n- Day 1 Sun Jun 28: Disneyland closes 12:00 AM (midnight)';
  system += '\n- Day 2 Mon Jun 29: Disneyland closes 11:00 PM';
  system += '\n- Day 3 Tue Jun 30: DCA closes 10:00 PM, Disneyland closes 11:00 PM';
  system += '\nThe LAST scheduled item on each day must be timed at or after:';
  system += '\n- Day 1: 11:00 PM (with note about staying for midnight close)';
  system += '\n- Day 2: 10:30 PM';
  system += '\n- Day 3: 10:00 PM (DCA close) or 10:30 PM (Disneyland)';
  system += '\nIf there is a fireworks or nighttime show, it typically ends around 9:30-10:00 PM. After the show, schedule MUST continue with: (1) Post-show strategy tip, (2) Final evening rides with low waits, (3) Last call snack or treat, (4) Park exit strategy tip.';
  system += '\nNEVER end the schedule at 9:00 PM or 9:30 PM. Always continue through the actual park closing time.';
  system += '\nEXAMPLE end-of-day sequence after 9:30 PM fireworks: { t: "9:30 PM", type: "show", h: "Fireworks" }, { t: "9:55 PM", type: "tip", h: "Post-Fireworks Fantasyland Sprint" }, { t: "10:15 PM", type: "ride", h: "Haunted Mansion Re-Ride" }, { t: "10:45 PM", type: "ride", h: "Space Mountain Final Ride" }, { t: "11:15 PM", type: "tip", h: "Main Street Exit Strategy" }';

  console.log('generateschedule mode:', mode || 'default', 'park_intel:', !!parkIntel, 'char_intel:', !!charIntel, 'char_priority:', charPriority);

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt.substring(0, 8000) }] })
    });

    const data = await anthropicRes.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    let text = '';
    for (const block of (data.content || [])) {
      if (block.type === 'text') text += block.text;
    }

    if (!text) return res.status(200).json({ error: 'Empty response', stop_reason: data.stop_reason });

    const parsed = extractJSON(text);
    return res.status(200).json({ ok: true, text, parsed, model: data.model });

  } catch (e) {
    console.error('generateschedule error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.config = { maxDuration: 30 };