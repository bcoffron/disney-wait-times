const { list } = require('@vercel/blob');

// âââ buildCacheContext ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Reads from new two-cache architecture and extracts only requested sections.
async function buildCacheContext(sectionNames, includeDynamic = false) {
  const results = {};

  // Stable cache
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

  // Dynamic cache
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

// âââ Character intel (unchanged) âââââââââââââââââââââââââââââââââââââââââââââ
async function getCharacterIntel() {
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

function buildCharacterContext(charIntel, maxChars) {
  if (!charIntel) return null;
  const { disclaimer, characters } = charIntel;
  if (!characters.length) return null;
  const lines = [];
  for (const c of characters) {
    const windows = Array.isArray(c.typicalWindows) ? c.typicalWindows.join(', ') : (c.typicalWindows || '');
    lines.push('- ' + c.name + ' | ' + (c.location || '') + ' | Windows: ' + windows + ' | Typical wait: ' + (c.typicalWait || 0) + ' min');
  }
  const body = lines.join('\n');
  const full = 'CHARACTER INTEL (from cache â do not fabricate):\nDisclaimer: ' + disclaimer + '\n\nCharacter windows to avoid conflicts:\n' + body;
  return full.substring(0, maxChars);
}

// âââ Normalize entry (unchanged) âââââââââââââââââââââââââââââââââââââââââââââ
function normalizeEntry(e) {
  var base = {
    t: e.t || e.time || '',
    h: e.h || e.name || e.title || e.attraction || '',
    type: e.type || 'ride',
    n: e.n || e.note || e.tip || e.description || '',
    land: e.land || ''
  };
  if (e.type === 'dining' || e.type === 'quickservice') {
    if (e.topPick) base.topPick = e.topPick;
    if (e.veg) base.veg = e.veg;
    if (e.kids) base.kids = e.kids;
    if (e.reservationTime) base.reservationTime = e.reservationTime;
    if (base.topPick === true || base.topPick === false || base.topPick === 'true' || base.topPick === 'false') { delete base.topPick; }
    if (base.veg === true || base.veg === false || base.veg === 'true' || base.veg === 'false') { delete base.veg; }
    if (base.kids === true || base.kids === false || base.kids === 'true' || base.kids === 'false') { delete base.kids; }
  }
  if (e.type === 'character') {
    base.typicalWait = e.typicalWait || 0;
    base.vipAccessible = !!e.vipAccessible;
    base.disclaimer = true;
  }
  if (e.type === 'tip' || e.type === 'snack' || e.type === 'photo' || e.type === 'character') {
    const origNote = e.n || e.note || e.tip || e.description || '';
    if (base.n && origNote && base.n.length < origNote.length) {
      base.n = origNote;
    }
  }
  return base;
}

// âââ Main handler âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { scheduleItems, dayLabel, tripDayDate, isInTrip, currentTime, liveWaits, apiKey: clientKey, ridePrefsContext } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY || clientKey;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });

    // ââ Build cache context from new two-cache architecture ââââââââââââââââââ
    const cacheCtx = await buildCacheContext(
      ['LAND_MAP', 'WAIT_PATTERNS', 'CROWD_FLOW', 'WALKING_ROUTES'],
      true // include dynamic (CURRENT_CLOSURES, TRIP_CONTEXT, etc.)
    );

    // ── Cache assertion (Safeguard 2) ─────────────────────────────────
    const sectionCount = Object.keys(cacheCtx).length;
    console.log('cache_sections:', Object.keys(cacheCtx).join(','));
    if (sectionCount < 4) {
      console.error('[reoptimize] CACHE EMPTY — aborting AI call. Got', sectionCount, 'sections, need 4');
      return res.status(503).json({ error: 'Park intelligence cache unavailable. Please try again.', cache_sections: Object.keys(cacheCtx), sections_found: sectionCount });
    }
    // ââ Slice each section to target ~4,000 chars total ââââââââââââââââââââââ
    const landMap      = (cacheCtx.LAND_MAP       || '').substring(0, 1200);
    const waitPatterns = (cacheCtx.WAIT_PATTERNS  || '').substring(0, 1500);
    const crowdFlow    = (cacheCtx.CROWD_FLOW      || '').substring(0, 600);
    const walkRoutes   = (cacheCtx.WALKING_ROUTES  || '').substring(0, 500);
    const closures     = (cacheCtx.CURRENT_CLOSURES|| '').substring(0, 300);
    const tripCtx      = (cacheCtx.TRIP_CONTEXT    || '').substring(0, 500);

    const parkIntelContext = [
      'LAND MAP AND ADJACENCY:\n' + landMap,
      'WAIT TIME PATTERNS BY ATTRACTION:\n' + waitPatterns,
      'CROWD FLOW BY TIME OF DAY:\n' + crowdFlow,
      'WALKING ROUTES BETWEEN LANDS:\n' + walkRoutes,
      'CURRENT CLOSURES:\n' + closures,
      'TRIP CONTEXT:\n' + tripCtx
    ].join('\n\n');

    // ââ Character intel ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    const charIntel = await getCharacterIntel();
    const charContext = buildCharacterContext(charIntel, 2000);

    // ââ Build schedule items string ââââââââââââââââââââââââââââââââââââââââââ
    const existingSections = (scheduleItems && Array.isArray(scheduleItems) && scheduleItems.length > 0)
      ? JSON.stringify([{ title: dayLabel || 'Schedule', entries: scheduleItems }])
      : null;

    console.log('[reoptimize] scheduleItems received:', scheduleItems ? scheduleItems.length : 'null', '| dayLabel:', dayLabel || 'none', '| tripDayDate:', tripDayDate || 'none', '| isInTrip:', isInTrip, '| existingSections:', existingSections ? 'built' : 'null');

    // ââ New system prompt (wait-first, walk-second, all-items preserved) âââââ
    var systemPrompt =
      'You are an expert Disneyland schedule optimizer for a group of 9 guests. ' +
      'Your job is to reorder the schedule items provided to minimize time spent ' +
      'waiting in lines (PRIORITY 1) and minimize unnecessary walking between lands ' +
      '(PRIORITY 2). ' +
      '\n\nOPTIMIZATION RULES:' +
      '\n1. WAIT TIME is the top priority. Always move high-wait attractions to ' +
      'their lowest-wait time window based on the WAIT TIME PATTERNS provided.' +
      '\n2. WALKING is secondary. Among options with similar wait times, choose ' +
      'the sequence that keeps the group in the same land or adjacent lands.' +
      '\n3. NEVER drop, remove, or consolidate any items. Return EVERY item you ' +
      'receive, just reordered. If you receive 15 items, return exactly 15 items.' +
      '\n4. ANCHORED ITEMS: Never move dining reservations, confirmed shows, or ' +
      'any item with type "dining" that has isConfirmed=true. Keep them at their ' +
      'exact scheduled time.' +
      '\n5. APPLY CLOSURES: Never include any attraction listed in CURRENT CLOSURES.' +
      '\n6. ALL ITEM TYPES: Apply optimization to rides, dining, snacks, breaks, ' +
      'and photo stops. A snack stop should be in the same land as surrounding rides. ' +
      'A bathroom break should be near the next attraction.' +
      '\n\nOUTPUT FORMAT (strict JSON only, no markdown):' +
      '\n{"sections":[{"title":"[park name]","entries":[' +
      '{"t":"8:00 AM","h":"Attraction Name","type":"ride",' +
      '"n":"Strategic note explaining why this timing","land":"Land Name"}' +
      ']}],"explanation":"One warm sentence explaining the overall strategy"}' +
      '\n\nPreserve ALL fields on every entry (type, n, land, topPick, veg, kids, ' +
      'isConfirmed, etc). Never shorten or remove note text (n field). ' +
      'The explanation should sound like a knowledgeable friend, not a system.' +
      (isInTrip
        ? '\n\nMODE: In-trip. Use LIVE WAIT TIMES provided to make real-time decisions.'
        : '\n\nMODE: Pre-trip. Use WAIT TIME PATTERNS and CROWD FLOW for the specific ' +
          'day of week (' + (tripDayDate || '') + ') to predict optimal timing.');

    // ââ Inject park intelligence into system prompt âââââââââââââââââââââââââââ
    systemPrompt += '\n\n=== PARK INTELLIGENCE ===\n' + parkIntelContext;

    if (charContext) {
      systemPrompt += '\n\n=== ' + charContext + ' ===';
    }

    // ââ Dining and show preservation rules (unchanged from original) âââââââââ
    systemPrompt += '\n\n=== DINING AND SHOW PRESERVATION RULES ===';
    systemPrompt += '\nWhen reordering the schedule, NEVER modify the content of dining or show cards.';
    systemPrompt += '\nRules:';
    systemPrompt += '\n1. Preserve ALL fields on type "dining" and type "quickservice" cards:';
    systemPrompt += '\n h, n, topPick, veg, kids, land â copy them exactly, word for word';
    systemPrompt += '\n7. topPick, veg, and kids fields MUST be copied as exact strings â NEVER substitute with true, false, or any boolean value';
    systemPrompt += '\n2. Preserve ALL fields on type "show" cards: h, n, land';
    systemPrompt += '\n3. You MAY adjust the time slot of a quickservice card if needed for schedule flow';
    systemPrompt += '\n4. NEVER move a confirmed reservation (type "dining") more than 30 minutes from its original time â it is a fixed anchor';
    systemPrompt += '\n5. NEVER replace a rich multi-line note with a generic one-liner';
    systemPrompt += '\n6. If you cannot preserve the original content, keep the card exactly as-is and do not move it';
    systemPrompt += '\n7. Preserve ALL fields on type "tip" cards: the entire note field must be kept exactly word for word.';
    systemPrompt += '\n Tip notes contain strategic park advice. Never shorten, summarize, or replace tip notes.';
    systemPrompt += '\n8. Preserve ALL fields on type "snack", type "photo", and type "character" cards exactly as-is.';
    systemPrompt += '\n These non-ride card types must never have their notes replaced with one-liners.';
    systemPrompt += '\n9. ONLY ride cards (type: "ride") may have their time slots adjusted during optimization.';
    systemPrompt += '\n Never replace any card note with a shorter version. Never genericize a specific note.';

    // ââ Build date-specific crowd guidance âââââââââââââââââââââââââââââââââââ
    var crowdGuide = '';
    if (tripDayDate) {
      var _dow = '';
      try { _dow = new Date(tripDayDate + 'T12:00:00').toDateString().split(' ')[0]; } catch(e) {}
      var _crowdMap = {
        'Sun': 'Sundays are typically busy â crowds peak mid-morning. Prioritize rope drop and Lightning Lane.',
        'Mon': 'Mondays are moderate â lighter than weekends. Good window for popular rides mid-morning.',
        'Tue': 'Tuesdays are among the lightest crowd days. More flexibility throughout the day.',
        'Wed': 'Wednesdays are light to moderate.',
        'Thu': 'Thursdays are light. Excellent for popular attractions.',
        'Fri': 'Fridays start light but get busier by afternoon as weekend crowds arrive.',
        'Sat': 'Saturdays are the busiest day. Strict rope drop strategy essential.'
      };
      if (_dow && _crowdMap[_dow]) crowdGuide = 'TRIP DAY: ' + tripDayDate + ' (' + _dow + ')\nCROWD PATTERN: ' + _crowdMap[_dow] + '\n';
    }

    var modeContext = isInTrip
      ? 'MODE: In-trip â reorder upcoming items using live wait times.\n' + (currentTime ? 'CURRENT TIME: ' + currentTime + '\n' : '') + (liveWaits ? 'LIVE WAIT TIMES:\n' + liveWaits + '\n' : '')
      : 'MODE: Pre-trip â optimize using historical patterns for trip dates, not today\'s live waits.\n';

    // ââ Build user message ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
var userMessage =
  'SCHEDULE TO OPTIMIZE (' + scheduleItems.length + ' items):\n' +
  JSON.stringify(scheduleItems) +
  '\n\nDAY: ' + (dayLabel || '') +
  (isInTrip && currentTime ? '\nCURRENT TIME: ' + currentTime : '') +
  (isInTrip && liveWaits ? '\nLIVE WAITS:\n' + liveWaits.substring(0, 400) : '') +
  '\n\nPARK INTELLIGENCE:\n' +
  'WAIT PATTERNS:\n' + (cacheCtx.WAIT_PATTERNS || '').substring(0, 800) +
  '\nCROWD FLOW:\n' + (cacheCtx.CROWD_FLOW || '').substring(0, 400) +
  '\nLAND ADJACENCY (short):\n' + (cacheCtx.LAND_MAP || '').substring(0, 400) +
  '\nWALKING ROUTES:\n' + (cacheCtx.WALKING_ROUTES || '').substring(0, 300) +
  '\nCLOSURES:\n' + (cacheCtx.CURRENT_CLOSURES || '').substring(0, 200) +
  '\nTRIP CONTEXT:\n' + (cacheCtx.TRIP_CONTEXT || '').substring(0, 300) +
  (ridePrefsContext ? '\n\n' + ridePrefsContext : '');

// // Cap at 16000 (20 items ~11K chars, needs room) â schedule items need room) (raised from 6000 â schedule items need room)
var cappedMessage = userMessage.substring(0, 16000);

    const model = 'claude-haiku-4-5-20251001';

        console.log('[reoptimize] scheduleItems JSON length:', JSON.stringify(scheduleItems).length);
            console.log('[reoptimize] building from scheduleItems:', scheduleItems.length);
    console.log('[reoptimize] userMessage length:', userMessage.length);
console.log('[reoptimize] userMessage sample:', userMessage.substring(0, 300));
const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 8000, system: systemPrompt, messages: [{ role: 'user', content: cappedMessage }] })
    });
    const data = await anthropicRes.json();

