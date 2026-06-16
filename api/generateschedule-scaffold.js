// api/generateschedule-scaffold.js
// PARALLEL scaffold path (behind ?scaffold=1). PHYSICS vs STRATEGY:
//   - CODE computes ONLY physics: park-by-time blocks (from park hours + hop), one meal slot per type,
//     day starts at open / ends by close. A card cannot be in a park you are not physically in for that block.
//   - MODEL + CACHE own ALL strategy: which rides + order, whether/when to hop, what to rope-drop, which
//     venue, off-peak meal timing. Code never decides these (that would make it robotic).
// Reuses the same buildCacheContext / character helpers as generateschedule.js so cache data flow is identical.
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


// ============================================================================
// PHYSICS LAYER: buildScaffold
// Computes the immovable structure of a day. Returns blocks (park-tagged time
// spans) with empty ride slots + meal slots. The MODEL fills every slot using
// cache strategy; CODE only guarantees the structure is physically possible.
// ============================================================================

// minutes since midnight from "8:00 AM" / "10:30 PM"
function _t2m(s) {
  if (!s) return -1;
  const m = String(s).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return -1;
  let h = parseInt(m[1], 10); const min = parseInt(m[2], 10);
  const pm = /pm/i.test(m[3]);
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return h * 60 + min;
}
// "8:00 AM" from minutes
function _m2t(mins) {
  if (mins == null || mins < 0) return '';
  let h = Math.floor(mins / 60) % 24; const m = mins % 60;
  const mer = h >= 12 ? 'PM' : 'AM';
  let hh = h % 12; if (hh === 0) hh = 12;
  return hh + ':' + String(m).padStart(2, '0') + ' ' + mer;
}

// Pull this day's open/close (in minutes) for a given park from the PARK_HOURS cache text.
// PARK_HOURS is verified cache data; we parse it rather than hardcode hours.
function _parkHoursFor(parkHoursText, parkKey, dateStr) {
  // parkKey: 'DL' or 'DCA'. Look for a line mentioning the park + a time range.
  // Cache format is prose/structured text; match "Disneyland ... 8:00 AM - 11:00 PM".
  const text = parkHoursText || '';
  const parkNames = parkKey === 'DCA'
    ? ['california adventure', 'dca', 'disney california']
    : ['disneyland park', 'disneyland', 'dl'];
  const lines = text.split(/\n|\.|;/);
  for (const ln of lines) {
    const low = ln.toLowerCase();
    if (!parkNames.some(n => low.indexOf(n) !== -1)) continue;
    // find two times in the line
    const times = ln.match(/\d{1,2}:\d{2}\s*(AM|PM)/gi);
    if (times && times.length >= 2) {
      return { openMin: _t2m(times[0]), closeMin: _t2m(times[times.length - 1]) };
    }
  }
  return null; // unknown -> caller supplies a safe default
}

// Decide the day's park layout. This is PHYSICS (where you can be), NOT strategy
// (whether to hop is the model's call — but if tripConfig says no hopper, one park is enforced).
// We do NOT pick the hop time here arbitrarily; if hopping is allowed we create a single
// hop boundary at a neutral midday point and let the model justify ride choices around it.
// PER-DAY hop decision. A real hop needs a destination park that DIFFERS from the start park.
// hopTo: true is just "hopper tickets exist" - it is NOT a destination and must not trigger a 2nd block.
function resolveHopDestination(day, startPark, tripConfig) {
  // 1) Explicit per-day destination wins (future onboarding may store hopTo: 'DCA').
  //    Guard: normPark expects a string; a boolean true/false must not be passed through.
  const rawHop = day && day.hopTo;
  if (rawHop && typeof rawHop === 'string') {
    const dest = normPark(rawHop);
    if (dest && dest !== startPark) return dest; // real, different named destination
    return null;                                  // same-as-start or unrecognized -> no hop
  }
  // 2) OPTION-2 RULE (no explicit per-day destination stored): if this group holds hopper
  //    tickets, ALLOW a hop to the other park. This only creates the 2-block STRUCTURE; the
  //    model+cache (PARK_HOP_STRATEGY) still decide whether/when to actually lean into it and
  //    can keep most rides in the start park if the data says so. Code never forces the hop.
  //    A day explicitly flagged single-park (day.singlePark === true) never hops.
  if (day && day.singlePark === true) return null;
  if (tripConfig && tripConfig.parkHopping) {
    return startPark === 'DL' ? 'DCA' : 'DL';
  }
  return null; // no hopper tickets -> single park
}

