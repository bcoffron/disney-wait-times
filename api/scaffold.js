// api/scaffold.js
// Milestone 1 -- single-park schedule SKELETON (physics only).
// Pure function: given a day's park hours + config, return an ordered list of typed,
// park-stamped, time-bounded slots. The model fills each slot; it may choose the ride/
// venue/note and the exact time inside a slot's window, but it may NOT add, remove,
// reorder, or change the park of any slot. See SCAFFOLD_DESIGN.md.

const LUNCH_WINDOWS = [[660, 705], [810, 870]]; // 11:00-11:45 or 1:30-2:30
const DINNER_WINDOWS = [[990, 1050], [1170, 1260]]; // 4:30-5:30 or 7:30-9:00
const SNACK_PM_WINDOW = [780, 900]; // 1:00-3:00
export const DEFAULT_PACE_MIN_PER_RIDE = 44; // ~16 rides on a full day; tunable, becomes a tripConfig field later

function numOrNull(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function winStart(w) { return Array.isArray(w[0]) ? w[0][0] : w[0]; }

// Evenly-spaced RIDE buckets across [start,end] at the cadence: each gets a nominal
// time and a +/- half-step window (clamped), so rides stay spread out but the model
// still picks which ride fills each bucket.
function rideBuckets(start, end, park, pace, role) {
  const out = [];
  const span = end - start;
  if (span < pace * 0.6) return out;
  const n = Math.max(1, Math.round(span / pace));
  const step = span / n;
  const half = Math.max(10, Math.round(step / 2));
  for (let i = 0; i < n; i++) {
    const nominal = Math.round(start + step * (i + 0.5));
    out.push({ block: 'ride', type: 'ride', park,
      window: [Math.max(start, nominal - half), Math.min(end, nominal + half)], role });
  }
  return out;
}

function fitWindows(windows, lo, hi) {
  return windows.map(w => [Math.max(w[0], lo), Math.min(w[1], hi)]).filter(w => w[1] - w[0] >= 20);
}

// Hop-day skeleton. buildSkeleton delegates here when cfg.hop is set and the day is not VIP.
// Morning = start park (open -> hopAt), evening = to-park (hopAt -> close). Single-park path untouched.
function buildHopSkeleton(cfg) {
  const startPark = cfg.park || 'Disneyland';
  const toPark = cfg.hop.toPark;
  const open = cfg.openMin, close = cfg.closeMin, hopAt = cfg.hop.atMin;
  const pace = cfg.paceMinPerRide || DEFAULT_PACE_MIN_PER_RIDE;
  const hasLL = cfg.hasLL !== false;

  const slots = [];
  const push = s => slots.push(s);

  const showWin = [Math.max(1200, close - 120), Math.min(close - 5, 1290)];
  const canShow = showWin[1] - showWin[0] >= 15;

  // ---- MORNING SEGMENT: start park, open -> hopAt ----
  push({ block: 'arrival', type: 'tip', park: startPark, window: [Math.max(0, open - 60), open - 5], role: 'arrival, security, walk to rope-drop land' });
  if (hasLL) push({ block: 'llTip', type: 'tip', park: startPark, window: [Math.max(0, open - 60), Math.max(1, open - 25)], role: 'book the opening Lightning Lane (top headliner)' });
  push({ block: 'ropedrop', type: 'ride', park: startPark, window: [open + 5, open + 20], role: 'headliner rope drop -- best low-wait window of the day' });

  const lunchMorning = fitWindows(LUNCH_WINDOWS, open, hopAt);
  const lunchEvening = fitWindows(LUNCH_WINDOWS, hopAt, close);
  const lunchInMorning = lunchMorning.length > 0;
  const lunchWins = lunchInMorning ? lunchMorning : lunchEvening;

  if (lunchInMorning) {
    const lunchNom = lunchWins[0][0];
    rideBuckets(open + 25, lunchNom - 10, startPark, pace, 'morning ride').forEach(push);
    push({ block: 'lunch', type: 'dining', park: startPark, window: lunchWins, role: 'one lunch, off-peak, name the venue' });
    if (hasLL) push({ block: 'llTip', type: 'tip', park: startPark, window: [590, 620], role: 'mid-morning Lightning Lane rebook' });
    rideBuckets(lunchWins[0][1] + 10, hopAt - 10, startPark, pace, 'late-morning ride').forEach(push);
  } else {
    if (hasLL) push({ block: 'llTip', type: 'tip', park: startPark, window: [590, 620], role: 'mid-morning Lightning Lane rebook' });
    rideBuckets(open + 25, hopAt - 10, startPark, pace, 'morning ride').forEach(push);
  }

  // ---- HOP TRANSITION (tip; park stamp not enforced) ----
  push({ block: 'hop', type: 'tip', park: toPark, window: [hopAt - 10, hopAt + 20], role: 'park hop: walk to ' + toPark + ', security screening (~15 min)' });

  // ---- EVENING SEGMENT: to park, hopAt -> close ----
  const eveStart = hopAt + 25;
  let dinnerSource = canShow ? [DINNER_WINDOWS[0]] : DINNER_WINDOWS;
  if (fitWindows(dinnerSource, eveStart, close).length === 0 && fitWindows(DINNER_WINDOWS, eveStart, close).length > 0) dinnerSource = DINNER_WINDOWS;
  const dinnerWins = fitWindows(dinnerSource, eveStart, close);
  const dinnerNom = dinnerWins.length ? dinnerWins[0][0] : null;
  const preDinnerEnd = dinnerNom !== null ? dinnerNom - 10 : close - 30;

  let afternoonFrom = eveStart;
  if (!lunchInMorning && lunchWins.length) {
    const lNom = lunchWins[0][0];
    rideBuckets(eveStart, lNom - 10, toPark, pace, 'afternoon ride').forEach(push);
    push({ block: 'lunch', type: 'dining', park: toPark, window: lunchWins, role: 'one lunch, off-peak, name the venue' });
    afternoonFrom = lunchWins[0][1] + 10;
  }

  const sWin = [Math.max(SNACK_PM_WINDOW[0], afternoonFrom), Math.min(SNACK_PM_WINDOW[1], preDinnerEnd)];
  const snackFits = (sWin[1] - sWin[0] >= 20) && afternoonFrom <= SNACK_PM_WINDOW[1];
  if (snackFits) {
    const sNom = Math.round((sWin[0] + sWin[1]) / 2);
    rideBuckets(afternoonFrom, sNom - 10, toPark, pace, 'afternoon ride').forEach(push);
    push({ block: 'snackPM', type: 'snack', park: toPark, window: sWin, role: 'one afternoon snack / shopping break' });
    if (hasLL) push({ block: 'llTip', type: 'tip', park: toPark, window: [810, 840], role: 'afternoon Lightning Lane check' });
    rideBuckets(sNom + 10, preDinnerEnd, toPark, pace, 'afternoon ride').forEach(push);
  } else {
    if (hasLL) push({ block: 'llTip', type: 'tip', park: toPark, window: [810, 840], role: 'afternoon Lightning Lane check' });
    rideBuckets(afternoonFrom, preDinnerEnd, toPark, pace, 'afternoon ride').forEach(push);
  }

  if (dinnerWins.length) push({ block: 'dinner', type: 'dining', park: toPark, window: dinnerWins, role: 'one dinner, off-peak, name the venue' });
  const afterDinner = dinnerWins.length ? dinnerWins[0][1] + 10 : preDinnerEnd;

  if (canShow) {
    rideBuckets(afterDinner, showWin[0] - 10, toPark, pace, 'evening ride').forEach(push);
    push({ block: 'show', type: 'show', park: toPark, window: showWin, role: 'nighttime spectacular -- arrive early for a spot' });
    rideBuckets(showWin[1] + 10, close - 10, toPark, pace, 'late-night ride').forEach(push);
  } else {
    rideBuckets(afterDinner, close - 10, toPark, pace, 'evening ride').forEach(push);
  }

  slots.sort((a, b) => winStart(a.window) - winStart(b.window));
  slots.forEach((s, i) => { s.id = 's' + pad2(i + 1); });
  const ordered = slots.map(s => ({ id: s.id, block: s.block, type: s.type, park: s.park, window: s.window, role: s.role }));
  return { day: cfg.dayNum || 1, park: startPark, toPark, hop: true, openMin: open, closeMin: close, hopAtMin: hopAt, paceMinPerRide: pace, vip: false, slots: ordered };
}

export function buildSkeleton(cfg) {
  const park = cfg.park || 'Disneyland';
  const openMin = cfg.openMin, closeMin = cfg.closeMin;
  const pace = cfg.paceMinPerRide || DEFAULT_PACE_MIN_PER_RIDE;
  const hasLL = cfg.hasLL !== false;
  const vipStart = numOrNull(cfg.vipStartMin), vipEnd = numOrNull(cfg.vipEndMin);
  const isVip = vipStart !== null && vipEnd !== null;
  if (cfg.hop && cfg.hop.toPark && !isVip) return buildHopSkeleton(cfg);

  let showWin = [Math.max(1200, closeMin - 120), Math.min(closeMin - 5, 1290)];
  const canShow = showWin[1] - showWin[0] >= 15;

  const slots = [];
  const push = s => slots.push(s);

  // everything from `from` to close: afternoon rides, snackPM, afternoon LL, dinner, evening rides, show, late rides
  function layEvening(from) {
    const dinnerSource = canShow ? [DINNER_WINDOWS[0]] : DINNER_WINDOWS; // dinner before the show on show nights
    const dinnerWins = fitWindows(dinnerSource, from, closeMin);
    const dinnerNom = dinnerWins.length ? dinnerWins[0][0] : null;
    const preDinnerEnd = dinnerNom !== null ? dinnerNom - 10 : closeMin - 30;

    const sWin = [Math.max(SNACK_PM_WINDOW[0], from), Math.min(SNACK_PM_WINDOW[1], preDinnerEnd)];
    const snackFits = (sWin[1] - sWin[0] >= 20) && from <= SNACK_PM_WINDOW[1];
    if (snackFits) {
      const sNom = Math.round((sWin[0] + sWin[1]) / 2);
      rideBuckets(from, sNom - 10, park, pace, 'afternoon ride').forEach(push);
      push({ block: 'snackPM', type: 'snack', park, window: sWin, role: 'one afternoon snack / shopping break' });
      if (hasLL) push({ block: 'llTip', type: 'tip', park, window: [810, 840], role: 'afternoon Lightning Lane check' });
      rideBuckets(sNom + 10, preDinnerEnd, park, pace, 'afternoon ride').forEach(push);
    } else {
      if (hasLL) push({ block: 'llTip', type: 'tip', park, window: [810, 840], role: 'afternoon Lightning Lane check' });
      rideBuckets(from, preDinnerEnd, park, pace, 'afternoon ride').forEach(push);
    }

    if (dinnerWins.length) push({ block: 'dinner', type: 'dining', park, window: dinnerWins, role: 'one dinner, off-peak, name the venue' });
    const afterDinner = dinnerWins.length ? dinnerWins[0][1] + 10 : preDinnerEnd;

    if (canShow) {
      rideBuckets(afterDinner, showWin[0] - 10, park, pace, 'evening ride').forEach(push);
      push({ block: 'show', type: 'show', park, window: showWin, role: 'nighttime spectacular -- arrive early for a spot' });
      rideBuckets(showWin[1] + 10, closeMin - 10, park, pace, 'late-night ride').forEach(push);
    } else {
      rideBuckets(afterDinner, closeMin - 10, park, pace, 'evening ride').forEach(push);
    }
  }

  // Arrival + opening LL (pre-open)
  push({ block: 'arrival', type: 'tip', park, window: [Math.max(0, openMin - 60), openMin - 5], role: 'arrival, security, walk to rope-drop land' });
  if (hasLL) push({ block: 'llTip', type: 'tip', park, window: [Math.max(0, openMin - 60), Math.max(1, openMin - 25)], role: 'book the opening Lightning Lane (top headliner)' });

  if (isVip) {
    if (openMin + 20 <= vipStart) {
      push({ block: 'ropedrop', type: 'ride', park, window: [openMin + 5, Math.min(openMin + 20, vipStart - 5)], role: 'headliner rope drop before your tour' });
      rideBuckets(openMin + 25, vipStart - 5, park, pace, 'pre-tour ride').forEach(push);
    }
    // VOID vipStart..vipEnd (no slots); morning snack intentionally skipped on VIP mornings
    layEvening(vipEnd);
  } else {
    push({ block: 'ropedrop', type: 'ride', park, window: [openMin + 5, openMin + 20], role: 'headliner rope drop -- best low-wait window of the day' });
    const lunchWins = fitWindows(LUNCH_WINDOWS, openMin, closeMin);
    const lunchNom = lunchWins.length ? lunchWins[0][0] : null;
    const morningEnd = lunchNom !== null ? lunchNom - 10 : Math.min(closeMin - 30, 720);
    rideBuckets(openMin + 25, morningEnd, park, pace, 'morning ride').forEach(push);
    if (lunchWins.length) push({ block: 'lunch', type: 'dining', park, window: lunchWins, role: 'one lunch, off-peak, name the venue' });
    if (hasLL) push({ block: 'llTip', type: 'tip', park, window: [590, 620], role: 'mid-morning Lightning Lane rebook' });
    layEvening(lunchWins.length ? lunchWins[0][1] + 10 : morningEnd);
  }

  // sort by time, then assign stable ids in time order
  slots.sort((a, b) => winStart(a.window) - winStart(b.window));
  slots.forEach((s, i) => { s.id = 's' + pad2(i + 1); });
  const ordered = slots.map(s => ({ id: s.id, block: s.block, type: s.type, park: s.park, window: s.window, role: s.role }));

  return { day: cfg.dayNum || 1, park, openMin, closeMin, paceMinPerRide: pace, vip: isVip, slots: ordered };
}

// ---------------------------------------------------------------------------
// FILL LAYER -- the model fills the skeleton; code enforces physics on the way back.
// ---------------------------------------------------------------------------

function toClock(min) {
  min = ((Math.round(min) % 1440) + 1440) % 1440;
  let h = Math.floor(min / 60), m = min % 60, mer = h < 12 ? 'AM' : 'PM', hh = h % 12; if (hh === 0) hh = 12;
  return hh + ':' + (m < 10 ? '0' : '') + m + ' ' + mer;
}
function parseClock(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/(\d{1,2}):(\d{2})\s*([AaPp])/);
  if (!m) return null;
  let h = parseInt(m[1], 10), mn = parseInt(m[2], 10); const pm = /p/i.test(m[3]);
  if (pm && h !== 12) h += 12; if (!pm && h === 12) h = 0;
  return h * 60 + mn;
}
function rangesOf(win) { return Array.isArray(win[0]) ? win : [win]; }
function renderWin(win) { return rangesOf(win).map(r => toClock(r[0]) + '-' + toClock(r[1])).join(' or '); }
function clampToWindow(min, win, fixed) {
  if (typeof fixed === 'number') return { t: fixed, changed: min !== fixed };
  const rs = rangesOf(win);
  if (min === null) return { t: rs[0][0], changed: true };
  for (const r of rs) if (min >= r[0] && min <= r[1]) return { t: min, changed: false };
  let best = rs[0][0], bd = Infinity;
  for (const r of rs) for (const edge of r) { const d = Math.abs(edge - min); if (d < bd) { bd = d; best = edge; } }
  return { t: best, changed: true };
}
function normParkName(p) { const s = String(p || '').toLowerCase(); if (/cali|dca|adventure/.test(s)) return 'dca'; if (/disneyland|\bdl\b/.test(s)) return 'dl'; return s; }
function sameParkName(a, b) { const x = normParkName(a); return x !== '' && x === normParkName(b); }
function buildCard(slot, f, t) {
  const card = { t: toClock(t), h: String(f.h || '').trim(), type: slot.type, n: String(f.n || '').slice(0, 80), land: String(f.land || '').trim() };
  if (f.ride) card.ride = f.ride;
  if (f.ll && (slot.type === 'ride' || slot.type === 'tip')) card.ll = f.ll;
  return card;
}
function placeholderCard(slot) { return { t: toClock(rangesOf(slot.window)[0][0]), h: '(to fill)', type: slot.type, n: '', land: '' }; }

