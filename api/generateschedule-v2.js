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
import { deriveBlocks, parseParkHoursForDate, buildCatalogFilter, whichParkAt, parseHourMin, isAttractionAvailable, appendEveningHopBack } from './schedule-engine.js';
import { getRopeDropRanking, normRideName } from './schedule-rules.js';
import { assignRopeDropsAcrossDays, assignRidesAcrossDays } from './schedule-skeleton.js';
import { enforceBreaks, enforceMealWindows, enforceExclusions } from './schedule-corrections.js';
import { assignShowsAcrossDays, applyShowAssignment } from './schedule-shows.js';

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
function candidateMenu(catalog, park, shortestHeightInches, tripDate, closureOverrides, reservedVenueSet) {
  const f = buildCatalogFilter(catalog, park, tripDate, closureOverrides); // drops wrong-park, excluded, AND closed-on-trip-date
  const _vn = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  // STRUCTURAL: a reservation-REQUIRED venue is only a real option if the trip holds a reservation for it.
  // Otherwise the model keeps suggesting fine-dining (Carthay Circle Restaurant) as a spontaneous meal.
  // Drop required venues the group has not reserved; keep walkup/lounge/quickservice venues as-is.
  const usableVenues = f.venues.filter(v => {
    // PHYSICS rule: a sit-down (service:table) venue OR a reservation-REQUIRED venue is only a real
    // option if the trip actually holds a reservation for it. Table-service walk-ups are NOT offered
    // spontaneously -- no table-service venue appears on the schedule unless explicitly reserved.
    // Quickservice and lounges stay as walk-up options.
    const policy = (v.reservationPolicy || 'walkup');
    const isTable = String(v.service || 'quickservice').toLowerCase() === 'table';
    if (policy === 'required' || isTable) {
      return reservedVenueSet && reservedVenueSet.has(_vn(v.name));
    }
    return true;
  });
  const rideLines = f.attractions
    .map(a => {
      const tooTall = (shortestHeightInches > 0 && a.heightInches > shortestHeightInches);
      return '- ' + a.name + ' [' + a.land + '] ll=' + (a.llKind || 'none')
        + ' ropeDrop=' + (a.ropeDropValue || 'med')
        + (a.heightInches ? ' height=' + a.heightInches + 'in' : '')
        + (tooTall ? ' (HEIGHT: someone in group is below this -- include a rider-swap note if used)' : '');
    })
    .join('\n');
  const venueLines = usableVenues
    .map(v => '- ' + v.name + ' [' + v.land + '] ' + (v.service || 'quickservice')
      + ' resv=' + (v.reservationPolicy || 'walkup')
      + (v.walkupEase ? ' walkup=' + v.walkupEase : ''))
    .join('\n');
  return { rideLines, venueLines, rideCount: f.attractions.length, venueCount: usableVenues.length };
}