function buildScaffold(tripConfig, dayIndex, cache) {
  const days = (tripConfig && tripConfig.schedule && tripConfig.schedule.days) || [];
  const day = days[dayIndex] || {};
  const parkHoursText = cache.PARK_HOURS || '';

  const startPark = /california|dca|adventure/i.test(day.park || '') ? 'DCA' : 'DL';
  const hopDest = resolveHopDestination(day, startPark, tripConfig); // explicit dest, else option-2 hopper rule
  const hopper = !!hopDest;                               // true only when hopDest names a different park
  const otherPark = hopDest || startPark;                 // never invent the opposite park

  // Hours from cache (fallback to conservative defaults if cache line not found)
  const startHours = _parkHoursFor(parkHoursText, startPark, day.date) || { openMin: 8 * 60, closeMin: 23 * 60 };
  const otherHours = _parkHoursFor(parkHoursText, otherPark, day.date) || { openMin: 8 * 60, closeMin: 22 * 60 };

  const dayOpen = startHours.openMin;
  // Day ends at the later close among parks we may be in.
  const dayClose = hopper ? Math.max(startHours.closeMin, otherHours.closeMin) : startHours.closeMin;

  const blocks = [];
  if (!hopper) {
    blocks.push({ id: 'A', park: startPark, startMin: dayOpen, endMin: dayClose });
  } else {
    // One hop boundary. We do NOT hardcode the strategic hop time; we place a structural
    // boundary that splits the day so the model can choose ride order in each park. The model
    // is told it MAY refine the exact hop moment, but cannot place a ride in the wrong park.
    // Physics default: spend the rope-drop park first (where this day starts), hop after lunch.
    const hopBoundary = Math.min(startHours.closeMin - 30, Math.max(dayOpen + 180, 12 * 60)); // ~noon-ish, >=3h in start park
    blocks.push({ id: 'A', park: startPark, startMin: dayOpen, endMin: hopBoundary });
    blocks.push({ id: 'B', park: otherPark, startMin: hopBoundary, endMin: dayClose });
  }

  // MEAL SLOTS (physics: one of each type exists, each tagged to the park you're in at that time).
  // The model picks the VENUE + the exact OFF-PEAK time within each window (strategy from DINING_TIMING).
  // We provide an off-peak target window for each meal so the model never lands in the crowd's peak.
  // Lunch peak 12-1 and dinner peak 6-7 are EXCLUDED here by construction.
  function parkAtMin(min) {
    for (const b of blocks) { if (min >= b.startMin && min < b.endMin) return b.park; }
    return blocks[blocks.length - 1].park;
  }
  const mealSlots = [];
  function addMeal(type, windowStart, windowEnd, offPeakNote) {
    // only add if the window fits within the day
    if (windowEnd <= dayOpen || windowStart >= dayClose) return;
    const ws = Math.max(windowStart, dayOpen);
    const we = Math.min(windowEnd, dayClose);
    mealSlots.push({
      type,                         // 'morning-snack' | 'lunch' | 'afternoon-snack' | 'dinner'
      windowStartMin: ws,
      windowEndMin: we,
      windowLabel: _m2t(ws) + ' - ' + _m2t(we),
      park: parkAtMin(Math.floor((ws + we) / 2)),  // park you're in mid-window
      offPeakNote                   // guidance handed to the model
    });
  }
  // Morning snack: between rope-drop and late morning
  addMeal('morning-snack', dayOpen + 90, 11 * 60, 'a light morning bite; pick a quick spot in this park');
  // Lunch: OFF-PEAK only -> 11:00-11:45 OR 1:00-1:45 (never 12-1). Give the early-lunch window;
  // the model may instead choose the 1:00-1:45 window. Both avoid the 12-1 rush.
  addMeal('lunch', 11 * 60, 11 * 60 + 45, 'EARLY off-peak lunch 11:00-11:45 OR shift to 1:00-1:45 - NEVER 12:00-1:00 (that is the crowd peak)');
  // Afternoon snack
  addMeal('afternoon-snack', 14 * 60 + 30, 16 * 60, 'an afternoon pick-me-up in this park');
  // Dinner: OFF-PEAK only -> 4:30-5:30 OR 7:30+ (never 6-7).
  addMeal('dinner', 16 * 60 + 30, 17 * 60 + 30, 'EARLY off-peak dinner 4:30-5:30 OR shift to 7:30+ - NEVER 6:00-7:00 (that is the crowd peak)');

  return { startPark, otherPark, hopper, dayOpen, dayClose, blocks, mealSlots, date: day.date, dayIndex };
}