// Short fill prompt -- the skeleton replaces ~30 of the old structural prose rules.
export function buildFillPrompt(skeleton, opts) {
  opts = opts || {};
  const lines = skeleton.slots.map(s => s.id + ' | ' + s.type + ' | ' + s.park + ' | ' + renderWin(s.window) + ' | ' + (s.role || ''));
  let sys = 'You are the genius best friend who knows Disneyland and Disney California Adventure inside out. A structural plan (the SKELETON) has already been built for this day: the time blocks, which park each block is in, the single lunch and single dinner, the show, and the Lightning Lane checkpoints are all FIXED. Your only job is to fill each slot with the smartest real choice from the CACHE DATA.';
  sys += '\n\nRULES:';
  sys += '\n- Return a JSON array with EXACTLY one object per slot, using the same slot ids in the same order. Never add, remove, reorder, merge, or split slots.';
  sys += '\n- Choose each ride/venue/character/tip from the CACHE ONLY (wait patterns, rope-drop and LL strategy, verified dining and character lists). NEVER invent an attraction, venue, wait time, or window -- if a name is not in the cache, do not use it.';
  sys += "\n- Use each attraction's name EXACTLY as written in the cache; never swap in a former, older, or more familiar name from your own memory for a re-themed ride, and never place a permanently-closed attraction.";
  sys += "\n- CORRECTIONS (these override anything in the cache or your own memory): ALWAYS use the current name -- Tiana's Bayou Adventure (never Splash Mountain), Incredicoaster (never California Screamin'), Guardians of the Galaxy - Mission: BREAKOUT! (never Twilight Zone Tower of Terror), Jessie's Critter Carousel (never Jessie's Critter BBQ). It's Tough to be a Bug! is PERMANENTLY CLOSED and must NEVER be scheduled or named. If a forbidden name would ever appear, use its current replacement instead, or omit it -- never output the old or closed name.";
  sys += "\n- Every choice MUST be physically in the slot's park (never a Disneyland attraction in a DCA slot or vice versa), and label each with its correct land from the cache LAND_MAP.";
  sys += "\n- Pick a time INSIDE the slot's window. When a meal slot lists two windows, choose the off-peak one that flows best.";
  sys += "\n- A RIDE slot must be ONE specific, real attraction from the cache. NEVER fill a ride slot with a generic activity ('Explore', 'Recharge', 'Free time', 'Recheck Lightning Lane', 'Wander') -- those belong only in tip slots.";
  sys += '\n- The rope-drop slot MUST be the single highest-demand headliner (top E-ticket) the cache shows for this park, at park open. Spend Lightning Lane on high-wait headliners too.';
  sys += '\n- Never repeat a ride or venue anywhere in the day, or any venue in the ALREADY-USED list. Give exactly ONE name per slot -- never "X (or Y)" or a list of alternatives.';
  sys += '\n- Object schema: { "id":"s03", "t":"8:10 AM", "h":"Name", "type":"<the slot\'s type>", "land":"Land", "n":"tip under 80 chars", "ride":"Exact ride name (rides/LL only)", "ll":{ "t":"multi|single", "a":"..." } }';
  sys += '\n- ll only on ride/tip slots and only if the day has Lightning Lane. ASCII only. Notes under 80 characters.';
  if (opts.closedNames && opts.closedNames.length) sys += '\n- DOWN / CLOSED right now -- do NOT place any of these in a ride slot; if your best pick is on this list, choose a different open attraction from the cache for that slot instead: ' + opts.closedNames.join('; ') + '.';
  sys += '\n\nSKELETON (fill EVERY slot):\n' + lines.join('\n');
  if (opts.usedDining && opts.usedDining.length) sys += '\n\nALREADY-USED venues (never repeat): ' + opts.usedDining.join('; ');
  return sys;
}

