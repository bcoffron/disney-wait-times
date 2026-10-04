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
    // Single VIP Tour card at vipStart (applyFills emits it verbatim from role); covers the whole tour
    push({ block: 'vip', type: 'vip', park, window: [vipStart, vipStart], role: 'Your private guide handles all skip-the-line access from ' + toClock(vipStart) + ' to ' + toClock(vipEnd) + '.' });
    // VOID vipStart..vipEnd; resume full evening at vipEnd
    layEvening(vipEnd);
    // Nothing but the VIP card may fall inside the tour window (removes e.g. layEvening's fixed 1:30 PM LL tip)
    for (let i = slots.length - 1; i >= 0; i--) {
      const ws = winStart(slots[i].window);
      if (slots[i].block !== 'vip' && ws >= vipStart && ws < vipEnd) slots.splice(i, 1);
    }
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
  let _h = String(f.h || '').trim();
  // The fill sometimes returns the park or land name as the heading with the real
  // attraction in `ride` (guests saw ride cards titled "Disneyland" / "DCA"). On
  // ride slots the ride name is the heading whenever the two disagree.
  if (slot.type === 'ride' && f.ride && normName(_h) !== normName(f.ride)) _h = String(f.ride).trim();
  const card = { t: toClock(t), h: _h, type: slot.type, n: String(f.n || '').slice(0, 80), land: String(f.land || '').trim() };
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
  if (opts.closedVenueNames && opts.closedVenueNames.length) sys += '\n- DOWN FOR REFURBISHMENT right now -- do NOT place any of these in a dining, quickservice, or snack slot; choose a different open venue from the verified dining list instead: ' + opts.closedVenueNames.join('; ') + '.';
  sys += '\n\nSKELETON (fill EVERY slot):\n' + lines.join('\n');
  if (opts.usedDining && opts.usedDining.length) sys += '\n\nALREADY-USED venues (never repeat): ' + opts.usedDining.join('; ');
  if (opts.usedRides && opts.usedRides.length) sys += '\n\nALREADY-USED rides on earlier days of this trip (never repeat): ' + opts.usedRides.join('; ');
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
  // DINING_CLOSURES cache (trip-date-windowed): closed restaurant / quick-service / snack names.
  const closedVenueNames = (opts.closedVenueNames || []).map(s => String(s).toLowerCase()).filter(Boolean);
  const byId = {}; (fills || []).forEach(f => { if (f && f.id) byId[f.id] = f; });
  const cards = [], needsRetry = [], report = { clamped: 0, wrongPark: 0, missing: 0, fallback: 0, dropped: [] };
  const used = new Set();
  const usedRideNames = new Set();
  // Cross-day dedupe: rides already placed on earlier days of this trip count as
  // used, so fills and the deterministic backfill will not repeat them. Must-dos
  // are exempt -- the guest asked for those by name, repeats included.
  const _mustKeys = new Set((opts.mustDoNames || []).map(normName));
  (opts.priorRides || []).forEach(function(n) { const k = normName(n); if (k && !_mustKeys.has(k)) usedRideNames.add(k); });
  const placed = new Set(['ride', 'dining', 'quickservice', 'snack', 'show', 'character']); // slots that occupy a park
  const mkFallback = (slot) => {
    const c = fallbackFor ? fallbackFor(slot, { usedNames: used, usedRideKeys: usedRideNames }) : placeholderCard(slot);
    if (fallbackFor) report.fallback++;
    c.t = toClock(clampToWindow(parseClock(c.t), slot.window, slot.fixed).t); // stamp a valid in-window time
    if (!c.type) c.type = slot.type;
    return c;
  };

  for (const slot of skeleton.slots) {
    if (slot.type === 'vip') {
      cards.push({ t: toClock(winStart(slot.window)), h: 'VIP Tour', type: 'vip', n: slot.role || '', land: '' });
      continue;
    }
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
      const isDiningSlot = slot.type === 'dining' || slot.type === 'quickservice' || slot.type === 'snack';
      const venueClosed = isDiningSlot && closedVenueNames.some(cn => cn && hL.indexOf(cn) !== -1);
      const retiredClosed = isRideSlot && !!nkey && RETIRED.some(r => r.to === null && nkey.indexOf(r.m) !== -1);
      if (parkBad || generic || dup || closed || retiredClosed || venueClosed) {
        if (parkBad) report.wrongPark++;
        if (generic) report.generic = (report.generic || 0) + 1;
        if (dup) report.dupe = (report.dupe || 0) + 1;
        if (closed || retiredClosed || venueClosed) report.closed = (report.closed || 0) + 1;
        report.dropped.push({ h: cleanH, reason: (closed || retiredClosed || venueClosed) ? 'closed' : parkBad ? 'wrong-park' : dup ? 'dupe' : 'generic' });
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

// ILL-only attractions at the Disneyland Resort (per the CURRENT_LL_PRICING cache:
// exactly two). Every other Lightning Lane attraction is Multi Pass. Static
// counterpart to the pricing cache, same pattern as RETIRED above.
const ILL_ONLY_KEYS = new Set(['star wars rise of the resistance', 'radiator springs racers'].map(normName));

// Parse the CATALOG cache section (JSON string or object) into a lookup:
//   normName(attraction name) -> { name, park, land, status, typicalPeakWait, ropeDropValue }
// Rides only (venues ignored here -- see parseCatalogVenues). Fail-open: returns {} on any
// parse failure, which makes verifyScaffold behave exactly as before (no CATALOG enforcement)
// rather than throwing. The extra fields power deterministicBackfill's smart picks.
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
    idx[k] = { name: String(a.name), park: a.park || '', land: a.land || '',
      status: String(a.status || 'operating'),
      typicalPeakWait: (typeof a.typicalPeakWait === 'number') ? a.typicalPeakWait : 0,
      ropeDropValue: a.ropeDropValue || '' };
  }
  return idx;
}