// ============================================================================
// ENFORCEMENT LAYER (the part that actually makes physics non-negotiable).
// The model PROPOSES; this code ASSIGNS each item to the block its time falls in
// and REJECTS anything physically impossible (wrong park for that block, a 2nd
// hop the scaffold never declared, a duplicate meal slot). Prompts get ignored;
// code does not. Same land->park source of truth as validate-schedule.js.
// ============================================================================
const DCA_LANDS = ['cars land','cozy cone','radiator springs','pixar pier','paradise gardens','incredicoaster','avengers campus','grizzly peak','san fransokyo','hollywood land','buena vista street','pacific wharf','pixar pal'];
const DL_LANDS = ['main street','adventureland','new orleans square','frontierland','bayou country','critter country','fantasyland','mickey','toontown','tomorrowland','galaxy','star wars','pixie hollow'];
function landToPark(land) {
  const s = (land || '').toLowerCase();
  if (!s) return null;
  for (const k of DCA_LANDS) { if (s.indexOf(k) !== -1) return 'DCA'; }
  for (const k of DL_LANDS) { if (s.indexOf(k) !== -1) return 'DL'; }
  return null;
}
function normPark(p) {
  const s = (p || '').toLowerCase();
  if (s.indexOf('california') !== -1 || s.indexOf('dca') !== -1 || s.indexOf('adventure') !== -1) return 'DCA';
  if (s.indexOf('disneyland') !== -1 || s === 'dl') return 'DL';
  return null;
}
// Which block (and therefore which park) a given time belongs to.
function blockParkAtMin(scaffold, min) {
  for (const b of scaffold.blocks) { if (min >= b.startMin && min < b.endMin) return b.park; }
  // before first / after last -> clamp to nearest block
  if (min < scaffold.blocks[0].startMin) return scaffold.blocks[0].park;
  return scaffold.blocks[scaffold.blocks.length - 1].park;
}