// Extract the FIRST complete, balanced JSON array from model text. Scans from the first '[' and
// matches its closing ']' by bracket depth, ignoring '[' or ']' that appear inside string literals.
// This is robust to anything the model adds AFTER the array (explanatory prose, a second code block,
// a stray bracket) -- the old indexOf('[')..lastIndexOf(']') approach spanned to the last bracket
// anywhere in the text and threw "Unexpected non-whitespace after JSON" whenever extra content
// followed the array, which silently produced an EMPTY day (observed on the complex VIP day).
// Returns the array substring, or null if no balanced array is found (e.g. truncated output).
function extractFirstJsonArray(text) {
  if (!text) return null;
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null; // unbalanced (likely truncated) -> caller leaves parsed null
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
    const { dayIndex, tripConfig, maxTokens = 8000, priorRides = [], priorShows = [] } = body;
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
    let blocks = deriveBlocks(intent, parkHoursForDate);
    // Park-hopper optimization: if the configured hop would leave the day ending in the
    // earlier-closing park while the start park is open meaningfully later, append an evening
    // hop-back block so the day runs until ~30 min before the LATEST park close (not the earlier
    // one). Additive: single-park days and days already ending in the later-closing park are
    // unchanged. Everything downstream (blockText, whichParkAt wrong-park guard, night-fill) is
    // block-driven, so it adapts to the 3rd block automatically.
    blocks = appendEveningHopBack(blocks, parkHoursForDate);

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

    // ---- reserved-venue name set across the WHOLE trip (normalized) ----
    // A reservationPolicy:"required" venue (e.g. Carthay Circle Restaurant) should only ever be offered
    // to the model if the trip actually holds a reservation for it. Day-binding is handled separately by
    // resLines/otherDayResNames; this set just answers "is this required venue reserved at all on the
    // trip?" so candidateMenu can drop required venues the group has no reservation for. The group's only
    // reservation here is Cafe Orleans -> Carthay (required) gets filtered out, fixing the bug where it was
    // suggested as a spur-of-the-moment dinner against a "quick service mostly" preference.
    const _vnorm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const reservedVenueSet = new Set(
      []
        .concat(flatRes.map(str => String(str).split(',')[0]))
        .concat(structRes.map(r => (r && r.name) || ''))
        .map(_vnorm)
        .filter(Boolean)
    );

    // ---- build the SLIM per-block prompt ----
    const blockText = blocks.map((b, i) => {
      const menu = candidateMenu(catalog, b.park, shortest, tripDate, closureOverrides, reservedVenueSet);
      return 'BLOCK ' + (i + 1) + ' -- ' + b.park + ' from ' + minToLabel(b.startMin) + ' to ' + minToLabel(b.endMin) + '.\n'
        + 'You may ONLY use attractions and venues from THIS block\'s lists (they are physically in ' + b.park + '):\n'
        + 'RIDES (' + menu.rideCount + '):\n' + menu.rideLines + '\n'
        + 'VENUES (' + menu.venueCount + '):\n' + menu.venueLines;
    }).join('\n\n');

    // If an evening hop-back block was appended, tell the model explicitly so it adds the hop card
    // and fills that block (its menu is the same park as an earlier block, so it must use rides not
    // already used). Empty string on normal days.
    const _hb = blocks.find(b => b && b.hopBack);
    const hopBackNote = _hb
      ? ('EVENING HOP-BACK: the LAST block returns to ' + _hb.park + ' for the late evening because '
         + _hb.park + ' stays open later than the park you were in before it. Add a brief "Park Hop to '
         + (_hb.park === 'DCA' ? 'Disney California Adventure' : 'Disneyland') + '" tip card at '
         + minToLabel(_hb.startMin) + ', then fill that block with ' + _hb.park
         + ' rides you have NOT used earlier in the day, running until ~30 min before '
         + minToLabel(_hb.endMin) + '. This is prime time -- post-show waits are at their lowest.\n\n')
      : '';

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
+ '- The day OPENS with a pre-selected rope-drop ride in the starting park (it is added for you at park open). Do NOT add your own "Rope Drop" card, do NOT open with a meal, and do NOT schedule a rope-drop ride from the other park. Plan the rest of the morning around that opener.\n'
+ '- Fill the first block primarily with attractions from the STARTING park before the hop -- do not lean on the second park\'s list to fill the morning.\n'
+ '- WRONG-PARK TIPS ARE FORBIDDEN: every card (ride AND tip) must belong to the park of the block its time falls in. Do NOT, in an early block, emit a rope-drop tip, a "Book Lightning Lane" tip, a "head to" tip, or any actionable instruction that names a ride in the OTHER park (the park you have not hopped to yet). There is no "Block 2 rope drop" for the second park -- you rope-drop ONCE, in the starting park, at open. Lightning Lane bookings for the second park only make sense AFTER the hop time; do not schedule them while still in the first park.\n'
+ '- FILL THE EVENING TO CLOSE: the nighttime spectacular (fireworks, World of Color, Fantasmic!) is a MIDPOINT of the night, NOT the end. After it, schedule 2-4 more rides until ~30 min before close -- standby waits drop to their lowest of the day during and right after the show, so this is prime ride time. These late rides are normal ride cards (same format, same warm one-sentence note) -- never label them differently or treat them as filler. Pick the night show ONCE for the trip across all days; do not repeat the same spectacular on multiple days.\n'
+ '- Pick venues from the lists. service=table means a sit-down meal (a reservation or walk-up list); quickservice is a counter grab; lounge is a walk-up lounge. Do not treat a table-service spot as a quick grab.\n'
+ (resLines.length ? '- CONFIRMED RESERVATIONS for THIS day that MUST appear at their stated times: ' + resLines.join(' | ') + '\n' : '')
+ (otherDayResNames.length ? '- These venues are reserved on a DIFFERENT day, so do NOT schedule them today: ' + otherDayResNames.join(' | ') + '\n' : '')
+ (llOn ? 'LIGHTNING LANE REMINDERS (Lightning Lane is ON): add standalone booking-reminder cards (type "tip") that guide the group to use Lightning Lane Multi Pass optimally. HOW LLMP ACTUALLY WORKS AT DISNEYLAND (follow this mechanic exactly, do NOT invent fixed booking clock-times): you hold ONE Multi Pass selection at a time; you book your next selection the moment you tap into your current Lightning Lane ride (or 2 hours after booking, whichever comes first) -- in practice you re-book right when you tap in, so bookings are paced by your ride flow, NOT by a fixed 2-hour clock. So: (1) FIRST reminder card at park entry (' + minToLabel(blocks[0].startMin) + '): "book your #1 priority LLMP-eligible ride now." (2) Then up to FOUR more reminder cards (HARD CAP: 5 LL reminder cards TOTAL per day, INCLUDING the park-open one -- never exceed 5, and do not let LL cards dominate the timeline), one for each of the highest-priority LLMP-eligible rides in priority order. Place each reminder right before/at the LLMP ride they will be tapping into when that booking unlocks, framed as event-driven: e.g. "While you tap into [current LLMP ride], book your next Lightning Lane: [next priority ride]." Cover the TOP rides only -- if there are more than 5 LLMP-eligible rides, pick the 5 highest-priority / longest-wait ones and skip reminders for the rest (guests can rebook those on their own when they tap in). Name the specific rides (ll="multi" attractions). Do NOT state an exact booking time as if it were known -- the timing is driven by when they tap in. Individual Lightning Lane / Single Pass (ll="single", e.g. Rise of the Resistance, Radiator Springs Racers) are SEPARATE one-time paid buys -- mention them once if relevant but they are NOT part of the Multi Pass reminder chain.\n' : '- Lightning Lane is OFF: standby only, no LL reminder cards.\n')
+ '- Include a morning snack and an afternoon snack (real venue names from the lists, not "Morning Snack").\n'
+ '- If the group has character interest and a character category fits, include 1-2 character meets as type "character" with a real location.\n'
+ 'OUTPUT: Return ONLY a raw JSON array (no prose, no markdown) of items with fields: t ("H:MM AM"), h (activity name), type (ride|show|dining|quickservice|break|tip|snack|character), n (one warm sentence explaining why/when), land (land name). Order by time.';

    // ---- CROSS-DAY RIDE ALLOCATION (variety + must-do seeding). Deterministic, PURE function of
    // ALL days; recomputed identically on every per-day call and indexed by dayIndex (exactly like
    // rope-drops/shows), so the parallel calls agree without coordination. It decides the SET of
    // rides each day features; the model still routes/times them and writes the notes. The VIP tour
    // window is carved out of that day's blocks so guide-led hours do not soak up the trip's ride
    // budget, and we do NOT inject the plan on a VIP day (the guide picks live) -- the allocation
    // still RUNS for all days so the non-VIP days' shares are computed against the right capacity. ----
    let _featuredLines = [];
    try {
      const _ranking = getRopeDropRanking(sections);
      const _mustDoNorm = new Set(((((tripConfig.ridePreferences || {}).mustDo) || [])).map(normRideName));
      const _skipNorm = new Set(((((tripConfig.ridePreferences || {}).skip) || tripConfig.neverSchedule || []) || []).map(normRideName));
      const _poolByPark = { DL: [], DCA: [] };
      const _attrByNorm = new Map();
      (catalog.attractions || []).forEach((a) => {
        if (!a) return;
        _attrByNorm.set(normRideName(a.name), a);
        if (a.exclude === true) return;
        if (_skipNorm.has(normRideName(a.name))) return;
        const _p = String(a.park).toUpperCase() === 'DCA' ? 'DCA' : 'DL';
        _poolByPark[_p].push(a.name);
      });
      const _dayDates = days.map((d) => (d && d.date) ? String(d.date).slice(0, 10) : null);
      const _isAvail = (idx, rideName) => {
        const a = _attrByNorm.get(normRideName(rideName));
        if (!a) return true;
        return isAttractionAvailable(a, _dayDates[idx], closureOverrides);
      };
      const _allDaysAlloc = days.map((d, i) => {
        const _di = (d && d.intent) || { startPark: /dca|california/i.test((d && (d.startPark || d.park)) || '') ? 'DCA' : 'DL', hop: null, vip: null };
        let _ph = Array.isArray(tripConfig.parkHours) ? parseParkHoursForDate(tripConfig.parkHours, i) : null;
        if (!_ph) _ph = { DL: { openMin: 480, closeMin: 1380 }, DCA: { openMin: 480, closeMin: 1320 } };
        let _bl = deriveBlocks(_di, _ph);
        _bl = appendEveningHopBack(_bl, _ph);
        const _vw = _di.vip;
        if (_vw && typeof _vw.startMin === 'number' && typeof _vw.endMin === 'number') {
          const _carved = [];
          _bl.forEach((b) => {
            if (b.endMin <= _vw.startMin || b.startMin >= _vw.endMin) { _carved.push(b); return; }
            if (b.startMin < _vw.startMin) _carved.push({ park: b.park, startMin: b.startMin, endMin: _vw.startMin });
            if (b.endMin > _vw.endMin) _carved.push({ park: b.park, startMin: _vw.endMin, endMin: b.endMin });
          });
          _bl = _carved;
        }
        return { dayIndex: i, blocks: _bl };
      });
      const _alloc = assignRidesAcrossDays({ days: _allDaysAlloc, ranking: _ranking, poolByPark: _poolByPark, mustDoNorm: _mustDoNorm, isAvailableForDay: _isAvail });
      const _mine = (_alloc && _alloc[dayIndex]) || {};
      if (!vip) {
        _featuredLines = Object.keys(_mine)
          .filter((pk) => Array.isArray(_mine[pk]) && _mine[pk].length)
          .map((pk) => pk + ' -> ' + _mine[pk].join(', '));
      }
    } catch (e) { _featuredLines = []; }

    // ---- GROUP PREFERENCES -> soft prompt context (dietary, accessibility, quick-service wishlist).
    // Quick-service-only dining is enforced structurally in candidateMenu (table service appears only
    // via reservations); these only shape QS/snack picks and add helpful notes -- guidance, not physics. ----
    const _dietRaw = Array.isArray(tripConfig.dietaryNeeds) ? tripConfig.dietaryNeeds : [];
    const _diet = _dietRaw.filter((x) => x && !/^no restrictions$/i.test(String(x).trim()));
    const _dietaryLine = _diet.length
      ? 'Group dietary needs: ' + _diet.join(', ') + '. When choosing quick-service meals AND snacks, favor venues that can accommodate these and note the accommodation in the card.\n'
      : '';
    const _acc = Array.isArray(tripConfig.accessibility) ? tripConfig.accessibility : [];
    const _accBits = [];
    if (_acc.indexOf('mobility') !== -1) _accBits.push('someone uses a wheelchair or ECV -- keep walking between consecutive stops modest, prefer step-free routes, and note accessible ride entrances where relevant');
    if (_acc.indexOf('service') !== -1) _accBits.push('the group travels with a service animal -- on a couple of stops add a brief note pointing out the nearest service-animal relief area');
    const _accLine = _accBits.length ? 'Accessibility: ' + _accBits.join('; ') + '.\n' : '';
    const _wish = (typeof tripConfig.wantedRestaurants === 'string' ? tripConfig.wantedRestaurants : '').trim();
    const _wishLine = _wish
      ? 'Quick-service spots the group would love if they fit the route and the park they are in: ' + _wish + '. Work in the ones that are counter-service and on the day\'s path; if any named spot is table-service, do NOT schedule it -- it belongs to their reservations only.\n'
      : '';
    const user =
'Build Day ' + (dayIndex + 1) + ' of ' + days.length + '. Date: ' + (day.date || '') + '.\n'
+ 'Trip: ' + (tripConfig.tripName || '') + '. Thrill level: ' + (tripConfig.thrillLevel || 'mix') + '.\n'
+ 'Must-do rides: ' + (((tripConfig.ridePreferences || {}).mustDo || []).join(', ') || 'none') + '.\n'
+ 'Never schedule: ' + (((tripConfig.ridePreferences || {}).skip || tripConfig.neverSchedule || []).join(', ') || 'none') + '.\n'
+ 'Character interest: ' + (((tripConfig.characters || {}).categories || []).join(', ') || 'none') + ' (priority ' + ((tripConfig.characters || {}).priority || 'niceToHave') + ').\n'
+ 'Shortest person height: ' + (shortest > 0 ? shortest + ' inches (apply rider-swap on taller-requirement rides)' : 'everyone meets all height requirements') + '.\n\n'
+ _dietaryLine
+ _accLine
+ _wishLine
+ (_featuredLines.length
    ? 'VARIETY PLAN (already balanced across your whole trip so the days do not repeat -- LEAD with these rides today, in roughly this priority order; you may add a few others from the block lists if time remains, and you need NOT force every one if the day fills up): '
      + _featuredLines.join('  |  ')
      + '. Must-do rides the group chose are already folded into this list wherever their park is visited -- never drop a must-do.\n'
    : '')
+ (Array.isArray(priorShows) && priorShows.length
    ? 'NO-REPEAT (HARD RULE): earlier days of this trip already used these nighttime shows and sit-down dinners: '
      + [...new Set(priorShows)].join(', ') + '. Do NOT schedule any of these again on this day -- the nighttime spectacular (fireworks, World of Color, Fantasmic!) and sit-down/table-service dinners must each appear only ONCE across the whole trip. Treat a show or venue as ALREADY USED even if you would name it slightly differently -- match on the core name and ignore location/edition suffixes (e.g. "Fantasmic!" = "Fantasmic! at Disneyland"; "World of Color" = "World of Color -- Happiness!"). Pick a DIFFERENT show and a DIFFERENT sit-down dinner today. (This is stricter than ride variety: rides may repeat for must-dos; shows and table-service dinners may not.)\n'
    : '')
+ 'PARK BLOCKS FOR TODAY (physics -- you cannot leave these):\n' + blockText + '\n\n' + hopBackNote
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
      const arr = extractFirstJsonArray(t);
      if (arr) parsed = JSON.parse(arr);
    } catch (e) { /* leave parsed null; client falls back to text */ }

    // ---- NIGHT-FILL RE-PROMPT (structural, but the MODEL still authors the cards): the single most
    // common evening failure is the model treating the nighttime spectacular (fireworks / World of Color
    // / Fantasmic!) as the FINALE and stopping there, leaving 1-2 hours of open park unscheduled. Live
    // verification confirmed this: days ended on the show at 8:30-9:20 PM against a 10-11 PM close even
    // with the prompt's evening rule present. Pure prompt escalation did not move it, and dumb code-
    // appended filler can't carry a warm note. So when the parsed day ends > 45 min before the last
    // block's close, fire ONE focused follow-up call asking the model for ONLY the post-show ride cards
    // needed to bridge to ~20 min before close -- same warm format, rides in the closing block's park
    // that were not already used today. The new cards are spliced into `parsed` BEFORE physics
    // enforcement below, so they pass through the same wrong-park / dedup / sort guards as everything
    // else. This is inherently PER-DAY: a day that already fills to close (gap <= 45) never triggers it,
    // so a perfectly-timed evening is left untouched. ----
    let _enforce = { dropped: [] };
    _enforce.variety = _featuredLines.length ? _featuredLines : null;
    // (night-fill re-prompt MOVED below, to run AFTER VIP collapse / show-dedup so it sees the final timeline)

    // ---- PHYSICS ENFORCEMENT (code, not prompt): drop any RIDE scheduled into a block whose park
    // does not contain it. The model is told to stay in-block, but prompt rules can lose to the data;
    // this guarantees a ride's time falls in a block whose park's catalog actually has that ride.
    // Conservative: only drops type 'ride' items we can confidently match as wrong-park. Never touches
    // meals/tips/shows/snacks. Does NOT regenerate or insert filler (that was the scaffold's failure). ----
    // (_enforce is declared earlier, before the night-fill re-prompt block, so that block can record into it.)
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
        // tip/character cards can carry actionable wrong-park guidance even when no ride card does
        // (e.g. on a hop day the model invents a pre-hop "Rope Drop -- Peter Pan's Flight (DL Block 2)"
        // or "Book Next Lightning Lane: Haunted Mansion (DL)" inside the morning DCA block). Those
        // bypass the ride-only check above. Drop a tip/character ONLY when it is an actionable NOW
        // instruction (rope drop / book LL / head to) AND its text names a ride that belongs to the
        // OTHER park for the block it sits in. Passive future mentions ("after you hop to DL...") are
        // left alone: they are not rope-drop/book-now phrasings, so they don't match actionableRe.
        else if (it && (it.type === 'tip' || it.type === 'character') && it.t) {
          const tm = parseHourMin(it.t);
          const parkAt = whichParkAt(blocks, tm);
          const ownSet = _parkRideSet[parkAt];
          const rawTxt = String((it.h || '') + ' ' + (it.n || '')).toLowerCase();
          // normalize the haystack the SAME way ride names are normalized (strip punctuation), so an
          // apostrophe in "Peter Pan's Flight" doesn't defeat the substring match against "peter pans flight"
          const txt = _norm(rawTxt);
          const actionableRe = /rope drop|book (your |the |next )?(a )?lightning lane|book next|grab (a )?lightning lane|head (straight )?to|make your way to|first ride|ride this first/i;
          if (ownSet && ownSet.size && actionableRe.test(rawTxt)) {
            const wrongParkRide = Object.keys(_parkRideSet).some(p => {
              if (p === parkAt) return false;
              return [..._parkRideSet[p]].some(name =>
                name.length >= 6 && txt.includes(name) && !ownSet.has(name));
            });
            if (wrongParkRide) { _enforce.dropped.push({ t: it.t, h: it.h, scheduledIn: parkAt, kind: it.type }); return; }
          }
        }
        _kept.push(it);
      });
      if (_enforce.dropped.length) { parsed = _kept; }
    }

    // ---- SNACK-VENUE GUARD (physics, code-enforced): a "snack" card must be a walk-up / counter grab,
    // never a sit-down meal. The model kept putting Carthay Circle Lounge (service "lounge") into snack
    // slots -- an elevated, order-from-a-menu sit-down spot, not a walk-around snack. The CATALOG venue
    // tags are correct (service: table | lounge | quick), so we enforce off them: drop any snack card
    // whose name matches a catalog venue tagged service "table" or "lounge". Snacks at quick-service /
    // cart / stand venues, and generic snacks that match no sit-down venue, are left alone. ----
    _enforce.snackVenueDropped = [];
    if (Array.isArray(parsed) && parsed.length && catalog && Array.isArray(catalog.venues)) {
      const _snorm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      const _svc = {};
      catalog.venues.forEach(v => { const k = _snorm(v.name); if (k) _svc[k] = String(v.service || 'quickservice').toLowerCase(); });
      const sitDown = s => s === 'table' || s === 'lounge';
      const _kept2 = [];
      parsed.forEach(it => {
        if (it && it.type === 'snack') {
          const txt = _snorm((it.h || ''));
          // match against any sit-down venue name appearing in the snack card's title
          const hitSitDown = Object.keys(_svc).some(name => name.length >= 6 && sitDown(_svc[name]) && txt.includes(name));
          if (hitSitDown) { _enforce.snackVenueDropped.push({ t: it.t, h: it.h }); return; }
        }
        _kept2.push(it);
      });
      if (_enforce.snackVenueDropped.length) { parsed = _kept2; }
    }
    // ---- ROPE-DROP GUARANTEE (physics, code-enforced): the morning is the most important hour and
    // rope-drop strategy differs by park. After wrong-park drops, ensure the day OPENS with a real
    // rope-drop ride IN THE STARTING PARK. If the first ride isn't a starting-park ropeDrop=high ride,
    // prepend the best available one at park open. Picks the single-ILL headliner first (Rise for DL,
    // Radiator Springs for DCA), else the first high-value rope-drop ride in the starting park that the
    // model didn't already schedule. Deterministic -- no model dependency. ----
    // ---- DETERMINISTIC ROPE-DROP (single source of truth = the cache ranking) ----
    // The opening ride is NOT a model decision. Compute it from the cache's ROPE_DROP_STRATEGY
    // ranked list: the highest-ranked ride for THIS day's starting park that the group hasn't
    // excluded, isn't closed on the date, and wasn't rope-dropped on a PRIOR same-park day. The
    // full cross-day assignment is recomputed from tripConfig.days on every per-day call and indexed
    // by dayIndex, so the separate calls agree (Day1 Peter Pan, Day2 Rise no-repeat, Day3 Radiator
    // Springs). The day is then forced to OPEN with it and every other rope-drop-prefixed card is
    // removed, which also kills the historical double-rope-drop. Tested in tests/test-skeleton.mjs.
    _enforce.ropeDrop = null;
    if (Array.isArray(parsed) && blocks.length) {
      const ranking = getRopeDropRanking(sections);
      const excludedNorm = new Set(
        ((((tripConfig.ridePreferences || {}).skip) || tripConfig.neverSchedule || []) || []).map(normRideName)
      );
      const attrByNorm = new Map();
      (catalog.attractions || []).forEach(a => { attrByNorm.set(normRideName(a.name), a); });
      const dayParks = days.map(d => ({ park: (/dca|california/i.test((d && (d.startPark || d.park)) || '') ? 'DCA' : 'DL') }));
      const dayDates = days.map(d => (d && d.date) ? String(d.date).slice(0, 10) : null);
      const isAvailableForDay = (idx, rideName) => {
        const a = attrByNorm.get(normRideName(rideName));
        if (!a) return true; // unknown to catalog -> don't block
        return isAttractionAvailable(a, dayDates[idx], closureOverrides);
      };
      const assignment = assignRopeDropsAcrossDays({ days: dayParks, ranking, excludedNorm, isAvailableForDay });
      const myPick = assignment[dayIndex];
      if (myPick && myPick.name) {
        const startOpen = blocks[0].startMin;
        const attr = attrByNorm.get(normRideName(myPick.name));
        const canonical = attr ? attr.name : myPick.name;
        // remove ANY rope-drop-prefixed card and any other copy of the chosen ride (no doubles),
        // then prepend the authoritative opener.
        parsed = (parsed || []).filter(it => {
          if (!it) return false;
          if (/^\s*rope drop\b/i.test(String(it.h || ''))) return false;
          if (it.type === 'ride' && normRideName(cleanRideName(it.h)) === normRideName(canonical)) return false;
          return true;
        });
        const openItem = {
          t: minToLabel(startOpen),
          h: 'Rope Drop: ' + canonical,
          type: 'ride',
          n: 'Be at the gate before open and head straight here -- ' + canonical + ' is the top rope-drop priority for the park you start in, so riding it first saves the most time of any move all day.',
          land: attr ? attr.land : undefined
        };
        // DE-COLLIDE: the model often also places ITS own opener at park-open (the same minute as our
        // authoritative opener), leaving two ride cards stacked at the open time (e.g. Peter Pan + Rise
        // both at 8:00). Bump any OTHER ride still sitting exactly at the open minute to ~25 min later
        // (one rope-drop ride's worth) so the day opens with a single ride, then the next. Only nudges
        // ride cards; the arrival tip and first LL-booking reminder at open are left in place.
        for (let _i = 0; _i < parsed.length; _i++) {
          const _it = parsed[_i];
          if (_it && _it.type === 'ride' && _it.t && parseHourMin(_it.t) === startOpen) {
            _it.t = minToLabel(startOpen + 25);
          }
        }
        parsed.unshift(openItem);
        _enforce.ropeDrop = { chosen: canonical, rank: myPick.rank, reason: myPick.reason, source: ranking.source, at: openItem.t };
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
      // Before clearing the window, RESCUE a dinner the model placed inside it. The prompt requires one
      // dinner/day, but the model often anchors it around 4:30-5:30 -- which can fall inside the VIP
      // window and get cleared with everything else, leaving the day with no dinner. Pull the LAST such
      // in-window dining card out and re-place it just after the tour ends, preserving the model's venue
      // choice (strategy stays with the model; we only move it). Snacks/quickservice are left to the
      // normal evening flow; this rescue is specifically for a dining-type meal so dinner survives.
      let _rescuedDinner = null;
      parsed.forEach(it => {
        if (!it || it.type !== 'dining' || !it.t) return;
        const m = parseHourMin(it.t);
        if (m >= vS && m <= vE) _rescuedDinner = it; // keep the latest in-window dining card
      });
      // keep only items strictly OUTSIDE the window (start-exclusive at end so a card exactly at vE,
      // e.g. a "tour ends" handoff, is treated as inside and removed too)
      const kept = parsed.filter(it => {
        if (!it || !it.t) return true; // untimed items (rare) pass through
        const m = parseHourMin(it.t);
        if (m < 0) return true;
        return m < vS || m > vE;
      });
      const removed = before - kept.length;
      // If the day now has NO dining card after the tour and we rescued one, re-place it 30 min after
      // the tour ends (a natural dinner slot once the guide hands off).
      const hasPostTourDinner = kept.some(it => it && it.type === 'dining' && it.t && parseHourMin(it.t) > vE);
      if (_rescuedDinner && !hasPostTourDinner) {
        const dinnerMin = Math.min(vE + 30, 1410);
        kept.push(Object.assign({}, _rescuedDinner, { t: minToLabel(dinnerMin) }));
      }
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

    // ---- CROSS-DAY SHOW + PARADE ASSIGNMENT (DATA + deterministic; single source of truth =
    // the cache SHOWS catalog, with a verified seed fallback in schedule-shows.js exactly like the
    // rope-drop DEFAULT ranking). Mirrors the rope-drop cross-day pattern: the full trip-wide
    // assignment is recomputed from tripConfig.days on EVERY per-day call and indexed by dayIndex,
    // so the separate per-day calls agree without needing future knowledge. This REPLACES the old
    // drop-only dedup -- instead of deleting a repeated show and leaving a night with no spectacular,
    // we ASSIGN a DISTINCT show to each night: no trip-wide repeats, up to 2 shows/night, fireworks
    // only on a flagged fireworks night where the group is physically in that park at showtime, and
    // each show matched to a showtime the group can actually reach (e.g. a late Fantasmic after the
    // 10pm hop-back). Then strip the model's improvised/duplicate/outdated show cards and insert the
    // authoritative assigned ones (canonical name + showtime + warm note). Tested in tests/test-shows.mjs.
    _enforce.showAssignment = null;
    if (Array.isArray(parsed)) {
      const showsData = (dynamicSections && dynamicSections.SHOWS) ? dynamicSections.SHOWS : null;
      const allDays = (days || []).map((d, i) => {
        const di = (d && d.intent) || {
          startPark: /dca|california/i.test((d && (d.startPark || d.park)) || '') ? 'DCA' : 'DL',
          hop: null, vip: null
        };
        let ph = Array.isArray(tripConfig.parkHours) ? parseParkHoursForDate(tripConfig.parkHours, i) : null;
        if (!ph) ph = { DL: { openMin: 480, closeMin: 1380 }, DCA: { openMin: 480, closeMin: 1320 } };
        let bl = deriveBlocks(di, ph);
        bl = appendEveningHopBack(bl, ph);
        return { dayIndex: i, dateISO: (d && d.date) ? String(d.date) : null, blocks: bl, vip: di.vip || null };
      });
      const _showPrefs = (tripConfig && tripConfig.showPreferences) ? tripConfig.showPreferences : {};
      const showPlan = assignShowsAcrossDays({ days: allDays, showsData, skipNames: _showPrefs.skip || [], wantNames: _showPrefs.want || [] });
      const myShows = showPlan[dayIndex] || [];
      const applied = applyShowAssignment(parsed, myShows);
      parsed = applied.parsed;
      _enforce.showAssignment = {
        assigned: myShows.map(s => ({ t: s.t, h: s.name, type: s.type })),
        stripped: applied.stripped,
        inserted: applied.inserted,
        source: (showsData ? 'cache' : 'seed')
      };
    }

    // ---- LL-REMINDER CHECK (verifier, NOT an injector): when Lightning Lane is on, the model is told to
    // add standalone LLMP booking-reminder cards -- the FIRST at park entry, then one per LLMP-eligible
    // ride, framed event-driven ("book your next when you tap in"). LL ride choice + reminder content is
    // strategy the model owns, so we do NOT rewrite it here. We only MEASURE: (a) at least one reminder
    // exists, and (b) the FIRST reminder is at/near park open. We deliberately do NOT flag the gap between
    // reminders: Disneyland LLMP unlocks your next booking when you TAP IN (or 2h after booking, whichever
    // comes first) -- in practice you re-book at tap-in, so sub-2-hour gaps are the NORMAL, optimal pattern,
    // not a violation. (The old 2-hour-floor check was based on a misreading of the rule and flagged correct
    // schedules; it has been removed.) We record the reminder cadence for visibility only. Identifies LLMP
    // reminders as type 'tip' mentioning Lightning Lane / LLMP / Multi Pass booking (excludes Individual LL /
    // Single Pass, which are separate one-time buys). ----
    _enforce.llReminders = null;
    if (Array.isArray(parsed) && parsed.length && llOn && blocks.length) {
      const isLLMPTip = it => {
        if (!it || it.type !== 'tip' || !it.t) return false;
        const txt = ((it.h || '') + ' ' + (it.n || '')).toLowerCase();
        const mentionsLL = /lightning lane|llmp|multi ?pass/.test(txt);
        const mentionsBook = /book|reserve|grab|select|tap|return time|next selection|window opens/.test(txt);
        const isIndividual = /individual lightning lane|\bill\b|single lightning lane/.test(txt) && !/multi ?pass/.test(txt);
        return mentionsLL && mentionsBook && !isIndividual;
      };
      let llTips = parsed.filter(isLLMPTip)
        .map(it => ({ t: it.t, min: parseHourMin(it.t), h: it.h }))
        .filter(x => x.min >= 0)
        .sort((a, b) => a.min - b.min);
      // HARD CAP (code-enforced, since prompt counts get ignored): max 5 LL reminder cards/day,
      // including the park-open one. The earliest 5 by time are the highest-priority chain (entry +
      // the first rides tapped into); trim the rest out of `parsed` so LL cards never dominate the day.
      let llTrimmed = 0;
      if (llTips.length > 5) {
        const keepSet = new Set(llTips.slice(0, 5).map(x => x.t + '||' + x.h));
        const before = parsed.length;
        parsed = parsed.filter(it => {
          if (!isLLMPTip(it)) return true;
          return keepSet.has(it.t + '||' + it.h);
        });
        llTrimmed = before - parsed.length;
        llTips = llTips.slice(0, 5);
      }
      const openMin = blocks[0].startMin;
      const violations = [];
      if (!llTips.length) {
        violations.push({ rule: 'no-ll-reminders' });
      } else if (llTips[0].min > openMin + 30) {
        // first reminder should land at/near open (within 30 min) -- the one real timing rule
        violations.push({ rule: 'first-not-at-open', firstTip: llTips[0].t, open: minToLabel(openMin) });
      }
      // gaps recorded for visibility only -- NOT violations (sub-2h is normal/optimal)
      const gaps = [];
      for (let i = 1; i < llTips.length; i++) gaps.push(llTips[i].min - llTips[i - 1].min);
      _enforce.llReminders = { count: llTips.length, tips: llTips.map(x => x.t), gapsMin: gaps, trimmed: llTrimmed, violations: violations };

      // ---- LL-CHAIN COHERENCE (deterministic rewrite): the model frames each reminder "while you tap
      // into [X], book [Y]" but doesn't track which Multi Pass you're actually holding, so [X] often names
      // the wrong ride (observed Day 0: "book Indiana" then "while tapping TIANA'S, book Haunted Mansion"
      // -- you're holding Indiana, not Tiana's). At Disneyland your next Multi Pass unlocks when you tap
      // your CURRENT one, so each link's "tap into" ride must be the ride booked by the PREVIOUS card. We
      // keep the model's ride CHOICES and ORDER (strategy) and only fix the chain REFERENCES (coherence).
      // Two kinds of cards: an ANCHOR ("Book Lightning Lane: X", no tap reference) starts/!resets a chain --
      // this is also how a fresh chain begins in the second park after a hop -- and is left as-is; a LINK
      // ("while tapping into Y, book Z") has its tap-into rewritten to the previous booked ride. A link that
      // re-books the ride you're already holding is redundant and dropped. Idempotent: an already-correct
      // chain (e.g. the post-hop DL chain) rewrites to itself.
      const _tapRe = /tap(?:ping)?\s+into|while\s+you\s+tap|when\s+you\s+tap/i;
      const _bookedOf = it => {
        let b = String(it.h || '').split(/lightning lane:\s*/i).pop().trim();
        // the model sometimes appends its own chain clause AFTER the ride name ("Tiana's -- while
        // tapping into Indiana Jones"); cut a trailing clause that starts with a separator (em/en dash,
        // spaced hyphen, comma, or paren) followed by chain language, so we keep just the ride name.
        // Ride names with incidental punctuation (e.g. "Pixar Pal-A-Round", "Millennium Falcon: Smugglers
        // Run") are unaffected because the strip requires a chain word right after the separator.
        b = b.replace(/\s*[\u2014\u2013-]\s*(?:while|as you|when you|after you|right (?:after|when)|then|book|tap)\b.*$/i, '').trim();
        b = b.replace(/\s*,\s*(?:while|as you|when you|then|book|tap)\b.*$/i, '').trim();
        b = b.replace(/\s*\((?:while|as you|when you|tap)\b.*$/i, '').trim();
        return b;
      };
      const _orderedLL = parsed.filter(isLLMPTip)
        .map(it => ({ it, min: parseHourMin(it.t) }))
        .filter(x => x.min >= 0)
        .sort((a, b) => a.min - b.min)
        .map(x => x.it);
      const _llOrder = [];
      const _llDrop = new Set();
      let _llRewrote = 0;
      let _prevBooked = '';
      for (let _k = 0; _k < _orderedLL.length; _k++) {
        const _card = _orderedLL[_k];
        const _booked = _bookedOf(_card);
        if (!_booked) continue; // unparseable title; leave the card untouched
        const _isLink = _tapRe.test(String(_card.h || ''));
        if (_isLink && _prevBooked) {
          if (normRideName(_booked) === normRideName(_prevBooked)) { _llDrop.add(_card); continue; } // redundant re-book
          _card.h = 'While you tap into ' + _prevBooked + ', book your next Lightning Lane: ' + _booked;
          _card.n = 'As you scan into ' + _prevBooked + ', your next Lightning Lane unlocks -- book ' + _booked + ' right then so your return windows keep flowing.';
          _llRewrote++;
        }
        _prevBooked = _booked;
        _llOrder.push((_isLink ? '> ' : '* ') + _booked);
      }
      if (_llDrop.size) parsed = parsed.filter(it => !_llDrop.has(it));
      _enforce.llChain = _orderedLL.length ? { order: _llOrder, rewrote: _llRewrote, dropped: _llDrop.size } : null;
    }

    // ---- NIGHT-FILL CHECK (verifier, NOT a filler): measure whether the last real activity reaches
    // close. We deliberately do NOT inject evening cards here -- code-appended rides can't carry the
    // model's warm note, and night cards must read identically to day cards. So this only RECORDS the
    // gap in _enforce.underfilled; the fill itself is the prompt's job (Rule 5 + the evening strategy
    // line). If live verification shows the model still ends early, escalate the prompt -- not filler. ----
    // ---- NIGHT-FILL RE-PROMPT (relocated): runs AFTER VIP collapse + show-dedup so it measures the
    // FINAL timeline. On VIP days the collapse removes the 10-5 tour into one card, creating an
    // evening gap that only exists post-collapse; running here (not early) is what lets the gap be
    // seen and filled. The model authors the post-show ride cards; pool is the closing park's
    // attractions minus rides already used today. ----
    _enforce.nightFillReprompt = null;
    if (Array.isArray(parsed) && parsed.length && blocks.length) {
      const _nfClose = blocks[blocks.length - 1].endMin;
      const _nfPark = blocks[blocks.length - 1].park;
      const _nfReal = ['ride', 'show', 'dining', 'quickservice', 'snack', 'character', 'vip'];
      const _nfLast = parsed
        .filter(it => it && _nfReal.indexOf(it.type) !== -1 && it.t)
        .reduce((mx, it) => Math.max(mx, parseHourMin(it.t)), -1);
      // only re-prompt when there is a real gap AND enough room for at least ~2 rides (>= 50 min)
      if (_nfLast >= 0 && _nfLast < _nfClose - 45 && (_nfClose - _nfLast) >= 50) {
        // rides already on today's plan (cleaned/normalized) so we don't ask for repeats
        const _nfNorm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
        const _nfUsed = new Set(parsed.filter(it => it && it.type === 'ride')
          .map(it => _nfNorm(String(it.h || '').replace(/^rope drop[^:]*:?\s*/i, '').replace(/^rope drop\s*[\u2014-]\s*/i, ''))));
        // candidate rides for the CLOSING block's park, minus what's already used
        const _nfFilter = buildCatalogFilter(catalog, _nfPark, tripDate, closureOverrides);
        const _nfPool = (_nfFilter.attractions || [])
          .filter(a => !_nfUsed.has(_nfNorm(a.name)))
          .map(a => a.name + (a.land ? ' (' + a.land + ')' : ''));
        const _nfNeed = Math.max(2, Math.min(4, Math.round((_nfClose - _nfLast) / 35)));
        if (_nfPool.length) {
          const _nfSys = 'You add late-evening ride cards to an existing theme-park day. Output ONLY a JSON array of new ride-card objects, no prose, no markdown. Each object: {"t":"H:MM PM","h":"Ride Name","type":"ride","n":"one warm friendly sentence","land":"Land Name"}. Waits drop to their lowest of the day during and right after the nighttime show, so these late rides are prime time -- write them as normal, appealing ride cards, never as filler or afterthoughts.';
          const _nfUser = 'The day is in ' + _nfPark + ' and the park is open until ' + minToLabel(_nfClose)
            + '. The current plan already ends at ' + minToLabel(_nfLast) + ', which leaves the evening empty -- the nighttime spectacular is a MIDPOINT of the night, not the end. Add ' + _nfNeed
            + ' more ride cards, spaced from about ' + minToLabel(_nfLast + 15) + ' to about ' + minToLabel(_nfClose - 20)
            + ', so the day stays active until close. Choose ONLY from these ' + _nfPark + ' rides that are not already on the plan: '
            + _nfPool.slice(0, 30).join('; ') + '. Return ONLY the JSON array of the NEW cards.';
          try {
            const _nfCtl = new AbortController();
            const _nfTo = setTimeout(() => _nfCtl.abort(), 45000);
            const _nfRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: _nfSys, messages: [{ role: 'user', content: _nfUser }] }),
              signal: _nfCtl.signal
            });
            clearTimeout(_nfTo);
            const _nfData = await _nfRes.json();
            const _nfText = (_nfData.content && _nfData.content[0] && _nfData.content[0].text) || '';
            let _nfCards = null;
            try {
              const tt = _nfText.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
              const _nfArr = extractFirstJsonArray(tt);
              if (_nfArr) _nfCards = JSON.parse(_nfArr);
            } catch (ee) { _nfCards = null; }
            if (Array.isArray(_nfCards) && _nfCards.length) {
              // accept only well-formed ride cards strictly AFTER the current last activity and before close,
              // not duplicating a ride already on the plan
              const _nfAdded = [];
              _nfCards.forEach(c => {
                if (!c || c.type !== 'ride' || !c.t || !c.h) return;
                const cm = parseHourMin(c.t);
                if (cm <= _nfLast || cm >= _nfClose) return;
                const key = _nfNorm(c.h);
                if (_nfUsed.has(key)) return;
                _nfUsed.add(key);
                _nfAdded.push({ t: c.t, h: String(c.h), type: 'ride', n: String(c.n || ''), land: String(c.land || '') });
              });
              if (_nfAdded.length) {
                parsed = parsed.concat(_nfAdded);
                parsed.sort((a, b) => {
                  const ma = a && a.t ? parseHourMin(a.t) : 100000;
                  const mb = b && b.t ? parseHourMin(b.t) : 100000;
                  return ma - mb;
                });
                _enforce.nightFillReprompt = { gapMin: _nfClose - _nfLast, requested: _nfNeed, added: _nfAdded.length, lastWas: minToLabel(_nfLast), close: minToLabel(_nfClose) };
              }
            }
          } catch (ee) { /* re-prompt failed; leave the day as-is, underfilled check still records the gap */ }

          // DETERMINISTIC EVENING BACKSTOP: the night-fill above is a single best-effort model call;
          // it can return nothing usable (timeout, empty, or all cards rejected/duplicated). When it
          // does, the CLOSING block -- including an appended evening hop-back -- is left empty, which
          // alongside a "Park Hop to Disneyland" card reads as broken (a hop into an empty night).
          // So after the model attempt, if the closing block is STILL underfilled, fill it
          // deterministically from unused rides in the closing park. Rides land only inside the
          // closing block's window (>= its start + a few min, so a hop-back evening gets DL rides
          // AFTER the hop card, never before it). The model still authors the main day; this only
          // fires as a guarantee when the model comes up empty.
          const _lastBlk = blocks[blocks.length - 1];
          const _nfLast2 = parsed
            .filter(it => it && _nfReal.indexOf(it.type) !== -1 && it.t)
            .reduce((mx, it) => Math.max(mx, parseHourMin(it.t)), -1);
          if (_nfLast2 >= 0 && _nfLast2 < _nfClose - 45) {
            const _bStart = Math.max(_nfLast2 + 20, _lastBlk.startMin + 10);
            const _bEnd = _nfClose - 25;
            if (_bEnd - _bStart >= 10) {
              const _bPool = (_nfFilter.attractions || []).filter(a => a && !_nfUsed.has(_nfNorm(a.name)));
              const _bNotes = [
                'Waits bottom out right after the nighttime show -- this one is nearly a walk-on now.',
                'A relaxed evening ride before the park closes.',
                'Late-night low wait -- great timing to hop right on.',
                'One more while the lines are short before close.'
              ];
              const _bAdded = [];
              let _bIdx = 0;
              for (let _t = _bStart; _t <= _bEnd && _bIdx < _bPool.length; _t += 28) {
                const _a = _bPool[_bIdx++];
                _nfUsed.add(_nfNorm(_a.name));
                _bAdded.push({ t: minToLabel(_t), h: String(_a.name), type: 'ride', n: _bNotes[_bAdded.length % _bNotes.length], land: String(_a.land || '') });
              }
              if (_bAdded.length) {
                parsed = parsed.concat(_bAdded);
                parsed.sort((a, b) => { const ma = a && a.t ? parseHourMin(a.t) : 100000; const mb = b && b.t ? parseHourMin(b.t) : 100000; return ma - mb; });
                _enforce.eveningBackfill = { added: _bAdded.length, from: minToLabel(_bStart), to: minToLabel(_bEnd), park: _nfPark, reason: 'model-nightfill-left-closing-block-underfilled' };
              }
            }
          }
        }
      }
    }

    // ---- DETERMINISTIC POST-CORRECTIONS (single source of truth = schedule-rules.js) ----
    // Run AFTER all other enforcers/night-fill so they see the final timeline. These are the tested
    // pure transforms (tests/test-corrections.mjs): cap breaks at <=1 morning + <=1 afternoon and
    // label each by its actual time; move any app-chosen meal out of the 12-1 / 5-6 peak windows
    // (reservations exempt). v2 previously never ran the validator, so these rules had no effect on
    // the live path; applying them here is what makes them real.
    if (Array.isArray(parsed) && parsed.length) {
      // hard exclusion backstop: remove any attraction the group asked never to schedule, even if the
      // model added it from its own knowledge (the candidate-menu filter is only a soft prevention).
      const _exNorm = new Set(((((tripConfig.ridePreferences || {}).skip) || tripConfig.neverSchedule || []) || []).map(normRideName));
      const _ex = enforceExclusions(parsed, { excludedNorm: _exNorm });
      parsed = _ex.items;
      _enforce.excluded = _ex.removed.length ? _ex.removed : null;

      const _bk = enforceBreaks(parsed);
      parsed = _bk.items;
      _enforce.breaksCapped = _bk.removed.length ? _bk.removed : null;

      const _resList = (tripConfig.dining && tripConfig.dining.reservations) || tripConfig.reservations || [];
      const _reservedNames = Array.from(new Set(
        _resList.map(r => normRideName((r && (typeof r === 'string' ? r : (r.name || r.venue))) || '')).filter(Boolean)
      ));
      // A card is a reservation (exempt from meal-window moves) if it carries a reservation flag, OR
      // the generator labeled it a "Reservation" (e.g. "Cafe Orleans -- Dinner Reservation"), OR its
      // name substring-matches a configured reservation venue. Name-equality alone was too strict --
      // the card title appends "Dinner Reservation", so the Day-3 Cafe Orleans booking was being moved.
      const _isReserved = (it) => {
        if (!it) return false;
        if (it.isReserved === true || it.isConfirmed === true) return true;
        if (/reservation/i.test(String(it.h || ''))) return true;
        const n = normRideName(it.h);
        return !!n && _reservedNames.some(rn => rn && (n.indexOf(rn) !== -1 || rn.indexOf(n) !== -1));
      };
      const _dayBounds = { startMin: blocks[0] ? blocks[0].startMin : 0, endMin: blocks.length ? blocks[blocks.length - 1].endMin : undefined };
      const _ml = enforceMealWindows(parsed, { isReserved: _isReserved, dayBounds: _dayBounds });
      parsed = _ml.items;
      _enforce.mealsMoved = _ml.moved.length ? _ml.moved : null;

      // PARK-HOP CARDS (physics, strip-and-reinsert): the model emits its own hop cards that often
      // don't match the real block structure -- duplicates, a hop into a park it is already in, or a
      // hop a few minutes off the boundary -- and the old 30-min near-dedup missed pairs that were
      // farther apart (observed Day 2: three hop cards including a duplicate). So drop EVERY
      // model-authored hop card, then insert exactly one at each real park transition. The
      // authoritative hop times come from the intent (configured midday hop) plus any appended
      // evening hop-back block -- same authoritative-override pattern as the rope-drop opener and the
      // show assignment. The strip matches on the card TITLE only ("[Park] Hop (back) to <park>"),
      // which no ride/meal/show ever uses, so an LL reminder that merely MENTIONS a "park hop" in its
      // note text is never removed. A transition that lands strictly INSIDE the VIP tour window is
      // skipped (the collapsed VIP card covers it); a transition landing exactly AT vip.endMin is the
      // after-tour hop and IS shown (boundary is exclusive), which fixes the missing DL->DCA hop on
      // the VIP day.
      const _hopTitle = /^\s*(park\s+)?hop\s+(back\s+)?to\b/i;
      parsed = (parsed || []).filter(it => !(it && _hopTitle.test(String(it.h || ''))));
      _enforce.hopCardsInserted = [];
      for (let _bi = 1; _bi < blocks.length; _bi++) {
        const _prev = blocks[_bi - 1], _cur = blocks[_bi];
        if (!_cur || !_prev || _cur.park === _prev.park) continue;
        const _tMin = _cur.startMin;
        if (intent && intent.vip && _tMin >= intent.vip.startMin && _tMin < intent.vip.endMin) continue;
        const _label = _cur.park === 'DCA' ? 'Disney California Adventure' : 'Disneyland';
        const _note = _cur.hopBack
          ? 'Head back to ' + _label + ' for the rest of the night -- it stays open later, so the evening rides here have short post-show waits.'
          : 'Time to hop over to ' + _label + ' -- your afternoon and evening plans are over here now.';
        parsed.push({ t: minToLabel(_tMin), h: 'Park Hop to ' + _label, type: 'tip', n: _note, land: '' });
        _enforce.hopCardsInserted.push({ at: minToLabel(_tMin), park: _cur.park, hopBack: !!_cur.hopBack });
      }
      if (!_enforce.hopCardsInserted.length) _enforce.hopCardsInserted = null;

      // enforceMealWindows / hop-back insertion can change ordering, so re-sort chronologically
      // (same comparator used after night-fill) to keep the timeline ordered.
      parsed.sort((a, b) => {
        const ma = a && a.t ? parseHourMin(a.t) : 100000;
        const mb = b && b.t ? parseHourMin(b.t) : 100000;
        return ma - mb;
      });
    }

    // MID-SCHEDULE GAP-FILL (physics/quality backstop): the model sometimes leaves a long dead hole in
    // the middle of an open-park stretch -- e.g. a ~2h hole between an afternoon ride and a 9pm show, or
    // after dinner before the evening rides. The night-fill backstop above covers only the CLOSING gap;
    // this covers INTERIOR gaps between two real-activity cards. Free time is measured from when the
    // group is actually free (meals/shows occupy time; the VIP tour card occupies through vip.endMin), so
    // a pre-reservation wind-down isn't mistaken for dead time. Any free gap over GAP_MIN that sits
    // entirely inside one park block gets ~one unused ride per hour from that park, placed evenly and
    // kept clear of the next card (so a pre-show window is never crowded). Rides only; dedup +
    // de-collision run after this and clean up incidental overlaps. The model still authors the day --
    // this just guarantees no dead multi-hour holes while a park is open.
    if (Array.isArray(parsed) && parsed.length && blocks.length) {
      const GAP_MIN = 75, CLEAR_BEFORE = 15, CLEAR_AFTER = 10;
      const REALG = ['ride', 'show', 'dining', 'quickservice', 'snack', 'character', 'vip'];
      const gDur = it => { const ty = it && it.type; if (ty === 'dining') return 50; if (ty === 'quickservice') return 20; if (ty === 'snack') return 15; if (ty === 'show') return 30; return 0; };
      const gFree = it => (it && it.type === 'vip' && intent && intent.vip) ? intent.vip.endMin : (parseHourMin(it.t) + gDur(it));
      const gNorm = s => normRideName(cleanRideName(s));
      const gUsed = new Set(parsed.filter(it => it && it.type === 'ride').map(it => gNorm(it.h)));
      const gNotes = [
        'Waits dip in this window -- a good time to slip in another ride.',
        'Short wait right about now -- worth hopping on while you are nearby.',
        'An easy one to add while you are in this part of the park.'
      ];
      const gReals = parsed.filter(it => it && REALG.indexOf(it.type) !== -1 && it.t)
        .sort((a, b) => parseHourMin(a.t) - parseHourMin(b.t));
      const gAdded = [];
      for (let _i = 0; _i + 1 < gReals.length; _i++) {
        const aFree = gFree(gReals[_i]);
        const bStart = parseHourMin(gReals[_i + 1].t);
        const freeGap = bStart - aFree;
        if (freeGap <= GAP_MIN) continue;
        if (intent && intent.vip && bStart <= intent.vip.endMin) continue; // gap lies inside the tour
        // gap must sit entirely within ONE park block (never straddle a hop boundary)
        const gPark = whichParkAt(blocks, aFree + Math.floor(freeGap / 2));
        if (!gPark || gPark !== whichParkAt(blocks, aFree + 1) || gPark !== whichParkAt(blocks, bStart - 1)) continue;
        const gFilter = buildCatalogFilter(catalog, gPark, tripDate, closureOverrides);
        const gPool = (gFilter.attractions || []).filter(a => a && !gUsed.has(gNorm(a.name)));
        if (!gPool.length) continue;
        // prefer lower-demand attractions for a quick gap-fill -- dropping a long-wait headliner into a
        // short window would blow the timing and the "waits dip now" note would be wrong. Headliners
        // (ropeDropValue 'high') sort last and are only used if nothing lighter is left.
        const gRank = v => (v === 'high' ? 2 : (v === 'med' ? 1 : 0));
        gPool.sort((a, b) => gRank(a.ropeDropValue) - gRank(b.ropeDropValue));
        const n = Math.min(Math.floor(freeGap / 60), gPool.length);
        let pi = 0;
        for (let k = 1; k <= n; k++) {
          const t = aFree + Math.round(freeGap * k / (n + 1));
          if (t <= aFree + CLEAR_AFTER || t >= bStart - CLEAR_BEFORE) continue;
          if (pi >= gPool.length) break;
          const a = gPool[pi++];
          gUsed.add(gNorm(a.name));
          gAdded.push({ t: minToLabel(t), h: String(a.name), type: 'ride', n: gNotes[gAdded.length % gNotes.length], land: String(a.land || '') });
        }
      }
      if (gAdded.length) { parsed = parsed.concat(gAdded); _enforce.midGapFill = gAdded.map(x => x.t + ' ' + x.h); }
      else { _enforce.midGapFill = null; }
    }

    // GENERAL RIDE DE-DUPLICATION (physics/quality): each attraction appears at most once per day.
    // The model sometimes lists the same ride twice, often under alias names the rope-drop dedup
    // (which only covers the chosen opener) misses -- e.g. "Rise of the Resistance" and "Star Wars:
    // Rise of the Resistance" on the same day. Keep the FIRST occurrence in time order and drop later
    // duplicates of the same normalized ride name. Recorded in _enforce.rideDupesRemoved.
    if (Array.isArray(parsed) && parsed.length) {
      const _fmD = (x) => (x && x.t ? parseHourMin(x.t) : 100000);
      const _orderedDup = parsed.slice().sort((a, b) => _fmD(a) - _fmD(b));
      const _seenRides = new Set();
      const _dropRefs = new Set();
      const _dropNames = [];
      for (const _it of _orderedDup) {
        if (!_it || _it.type !== 'ride') continue;
        const _n = normRideName(cleanRideName(_it.h));
        if (!_n) continue;
        if (_seenRides.has(_n)) { _dropRefs.add(_it); _dropNames.push(_it.h); }
        else _seenRides.add(_n);
      }
      if (_dropRefs.size) {
        parsed = parsed.filter(it => !_dropRefs.has(it));
        _enforce.rideDupesRemoved = _dropNames;
      } else {
        _enforce.rideDupesRemoved = null;
      }
    }

    // GENERAL DE-COLLISION (physics): no two RIDE cards may share the same minute -- you can't be on
    // two attractions at once. The model occasionally stacks rides at one time anywhere in the day
    // (observed: Haunted Mansion + Jungle Cruise both at 11:15 PM in the hop-back window); the
    // rope-drop opener de-collision only covered park-open. Walk the time-sorted cards and, for any
    // ride landing at or before the previous ride's minute, nudge it +10 (capped just under the day's
    // close) so ride times strictly increase. Only rides move; meals/shows/tips/LL reminders may
    // legitimately overlap a ride and are left in place. Re-sort afterward for a clean timeline.
    if (Array.isArray(parsed) && parsed.length) {
      const _fm = (x) => (x && x.t ? parseHourMin(x.t) : 100000);
      const _closeMin = blocks.length ? blocks[blocks.length - 1].endMin : 1440;
      parsed.sort((a, b) => _fm(a) - _fm(b));
      _enforce.rideDeCollisions = [];
      let _lastRide = -1;
      for (let _i = 0; _i < parsed.length; _i++) {
        const _it = parsed[_i];
        if (!_it || _it.type !== 'ride' || !_it.t) continue;
        const _m = parseHourMin(_it.t);
        if (_m <= _lastRide) {
          const _nm = Math.min(_lastRide + 10, _closeMin - 1);
          if (_nm > _m) {
            _enforce.rideDeCollisions.push({ ride: _it.h, from: _it.t, to: minToLabel(_nm) });
            _it.t = minToLabel(_nm);
          }
          _lastRide = Math.max(_nm, _m);
        } else {
          _lastRide = _m;
        }
      }
      if (!_enforce.rideDeCollisions.length) _enforce.rideDeCollisions = null;
      parsed.sort((a, b) => _fm(a) - _fm(b));
    }

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