// M2 fill-quality helpers.
// Generic activity phrases that must never fill a RIDE slot (they belong in tips).
const GENERIC_RIDE_RE = /^\s*(explore|recharge|free\s*time|flex\s*time|flex\b|recheck|re-check|wander|relax|downtime|buffer|take a break|open (dining )?choice|open choice)/i;
// Display cleanup: drop "(or X)" / "(aka X)" alternatives the model sometimes appends.
function stripAlt(h) { return String(h || '').replace(/\s*\((?:or|aka|a\.?k\.?a\.?)\b[^)]*\)/gi, '').replace(/\s{2,}/g, ' ').trim(); }
// Dedup key: lowercase, drop ALL parentheticals + filler words so "Space Mountain (Night Ride)" collides with "Space Mountain".
function normName(h) { return String(h || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an|ride|standby|at|to|and)\b/g, ' ').replace(/\s+/g, ' ').trim(); }

// Deterministic enforcement of the model's fills. Code owns physics; it never picks
// a ride/venue except via the caller-supplied cache fallback. Returns enforced cards +
// a report + the slot ids that need a retry (missing or wrong-park).
export function applyFills(skeleton, fills, opts) {
  opts = opts || {};
  const landToPark = opts.landToPark || (() => null);
  const fallbackFor = opts.fallbackFor || null;
  const closedNames = (opts.closedNames || []).map(s => String(s).toLowerCase()).filter(Boolean);
  const byId = {}; (fills || []).forEach(f => { if (f && f.id) byId[f.id] = f; });
  const cards = [], needsRetry = [], report = { clamped: 0, wrongPark: 0, missing: 0, fallback: 0, dropped: [] };
  const used = new Set();
  const usedRideNames = new Set();
  const placed = new Set(['ride', 'dining', 'quickservice', 'snack', 'show', 'character']); // slots that occupy a park
  const mkFallback = (slot) => {
    const c = fallbackFor ? fallbackFor(slot, used) : placeholderCard(slot);
    if (fallbackFor) report.fallback++;
    c.t = toClock(clampToWindow(parseClock(c.t), slot.window, slot.fixed).t); // stamp a valid in-window time
    if (!c.type) c.type = slot.type;
    return c;
  };

  for (const slot of skeleton.slots) {
    const f = byId[slot.id];
    let card = null;
    if (f && f.h) {
      const cleanH = stripAlt(f.h);
      const clamp = clampToWindow(parseClock(f.t), slot.window, slot.fixed);
      if (clamp.changed) report.clamped++;
      const landPark = f.land ? landToPark(f.land) : null;
      const parkBad = placed.has(slot.type) && f.land && landPark && !sameParkName(landPark, slot.park);
      const isRideSlot = slot.type === 'ride';
      const generic = isRideSlot && GENERIC_RIDE_RE.test(cleanH);
      const nkey = normName(f.ride || cleanH);
      const dup = isRideSlot && nkey && usedRideNames.has(nkey);
      const hL = cleanH.toLowerCase();
      const closed = isRideSlot && closedNames.some(cn => cn && hL.indexOf(cn) !== -1);
      if (parkBad || generic || dup || closed) {
        if (parkBad) report.wrongPark++;
        if (generic) report.generic = (report.generic || 0) + 1;
        if (dup) report.dupe = (report.dupe || 0) + 1;
        if (closed) report.closed = (report.closed || 0) + 1;
        report.dropped.push({ h: cleanH, reason: closed ? 'closed' : parkBad ? 'wrong-park' : dup ? 'dupe' : 'generic' });
        needsRetry.push(slot.id);
        card = mkFallback(slot);
      } else {
        card = buildCard(slot, Object.assign({}, f, { h: cleanH }), clamp.t);
        if (isRideSlot && nkey) usedRideNames.add(nkey);
      }
    } else {
      report.missing++; needsRetry.push(slot.id);
      card = mkFallback(slot);
    }
    if (card) { if (card.h) used.add(card.h.toLowerCase()); cards.push(card); }
  }
  return { cards, needsRetry, report };
}

