// api/generateschedule-v2.js
// FOUNDATION v2 generator. Behind ?engine=v2. Working /api/generateschedule untouched.
//
// PHYSICS vs STRATEGY (Beau's core principle):
//   - CODE enforces PHYSICS: one park at a time (deriveBlocks/whichParkAt), a card's land must
//     belong to the park it's physically in (per-block CATALOG candidate filtering), one of each
//     meal in the right block, day starts at open/ends by close, hop only if planned.
//   - MODEL + CACHE own STRATEGY: which rides + order, what to rope-drop, which venue, off-peak
//     meal timing, hop-time refinement. The model picks ONLY from the per-block candidate list,
//     so a DL ride cannot appear in a DCA block -- it is not on the menu.
//
// Returns the SAME shape as the working path: { ok, text, parsed, model } so the client's
// existing d.parsed handling is unchanged.

import { list } from '@vercel/blob';
import { deriveBlocks, parseParkHoursForDate, buildCatalogFilter, whichParkAt, parseHourMin } from './schedule-engine.js';

const MODEL = 'claude-sonnet-4-6';

// ---- cache loaders (reuse the proven path from generateschedule.js) ----
async function loadStableSections() {
  const out = { sections: {}, dining: null };
  try {
    const { blobs } = await list({ prefix: 'twize/park_intel_dl_stable.json' });
    if (blobs && blobs.length) {
      const url = blobs[0].downloadUrl || blobs[0].url;
      const blob = await fetch(url).then(r => r.json());
      out.sections = (blob.data && blob.data.sections) || blob.sections || {};
    }
  } catch (e) { console.error('[v2] stable read error:', e.message); }
  try {
    let { blobs } = await list({ prefix: 'twize/dining_intel_dl.json' });
    if (blobs && blobs.length) {
      const url = blobs[0].downloadUrl || blobs[0].url;
      const d = await fetch(url).then(r => r.json());
      out.dining = typeof d.data === 'string' ? d.data : JSON.stringify(d.data || d);
    }
  } catch (e) { console.error('[v2] dining read error:', e.message); }
  return out;
}

async function loadParkHours() {
  // PARK_HOURS lives in the dynamic blob's TRIP_CONTEXT in some builds and as a top-level
  // structured array in others; the client also has window.PARK_HOURS. We accept it from
  // tripConfig.parkHours if the client passes it, else fall back to sane DLR summer hours.
  return null;
}

// Minutes -> "H:MM AM" for the prompt.
function minToLabel(min) {
  if (min == null) return '';
  let h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  let hh = h % 12; if (hh === 0) hh = 12;
  return hh + ':' + (m < 10 ? '0' + m : m) + ' ' + ap;
}