// Parse the CATALOG cache section's venues into an ordered array:
//   [{ name, park, land, service, reservationPolicy, exclude }]
// Used by deterministicBackfill for dining/snack slots. Fail-open: [] on any parse failure.
export function parseCatalogVenues(catalogRaw) {
  if (!catalogRaw) return [];
  let cat = catalogRaw;
  if (typeof cat === 'string') { try { cat = JSON.parse(cat); } catch (e) { return []; } }
  const list = (cat && Array.isArray(cat.venues)) ? cat.venues : [];
  const out = [];
  for (const v of list) {
    if (!v || !v.name) continue;
    out.push({ name: String(v.name), park: v.park || '', land: v.land || '',
      service: v.service || '', reservationPolicy: v.reservationPolicy || '',
      exclude: v.exclude === true });
  }
  return out;
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
  const allowedParks = (Array.isArray(opts.parks) && opts.parks.length) ? opts.parks : (opts.park ? [opts.park] : []);
  const landToPark = opts.landToPark || (() => null);
  const catalog = opts.catalog || {};
  const catalogLoaded = Object.keys(catalog).length > 0;
  const inAllowed = (p) => allowedParks.length === 0 || allowedParks.some(ap => sameParkName(p, ap));
  const closedNames = (opts.closedNames || []).map(s => String(s).toLowerCase()).filter(Boolean);
  // DINING_CLOSURES cache (trip-date-windowed): closed restaurant / quick-service / snack names.
  const closedVenueNames = (opts.closedVenueNames || []).map(s => String(s).toLowerCase()).filter(Boolean);
  const placed = new Set(['ride', 'dining', 'quickservice', 'snack', 'show', 'character']);
  const removed = [], kept = [], usedRide = new Set();
  for (const c of (cards || [])) {
    const hL = String(c.h || '').toLowerCase();
    // ILL correction: only Rise and Radiator Springs Racers are Individual
    // Lightning Lane. A 'single' tag on anything else (e.g. Space Mountain) is a
    // model error -- downgrade it to Multi Pass and scrub the wording, so the app
    // stops presenting it as a Single Pass purchase.
    if (c.ll && c.ll.t === 'single' && (c.type === 'ride' || c.type === 'tip')) {
      const _lk = normName(c.ride || c.h);
      if (_lk && !ILL_ONLY_KEYS.has(_lk)) {
        c.ll = Object.assign({}, c.ll, { t: 'multi' });
        const _scrub = (s) => typeof s === 'string' ? s.replace(/single pass/gi, 'Multi Pass').replace(/\bILL\b/g, 'LLMP') : s;
        if (c.ll.a) c.ll.a = _scrub(c.ll.a);
        c.h = _scrub(c.h); if (c.n) c.n = _scrub(c.n);
      }
    }
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
        if (allowedParks.length && ce.park && !inAllowed(ce.park)) { removed.push({ h: c.h, reason: 'wrong-park-catalog' }); continue; }
        if (ce.land) c.land = ce.land; // relabel to canonical land
        if (c.ride && normName(c.h) !== normName(ce.name)) c.h = ce.name; // heading is the ride's name, never the park/land name
      } else {
        const p = landToPark(c.land) || landToPark(c.h);
        if (catalogLoaded && !p) { removed.push({ h: c.h, reason: 'not-at-resort' }); continue; }
        if (allowedParks.length && p && !inAllowed(p)) { removed.push({ h: c.h, reason: 'wrong-park' }); continue; }
      }
      // 4. dupe
      const k = normName(c.ride || c.h);
      if (k && usedRide.has(k)) { removed.push({ h: c.h, reason: 'dupe' }); continue; }
      if (k) usedRide.add(k);
    } else if (allowedParks.length && placed.has(c.type)) {
      // DINING CLOSURES cache (trip-date-windowed): never seat a guest at a closed venue.
      if ((c.type === 'dining' || c.type === 'quickservice' || c.type === 'snack') &&
          closedVenueNames.some(cn => cn && hL.indexOf(cn) !== -1)) {
        removed.push({ h: c.h, reason: 'venue-closed' }); continue;
      }
      // A land or park name is not a show: fills sometimes name the land the show
      // lives in ("Pixar Pier") instead of the show itself. Drop those cards.
      if (c.type === 'show') {
        const _hk = normName(c.h);
        const _landKeys = new Set(Object.values(catalog).map(e => normName(e.land || '')).filter(Boolean));
        if (_landKeys.has(_hk) || _hk === 'disneyland' || _hk === 'disneyland park' || _hk === 'disney california adventure' || _hk === 'dca') {
          removed.push({ h: c.h, reason: 'land-as-show' }); continue;
        }
      }
      // non-ride placed types (dining/snack/show/character): unchanged landToPark wrong-park check
      const p = landToPark(c.land) || landToPark(c.h);
      if (p && !inAllowed(p)) { removed.push({ h: c.h, reason: 'wrong-park' }); continue; }
    }
    kept.push(c);
  }
  return { cards: sortAndSpace(kept), removed };
}