// Final safety net for the SCAFFOLD path -- REMOVE-ONLY. This replaces the heavy validateSchedule
// on this path: it never fills gaps, shifts times, or injects rides. It only drops cards that are
// genuinely unsafe -- a closed attraction, or one whose land/name resolves to the wrong park.
// applyFills already handles these per-slot with retry+fallback; verifyScaffold is the last-resort
// backstop for anything that survived (e.g. a wrong-park ride whose land field was blank). Leaving a
// gap is deliberate: an honest hole beats a wrong-park or closed ride, and no code invents content.
// Permanently retired at the Disneyland Resort. The fill model invents these from memory even
// when they are absent from the cache, and prompt instructions don't reliably stop it -- so the
// remove-only verify layer enforces them deterministically (a static counterpart to the dynamic
// closures cache). Matched via normName(contains). String `to` = current name (rename in place);
// null = permanently closed (drop the card).
const RETIRED = [
  { m: 'splash mountain', to: "Tiana's Bayou Adventure" },
  { m: 'california screamin', to: 'Incredicoaster' },
  { m: 'tower of terror', to: 'Guardians of the Galaxy - Mission: BREAKOUT!' },
  { m: 'critter bbq', to: "Jessie's Critter Carousel" },
  { m: 'tough be bug', to: null }
];

