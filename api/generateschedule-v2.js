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
import { deriveBlocks, parseParkHoursForDate, buildCatalogFilter, whichParkAt, parseHourMin, isAttractionAvailable } from './schedule-engine.js';

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

// Load the WEEKLY dynamic blob (closures, events) -- separate cadence from the monthly CATALOG.
async function loadDynamicSections() {
  try {
    const { blobs } = await list({ prefix: 'twize/park_intel_dl_dynamic.json' });
    if (blobs && blobs.length) {
      const url = blobs[0].downloadUrl || blobs[0].url;
      const blob = await fetch(url).then(r => r.json());
      return (blob.data && blob.data.sections) || blob.sections || {};
    }
  } catch (e) { console.error('[v2] dynamic read error:', e.message); }
  return {};
}

// Build a closure-override map { normalizedName: {status, reopenDate, reopenConfidence} } from the
// structured weekly CLOSURES section. This is the FRESH source of truth for open/closed and reopen
// dates; it overrides the monthly CATALOG's per-attraction status fields (which can be ~30 days stale).
// If the structured section is absent (older cache), returns null and v2 falls back to CATALOG fields.
function buildClosureOverrides(dynamicSections) {
  if (!dynamicSections) return null;
  let cl = dynamicSections.CLOSURES;
  if (typeof cl === 'string') { try { cl = JSON.parse(cl); } catch (e) { cl = null; } }
  if (!Array.isArray(cl)) return null;
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const map = {};
  cl.forEach(c => {
    if (c && c.name) {
      map[norm(c.name)] = {
        status: c.status != null ? c.status : 'closed_for_refurbishment',
        reopenDate: c.reopenDate != null ? c.reopenDate : null,
        reopenConfidence: c.reopenConfidence != null ? c.reopenConfidence : 'unknown'
      };
    }
  });
  return Object.keys(map).length ? map : null;
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
function candidateMenu(catalog, park, shortestHeightInches, tripDate, closureOverrides) {
  const f = buildCatalogFilter(catalog, park, tripDate, closureOverrides); // drops wrong-park, excluded, AND closed-on-trip-date
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

    // ---- WEEKLY closures (date-aware). The structured CLOSURES section is the fresh source of truth
    // for open/closed + reopen dates; it overrides the monthly CATALOG status. tripDate is THIS day's
    // date, so a ride closed-but-reopening-before-our-visit is correctly treated as available. ----
    const dynamicSections = await loadDynamicSections();
    const closureOverrides = buildClosureOverrides(dynamicSections);
    const tripDate = (day && day.date) ? String(day.date).slice(0, 10) : null;

    const shortest = (tripConfig.groupProfile && typeof tripConfig.groupProfile.shortestHeightInches === 'number')
      ? tripConfig.groupProfile.shortestHeightInches : 0;

    // ---- strategy context (the cache the model reads to DECIDE) ----
    // PER-SECTION budgets so EVERY strategy section reaches the model. A single global slice(0,5000)
    // previously let WAIT_PATTERNS (~14KB of raw multipliers) eat the whole budget and silently drop
    // LIGHTNING_LANE_STRATEGY, DINING_TIMING, and PARK_HOP_STRATEGY entirely -- so the model was deciding
    // LL/dining/hop with NO cache data. WAIT_PATTERNS is capped tighter (it's bulk numbers); the
    // actionable prose sections get enough room to arrive whole.
    const STRAT_BUDGET = { ROPE_DROP_STRATEGY: 2000, WAIT_PATTERNS: 3500, LIGHTNING_LANE_STRATEGY: 6500, DINING_TIMING: 6500, PARK_HOP_STRATEGY: 5000 };
    const strat = [];
    ['ROPE_DROP_STRATEGY', 'WAIT_PATTERNS', 'LIGHTNING_LANE_STRATEGY', 'DINING_TIMING', 'PARK_HOP_STRATEGY']
      .forEach(k => {
        if (!sections[k]) return;
        const raw = typeof sections[k] === 'string' ? sections[k] : JSON.stringify(sections[k]);
        const cap = STRAT_BUDGET[k] || 3000;
        strat.push(k + ':\n' + (raw.length > cap ? raw.slice(0, cap) : raw));
      });
    const stratText = strat.join('\n\n');

    // ---- reservations the user explicitly entered (must appear at their times) ----
    // A confirmed reservation exists on exactly ONE day. Bind it to its day (PHYSICS): only surface
    // it on its own day, and tell the model to AVOID that venue on every other day so a single
    // reservation can't be scattered across days (e.g. a Day-3 Cafe Orleans dinner showing up as a
    // Day-1 lunch). Day numbering: structured r.day and string "Day N" are 1-based == dayIndex+1.
    const thisDayNum = dayIndex + 1;
    const flatRes = Array.isArray(tripConfig.reservations) ? tripConfig.reservations : [];
    const structRes = (tripConfig.dining && Array.isArray(tripConfig.dining.reservations)) ? tripConfig.dining.reservations : [];
    // extract a 1-based day from a string reservation like "cafe orleans, 5:30pm, Day 3" (null if none)
    const dayOfStr = str => { const m = String(str).match(/day\s*(\d+)/i); return m ? Number(m[1]) : null; };
    // reservation lines for THIS day only (string with no day -> show on all days, can't tell)
    const resLinesToday = []
      .concat(flatRes.filter(str => { const d = dayOfStr(str); return d == null || d === thisDayNum; })
        .map(str => typeof str === 'string' ? str : JSON.stringify(str)))
      .concat(structRes.filter(r => r && r.name && (r.day == null || Number(r.day) === thisDayNum))
        .map(r => r.name + (r.time ? ' @ ' + r.time : '')))
      .filter(Boolean);
    // venues reserved on OTHER days -> the model must NOT schedule these today (avoids scatter)
    const otherDayResNames = []
      .concat(flatRes.filter(str => { const d = dayOfStr(str); return d != null && d !== thisDayNum; })
        .map(str => String(str).split(',')[0].trim()))
      .concat(structRes.filter(r => r && r.name && r.day != null && Number(r.day) !== thisDayNum)
        .map(r => r.name))
      .filter(Boolean);
    const resLines = resLinesToday;

    // ---- build the SLIM per-block prompt ----
    const blockText = blocks.map((b, i) => {
      const menu = candidateMenu(catalog, b.park, shortest, tripDate, closureOverrides);
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
+ '5. Day starts at the first block\'s open time and STAYS ACTIVE until ~30 minutes before the last block\'s close time. The last scheduled ride/show must be no earlier than 30 min before close -- an evening that ends 2-3 hours early is wrong. Fill the whole day.\n'
+ (vip ? '6. VIP TOUR from ' + minToLabel(vip.startMin) + ' to ' + minToLabel(vip.endMin) + '. The guide MEETS THE GROUP exactly at ' + minToLabel(vip.startMin) + ' (the tour start time) -- schedule the "guide meets your group" item AT ' + minToLabel(vip.startMin) + ', never earlier. Do NOT put any VIP/guide item before the start time. BEFORE ' + minToLabel(vip.startMin) + ' and AFTER ' + minToLabel(vip.endMin) + ', plan a completely normal self-guided day (rope drop, standby/Lightning Lane rides, meals) as if there were no tour -- the morning before the tour should include a normal starting-park rope-drop ride. DURING the window the guide leads and handles skip-the-line; mark those items type "tip"/"ride" with a note that the guide leads, and do NOT schedule normal standby rides against the guide -- the guide picks rides live.\n' : '')
+ 'STRATEGY (you decide, using this verified cache data -- vary by crowd/wait, do not be robotic):\n'
+ '- Open the day with a rope-drop ride IN THE STARTING PARK (the first block\'s park): pick the highest-value ropeDrop=high attraction from THAT block\'s list. This rope-drop choice OVERRIDES cross-day variety -- a strong rope-drop in the park you are actually standing in matters more than avoiding a repeat, so repeat it if it is the best opener. Never open with a meal, and never rope-drop a ride from the other park.\n'
+ '- Fill the first block primarily with attractions from the STARTING park before the hop -- do not lean on the second park\'s list to fill the morning.\n'
+ '- FILL THE EVENING TO CLOSE: the nighttime spectacular (fireworks, World of Color, Fantasmic!) is a MIDPOINT of the night, NOT the end. After it, schedule 2-4 more rides until ~30 min before close -- standby waits drop to their lowest of the day during and right after the show, so this is prime ride time. These late rides are normal ride cards (same format, same warm one-sentence note) -- never label them differently or treat them as filler. Pick the night show ONCE for the trip across all days; do not repeat the same spectacular on multiple days.\n'
+ '- Pick venues from the lists. service=table means a sit-down meal (a reservation or walk-up list); quickservice is a counter grab; lounge is a walk-up lounge. Do not treat a table-service spot as a quick grab.\n'
+ (resLines.length ? '- CONFIRMED RESERVATIONS for THIS day that MUST appear at their stated times: ' + resLines.join(' | ') + '\n' : '')
+ (otherDayResNames.length ? '- These venues are reserved on a DIFFERENT day, so do NOT schedule them today: ' + otherDayResNames.join(' | ') + '\n' : '')
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
+ 'STRATEGY CACHE (verified sources -- use to decide rope-drop, waits, LL, dining timing):\n' + stratText
+ (dining ? '\n\nDINING INTEL (verified venue detail -- use for which venue to pick and why; still obey the block VENUE lists for what is physically available):\n' + String(dining).slice(0, 4000) : '');

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
    // Single source of truth for normalizing a schedule item's ride name for catalog matching.
    // Strips rope-drop prefixes (colon form 'Rope Drop:' AND dash form 'Rope Drop -/\u2014') and
    // trailing (LL...)/(night...) adornments, then lowercases/strips punctuation. ORDERING: em-dash
    // form MUST run before colon form -- 'Rope Drop \u2014 Star Wars: Rise of ...' has a colon in
    // the ride name; the colon-form regex [^:]*: would eat through 'Star Wars:' and strip too much.
    const cleanRideName = h => String(h || '')
      .replace(/^rope drop\s*[\u2014-]\s*/i, '')
      .replace(/^rope drop[^:]*:\s*/i, '')
      .replace(/\s*\((ll|lightning)[^)]*\)\s*$/i, '')
      .replace(/\s*\(night[^)]*\)\s*$/i, '')
      .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (Array.isArray(parsed) && parsed.length) {
      // precompute per-park ride name sets (normalized) from the catalog
      const _norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      const _parkRideSet = {};
      blocks.forEach(b => {
        if (!_parkRideSet[b.park]) {
          const f = buildCatalogFilter(catalog, b.park, tripDate, closureOverrides);
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
          const rideName = cleanRideName(it.h);
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

    // ---- ROPE-DROP GUARANTEE (physics, code-enforced): the morning is the most important hour and
    // rope-drop strategy differs by park. After wrong-park drops, ensure the day OPENS with a real
    // rope-drop ride IN THE STARTING PARK. If the first ride isn't a starting-park ropeDrop=high ride,
    // prepend the best available one at park open. Picks the single-ILL headliner first (Rise for DL,
    // Radiator Springs for DCA), else the first high-value rope-drop ride in the starting park that the
    // model didn't already schedule. Deterministic -- no model dependency. ----
    _enforce.ropeDrop = null;
    if (Array.isArray(parsed) && parsed.length && blocks.length) {
      const _norm2 = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      const startPark = blocks[0].park;
      const startOpen = blocks[0].startMin;
      // high-value rope-drop rides in the starting park, headliner (single ILL) first
      // date-aware availability (same rule as buildCatalogFilter): never rope-drop a ride that's
      // closed THROUGH the trip date; a ride reopening before our visit is eligible.
      const rdPool = catalog.attractions
        .filter(a => a.park === startPark && a.ropeDropValue === 'high' && a.exclude !== true && isAttractionAvailable(a, tripDate, closureOverrides))
        .sort((a, b) => (a.llKind === 'single' ? -1 : 0) - (b.llKind === 'single' ? -1 : 0));
      // names already scheduled as rides today (cleaned)
      const usedNames = new Set(parsed.filter(it => it && it.type === 'ride')
        .map(it => _norm2(cleanRideName(it.h))));
      // find the first actual RIDE of the day (by time) and whether it's a starting-park rope-drop ride
      const ridesByTime = parsed.filter(it => it && it.type === 'ride' && it.t)
        .sort((a, b) => parseHourMin(a.t) - parseHourMin(b.t));
      const firstRide = ridesByTime[0];
      const startParkHighSet = new Set(rdPool.map(a => _norm2(a.name)));
      const firstRideIsStartRopeDrop = firstRide && startParkHighSet.has(_norm2(cleanRideName(firstRide.h)));
      if (!firstRideIsStartRopeDrop && rdPool.length) {
        // Prefer pulling forward a high rope-drop ride the model ALREADY scheduled (headliner/single-ILL
        // first) so we don't strand it or add a second headliner; else introduce the best unused one;
        // else reuse the headliner (a repeat is fine for the single most important slot of the day).
        const pick = rdPool.find(a => usedNames.has(_norm2(a.name)))
          || rdPool.find(a => !usedNames.has(_norm2(a.name)))
          || rdPool[0];
        const openItem = {
          t: minToLabel(startOpen),
          h: 'Rope Drop: ' + pick.name,
          type: 'ride',
          n: 'Be at the gate before open and head straight here -- ' + pick.name + ' builds the longest lines fastest, so riding it first saves the most time of any move all day.',
          land: pick.land
        };
        // remove any existing copy of this exact ride so it isn't duplicated, then prepend
        parsed = parsed.filter(it => !(it && it.type === 'ride' &&
          cleanRideName(it.h) === cleanRideName(pick.name)));
        parsed.unshift(openItem);
        _enforce.ropeDrop = { added: pick.name, park: startPark, at: openItem.t };
      }
    }

    // ---- ARRIVAL GUARANTEE (physics, code-enforced, EVERY day no exceptions): the day must open with
    // an "arrive ~1 hour before park open" positioning card, BEFORE the rope-drop ride. The prompt can't
    // be trusted to do this every time, and it's a universal rule, so code guarantees it. The card is a
    // normal 'tip' card with a warm note -- reads identically to every other card. Placed at open-minus-60
    // and physically first in the array (also earliest by time, so any client/validator time-sort keeps
    // it first). De-dupes any arrival card the model already wrote. ----
    _enforce.arrival = null;
    if (Array.isArray(parsed) && blocks.length) {
      const startOpenMin = blocks[0].startMin;
      const arriveMin = Math.max(0, startOpenMin - 60);
      // remove any arrival/positioning card the model already added, so we don't double up
      parsed = parsed.filter(it => !(it && it.type === 'tip' &&
        /\barriv|be at the (gate|park|entrance)|before (the )?park opens|rope ?drop positioning|get to the gate/i.test(it.h || '')));
      const arriveItem = {
        t: minToLabel(arriveMin),
        h: 'Arrive at the park',
        type: 'tip',
        n: 'Get to the gate about an hour before the ' + minToLabel(startOpenMin) + ' open -- clearing security and bag check early puts you at the rope ready to go, which is the single biggest head start on the day.',
        land: (blocks[0].park === 'DCA') ? 'Esplanade / DCA Entrance' : 'Esplanade / Main Entrance'
      };
      parsed.unshift(arriveItem);
      _enforce.arrival = { at: arriveItem.t, open: minToLabel(startOpenMin) };
    }

    // ---- VIP SINGLE-CARD COLLAPSE (physics, code-enforced): on a VIP-tour day the guide leads the
    // whole window, so the schedule must show ONE card spanning vip.startMin -> vip.endMin, not a string
    // of scattered ride/meal/character cards. The ride-by-ride detail lives in the shared live-notes
    // component (pushed to everyone logged in, editable like a Google doc) -- NOT in static schedule
    // cards. So: drop every item whose time falls inside the VIP window and replace with a single VIP
    // card at the start time. Items BEFORE the window (arrival, rope-drop, morning rides) and AFTER it
    // (evening) are untouched -- the morning/evening stay normal self-guided cards. ----
    _enforce.vipCollapse = null;
    if (Array.isArray(parsed) && parsed.length && intent.vip &&
        typeof intent.vip.startMin === 'number' && typeof intent.vip.endMin === 'number') {
      const vS = intent.vip.startMin, vE = intent.vip.endMin;
      const before = parsed.length;
      // keep only items strictly OUTSIDE the window (start-exclusive at end so a card exactly at vE,
      // e.g. a "tour ends" handoff, is treated as inside and removed too)
      const kept = parsed.filter(it => {
        if (!it || !it.t) return true; // untimed items (rare) pass through
        const m = parseHourMin(it.t);
        if (m < 0) return true;
        return m < vS || m > vE;
      });
      const removed = before - kept.length;
      const vipCard = {
        t: minToLabel(vS),
        h: 'VIP Tour',
        type: 'vip',
        n: 'Your VIP guide leads the group from ' + minToLabel(vS) + ' to ' + minToLabel(vE) + ', handling every line and routing live -- just follow along. The running ride list and any updates show up in your shared trip notes.',
        land: (blocks[0] && blocks[0].park === 'DCA') ? 'Disney California Adventure' : 'Disneyland'
      };
      kept.push(vipCard);
      // keep the day time-sorted (untimed items sink to the end)
      kept.sort((a, b) => {
        const ma = a && a.t ? parseHourMin(a.t) : 100000;
        const mb = b && b.t ? parseHourMin(b.t) : 100000;
        return ma - mb;
      });
      parsed = kept;
      _enforce.vipCollapse = { window: minToLabel(vS) + '-' + minToLabel(vE), removed: removed, replacedWithOneCard: true };
    }

    // ---- NIGHT-FILL CHECK (verifier, NOT a filler): measure whether the last real activity reaches
    // close. We deliberately do NOT inject evening cards here -- code-appended rides can't carry the
    // model's warm note, and night cards must read identically to day cards. So this only RECORDS the
    // gap in _enforce.underfilled; the fill itself is the prompt's job (Rule 5 + the evening strategy
    // line). If live verification shows the model still ends early, escalate the prompt -- not filler. ----
    _enforce.underfilled = null;
    if (Array.isArray(parsed) && parsed.length && blocks.length) {
      const lastBlockClose = blocks[blocks.length - 1].endMin;
      const realTypes = ['ride', 'show', 'dining', 'quickservice', 'snack', 'character', 'vip'];
      const lastRealMin = parsed
        .filter(it => it && realTypes.indexOf(it.type) !== -1 && it.t)
        .reduce((mx, it) => Math.max(mx, parseHourMin(it.t)), -1);
      if (lastRealMin >= 0 && lastRealMin < lastBlockClose - 45) {
        _enforce.underfilled = {
          lastActivityMin: lastRealMin,
          lastActivity: minToLabel(lastRealMin),
          closeMin: lastBlockClose,
          close: minToLabel(lastBlockClose),
          gapMin: lastBlockClose - lastRealMin
        };
      }
    }

    return res.status(200).json({ ok: true, text, parsed, model: data.model, _engine: 'v2', _blocks: blocks, _enforce });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