// Build a compact candidate menu string for one park block from the CATALOG.
function candidateMenu(catalog, park, shortestHeightInches) {
  const f = buildCatalogFilter(catalog, park); // drops wrong-park AND v.exclude===true
  const rideLines = f.attractions
    .map(a => {
      const tooTall = (shortestHeightInches > 0 && a.heightInches > shortestHeightInches);
      return '- ' + a.name + ' [' + a.land + '] ll=' + (a.llKind || 'none')
        + ' ropeDrop=' + (a.ropeDropValue || 'med')
        + (a.heightInches ? ' height=' + a.heightInches + 'in' : '')
        + (tooTall ? ' (HEIGHT: someone in group is below this -- include a rider-swap note if used)' : '');
    })
    .join('\n');
  const venueLines = f.venues
    .map(v => '- ' + v.name + ' [' + v.land + '] ' + (v.service || 'quickservice')
      + ' resv=' + (v.reservationPolicy || 'walkup')
      + (v.walkupEase ? ' walkup=' + v.walkupEase : ''))
    .join('\n');
  return { rideLines, venueLines, rideCount: f.attractions.length, venueCount: f.venues.length };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-trip-code');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { dayIndex, tripConfig, maxTokens = 8000, priorRides = [] } = body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });
    if (typeof dayIndex !== 'number' || !tripConfig) {
      return res.status(400).json({ error: 'Missing dayIndex or tripConfig' });
    }

    const days = tripConfig.days || [];
    const day = days[dayIndex];
    if (!day) return res.status(400).json({ error: 'dayIndex out of range' });

    // ---- intent (Step 3). Fail safe to single-park if missing. ----
    const intent = day.intent || {
      startPark: /dca|california/i.test(day.startPark || day.park || '') ? 'DCA' : 'DL',
      hop: null,
      vip: null
    };

    // ---- park hours -> blocks (PHYSICS) ----
    let parkHoursForDate = null;
    if (Array.isArray(tripConfig.parkHours)) {
      parkHoursForDate = parseParkHoursForDate(tripConfig.parkHours, dayIndex);
    }
    if (!parkHoursForDate) {
      // sane DLR summer fallback; real hours come from the client passing tripConfig.parkHours
      parkHoursForDate = { DL: { openMin: 480, closeMin: 1380 }, DCA: { openMin: 480, closeMin: 1320 } };
    }
    const blocks = deriveBlocks(intent, parkHoursForDate);

    // ---- CATALOG (the machine-readable physics layer) ----
    const { sections, dining } = await loadStableSections();
    let catalog = sections.CATALOG;
    if (typeof catalog === 'string') { try { catalog = JSON.parse(catalog); } catch (e) { catalog = null; } }
    if (!catalog || !Array.isArray(catalog.attractions)) {
      return res.status(503).json({ error: 'CATALOG unavailable in cache; cannot run v2.' });
    }

    const shortest = (tripConfig.groupProfile && typeof tripConfig.groupProfile.shortestHeightInches === 'number')
      ? tripConfig.groupProfile.shortestHeightInches : 0;

    // ---- strategy context (prose cache the model reads to DECIDE) ----
    const strat = [];
    ['ROPE_DROP_STRATEGY', 'WAIT_PATTERNS', 'LIGHTNING_LANE_STRATEGY', 'DINING_TIMING', 'PARK_HOP_STRATEGY']
      .forEach(k => { if (sections[k]) strat.push(k + ':\n' + (typeof sections[k] === 'string' ? sections[k] : JSON.stringify(sections[k]))); });
    const stratText = strat.join('\n\n').slice(0, 5000);

    // ---- reservations the user explicitly entered (must appear at their times) ----
    const flatRes = Array.isArray(tripConfig.reservations) ? tripConfig.reservations : [];
    const structRes = (tripConfig.dining && Array.isArray(tripConfig.dining.reservations)) ? tripConfig.dining.reservations : [];
    const resLines = []
      .concat(flatRes.map(s => typeof s === 'string' ? s : JSON.stringify(s)))
      .concat(structRes.map(r => (r && r.name) ? (r.name + (r.time ? ' @ ' + r.time : '') + (r.day ? ' (day ' + r.day + ')' : '')) : ''))
      .filter(Boolean);

    // ---- build the SLIM per-block prompt ----
    const blockText = blocks.map((b, i) => {
      const menu = candidateMenu(catalog, b.park, shortest);
      return 'BLOCK ' + (i + 1) + ' -- ' + b.park + ' from ' + minToLabel(b.startMin) + ' to ' + minToLabel(b.endMin) + '.\n'
        + 'You may ONLY use attractions and venues from THIS block\'s lists (they are physically in ' + b.park + '):\n'
        + 'RIDES (' + menu.rideCount + '):\n' + menu.rideLines + '\n'
        + 'VENUES (' + menu.venueCount + '):\n' + menu.venueLines;
    }).join('\n\n');

    const llOn = !!day.hasLL;
    const vip = intent.vip;

    const system =
'You are a Disneyland Resort day-planning expert who writes like a knowledgeable friend. You build ONE day\'s schedule.\n'
+ 'HARD PHYSICS RULES (never break):\n'
+ '1. Use ONLY items from the block lists provided. A ride/venue not on a block\'s list is physically not in that park during that block -- never schedule it.\n'
+ '2. Respect each block\'s park and time window. Items must fall inside their block\'s start/end.\n'
+ '3. Exactly ONE lunch and ONE dinner across the day, each in whatever block covers that time. Lunch 11:00-11:45 or 1:00-1:45 (NEVER 12-1). Dinner 4:30-5:30 or 7:30+ (NEVER 6-7).\n'
+ '4. Never list the same ride twice in one day -- not within a block and NOT across blocks. Each ride name appears at most once in the whole day.\n'
+ '5. Day starts at the first block\'s open time and ends by the last block\'s close time.\n'
+ (vip ? '6. VIP TOUR from ' + minToLabel(vip.startMin) + ' to ' + minToLabel(vip.endMin) + ': during this window the VIP guide leads and handles skip-the-line; mark those items type "tip"/"ride" with a note that the guide leads, and do NOT schedule normal standby rides against the guide -- the guide picks rides live. Outside the VIP window, plan normally.\n' : '')
+ 'STRATEGY (you decide, using this verified cache data -- vary by crowd/wait, do not be robotic):\n'
+ '- Open the day with a rope-drop ride IN THE STARTING PARK (the first block\'s park): pick the highest-value ropeDrop=high attraction from THAT block\'s list. This rope-drop choice OVERRIDES cross-day variety -- a strong rope-drop in the park you are actually standing in matters more than avoiding a repeat, so repeat it if it is the best opener. Never open with a meal, and never rope-drop a ride from the other park.\n'
+ '- Fill the first block primarily with attractions from the STARTING park before the hop -- do not lean on the second park\'s list to fill the morning.\n'
+ '- Pick venues from the lists. service=table means a sit-down meal (a reservation or walk-up list); quickservice is a counter grab; lounge is a walk-up lounge. Do not treat a table-service spot as a quick grab.\n'
+ (resLines.length ? '- CONFIRMED RESERVATIONS that MUST appear at their stated times: ' + resLines.join(' | ') + '\n' : '')
+ (llOn ? '- Lightning Lane is ON: include 2-4 LL booking tip cards naming exact rides/times. ll="single" rides are Individual Lightning Lane (paid); ll="multi" are Lightning Lane Multi Pass.\n' : '- Lightning Lane is OFF: standby only, no LL tip cards.\n')
+ '- Include a morning snack and an afternoon snack (real venue names from the lists, not "Morning Snack").\n'
+ '- If the group has character interest and a character category fits, include 1-2 character meets as type "character" with a real location.\n'
+ 'OUTPUT: Return ONLY a raw JSON array (no prose, no markdown) of items with fields: t ("H:MM AM"), h (activity name), type (ride|show|dining|quickservice|break|tip|snack|character), n (one warm sentence explaining why/when), land (land name). Order by time.';

    const user =
'Build Day ' + (dayIndex + 1) + ' of ' + days.length + '. Date: ' + (day.date || '') + '.\n'
+ 'Trip: ' + (tripConfig.tripName || '') + '. Thrill level: ' + (tripConfig.thrillLevel || 'mix') + '.\n'
+ 'Must-do rides: ' + (((tripConfig.ridePreferences || {}).mustDo || []).join(', ') || 'none') + '.\n'
+ 'Never schedule: ' + (((tripConfig.ridePreferences || {}).skip || tripConfig.neverSchedule || []).join(', ') || 'none') + '.\n'
+ 'Character interest: ' + (((tripConfig.characters || {}).categories || []).join(', ') || 'none') + ' (priority ' + ((tripConfig.characters || {}).priority || 'niceToHave') + ').\n'
+ 'Shortest person height: ' + (shortest > 0 ? shortest + ' inches (apply rider-swap on taller-requirement rides)' : 'everyone meets all height requirements') + '.\n\n'
+ (Array.isArray(priorRides) && priorRides.length
    ? 'CROSS-DAY VARIETY (soft preference, NOT a hard rule): earlier days of this trip already scheduled these rides: '
      + [...new Set(priorRides)].slice(-18).join(', ') + '. Favor FRESH attractions the group has not done yet so the trip feels varied across days. '
      + 'It is fine to repeat a true must-do headliner the group loves (e.g. a top coaster or a marquee ride on their must-do list), '
      + 'but do not fill the day with repeats when good unused attractions remain in this block. EXCEPTION: the starting-park rope-drop and any must-do headliner may repeat freely -- variety applies to filler rides, never to the best opener.\n'
    : '')
+ 'PARK BLOCKS FOR TODAY (physics -- you cannot leave these):\n' + blockText + '\n\n'
+ 'STRATEGY CACHE (verified sources -- use to decide rope-drop, waits, LL, dining timing):\n' + stratText;

    // ---- model call ----
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 110000);
    let data;
    try {
      const aRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
        signal: controller.signal
      });
      data = await aRes.json();
    } catch (e) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') return res.status(504).json({ error: 'v2 request timed out' });
      return res.status(500).json({ error: e.message });
    }
    clearTimeout(timeout);
    if (data.error) return res.status(500).json({ error: data.error.message });

    const text = (data.content && data.content[0] && data.content[0].text) || '';
    if (!text) return res.status(200).json({ ok: false, error: 'Empty response', stop_reason: data.stop_reason });

    // ---- parse the array (no mutating validator here; v2 enforces physics via candidate lists) ----
    let parsed = null;
    try {
      const t = text.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
      const s = t.indexOf('['), e = t.lastIndexOf(']');
      if (s !== -1 && e !== -1) parsed = JSON.parse(t.substring(s, e + 1));
    } catch (e) { /* leave parsed null; client falls back to text */ }

    // ---- PHYSICS ENFORCEMENT (code, not prompt): drop any RIDE scheduled into a block whose park
    // does not contain it. The model is told to stay in-block, but prompt rules can lose to the data;
    // this guarantees a ride's time falls in a block whose park's catalog actually has that ride.
    // Conservative: only drops type 'ride' items we can confidently match as wrong-park. Never touches
    // meals/tips/shows/snacks. Does NOT regenerate or insert filler (that was the scaffold's failure). ----
    let _enforce = { dropped: [] };
    if (Array.isArray(parsed) && parsed.length) {
      // precompute per-park ride name sets (normalized) from the catalog
      const _norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      const _parkRideSet = {};
      blocks.forEach(b => {
        if (!_parkRideSet[b.park]) {
          const f = buildCatalogFilter(catalog, b.park);
          _parkRideSet[b.park] = new Set(f.attractions.map(a => _norm(a.name)));
        }
      });
      const _kept = [];
      parsed.forEach(it => {
        if (it && it.type === 'ride' && it.t) {
          const tm = parseHourMin(it.t);
          const parkAt = whichParkAt(blocks, tm);
          const set = _parkRideSet[parkAt];
          // strip rope-drop / LL adornments for matching, same as client cleaning
          const rideName = _norm(String(it.h || '').replace(/^rope drop[^:]*:?\s*/i, '').replace(/^rope drop\s*[\u2014-]\s*/i, '').replace(/\s*\(ll[^)]*\)\s*$/i, '').replace(/\s*\(night[^)]*\)\s*$/i, ''));
          // Only drop if we have a catalog set for that park AND the ride is genuinely absent from it
          // (i.e. it belongs to the OTHER park). If set is missing, keep (fail open, never over-drop).
          if (set && set.size && !set.has(rideName)) {
            // confirm it actually exists in some OTHER park before dropping (so we don't drop a name the
            // catalog simply lacks, e.g. a show mislabeled as a ride)
            const inOtherPark = Object.keys(_parkRideSet).some(p => p !== parkAt && _parkRideSet[p].has(rideName));
            if (inOtherPark) { _enforce.dropped.push({ t: it.t, h: it.h, scheduledIn: parkAt }); return; }
          }
        }
        _kept.push(it);
      });
      if (_enforce.dropped.length) { parsed = _kept; }
    }

    return res.status(200).json({ ok: true, text, parsed, model: data.model, _engine: 'v2', _blocks: blocks, _enforce });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