// Parse the CATALOG cache section (JSON string or object) into a lookup:
//   normName(attraction name) -> { park, land, status }
// Rides only (venues ignored here). Fail-open: returns {} on any parse failure, which makes
// verifyScaffold behave exactly as before (no CATALOG enforcement) rather than throwing.
export function buildCatalogIndex(catalogRaw) {
  const idx = {};
  if (!catalogRaw) return idx;
  let cat = catalogRaw;
  if (typeof cat === 'string') { try { cat = JSON.parse(cat); } catch (e) { return idx; } }
  const list = (cat && Array.isArray(cat.attractions)) ? cat.attractions : [];
  for (const a of list) {
    if (!a || !a.name) continue;
    const k = normName(a.name);
    if (!k) continue;
    idx[k] = { park: a.park || '', land: a.land || '', status: String(a.status || 'operating') };
  }
  return idx;
}

// Order final cards chronologically and de-collide identical timestamps. The model may pick
// any time inside a slot window, so slot order (window-start) can invert against chosen times.
// Equal times get bumped +1 min so each is distinct (display-only). Unparseable times sort last.
function sortAndSpace(cards) {
  const rows = (cards || []).map((c, i) => ({ c, i, m: parseClock(c.t) }));
  rows.sort((a, b) => ((a.m == null) - (b.m == null)) || ((a.m || 0) - (b.m || 0)) || (a.i - b.i));
  let prev = -1;
  for (const r of rows) {
    if (r.m == null) continue;
    let m = r.m;
    if (m <= prev) m = prev + 1;
    r.c.t = toClock(m);
    prev = m;
  }
  return rows.map(r => r.c);
}

