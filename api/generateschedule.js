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

// PART 1: Three-tier dining system
  const confirmedRestaurants = (tripConfig && tripConfig.dining && tripConfig.dining.reservations
    ? tripConfig.dining.reservations : [])
    .map(function(r) { return r && r.name ? r.name : null; })
    .filter(Boolean);

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
  system += '\n   Blue Bayou, Cafe Orleans, Carthay Circle Restaurant, Lamplight Lounge,';
  system += '\n   River Belle Terrace (table service), Wine Country Trattoria, Napa Rose,';
  system += '\n   Steakhouse 55, or any other sit-down table service location';
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
  system += '\n\nSNACK STOPS (type: "snack"):';
  system += '\nSame no-repeat rule — never the same snack location twice per trip.';
  system += '\nSNACK CARD SCHEMA:';
  system += '\n{ t: "2:30 PM", h: "Afternoon Snack: Dole Whip", type: "snack", n: "Pineapple Dole Whip at the Tiki Juice Bar near the Enchanted Tiki Room.", land: "Adventureland" }';
  system += '\nCRITICAL: Snack cards MUST NOT include topPick, veg, or kids fields. They are treat stops only. One warm note sentence is sufficient.';
  system += '\n\nCONFIRMED RESERVATION CARDS (type: "dining"):';
  system += '\nDo NOT generate these — they come from the trip config.';

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