// HARD ENFORCEMENT: take the model's items, keep only what's physically possible for the
// block each item's time lands in. Wrong-park items are dropped and replaced with a single
// gap marker per affected block (naming the CORRECT park). Returns {items, corrections}.
function enforceScaffold(rawItems, scaffold) {
  const corrections = [];
  const items = (rawItems || []).slice().map(it => Object.assign({}, it));
  items.forEach(it => { it._min = _t2m(it.t); });
  items.sort((a, b) => (a._min < 0 ? 1 : b._min < 0 ? -1 : a._min - b._min));

  // PHYSICS vs STRATEGY: the model OWNS the hop time (strategy). We do NOT impose the
  // scaffold's coded boundary. Instead we DETECT the model's FIRST hop from its own output
  // and enforce park-consistency around THAT. Items before the hop must be in startPark,
  // items at/after must be in the destination park. Any SECOND hop (back to startPark) is the
  // physically-impossible case the scaffold forbids -> those later wrong-park items are dropped.
  const startPark = scaffold.startPark;
  const destPark = scaffold.otherPark;
  let hopMin = -1;
  if (scaffold.hopper) {
    for (const it of items) {
      const h = (it.h || '');
      const isHopTip = /\bhop\b|arrive/i.test(h) && (it.type === 'tip');
      if (isHopTip) {
        const tipPark = normPark(h);
        if (tipPark === destPark && it._min >= 0) { hopMin = it._min; break; }
      }
    }
    // fallback: first destination-park ride/meal marks the hop if no explicit tip
    if (hopMin < 0) {
      for (const it of items) {
        const p = landToPark(it.land) || landToPark(it.h);
        if (p === destPark && it._min >= 0) { hopMin = it._min; break; }
      }
    }
  }
  // expectedParkAt: physics given the (model-chosen) hop time.
  function expectedParkAt(min) {
    if (!scaffold.hopper || hopMin < 0) return scaffold.blocks[0].park; // single-park day
    return (min >= 0 && min >= hopMin) ? destPark : startPark;
  }

  const droppedByPark = {};
  const kept = [];
  let hopSeen = false;
  for (const it of items) {
    const type = it.type || '';
    const exp = expectedParkAt(it._min >= 0 ? it._min : scaffold.dayOpen);
    if (type === 'tip' || type === 'break') {
      // A hop/arrive tip is allowed only if it matches the single allowed hop (start->dest).
      const isHopTip = /\bhop\b|arrive (disney|disney california|dca|disneyland)/i.test(it.h || '');
      if (isHopTip && scaffold.hopper) {
        const tipPark = normPark(it.h);
        if (tipPark === destPark && !hopSeen) { hopSeen = true; kept.push(it); continue; }       // the one real hop
        if (tipPark === startPark && hopSeen) {                                                    // hop BACK = invented 2nd hop
          corrections.push({ rule: 'scaffold-extra-hop', item: it.h, action: 'dropped - scaffold allows a single hop only' });
          continue;
        }
      }
      kept.push(it);
      continue;
    }
    const itemPark = landToPark(it.land) || landToPark(it.h);
    if (!itemPark) { kept.push(it); continue; }
    if (itemPark !== exp) {
      corrections.push({ rule: 'scaffold-wrong-park', item: it.h, t: it.t,
        action: 'dropped - ' + itemPark + ' item where you are physically in ' + exp });
      if (droppedByPark[exp] == null || (it._min >= 0 && it._min < droppedByPark[exp])) {
        droppedByPark[exp] = it._min >= 0 ? it._min : scaffold.dayOpen;
      }
      continue;
    }
    kept.push(it);
  }
  // Drop orphaned "head back to <startPark>" tips left over from a removed 2nd hop
  // (a hop-back tip with no startPark ride following it is meaningless).
  if (scaffold.hopper && hopMin >= 0) {
    for (let i = kept.length - 1; i >= 0; i--) {
      const it = kept[i];
      if ((it.type === 'tip') && /head back|return to|back to (disneyland|disney california)/i.test(it.h || '')) {
        const tipPark = normPark(it.h);
        // any real ride after this tip in tipPark?
        const hasFollowingSamePark = kept.slice(i + 1).some(j => {
          const p = landToPark(j.land) || landToPark(j.h);
          return p === tipPark && ['ride','show','character','quickservice','dining','snack'].indexOf(j.type) !== -1;
        });
        if (!hasFollowingSamePark) {
          corrections.push({ rule: 'scaffold-orphan-hop-tip', item: it.h, action: 'dropped - hop-back tip with nothing after it' });
          kept.splice(i, 1);
        }
      }
    }
  }

  // add one gap marker per block that lost an item, naming the correct park
  Object.keys(droppedByPark).forEach(park => {
    const parkFull = park === 'DCA' ? 'Disney California Adventure' : 'Disneyland Park';
    kept.push({ t: _m2t(droppedByPark[park]), type: 'tip',
      h: 'Open time - pick something in ' + parkFull + ' here',
      n: 'A suggestion here was in the wrong park and was removed. Tap Ask AI for a nearby option.' });
  });
  kept.forEach(it => { delete it._min; });
  kept.sort((a, b) => { const ma = _t2m(a.t), mb = _t2m(b.t); return ma < 0 ? 1 : mb < 0 ? -1 : ma - mb; });
  return { items: kept, corrections };
}