const rawText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
const stopReason = data.stop_reason || '';
console.log('[reoptimize] raw response length:', rawText.length);
console.log('[reoptimize] raw response sample:', rawText.substring(0, 200));
console.log('[reoptimize] stop_reason:', stopReason);


    if (data.error) {
      console.error('Anthropic error:', JSON.stringify(data.error));
      return res.status(500).json({ error: data.error.message || JSON.stringify(data.error) });
    }

    console.log('model:', data.model, 'stop:', data.stop_reason, 'cache_sections:', Object.keys(cacheCtx).join(','));

    let text = '';
    for (const block of (data.content || [])) {
      if (block.type === 'text') text += block.text;
    }

    if (!text) return res.status(200).json({ error: 'Empty response', stop_reason: data.stop_reason });

    let parsed = null;
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (fenceMatch) try { parsed = JSON.parse(fenceMatch[1].trim()); } catch(e) {}
    if (!parsed) try { parsed = JSON.parse(text.trim()); } catch(e) {}
    if (!parsed) {
      const m = text.match(/\{[\s\S]+\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch(e) {}
    }

    if (parsed && parsed.sections && Array.isArray(parsed.sections)) {
      const normalized = parsed.sections.map(s => ({
        title: s.title || '',
        entries: (s.entries || []).map(normalizeEntry)
      }));
      return res.status(200).json({ sections: normalized, explanation: parsed.explanation || 'Schedule optimized.' });
    }

    return res.status(200).json({ error: 'Parse failed', raw: text.substring(0, 8000) });

  } catch (e) {
    console.error('Handler error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

handler.config = { maxDuration: 60 };
module.exports = handler;
