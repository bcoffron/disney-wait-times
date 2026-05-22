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
  const full = 'CHARACTER INTEL (from cache — do not fabricate):\nDisclaimer: ' + disclaimer + '\n\nAvailable characters matching trip preferences:\n' + body;
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
      system += '\n\n=== CURRENT PARK INTELLIGENCE (use this — do not search the web) ===\n' + parkIntel;
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
      system += '\n- One character meet per gap maximum — never stack multiple meets back to back.';
      system += '\n- Character meet schedule entry schema: { "t": "H:MM AM", "h": "Character Name", "type": "character", "n": "Location, Land · Window start–end", "land": "Land Name", "typicalWait": 25, "vipAccessible": true, "disclaimer": true }';
      system += '\n- The "n" field must combine location and appearance window as one string.';
      system += '\n- Set disclaimer: true on all character entries so the app shows the schedule-change warning.';
    }


// FIX 3: Anti-hallucination strict content rules
system += '\n\n=== STRICT CONTENT RULES — NEVER VIOLATE ===';
system += '\n1. Only schedule activities that are: (a) explicitly in the trip config, (b) real attractions verified in the park_intel cache, or (c) standard park activities (rides, dining, shows, photo ops, snack stops, tip cards, restroom breaks).';
system += '\n2. NEVER invent tour packages, special experiences, or paid add-ons not in the trip config. Do not add VIP tours, bio tours, backstage tours, Keys to the Kingdom, or any paid tour product unless it appears explicitly in tripConfig.lightningLane.singlePass or tripConfig.dining.reservations.';
system += '\n3. NEVER schedule behind-the-scenes experiences, private tours, or special-access events that the user did not select during onboarding.';
system += '\n4. When uncertain, schedule a standard ride, dining suggestion, or tip card — never invent a special experience.';

// FIX 2: Inject booked restaurant exclusion list
const bookedRestaurants = ((tripConfig && tripConfig.dining && tripConfig.dining.reservations) || [])
  .map(function(r) { return r && r.name ? r.name : null; })
  .filter(Boolean);
if (bookedRestaurants.length > 0) {
  system += '\n\n=== DINING RESERVATIONS ALREADY BOOKED — DO NOT RECOMMEND THESE RESTAURANTS ===';
  system += '\nThe following restaurants are already reserved as fixed anchors in the schedule. Do NOT recommend them in any other dining card, suggestion, or note: ' + bookedRestaurants.join(', ') + '.';
  system += '\nThese are confirmed bookings — duplicating them would confuse the guest. Any free dining cards must recommend DIFFERENT restaurants.';
}
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