export function verifyScaffold(cards, opts) {
  opts = opts || {};
  const park = opts.park || null;
  const landToPark = opts.landToPark || (() => null);
  const catalog = opts.catalog || {};
  const catalogLoaded = Object.keys(catalog).length > 0;
  const closedNames = (opts.closedNames || []).map(s => String(s).toLowerCase()).filter(Boolean);
  const placed = new Set(['ride', 'dining', 'quickservice', 'snack', 'show', 'character']);
  const removed = [], kept = [], usedRide = new Set();
  for (const c of (cards || [])) {
    const hL = String(c.h || '').toLowerCase();
    if (c.type === 'ride') {
      // 1. RETIRED: rename outdated / drop permanently-closed
      const nn = normName(c.h);
      const rhit = RETIRED.find(r => nn.indexOf(r.m) !== -1);
      if (rhit) {
        if (rhit.to === null) { removed.push({ h: c.h, reason: 'retired' }); continue; }
        c.h = rhit.to; if (c.ride) c.ride = rhit.to;
      }
      // 2. CLOSURES cache (trip-date-windowed -- the closure authority)
      if (closedNames.some(cn => cn && hL.indexOf(cn) !== -1)) { removed.push({ h: c.h, reason: 'closed' }); continue; }
      // 3. CATALOG authoritative: relabel land + wrong-park + conservative hallucination drop
      const ce = catalog[normName(c.ride || c.h)];
      if (ce) {
        if (park && ce.park && !sameParkName(ce.park, park)) { removed.push({ h: c.h, reason: 'wrong-park-catalog' }); continue; }
        if (ce.land) c.land = ce.land; // relabel to canonical land
      } else {
        const p = landToPark(c.land) || landToPark(c.h);
        if (catalogLoaded && !p) { removed.push({ h: c.h, reason: 'not-at-resort' }); continue; }
        if (park && p && !sameParkName(p, park)) { removed.push({ h: c.h, reason: 'wrong-park' }); continue; }
      }
      // 4. dupe
      const k = normName(c.ride || c.h);
      if (k && usedRide.has(k)) { removed.push({ h: c.h, reason: 'dupe' }); continue; }
      if (k) usedRide.add(k);
    } else if (park && placed.has(c.type)) {
      // non-ride placed types (dining/snack/show/character): unchanged landToPark wrong-park check
      const p = landToPark(c.land) || landToPark(c.h);
      if (p && !sameParkName(p, park)) { removed.push({ h: c.h, reason: 'wrong-park' }); continue; }
    }
    kept.push(c);
  }
  return { cards: sortAndSpace(kept), removed };
}