// ---------------------------------------------------------------------------
// CLOSURE DIFF (twice-weekly sweep) -- pure helpers for detecting material changes
// between two snapshots of a closure list (CLOSURES or DINING_CLOSURES).
// A material change = an entry added, removed, or date/status-shifted. Prose-only
// differences never reach this layer (sections are structured JSON by contract).
// ---------------------------------------------------------------------------

// Stable identity for a closure entry: normalized name + park.
export function closureKey(e) {
  return String((e && e.name) || '').toLowerCase().replace(/[^a-z0-9]/g, '') +
    '|' + String((e && e.park) || '').toLowerCase();
}

// Diff two closure arrays -> {added, removed, changed}. changed entries carry
// {before, after}; a closeDate/reopenDate/status shift is material (it moves a trip day
// in or out of a closure window). Never throws.
export function diffClosureLists(prev, next) {
  const pm = new Map(), nm = new Map();
  (prev || []).forEach(e => { if (e && e.name) pm.set(closureKey(e), e); });
  (next || []).forEach(e => { if (e && e.name) nm.set(closureKey(e), e); });
  const added = [], removed = [], changed = [];
  for (const [k, e] of nm) {
    if (!pm.has(k)) { added.push(e); continue; }
    const p = pm.get(k);
    if (String(p.closeDate || '') !== String(e.closeDate || '') ||
        String(p.reopenDate || '') !== String(e.reopenDate || '') ||
        String(p.status || '') !== String(e.status || '')) {
      changed.push({ before: p, after: e });
    }
  }
  for (const [k, e] of pm) if (!nm.has(k)) removed.push(e);
  return { added, removed, changed };
}

// Stable alert id: the same closure on the same trip never alerts twice.
export function alertIdFor(kind, entry) {
  return 'closure:' + kind + ':' + closureKey(entry) + ':' + String(entry.closeDate || 'null');
}