// ============================================================================
// PROMPT LAYER: render the scaffold + ask the model to FILL it (strategy).
// The model receives: the fixed blocks (park + time span), the meal slots
// (park + off-peak window), and the full cache. It chooses rides, order,
// rope-drop, hop refinement, venues, and exact off-peak meal times - all from
// the cache. It must keep every ride inside its block's park (physics).
// ============================================================================
function renderScaffoldForPrompt(scaffold) {
  const lines = [];
  lines.push('DAY STRUCTURE (FIXED - you fill it, you do not change the park or the day bounds):');
  lines.push('Day runs ' + _m2t(scaffold.dayOpen) + ' to ' + _m2t(scaffold.dayClose) + '. First activity at park open. Keep going until close.');
  scaffold.blocks.forEach(b => {
    lines.push('');
    lines.push('BLOCK ' + b.id + ' = ' + (b.park === 'DCA' ? 'Disney California Adventure' : 'Disneyland Park') +
      ', ' + _m2t(b.startMin) + ' to ' + _m2t(b.endMin) + '.');
    lines.push('  Every ride/show/character/snack you place in Block ' + b.id + ' MUST physically be located in ' +
      (b.park === 'DCA' ? 'Disney California Adventure' : 'Disneyland Park') + '. Do not place a ride from the other park here.');
    lines.push('  YOU decide (from the cache): which rides, how many, the order, what to rope-drop at the start, and the Lightning Lane plan. Vary it by what the wait/crowd data shows for this day.');
  });
  if (scaffold.hopper && scaffold.blocks.length > 1) {
    const boundary = scaffold.blocks[0].endMin;
    lines.push('');
    lines.push('HOP: you move from Block A park to Block B park around ' + _m2t(boundary) +
      '. You MAY shift the exact hop time using PARK_HOP_STRATEGY, but everything before the hop is in Block A park and everything after is in Block B park.');
  }
  lines.push('');
  lines.push('MEAL SLOTS (one of each - fill the venue + an exact OFF-PEAK time in the window; never the crowd peak):');
  scaffold.mealSlots.forEach(ms => {
    lines.push('  - ' + ms.type.toUpperCase().replace('-', ' ') + ' in ' +
      (ms.park === 'DCA' ? 'Disney California Adventure' : 'Disneyland Park') +
      ', target window ' + ms.windowLabel + '. ' + ms.offPeakNote +
      '. Pick a real venue from the DINING list that is IN this park.');
  });
  return lines.join('\n');
}