// Given the structured CLOSURES cache (a JSON string or array of {name, closeDate?, reopenDate?})
// and the trip date, return the names of attractions whose closure window covers that date.
// Window = [closeDate, reopenDate): flag as closed on D only when a real closeDate is present and
// closeDate <= D AND (reopenDate is null OR D < reopenDate). FAIL OPEN: a missing/absent closeDate
// is NOT flagged -- a cache gap must never delete a live ride (soft-fail: might schedule a closed
// ride, which live wait-times surface; vs hard-fail: deleting a headliner). reopenDate null = no
// known reopen (closed indefinitely once started). Never throws; returns [] when the cache is
// missing/unparseable, the trip date is absent, or nothing matches. Dates compared as ISO YYYY-MM-DD.
export function closedNamesForDate(closures, tripDate) {
  const toISO = (s) => {
    if (!s) return '';
    s = String(s);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const dt = new Date(s);
    return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
  };
  let arr = closures;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { return []; } }
  if (arr && !Array.isArray(arr) && Array.isArray(arr.closures)) arr = arr.closures;
  if (!Array.isArray(arr)) return [];
  const d = toISO(tripDate);
  if (!d) return [];
  const names = [];
  for (const e of arr) {
    if (!e || !e.name) continue;
    const start = toISO(e.closeDate);
    const end = toISO(e.reopenDate);
    if (!start) continue; // fail OPEN: no known closure start -> never flag a live ride
    if (d < start) continue; // trip is before the closure begins -> open
    if (end && d >= end) continue; // trip is on/after the reopen date -> open
    names.push(String(e.name)); // closeDate <= tripDate < reopenDate (or no reopen) -> closed
  }
  return names;
}