// Given the structured CLOSURES cache (a JSON string or array of {name, closeDate?, reopenDate?})
// and the trip date, return the names of attractions whose closure window covers that date.
// NULL-DATE CONTRACT (matches the CLOSURES builder prompt FIELD RULES in api/cron-cache.js):
// a null closeDate means the attraction is ALREADY closed as of the cache build, with no known
// start date -- it counts as closed on the trip date unless a reopenDate is known and the trip
// is on/after it. Window = [closeDate, reopenDate) for dated entries: flag as closed on D only
// when closeDate <= D AND (reopenDate is null OR D < reopenDate). reopenDate null = no known
// reopen (closed indefinitely once started). Never throws; returns [] when the cache is
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
    if (!start) {
      // NULL-DATE FIX: null closeDate = already closed as of the cache build (per the
      // builder contract). Failing open here scheduled rides the cache knew were closed.
      if (end && d >= end) continue; // reopened on/before the trip -> open
      names.push(String(e.name));    // closed now, no known reopen -> closed on trip date
      continue;
    }
    if (d < start) continue; // trip is before the closure begins -> open
    if (end && d >= end) continue; // trip is on/after the reopen date -> open
    names.push(String(e.name)); // closeDate <= tripDate < reopenDate (or no reopen) -> closed
  }
  return names;
}

// ---------------------------------------------------------------------------
// DETERMINISTIC BACKFILL (recommendation #3) -- no placeholder cards, ever.
// When the model fails a slot (missing/invalid fill), pick a real, cache-verified
// choice deterministically instead of shipping "Flex time" / "Open dining choice".
// Pure function of (slot, ctx): same inputs -> same card, every run.
// ctx: { catalog: [ordered attraction entries], venues: [ordered venue entries],
//        closedNames: [raw closed names], usedRideKeys: Set (mutated),
//        usedNames: Set of lowercased placed names (mutated) }
export function deterministicBackfill(slot, ctx) {
  ctx = ctx || {};
  const catalog = Array.isArray(ctx.catalog) ? ctx.catalog : [];
  const venues = Array.isArray(ctx.venues) ? ctx.venues : [];
  const usedRideKeys = (ctx.usedRideKeys instanceof Set) ? ctx.usedRideKeys : new Set();
  const usedNames = (ctx.usedNames instanceof Set) ? ctx.usedNames : new Set();
  const closedKeys = new Set((ctx.closedNames || []).map(s => normName(s)).filter(Boolean));
  const closedVenueKeys = new Set((ctx.closedVenueNames || []).map(s => normName(s)).filter(Boolean));
  const inSlotPark = (p) => sameParkName(p, slot.park);
  const t0 = toClock(rangesOf(slot.window)[0][0]);

  if (slot.type === 'ride') {
    const cands = catalog.filter(e =>
      e && e.name && !usedRideKeys.has(normName(e.name)) &&
      inSlotPark(e.park) && (!e.status || e.status === 'operating') &&
      !closedKeys.has(normName(e.name)));
    // Deterministic: highest typical peak wait first (headliners earn the slot), ties by name.
    cands.sort((a, b) => ((b.typicalPeakWait || 0) - (a.typicalPeakWait || 0)) || String(a.name).localeCompare(String(b.name)));
    if (cands.length) {
      const pick = cands[0];
      usedRideKeys.add(normName(pick.name));
      usedNames.add(String(pick.name).toLowerCase());
      return { t: t0, h: pick.name, type: 'ride', n: 'Top standby-saver from the verified attraction list.', land: pick.land || '', ride: pick.name };
    }
  }

  if (slot.type === 'dining' || slot.type === 'quickservice' || slot.type === 'snack') {
    const rankResv = (r) => r === 'walkup' ? 0 : r === 'recommended' ? 1 : 2;
    const rankSvc = (s) => (s === 'quickservice' || s === 'snack') ? 0 : 1;
    const cands = venues
      .filter(v => v && v.name && !v.exclude && inSlotPark(v.park) &&
        !usedNames.has(String(v.name).toLowerCase()) &&
        !closedVenueKeys.has(normName(v.name)) &&
        (v.reservationPolicy === 'walkup' || v.reservationPolicy === 'recommended'))
      .sort((a, b) => (rankResv(a.reservationPolicy) - rankResv(b.reservationPolicy)) || (rankSvc(a.service) - rankSvc(b.service)));
    if (cands.length) {
      const pick = cands[0];
      usedNames.add(String(pick.name).toLowerCase());
      const note = pick.reservationPolicy === 'walkup'
        ? 'Verified walkup pick from the dining list.'
        : 'From the verified dining list -- booking ahead recommended.';
      return { t: t0, h: pick.name, type: slot.type, n: note, land: pick.land || '' };
    }
  }

  // Structural tip slots and anything unfillable: an honest, deterministic tip built from
  // the slot's own role -- never a "Flex time" placeholder.
  const tipTitle = slot.block === 'llTip' ? 'Lightning Lane check'
    : slot.block === 'arrival' ? 'Arrival and rope-drop positioning'
    : slot.block === 'hop' ? 'Park hop'
    : slot.block === 'show' ? 'Nighttime spectacular'
    : (slot.role || 'Break').split('--')[0].trim().slice(0, 60) || 'Break';
  const tipNote = slot.block === 'show'
    ? "Arrive early for a spot -- check today's showtimes."
    : String(slot.role || '').slice(0, 80);
  return { t: t0, h: tipTitle, type: slot.block === 'show' ? 'show' : 'tip', n: tipNote, land: '' };
}