export default async function handler(req, res) {
  const ORIGIN = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-trip-code');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { tripConfig, dayIndex = 0, maxTokens = 8000 } = req.body || {};
    if (!tripConfig) return res.status(400).json({ error: 'Missing tripConfig' });
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });

    // --- Cache (identical sections + flow as the working endpoint) ---
    const cacheCtx = await buildCacheContext(
      ['LAND_MAP', 'WAIT_PATTERNS', 'ROPE_DROP_STRATEGY', 'LIGHTNING_LANE_STRATEGY',
       'DINING_TIMING', 'CROWD_FLOW', 'PARK_HOURS', 'PARK_HOP_STRATEGY'], true);
    const sectionCount = Object.keys(cacheCtx).length;
    console.log('[scaffold] cache_sections:', Object.keys(cacheCtx).join(','));
    if (sectionCount < 6) {
      return res.status(503).json({ error: 'Park intelligence cache unavailable.', sections_found: sectionCount });
    }

    // --- PHYSICS: build the scaffold ---
    const scaffold = buildScaffold(tripConfig, dayIndex, cacheCtx);
    const scaffoldText = renderScaffoldForPrompt(scaffold);

    // --- Cache context (same shape as working endpoint) ---
    const parkIntelContext = [
      'LAND MAP:\n' + (cacheCtx.LAND_MAP || '').substring(0, 800),
      'WAIT PATTERNS:\n' + (cacheCtx.WAIT_PATTERNS || '').substring(0, 1200),
      'ROPE DROP STRATEGY:\n' + (cacheCtx.ROPE_DROP_STRATEGY || '').substring(0, 800),
      'LIGHTNING LANE STRATEGY:\n' + (cacheCtx.LIGHTNING_LANE_STRATEGY || '').substring(0, 600),
      'DINING TIMING:\n' + (cacheCtx.DINING_TIMING || '').substring(0, 600),
      'CROWD FLOW:\n' + (cacheCtx.CROWD_FLOW || '').substring(0, 500),
      'PARK HOP STRATEGY:\n' + (cacheCtx.PARK_HOP_STRATEGY || '').substring(0, 600),
      'CURRENT CLOSURES:\n' + (cacheCtx.CURRENT_CLOSURES || '').substring(0, 1000),
      'TRIP CONTEXT:\n' + (cacheCtx.TRIP_CONTEXT || '').substring(0, 600),
      'DINING LIST (venues - each tagged to its park):\n' + (cacheCtx.DINING_INTEL || '').substring(0, 6000)
    ].join('\n\n');

    const charIntel = await getCharacterIntel(4000);
    const charContext = buildCharacterContext(charIntel, tripConfig, 4000);

    const rp = (tripConfig.ridePreferences) || {};
    const ridePrefsContext = (rp.mustDo && rp.mustDo.length || rp.skip && rp.skip.length) ? [
      'GUEST RIDE PREFERENCES:',
      'Must Do (non-negotiable): ' + ((rp.mustDo && rp.mustDo.length) ? rp.mustDo.join(', ') : 'none'),
      'Skip (never include): ' + ((rp.skip && rp.skip.length) ? rp.skip.join(', ') : 'none')
    ].join('\n') : '';

    let system = 'You are the genius best friend who knows Disneyland and Disney California Adventure inside out. You are handed a FIXED day structure (blocks with a park and a time span, plus meal slots). Your job: FILL each block with the smartest rides, order, rope-drop, and Lightning Lane plan, and fill each meal slot with a real in-park venue at an off-peak time. EVERY choice must come from the CACHE DATA - wait patterns, rope-drop and hop strategy, crowd flow, the verified dining and character lists. Do NOT invent wait times, windows, ride names, or venues. NEVER place a ride in a block whose park it does not belong to. NEVER schedule a meal in the crowd peak (lunch 12-1, dinner 6-7). Give the best data-driven play, and let it VARY by day based on the data. Output a SINGLE valid JSON array of schedule items, no markdown.';
    system += '\n\n=== THE FIXED DAY STRUCTURE TO FILL ===\n' + scaffoldText;
    system += '\n\n=== CURRENT PARK INTELLIGENCE (use this - do not search the web) ===\n' + parkIntelContext;
    if (charContext && charContext.trim()) system += '\n\n=== CHARACTER MEETS (from cache) ===\n' + charContext;
    if (ridePrefsContext) system += '\n\n' + ridePrefsContext;
    system += '\n\nEach item: {"t":"H:MM AM/PM","type":"ride|show|character|snack|quickservice|dining|break|tip","h":"title","n":"warm friend note","ll":{"t":"multi|single"} (only for LL booking tips), "land":"the land it is in"}. Order items by time. Start at park open, end by close.';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    let text = '';
    try {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        signal: controller.signal, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, system,
          messages: [{ role: 'user', content: 'Fill the fixed day structure for day ' + (dayIndex + 1) + '. Return only the JSON array.' }] })
      });
      clearTimeout(timeout);
      const data = await anthropicRes.json();
      if (data.error) return res.status(500).json({ error: data.error.message });
      for (const block of (data.content || [])) { if (block.type === 'text') text += block.text; }
      if (!text) return res.status(200).json({ error: 'Empty response', stop_reason: data.stop_reason });

      let items = extractJSON(text);
      if (!Array.isArray(items)) return res.status(200).json({ ok: false, error: 'Model did not return an array', text });

      // --- ENFORCE PHYSICS (hard): assign each item to its block, drop wrong-park items.
      // This is what makes the scaffold real - the model's invented evening hop / DL-lunch-in-DCA
      // get removed by CODE, not by asking the model nicely. ---
      const enf = enforceScaffold(items, scaffold);
      const enforcedItems = enf.items;
      console.log('[scaffold] enforcement removed', enf.corrections.length, 'physically-impossible items');

      // --- VALIDATE: same safety net as the working path, now running on park-correct items ---
      const closedFromCache = parseClosedFromCache(cacheCtx.CURRENT_CLOSURES || '');
      const _day = (tripConfig.schedule && tripConfig.schedule.days && tripConfig.schedule.days[dayIndex]) || {};
      const singleDay = { days: [{ park: _day.park, date: _day.date, items: enforcedItems,
        closeMin: scaffold.dayClose, latestCloseMin: scaffold.dayClose,
        hopTo: scaffold.hopper ? (scaffold.otherPark === 'DCA' ? 'Disney California Adventure' : 'Disneyland') : null }] };
      const safeConfig = Object.assign({}, tripConfig);
      const valResult = validateSchedule(singleDay, safeConfig, closedFromCache, []);
      const validatedItems = (valResult.schedule && valResult.schedule.days[0] && valResult.schedule.days[0].items) || enforcedItems;

      return res.status(200).json({ ok: true, scaffold: { blocks: scaffold.blocks, mealSlots: scaffold.mealSlots },
        text, parsed: validatedItems, corrections: enf.corrections.concat(valResult.corrections), model: data.model });
    } catch (e) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') return res.status(504).json({ error: 'AI request timed out' });
      return res.status(500).json({ error: e.message });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