// ---------------------------------------------------------------------------
// PARAMETER-FIDELITY VERIFIER (recommendation #2): guest parameters are absolute.
// Checks the final cards against explicit trip parameters and reports violations.
// params: { mustDo: [names], skip: [names], hasLL: bool }. Never throws.
export function verifyTripParams(cards, params) {
  params = params || {};
  const violations = [];
  const keyOf = (c) => normName((c && (c.ride || c.h)) || '');
  const cardKeys = new Set((cards || []).map(keyOf).filter(Boolean));
  for (const name of (params.mustDo || [])) {
    const k = normName(name);
    if (k && !cardKeys.has(k)) violations.push({ kind: 'mustdo-missing', name: String(name) });
  }
  for (const name of (params.skip || [])) {
    const k = normName(name);
    if (k && cardKeys.has(k)) violations.push({ kind: 'skip-present', name: String(name) });
  }
  if (params.hasLL === false) {
    for (const c of (cards || [])) {
      if (c && c.ll) violations.push({ kind: 'll-when-none', name: String(c.h || '') });
    }
  }
  return violations;
}

// Deterministic enforcement for violations the cited retry didn't fix.
// skip-present -> card removed; ll-when-none -> ll field stripped;
// mustdo-missing -> swapped into the earliest non-rope-drop ride card in the matching
// park (mustDo is guest-non-negotiable; rope-drop headliner is preserved when possible).
// ctx: { catalog: {normKey: entry}, landToPark: fn }. Never throws.
export function enforceTripParams(cards, violations, ctx) {
  ctx = ctx || {};
  const catalog = ctx.catalog || {};
  const landToPark = ctx.landToPark || (() => null);
  const fixed = [], unfixable = [];
  let out = (cards || []).slice();
  const parkOfCard = (c) => normParkName(landToPark(c.land) || landToPark(c.h) || '');
  const parkOfName = (name) => {
    const ce = catalog[normName(name)];
    if (ce && ce.park) return normParkName(ce.park);
    return normParkName(landToPark(name) || '');
  };

  for (const v of (violations || [])) {
    if (v.kind === 'skip-present') {
      const k = normName(v.name);
      const before = out.length;
      out = out.filter(c => normName((c.ride || c.h) || '') !== k);
      if (out.length < before) fixed.push({ kind: v.kind, name: v.name, action: 'removed' });
      else unfixable.push(v);
    } else if (v.kind === 'll-when-none') {
      const k = normName(v.name);
      let n = 0;
      for (const c of out) {
        if (c.ll && (String(c.h || '') === v.name || normName((c.ride || c.h) || '') === k)) { delete c.ll; n++; }
      }
      if (n) fixed.push({ kind: v.kind, name: v.name, action: 'll-stripped' });
      else unfixable.push(v);
    } else if (v.kind === 'mustdo-missing') {
      const wantPark = parkOfName(v.name);
      // Recompute per violation so two missing mustDos never target the same card.
      const findTarget = () => {
        const rc = out.map((c, i) => ({ c, i })).filter(({ c }) => c.type === 'ride');
        const fr = rc[0];
        return rc.find(({ c }) => c !== (fr && fr.c) && (!wantPark || parkOfCard(c) === wantPark))
          || rc.find(({ c }) => !wantPark || parkOfCard(c) === wantPark);
      };
      const target = findTarget();
      if (target) {
        const ce = catalog[normName(v.name)];
        target.c.h = v.name;
        target.c.ride = v.name;
        if (ce && ce.land) target.c.land = ce.land;
        fixed.push({ kind: v.kind, name: v.name, action: 'swapped-in', at: target.c.t });
      } else {
        unfixable.push(v);
      }
    }
  }
  return { cards: out, fixed, unfixable };
}
