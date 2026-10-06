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
// Honest daypart pacing: a ride slot must price in the wait at that hour plus
// the ride itself plus walking. The old flat ~44 min/ride made midday plans
// physically impossible (a 55-min standby wait alone exceeds the bucket).
// Table = minutes per ride by segment start; scaled by the caller's base pace
// (44 = 1.0). VIP pace passes through untouched (a guide skips the lines).
function paceForSegment(startMin, base, isVip) {
  if (isVip) return base;
  const scale = (base || DEFAULT_PACE_MIN_PER_RIDE) / DEFAULT_PACE_MIN_PER_RIDE;
  let t;
  if (startMin < 660) t = 38;        // rope-drop window: lines still short
  else if (startMin < 780) t = 52;   // late morning
  else if (startMin < 1020) t = 62;  // midday / afternoon peak waits
  else if (startMin < 1200) t = 52;  // evening
  else t = 42;                       // late night: waits collapse
  return Math.max(30, Math.round(t * scale));
}
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

// Tail rides: fill from `from` to park close, guaranteeing a FINAL ride slot
// whose window ends at close. A schedule must run to closing -- without this the
// evening faded out 45-120 min early (last card = the show at its window start,
// or a late ride picked early in a wide window).
function tailRides(from, close, park, pace, role, push) {
  const end = close - 5;
  if (end - from < 12) return;
  const buckets = rideBuckets(from, Math.max(from, end - 30), park, pace, role);
  buckets.forEach(push);
  // Short tail (e.g. 30 min after the nighttime show): one last-ride slot using
  // the whole remaining window. Long tail with no room for pace buckets: anchor
  // the final slot in the last 30 min before close.
  const finStart = buckets.length
    ? Math.max(buckets[buckets.length - 1].window[1] + 5, end - 30)
    : (end - from > 30 ? end - 30 : from);
  if (end - finStart >= 12) {
    push({ block: 'ride', type: 'ride', park, window: [finStart, end], role: role + ' -- last ride of the night, ride until close' });
  }
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
  const P = (fromMin) => paceForSegment(fromMin, pace, false);
  const hasLL = cfg.hasLL !== false;

  // Return hop (hopper tickets only; the generator sets returnAtMin only when
  // the start park closes meaningfully later than the evening park): the
  // evening segment wraps up by returnAtMin, then the day hops BACK to the
  // start park and rides to its later close.
  const returning = !!(cfg.hop.returnAtMin && cfg.hop.returnCloseMin && cfg.hop.returnCloseMin > close);
  const returnAt = returning ? cfg.hop.returnAtMin : null;
  const eveClose = returning ? returnAt + 5 : close;

  const slots = [];
  const push = s => slots.push(s);

  const showWin = [Math.max(1200, eveClose - 120), Math.min(eveClose - 5, Math.max(1290, eveClose - 60))];
  const canShow = showWin[1] - showWin[0] >= 15;

  // ---- MORNING SEGMENT: start park, open -> hopAt ----
  push({ block: 'arrival', type: 'tip', park: startPark, window: [Math.max(0, open - 60), open - 5], role: 'arrival, security, walk to rope-drop land' });
  if (hasLL) push({ block: 'llTip', type: 'tip', park: startPark, window: [Math.max(0, open - 60), Math.max(1, open - 25)], role: 'book the opening Lightning Lane (top headliner)' });
  push({ block: 'ropedrop', type: 'ride', park: startPark, window: [open + 5, open + 20], role: 'headliner rope drop -- best low-wait window of the day' });

  const lunchMorning = fitWindows(LUNCH_WINDOWS, open, hopAt);
  const lunchEvening = fitWindows(LUNCH_WINDOWS, hopAt + 25, close); // evening segment starts at hopAt+25; fitting lunch from hopAt let its window open before the first evening ride bucket and the two collided 1 minute apart
  const lunchInMorning = lunchMorning.length > 0;
  const lunchWins = lunchInMorning ? lunchMorning : lunchEvening;

  if (lunchInMorning) {
    const lunchNom = lunchWins[0][0];
    rideBuckets(open + 25, lunchNom - 10, startPark, P(open + 25), 'morning ride').forEach(push);
    push({ block: 'lunch', type: 'dining', park: startPark, window: lunchWins, role: 'one lunch, off-peak, name the venue' });
    push({ block: 'photoMidday', type: 'break', park: startPark, window: [lunchWins[0][1] + 5, lunchWins[0][1] + 35], role: 'photo op near your lunch spot -- a quick group photo while you are in the area', breakTitle: 'Photo Op' });
    if (hasLL) push({ block: 'llTip', type: 'tip', park: startPark, window: [590, 620], role: 'mid-morning Lightning Lane rebook' });
    rideBuckets(lunchWins[0][1] + 10, hopAt - 10, startPark, P(lunchWins[0][1] + 10), 'late-morning ride').forEach(push);
  } else {
    if (hasLL) push({ block: 'llTip', type: 'tip', park: startPark, window: [590, 620], role: 'mid-morning Lightning Lane rebook' });
    rideBuckets(open + 25, hopAt - 10, startPark, P(open + 25), 'morning ride').forEach(push);
  }

  // Character meet (must-do categories): one guaranteed meet in the start park.
  if (cfg.charMeet && sameParkName(cfg.charMeet.park, startPark)) {
    push({ block: 'character', type: 'character', park: startPark, window: [open + 150, open + 215], role: 'character meet: ' + cfg.charMeet.name + ' at ' + (cfg.charMeet.land || '') + ' -- a must-do for this group', meetName: cfg.charMeet.name, meetLand: cfg.charMeet.land || '', meetCategory: cfg.charMeet.category || '' });
  }

  // Morning comfort stops (Beau, Oct 5, 2026: generated days had NO bathroom,
  // snack, shopping, or photo breaks at all). A mid-morning snack and a
  // restroom break are structural slots, not model whims: snack fills via the
  // venue path; the restroom break is emitted deterministically (breakBad in
  // applyFills routes it to the backfill verbatim).
  push({ block: 'snackAM', type: 'snack', park: startPark, window: [open + 90, open + 135], role: 'morning snack / coffee break -- a quick bite and drinks' });
  push({ block: 'breakAM', type: 'break', park: startPark, window: [open + 140, open + 185], role: 'restroom break -- restrooms, water refill, and a breather', breakTitle: 'Restroom Break' });

  // ---- HOP TRANSITION (tip; park stamp not enforced) ----
  push({ block: 'hop', type: 'tip', park: toPark, window: [hopAt - 10, hopAt + 20], role: 'park hop: walk to ' + toPark + ', security screening (~15 min)' });

  // ---- EVENING SEGMENT: to park, hopAt -> close ----
  const eveStart = hopAt + 25;
  let dinnerSource = canShow ? [DINNER_WINDOWS[0]] : DINNER_WINDOWS;
  if (fitWindows(dinnerSource, eveStart, eveClose).length === 0 && fitWindows(DINNER_WINDOWS, eveStart, eveClose).length > 0) dinnerSource = DINNER_WINDOWS;
  const dinnerWins = fitWindows(dinnerSource, eveStart, eveClose);
  const dinnerNom = dinnerWins.length ? dinnerWins[0][0] : null;
  const preDinnerEnd = dinnerNom !== null ? dinnerNom - 10 : eveClose - 30;

  let afternoonFrom = eveStart;
  if (!lunchInMorning && lunchWins.length) {
    const lNom = lunchWins[0][0];
    rideBuckets(eveStart, lNom - 10, toPark, P(eveStart), 'afternoon ride').forEach(push);
    push({ block: 'lunch', type: 'dining', park: toPark, window: lunchWins, role: 'one lunch, off-peak, name the venue' });
    push({ block: 'photoMidday', type: 'break', park: toPark, window: [lunchWins[0][1] + 5, lunchWins[0][1] + 35], role: 'photo op near your lunch spot -- a quick group photo while you are in the area', breakTitle: 'Photo Op' });
    afternoonFrom = lunchWins[0][1] + 10;
  }

  if (cfg.charMeet && sameParkName(cfg.charMeet.park, toPark)) {
    push({ block: 'character', type: 'character', park: toPark, window: [hopAt + 55, hopAt + 145], role: 'character meet: ' + cfg.charMeet.name + ' at ' + (cfg.charMeet.land || '') + ' -- a must-do for this group', meetName: cfg.charMeet.name, meetLand: cfg.charMeet.land || '', meetCategory: cfg.charMeet.category || '' });
  }
  const sWin = [Math.max(SNACK_PM_WINDOW[0], afternoonFrom), Math.min(SNACK_PM_WINDOW[1], preDinnerEnd)];
  const snackFits = (sWin[1] - sWin[0] >= 20) && afternoonFrom <= SNACK_PM_WINDOW[1];
  if (snackFits) {
    const sNom = Math.round((sWin[0] + sWin[1]) / 2);
    rideBuckets(afternoonFrom, sNom - 10, toPark, P(afternoonFrom), 'afternoon ride').forEach(push);
    push({ block: 'snackPM', type: 'snack', park: toPark, window: sWin, role: 'one afternoon snack / shopping break' });
    if (hasLL) push({ block: 'llTip', type: 'tip', park: toPark, window: [810, 840], role: 'afternoon Lightning Lane check' });
    rideBuckets(sNom + 10, preDinnerEnd, toPark, P(sNom + 10), 'afternoon ride').forEach(push);
  } else {
    if (hasLL) push({ block: 'llTip', type: 'tip', park: toPark, window: [810, 840], role: 'afternoon Lightning Lane check' });
    rideBuckets(afternoonFrom, preDinnerEnd, toPark, P(afternoonFrom), 'afternoon ride').forEach(push);
  }

  if (dinnerWins.length) push({ block: 'dinner', type: 'dining', park: toPark, window: dinnerWins, role: 'one dinner, off-peak, name the venue' });
  if (eveClose >= 1185) push({ block: 'photoPM', type: 'break', park: toPark, window: [1110, 1170], role: 'photo op and souvenir shopping -- golden-hour photos while you are in the area', breakTitle: 'Photo Op & Shopping Break' });
  const afterDinner = dinnerWins.length ? dinnerWins[0][1] + 10 : preDinnerEnd;

  if (canShow) {
    rideBuckets(afterDinner, showWin[0] - 10, toPark, P(afterDinner), 'evening ride').forEach(push);
    push({ block: 'show', type: 'show', park: toPark, window: showWin, role: 'nighttime spectacular -- arrive early for a spot' });
    tailRides(showWin[1] + 10, eveClose, toPark, P(showWin[1] + 10), 'late-night ride', push);
  } else {
    tailRides(afterDinner, eveClose, toPark, P(afterDinner), 'evening ride', push);
  }

  // ---- RETURN SEGMENT: start park again, returnAt -> its later close ----
  if (returning) {
    push({ block: 'hop', type: 'tip', park: startPark, window: [returnAt - 10, returnAt + 20], role: 'park hop back to ' + startPark + ': it stays open later -- more rides (~15 min walk + security)' });
    tailRides(returnAt + 25, cfg.hop.returnCloseMin, startPark, P(returnAt + 25), 'late-night ride', push);
  }

  slots.sort((a, b) => winStart(a.window) - winStart(b.window));
  slots.forEach((s, i) => { s.id = 's' + pad2(i + 1); });
  const ordered = slots.map(s => { const o = { id: s.id, block: s.block, type: s.type, park: s.park, window: s.window, role: s.role }; if (s.meetName) { o.meetName = s.meetName; o.meetLand = s.meetLand || ''; o.meetCategory = s.meetCategory || ''; } if (s.breakTitle) o.breakTitle = s.breakTitle; return o; });
  return { day: cfg.dayNum || 1, park: startPark, toPark, hop: true, openMin: open, closeMin: returning ? cfg.hop.returnCloseMin : close, hopAtMin: hopAt, paceMinPerRide: pace, vip: false, slots: ordered };
}

export function buildSkeleton(cfg) {
  const park = cfg.park || 'Disneyland';
  const openMin = cfg.openMin, closeMin = cfg.closeMin;
  const pace = cfg.paceMinPerRide || DEFAULT_PACE_MIN_PER_RIDE;
  const hasLL = cfg.hasLL !== false;
  const vipStart = numOrNull(cfg.vipStartMin), vipEnd = numOrNull(cfg.vipEndMin);
  const isVip = vipStart !== null && vipEnd !== null;
  const P = (fromMin) => paceForSegment(fromMin, pace, isVip);
  if (cfg.hop && cfg.hop.toPark && !isVip) return buildHopSkeleton(cfg);

  let showWin = [Math.max(1200, closeMin - 120), Math.min(closeMin - 5, Math.max(1290, closeMin - 60))];
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
      rideBuckets(from, sNom - 10, park, P(from), 'afternoon ride').forEach(push);
      push({ block: 'snackPM', type: 'snack', park, window: sWin, role: 'one afternoon snack / shopping break' });
      if (hasLL) push({ block: 'llTip', type: 'tip', park, window: [810, 840], role: 'afternoon Lightning Lane check' });
      rideBuckets(sNom + 10, preDinnerEnd, park, P(sNom + 10), 'afternoon ride').forEach(push);
    } else {
      if (hasLL) push({ block: 'llTip', type: 'tip', park, window: [810, 840], role: 'afternoon Lightning Lane check' });
      rideBuckets(from, preDinnerEnd, park, P(from), 'afternoon ride').forEach(push);
    }

    if (dinnerWins.length) push({ block: 'dinner', type: 'dining', park, window: dinnerWins, role: 'one dinner, off-peak, name the venue' });
    if (closeMin >= 1185) push({ block: 'photoPM', type: 'break', park, window: [1110, 1170], role: 'photo op and souvenir shopping -- golden-hour photos while you are in the area', breakTitle: 'Photo Op & Shopping Break' });
    const afterDinner = dinnerWins.length ? dinnerWins[0][1] + 10 : preDinnerEnd;

    if (canShow) {
      rideBuckets(afterDinner, showWin[0] - 10, park, P(afterDinner), 'evening ride').forEach(push);
      push({ block: 'show', type: 'show', park, window: showWin, role: 'nighttime spectacular -- arrive early for a spot' });
      tailRides(showWin[1] + 10, closeMin, park, P(showWin[1] + 10), 'late-night ride', push);
    } else {
      tailRides(afterDinner, closeMin, park, P(afterDinner), 'evening ride', push);
    }
  }

  // Arrival + opening LL (pre-open)
  push({ block: 'arrival', type: 'tip', park, window: [Math.max(0, openMin - 60), openMin - 5], role: 'arrival, security, walk to rope-drop land' });
  if (hasLL) push({ block: 'llTip', type: 'tip', park, window: [Math.max(0, openMin - 60), Math.max(1, openMin - 25)], role: 'book the opening Lightning Lane (top headliner)' });

  if (isVip) {
    if (openMin + 20 <= vipStart) {
      push({ block: 'ropedrop', type: 'ride', park, window: [openMin + 5, Math.min(openMin + 20, vipStart - 5)], role: 'headliner rope drop before your tour' });
      rideBuckets(openMin + 25, vipStart - 5, park, P(openMin + 25), 'pre-tour ride').forEach(push);
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
    rideBuckets(openMin + 25, morningEnd, park, P(openMin + 25), 'morning ride').forEach(push);
    if (lunchWins.length) {
      push({ block: 'lunch', type: 'dining', park, window: lunchWins, role: 'one lunch, off-peak, name the venue' });
      push({ block: 'photoMidday', type: 'break', park: park, window: [lunchWins[0][1] + 5, lunchWins[0][1] + 35], role: 'photo op near your lunch spot -- a quick group photo while you are in the area', breakTitle: 'Photo Op' });
    }
    if (hasLL) push({ block: 'llTip', type: 'tip', park, window: [590, 620], role: 'mid-morning Lightning Lane rebook' });
    if (cfg.charMeet && sameParkName(cfg.charMeet.park, park)) {
      push({ block: 'character', type: 'character', park, window: [openMin + 150, openMin + 215], role: 'character meet: ' + cfg.charMeet.name + ' at ' + (cfg.charMeet.land || '') + ' -- a must-do for this group', meetName: cfg.charMeet.name, meetLand: cfg.charMeet.land || '', meetCategory: cfg.charMeet.category || '' });
    }
    push({ block: 'snackAM', type: 'snack', park, window: [openMin + 90, openMin + 135], role: 'morning snack / coffee break -- a quick bite and drinks' });
    push({ block: 'breakAM', type: 'break', park, window: [openMin + 140, openMin + 185], role: 'restroom break -- restrooms, water refill, and a breather', breakTitle: 'Restroom Break' });
    layEvening(lunchWins.length ? lunchWins[0][1] + 10 : morningEnd);
  }

  // sort by time, then assign stable ids in time order
  slots.sort((a, b) => winStart(a.window) - winStart(b.window));
  slots.forEach((s, i) => { s.id = 's' + pad2(i + 1); });
  const ordered = slots.map(s => { const o = { id: s.id, block: s.block, type: s.type, park: s.park, window: s.window, role: s.role }; if (s.meetName) { o.meetName = s.meetName; o.meetLand = s.meetLand || ''; o.meetCategory = s.meetCategory || ''; } if (s.breakTitle) o.breakTitle = s.breakTitle; return o; });

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

// Match a card heading against the known-shows list (dynamic SHOWS section:
// [{name, park}]). The model shortens official names ("World of Color" for
// "World of Color - Happiness!"), so equality OR prefix containment counts.
function matchKnownShow(name, shows) {
  const k = normName(name);
  if (!k || !Array.isArray(shows)) return null;
  for (const s of shows) {
    if (!s || !s.name) continue;
    const sk = normName(s.name);
    if (sk && (sk === k || sk.startsWith(k) || k.startsWith(sk))) return s;
  }
  return null;
}
// Notes were hard-capped at 80 chars for tidiness, which cut tips off
// mid-word on the cards (Beau, Oct 6). Budget is now ~200 with a
// word-boundary trim so a note always reads as a finished thought.
function trimNoteText(v, max) {
  const str = String(v || '').trim();
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > 40 ? cut.slice(0, sp) : cut).trim();
}
function buildCard(slot, f, t) {
  let _h = String(f.h || '').trim();
  // The fill sometimes returns the park or land name as the heading with the real
  // attraction in `ride` (guests saw ride cards titled "Disneyland" / "DCA"). On
  // ride slots the ride name is the heading whenever the two disagree.
  if (slot.type === 'ride' && f.ride && normName(_h) !== normName(f.ride)) _h = String(f.ride).trim();
  const card = { t: toClock(t), h: _h, type: slot.type, n: trimNoteText(f.n, 200), land: String(f.land || '').trim() };
  if (f.ride) card.ride = f.ride;
  if (f.ll && (slot.type === 'ride' || slot.type === 'tip')) card.ll = f.ll;
  return card;
}
function placeholderCard(slot) { return { t: toClock(rangesOf(slot.window)[0][0]), h: '(to fill)', type: slot.type, n: '', land: '' }; }

// Short fill prompt -- the skeleton replaces ~30 of the old structural prose rules.
export function buildFillPrompt(skeleton, opts) {
  opts = opts || {};
  const lines = skeleton.slots.map(s => s.id + ' | ' + s.type + ' | ' + s.park + ' | ' + renderWin(s.window) + ' | ' + (s.role || '') + (s.preferRide ? ' | ASSIGNED RIDE: ' + s.preferRide + ' (rope-drop priority -- use exactly this ride)' : '') + (s.meetName ? ' | CHARACTER MEET: ' + s.meetName : ''));
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
  sys += '\n- A slot marked ASSIGNED RIDE already has its ride chosen by the day strategy -- use exactly that ride for that slot, no substitutions.';
  sys += '\n- Flow through the park land by land: when more than one ride fits a slot, choose the one in or nearest the land of the previous slot. Never send the group back and forth across the park.';
  sys += '\n- Never repeat a ride or venue anywhere in the day, or any venue in the ALREADY-USED list. Give exactly ONE name per slot -- never "X (or Y)" or a list of alternatives.';
  sys += '\n- Object schema: { "id":"s03", "t":"8:10 AM", "h":"Name", "type":"<the slot\'s type>", "land":"Land", "n":"tip in one or two short sentences, under 180 chars, always a complete sentence", "ride":"Exact ride name (rides/LL only)", "ll":{ "t":"multi|single", "a":"..." } }';
  sys += '\n- ll only on ride/tip slots and only if the day has Lightning Lane. ASCII only. Notes under 180 characters, complete sentences only.';
  if (opts.ill === false) sys += '\n- This group does NOT have Individual Lightning Lane (ILL): NEVER mention ILL, Single Pass, individual ride purchases, or per-ride prices anywhere -- not in headings, notes, or ll fields. Rise of the Resistance and Radiator Springs Racers are ridden standby or not at all.';
  if (opts.llmp === false && opts.ill === false) sys += '\n- This group has NO Lightning Lane products at all: do not include ll fields and do not write Lightning Lane booking advice; tip slots give standby strategy instead.';
  else if (opts.llmp === true && opts.ill === false) sys += '\n- Lightning Lane for this group means Multi Pass ONLY.';
  if (opts.closedNames && opts.closedNames.length) sys += '\n- DOWN / CLOSED right now -- do NOT place any of these in a ride slot; if your best pick is on this list, choose a different open attraction from the cache for that slot instead: ' + opts.closedNames.join('; ') + '.';
  if (opts.closedVenueNames && opts.closedVenueNames.length) sys += '\n- DOWN FOR REFURBISHMENT right now -- do NOT place any of these in a dining, quickservice, or snack slot; choose a different open venue from the verified dining list instead: ' + opts.closedVenueNames.join('; ') + '.';
  if (opts.tableVenueNames && opts.tableVenueNames.length) sys += '\n- MEALS ARE QUICK-SERVICE ONLY: these are sit-down / reservation venues -- ' + opts.tableVenueNames.join('; ') + '. NEVER place one as a meal or snack. The only exception: the guest has a confirmed reservation at that exact venue on this trip (then note it is their reservation). Otherwise pick a quick-service venue from the verified dining list.';
  sys += '\n\nSKELETON (fill EVERY slot):\n' + lines.join('\n');
  if (opts.usedDining && opts.usedDining.length) sys += '\n\nALREADY-USED venues (never repeat): ' + opts.usedDining.join('; ');
  if (opts.usedRides && opts.usedRides.length) sys += '\n\nALREADY-USED rides on earlier days of this trip (never repeat): ' + opts.usedRides.join('; ');
  return sys;
}

// M2 fill-quality helpers.
// Generic activity phrases that must never fill a RIDE slot (they belong in tips).
const GENERIC_RIDE_RE = /^\s*(explore|recharge|free\s*time|flex\s*time|flex\b|recheck|re-check|wander|relax|downtime|buffer|take a break|open (dining )?choice|open choice)/i;
// Pure meal labels are not dining fills ("Lunch", "Dinner" as a card heading
// names no restaurant). Exact normalized match only -- "Lunch at Flo's V-8 Cafe"
// contains a real venue name and passes.
const GENERIC_MEAL_KEYS = new Set(['lunch', 'dinner', 'breakfast', 'brunch', 'meal', 'dining', 'food', 'restaurant', 'eat']);
// Display cleanup: drop "(or X)" / "(aka X)" alternatives the model sometimes appends.
function stripAlt(h) { return String(h || '').replace(/\s*\((?:or|aka|a\.?k\.?a\.?)\b[^)]*\)/gi, '').replace(/\s{2,}/g, ' ').trim(); }
// Dedup key: lowercase, drop ALL parentheticals + filler words so "Space Mountain (Night Ride)" collides with "Space Mountain".
export function normName(h) { return String(h || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an|ride|standby|at|to|and)\b/g, ' ').replace(/\s+/g, ' ').trim(); }

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
  // Authoritative ride catalog (normName -> entry), when the caller supplies
  // one. The model's land field is self-reported and can lie (a Disneyland
  // ride labeled with a DCA land sails past the land-based park check), so
  // the catalog's park is the enforcement source for ride slots.
  const catalogIdx = (opts.catalog && typeof opts.catalog === 'object' && !Array.isArray(opts.catalog)) ? opts.catalog : {};
  const catalogBySquash = {};
  for (const _ck of Object.keys(catalogIdx)) { const _sk2 = _ck.replace(/ /g, ''); if (_sk2 && !catalogBySquash[_sk2]) catalogBySquash[_sk2] = catalogIdx[_ck]; }
  const byId = {}; (fills || []).forEach(f => { if (f && f.id) byId[f.id] = f; });
  const cards = [], needsRetry = [], report = { clamped: 0, wrongPark: 0, missing: 0, fallback: 0, dropped: [] };
  const used = new Set();
  const usedRideNames = new Set();
  // Cross-day dedupe: rides already placed on earlier days of this trip count as
  // used, so fills and the deterministic backfill will not repeat them. Must-dos
  // are exempt -- the guest asked for those by name, repeats included.
  const _mustKeys = new Set((opts.mustDoNames || []).map(normName));
  const priorRideKeySet = new Set();
  const todayRideNames = new Set();
  (opts.priorRides || []).forEach(function(n) { const k = normName(n); if (k && !_mustKeys.has(k)) { usedRideNames.add(k); priorRideKeySet.add(k); } });
  const usedRideSquash = new Set([...usedRideNames].map(k => k.replace(/ /g, '')));
  // Variant groups of everything already used (prior days + today). A sibling
  // variant of a used attraction counts as used -- same ride to the guest.
  const usedGroups = new Set([...priorRideKeySet].map(k => rideGroupKey(k)));
  const bannedGroups = (opts.bannedKeys instanceof Set) ? new Set([...opts.bannedKeys].map(k => rideGroupKey(k))) : null;
  // Cross-day dining dedupe: venues already served on earlier days of this trip
  // count as used. Seeding `used` also steers the deterministic backfill, whose
  // venue filter reads the same set.
  const priorVenueKeys = new Set((opts.priorVenues || []).map(normName).filter(Boolean));
  (opts.priorVenues || []).forEach(n => { if (n) used.add(String(n).toLowerCase()); });
  const placed = new Set(['ride', 'dining', 'quickservice', 'snack', 'show', 'character']); // slots that occupy a park
  const mkFallback = (slot) => {
    const c = fallbackFor ? fallbackFor(slot, { usedNames: used, usedRideKeys: usedRideNames, priorRideKeys: priorRideKeySet, todayRideKeys: todayRideNames, bannedKeys: (opts.bannedKeys instanceof Set) ? opts.bannedKeys : null, nearLand: (function () { for (let i = cards.length - 1; i >= 0; i--) { if (cards[i] && cards[i].land) return cards[i].land; } return ''; })() }) : placeholderCard(slot);
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
      const cleanH = stripAlt(f.h).replace(/\s*\((?:lightning lane|ll|multi pass|single pass)\)\s*$/i, '').trim();
      const clamp = clampToWindow(parseClock(f.t), slot.window, slot.fixed);
      if (clamp.changed) report.clamped++;
      const landPark = f.land ? landToPark(f.land) : null;
      const parkBad = placed.has(slot.type) && f.land && landPark && !sameParkName(landPark, slot.park);
      const isRideSlot = slot.type === 'ride';
      const generic = isRideSlot && GENERIC_RIDE_RE.test(cleanH);
      const nkey = normName(f.ride || cleanH);
      const gkey = nkey ? rideGroupKey(nkey) : '';
      // The slot's ASSIGNED ride (rope drop / morning block) is exempt from
      // the used/prior checks: repeating a headliner inside the morning
      // window is the strategy, and the assignment already honored bans
      // and closures when it picked the ride.
      const isAssigned = isRideSlot && !!slot.preferRide && nkey === normName(slot.preferRide);
      const dup = isRideSlot && nkey && !isAssigned && (usedRideNames.has(nkey) || usedRideSquash.has(nkey.replace(/ /g, '')) || (gkey && usedGroups.has(gkey)));
      const hL = cleanH.toLowerCase();
      const closed = isRideSlot && closedNames.some(cn => cn && hL.indexOf(cn) !== -1);
      const isDiningSlot = slot.type === 'dining' || slot.type === 'quickservice' || slot.type === 'snack';
      const venueClosed = isDiningSlot && closedVenueNames.some(cn => cn && hL.indexOf(cn) !== -1);
      // A restaurant repeated from an earlier day (or twice in one day) is a
      // failed fill -- the backfill has the full venue catalog to pick from.
      const venueDup = isDiningSlot && (priorVenueKeys.has(normName(cleanH)) || used.has(hL));
      const mealGeneric = (slot.type === 'dining' || slot.type === 'quickservice') && GENERIC_MEAL_KEYS.has(normName(cleanH));
      // A dining/quickservice heading that names no venue from the verified
      // catalog list is an invented restaurant -- a failed fill, so the
      // deterministic backfill seats the group somewhere real. Snack slots
      // get the same check unless the heading is a generic break (the venue
      // rides in the note). Fail-open when no venue list was supplied.
      const venueBad = (function () {
        if (!isDiningSlot) return false;
        const venues = Array.isArray(opts.venues) ? opts.venues : [];
        if (!venues.length) return false;
        const stripped = cleanH.replace(/^(lunch|dinner|breakfast|brunch)\s*[:\-]\s*/i, '').replace(/^(lunch|dinner|breakfast|brunch)\s+at\s+/i, '');
        const hk = normName(stripped);
        if (!hk) return false;
        const hitV = venues.find(v => { const vk = normName(v && v.name); return vk && (hk === vk || hk.indexOf(vk) !== -1 || (hk.length >= 4 && vk.indexOf(hk) !== -1)); });
        if (hitV) return !!(hitV.park && !sameParkName(hitV.park, slot.park));
        if (slot.type === 'snack' && /snack|break|shopping|hydration|rest|dole whip/i.test(cleanH)) return false;
        return true;
      })();
      // Table-service gate (Beau, Oct 6, 2026): a meal, quickservice, or
      // snack fill that names a TABLE or LOUNGE venue from the verified
      // catalog is a failed fill -- schedules are quick-service only unless
      // the guest noted that exact venue as a reservation in onboarding
      // (opts.reservationKeys). Mirrors the onboarding promise in pretrip.
      const venueServiceBad = (function () {
        if (!isDiningSlot) return false;
        const vsMap = opts.venueServices || null;
        if (!vsMap || !Object.keys(vsMap).length) return false;
        const stripped = cleanH.replace(/^(lunch|dinner|breakfast|brunch)\s*[:\-]\s*/i, '').replace(/^(lunch|dinner|breakfast|brunch)\s+at\s+/i, '');
        const hk = normName(stripped);
        if (!hk) return false;
        let hitSvc = null, hitKey = null;
        for (const k of Object.keys(vsMap)) {
          if (k && (hk === k || hk.indexOf(k) !== -1 || (hk.length >= 4 && k.indexOf(hk) !== -1))) { hitSvc = vsMap[k]; hitKey = k; break; }
        }
        if (hitSvc !== 'table' && hitSvc !== 'lounge') return false;
        if (opts.reservationKeys && opts.reservationKeys.has(hitKey)) return false;
        return true;
      })();
      // Guest bans are absolute at fill time (skip list + avoidWater folds):
      // a banned ride is a failed fill, never a card -- the backfill replaces it.
      const banned = isRideSlot && nkey && (opts.bannedKeys instanceof Set) && (opts.bannedKeys.has(nkey) || (bannedGroups && gkey && bannedGroups.has(gkey)));
      // Slots with an ASSIGNED ride (rope drop + the morning block) take
      // exactly that ride: any other ride in that slot is a failed fill.
      const ropeBad = isRideSlot && !!slot.preferRide && nkey && nkey !== normName(slot.preferRide);
      // Catalog park enforcement: the ride's real park (from CATALOG) must
      // match the slot's park segment, regardless of the land the model
      // claimed. Catches e.g. Jungle Cruise placed in a DCA segment under a
      // Grizzly Peak label.
      const catalogEntry = (isRideSlot && nkey) ? (catalogIdx[nkey] || catalogBySquash[nkey.replace(/ /g, '')] || null) : null;
      const catalogParkBad = !!(catalogEntry && catalogEntry.park && !sameParkName(catalogEntry.park, slot.park));
      // The character slot names the day's planned meet: a different character
      // is a failed fill (the deterministic backfill emits the planned meet).
      const charBad = slot.type === 'character' && !!slot.meetName && (function(){ const fk = normName(cleanH.replace(/^meet\s+/i, '')); const mk = normName(slot.meetName); return !(fk && mk && (fk === mk || fk.indexOf(mk) !== -1 || mk.indexOf(fk) !== -1)); })();
      // Break slots carry fixed guest-facing copy: any model fill is a failed
      // fill so the deterministic backfill emits the break card verbatim.
      const breakBad = slot.type === 'break';
      // Transport/walkthrough attractions never occupy a morning slot
      // (afternoon/evening only -- see NEVER_MORNING_KEYS).
      const transportBad = isRideSlot && !!nkey && NEVER_MORNING_KEYS.has(nkey) && winStart(slot.window) < 720;
      const retiredClosed = isRideSlot && !!nkey && RETIRED.some(r => r.to === null && nkey.indexOf(r.m) !== -1);
      // A park or land name is not a fill: the model sometimes answers a dining,
      // snack, or show slot with the place it sits in ("Disneyland", "DCA",
      // "Pixar Pier") instead of the venue or show. Treat it as a failed fill so
      // the deterministic backfill supplies a real name. Tips only fail on exact
      // park names (a tip may legitimately headline a land).
      const PARK_KEYS = new Set(['disneyland', 'disney california adventure', 'dca', 'disneyland park']);
      const placeNamed = (placed.has(slot.type) && slot.type !== 'tip' && (PARK_KEYS.has(normName(cleanH)) || !!landToPark(cleanH)))
        || (slot.type === 'tip' && PARK_KEYS.has(normName(cleanH)))
        || (isRideSlot && PARK_KEYS.has(nkey));
      // A real show in the WRONG park is still a wrong fill: a DCA spectacular
      // cannot headline a Disneyland evening. Known-show match also canonicalizes
      // the heading (model shortens official show names).
      const showMatch = slot.type === 'show' ? matchKnownShow(cleanH, opts.shows) : null;
      const showWrongPark = !!showMatch && !sameParkName(showMatch.park, slot.park);
      if (parkBad || catalogParkBad || generic || dup || closed || retiredClosed || venueClosed || placeNamed || showWrongPark || venueDup || mealGeneric || banned || ropeBad || charBad || venueBad || venueServiceBad || breakBad || transportBad) {
        if (parkBad || catalogParkBad) report.wrongPark++;
        if (generic) report.generic = (report.generic || 0) + 1;
        if (dup) report.dupe = (report.dupe || 0) + 1;
        if (closed || retiredClosed || venueClosed) report.closed = (report.closed || 0) + 1;
        report.dropped.push({ h: cleanH, reason: (closed || retiredClosed || venueClosed) ? 'closed' : (parkBad || catalogParkBad) ? 'wrong-park' : dup ? 'dupe' : showWrongPark ? 'wrong-park-show' : venueDup ? 'venue-dupe' : mealGeneric ? 'generic-meal' : placeNamed ? 'place-name' : banned ? 'banned' : ropeBad ? 'ropedrop-reassigned' : charBad ? 'wrong-character' : venueBad ? 'venue-unknown' : venueServiceBad ? 'venue-table-service' : breakBad ? 'break-fixed' : transportBad ? 'transport-morning' : 'generic' });
        needsRetry.push(slot.id);
        card = mkFallback(slot);
      } else {
        card = buildCard(slot, Object.assign({}, f, { h: showMatch ? showMatch.name : cleanH }), clamp.t);
        if (isRideSlot && nkey) { usedRideNames.add(nkey); usedRideSquash.add(nkey.replace(/ /g, '')); todayRideNames.add(nkey); if (gkey) usedGroups.add(gkey); }
      }
    } else {
      report.missing++; needsRetry.push(slot.id);
      card = mkFallback(slot);
    }
    if (card) {
      if (card.h) used.add(card.h.toLowerCase());
      // Register FALLBACK ride identities too: mkFallback cards bypass the
      // accept-branch bookkeeping, so without this a backfilled ride's name
      // and variant group stay invisible to later slots -- a later fill could
      // then place the sibling variant (or the same ride) again today.
      if (slot.type === 'ride') {
        const ck = normName(card.ride || card.h || '');
        if (ck) { usedRideNames.add(ck); usedRideSquash.add(ck.replace(/ /g, '')); todayRideNames.add(ck); const cg = rideGroupKey(ck); if (cg) usedGroups.add(cg); }
      }
      cards.push(card);
    }
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

// Transport + walkthrough attractions: afternoon/evening ONLY (Beau, Oct 5,
// 2026 -- the Disneyland Monorail landed at 9:38 AM in a prime morning slot
// on a generated day). They are conveyances and strolls, not morning
// priorities; mornings belong to headliners while lines are short. Enforced
// in the morning picker, fill validation, deterministic backfill, and the
// param enforcer's swap targeting.
export const NEVER_MORNING_KEYS = new Set(['disneyland monorail', 'disneyland railroad', 'main street vehicles', 'mark twain riverboat', 'sailing ship columbia', "davy crockett's explorer canoes", 'sleeping beauty castle walkthrough'].map(normName));

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
  let prevComfort = -1;
  for (const r of rows) {
    if (r.m == null) continue;
    let m = r.m;
    if (m <= prev) m = prev + 1;
    // Comfort spacing: a restroom break hard on the heels of a snack, break, or
    // meal reads as dead time (guests saw snack 9:30 + break 9:34). Nudge the
    // break later -- these are display times; slot structure is untouched.
    if (r.c.type === 'break' && prevComfort >= 0 && m - prevComfort < 25) m = prevComfort + 25;
    if (m <= prev) m = prev + 1;
    r.c.t = toClock(m);
    prev = m;
    if (r.c.type === 'break' || r.c.type === 'snack' || r.c.type === 'dining') prevComfort = m;
  }
  return rows.map(r => r.c);
}

// Anti-zigzag pass: within a run of consecutive ride cards, an A -> B -> A
// land pattern means the group crossed the park and came straight back.
// Swapping the identities of the B and last-A cards (times stay with the
// slots) yields A -> A -> B with the same rides, notes, and Lightning Lanes.
// Conservative: plain ride triples only, never an Individual Lightning Lane
// card (appointment-like), and the day's rope-drop card is only ever the
// first A, which this swap never touches.
function dezigzagRides(kept, catalog) {
  const landOf = (c) => {
    const ce = catalog && catalog[normName(c.ride || c.h)];
    return normName((ce && ce.land) || c.land || '');
  };
  const swapIdentity = (a, b) => {
    for (const f of ['h', 'ride', 'land', 'll', 'n']) {
      const t = a[f];
      if (b[f] === undefined) delete a[f]; else a[f] = b[f];
      if (t === undefined) delete b[f]; else b[f] = t;
    }
  };
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    let seg = [];
    const flush = () => {
      for (let j = 0; j + 2 < seg.length; j++) {
        const a = seg[j], b = seg[j + 1], c = seg[j + 2];
        const la = landOf(a), lb = landOf(b), lc = landOf(c);
        if (!la || !lb || !lc || la !== lc || la === lb) continue;
        if ((b.ll && b.ll.t === 'single') || (c.ll && c.ll.t === 'single')) continue;
        swapIdentity(b, c);
        changed = true;
      }
      seg = [];
    };
    for (const c of kept) {
      if (c.type === 'ride') seg.push(c); else flush();
    }
    flush();
    if (!changed) break;
  }
}

// ---------------------------------------------------------------------------
// LL NORMALIZATION + FEASIBILITY TRIM (deterministic; the model does not get
// a vote on either). LL tags used to be model-emitted, so they appeared on
// some days and not others, and ILL advice showed up for groups who never
// bought it. Code now assigns tags from the day's actual products, and the
// final schedule is checked against physics (wait + duration + walk) with
// impossible transitions trimmed.
// ---------------------------------------------------------------------------
const RIDE_DURATIONS_MIN = { 'star wars rise of the resistance': 20, 'indiana jones adventure': 12, 'radiator springs racers': 10, 'guardians of the galaxy mission breakout': 10, 'mickey minnie runaway railway': 10, 'millennium falcon smugglers run': 10, 'pirates of the caribbean': 15, 'tiana bayou adventure': 12, 'haunted mansion': 10, 'jungle cruise': 10, 'toy story midway mania': 10, 'web slingers spider man adventure': 10, 'space mountain': 8, 'incredicoaster': 8, 'big thunder mountain railroad': 8, 'grizzly river run': 8, 'soarin around the world': 8, 'soarin across america': 8, 'matterhorn bobsleds': 7, 'disneyland railroad': 20, 'disneyland monorail': 15 };
function activityDurationMin(c) {
  if (c.type === 'ride') return RIDE_DURATIONS_MIN[normName(c.ride || c.h)] || 6;
  if (c.type === 'show') return 25;
  if (c.type === 'dining') return 55;
  if (c.type === 'quickservice') return 40;
  if (c.type === 'character') return 15;
  if (c.type === 'snack') return 10;
  if (c.type === 'break') return 10;
  return 0;
}
function waitEstimateMin(c, startMin, waitPatterns, catalog) {
  if (c.type !== 'ride') return 0;
  const name = c.ride || c.h;
  let base = null;
  const wp = waitPatterns && name ? waitPatterns[name] : null;
  if (wp && wp.moderate) {
    const dp = startMin < 660 ? 'rope_drop' : startMin < 840 ? 'midday' : startMin < 1020 ? 'afternoon' : startMin < 1200 ? 'evening' : 'late';
    if (typeof wp.moderate[dp] === 'number') base = wp.moderate[dp];
  }
  if (base === null) {
    const e = catalog ? catalog[normName(name)] : null;
    base = e && e.typicalPeakWait ? Math.round(e.typicalPeakWait * 0.7) : 20;
  }
  if (c.ll && c.ll.t === 'multi') return Math.min(base, 12);
  if (c.ll && c.ll.t === 'single') return Math.min(base, 10);
  return base;
}
const EDGE_LANDS = new Set(["mickey's toontown", 'toontown', "star wars: galaxy's edge", 'bayou country', 'critter country']);
function walkMin(a, b, landToPark) {
  if (!a.land || !b.land || a.land === b.land) return 3;
  const pa = landToPark ? landToPark(a.land) : null;
  const pb = landToPark ? landToPark(b.land) : null;
  if (pa && pb && !sameParkName(pa, pb)) return 15;
  if (EDGE_LANDS.has(String(a.land).toLowerCase()) || EDGE_LANDS.has(String(b.land).toLowerCase())) return 11;
  return 8;
}
export function normalizeLLAssignments(cards, opts) {
  const llmp = !!(opts && opts.llmp), ill = !!(opts && opts.ill);
  const catalog = (opts && opts.catalog) || {};
  const list = cards || [];
  if (!llmp && !ill) { for (const c of list) if (c.ll) delete c.ll; return list; }
  for (const c of list) {
    if (c.type !== 'ride') continue;
    const k = normName(c.ride || c.h);
    if (ILL_ONLY_KEYS.has(k)) {
      if (ill) c.ll = { t: 'single', a: (c.ll && c.ll.a) || 'Individual Lightning Lane -- book in the app at park open.' };
      else if (c.ll && c.ll.t === 'single') delete c.ll;
    }
  }
  if (llmp) {
    const eligible = list.filter(c => c.type === 'ride' && !ILL_ONLY_KEYS.has(normName(c.ride || c.h)));
    const scored = eligible.map(c => { const e = catalog[normName(c.ride || c.h)] || {}; return { c, tagged: c.ll && c.ll.t === 'multi' ? 1 : 0, peak: e.typicalPeakWait || 0, m: parseClock(c.t) || 0 }; });
    scored.sort((a, b) => (b.tagged - a.tagged) || (b.peak - a.peak) || (a.m - b.m));
    const chosen = new Set(scored.slice(0, 8).map(x => x.c));
    for (const c of eligible) {
      if (chosen.has(c)) { if (!c.ll || c.ll.t !== 'multi') c.ll = { t: 'multi', a: 'Lightning Lane Multi Pass pick -- book a return time in the app.' }; }
      else if (c.ll && c.ll.t === 'multi') delete c.ll;
    }
  } else {
    for (const c of list) if (c.ll && c.ll.t === 'multi') delete c.ll;
  }
  return list;
}
const ACTIVITY_TYPES = new Set(['ride', 'show', 'dining', 'quickservice', 'character', 'snack']);
export function trimInfeasible(cards, opts) {
  const wp = opts && opts.waitPatterns;
  const trimmed = [];
  if (!wp) return { cards, trimmed };
  const catalog = (opts && opts.catalog) || {};
  const landToPark = (opts && opts.landToPark) || (() => null);
  let list = (cards || []).slice();
  const isProtected = (c, arr) => {
    if (c.type === 'dining' || c.type === 'show' || c.type === 'character') return true;
    // Comfort cards are the product, not filler (Beau, Oct 5, 2026): the old
    // trim dropped the day's only snack card as an 'infeasible-pace' victim
    // because the preceding headliner's standby wait priced against it. A
    // break has no hard start time -- being ten minutes late to it is fine.
    if (c.type === 'snack' || c.type === 'break') return true;
    if (c.type === 'ride') {
      const rides = arr.filter(x => x.type === 'ride');
      if (rides[rides.length - 1] === c) return true; // run-to-closing anchor
      const e = catalog[normName(c.ride || c.h)] || {};
      if ((e.typicalPeakWait || 0) >= 75) return true; // headliner: the plan bends around it
    }
    return false;
  };
  for (let iter = 0; iter < 14; iter++) {
    const acts = list.filter(c => ACTIVITY_TYPES.has(c.type) && parseClock(c.t) !== null);
    let dropped = false;
    for (let i = 0; i + 1 < acts.length; i++) {
      const cur = acts[i], nxt = acts[i + 1];
      const ct = parseClock(cur.t), nt = parseClock(nxt.t);
      const need = waitEstimateMin(cur, ct, wp, catalog) + activityDurationMin(cur) + walkMin(cur, nxt, landToPark);
      if (nt - ct - need >= -8) continue;
      const dropCur = !isProtected(cur, acts) && i > 0;
      const dropNxt = !isProtected(nxt, acts);
      const victim = dropNxt ? nxt : (dropCur ? cur : null);
      if (!victim) continue;
      list = list.filter(x => x !== victim);
      trimmed.push({ h: victim.h, reason: 'infeasible-pace' });
      dropped = true;
      break;
    }
    if (!dropped) break;
  }
  return { cards: list, trimmed };
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
  // Squash key: normName with spaces removed. The model respells rides across
  // cards ("WEB SLINGERS: ..." vs "Webslingers: ..."), which defeats the spaced
  // dedupe key and the catalog lookup. Squash-matching catches both.
  const squash = (s) => normName(s).replace(/ /g, '');
  const catalogBySquash = {};
  if (catalogLoaded) for (const k of Object.keys(catalog)) { const sk = squash(k); if (sk && !catalogBySquash[sk]) catalogBySquash[sk] = catalog[k]; }
  const usedRideSquash = new Set();
  const usedGroups = new Set();
  const removed = [], kept = [], usedRide = new Set();
  // ILL gating: the group did not buy Individual Lightning Lane, so no card may
  // carry ILL instructions. Tip cards built around ILL are removed outright;
  // ride cards keep the ride but lose any ILL sentence in the note.
  let _inputCards = cards || [];
  if (opts.hasILL === false) {
    const illRe = /\bILL\b|individual lightning|single pass/i;
    const nextIn = [];
    for (const c of _inputCards) {
      const text = String(c.h || '') + ' ' + String(c.n || '');
      if (c.type === 'tip' && illRe.test(text)) { removed.push({ h: c.h, reason: 'ill-not-purchased' }); continue; }
      if (c.n && illRe.test(c.n)) c.n = c.n.split(/(?<=[.!])\s+/).filter(p => !illRe.test(p)).join(' ').trim();
      nextIn.push(c);
    }
    _inputCards = nextIn;
  }
  for (const c of _inputCards) {
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
      let ce = catalog[normName(c.ride || c.h)];
      if (!ce && catalogLoaded) {
        const sq = catalogBySquash[squash(c.ride || c.h)];
        if (sq) { ce = sq; c.h = sq.name; if (c.ride) c.ride = sq.name; } // canonical spelling from the catalog
      }
      if (ce) {
        if (allowedParks.length && ce.park && !inAllowed(ce.park)) { removed.push({ h: c.h, reason: 'wrong-park-catalog' }); continue; }
        if (ce.land) c.land = ce.land; // relabel to canonical land
        if (c.ride && normName(c.h) !== normName(ce.name)) c.h = ce.name; // heading is the ride's name, never the park/land name
      } else {
        const p = landToPark(c.land) || landToPark(c.h);
        if (catalogLoaded && !p) { removed.push({ h: c.h, reason: 'not-at-resort' }); continue; }
        if (allowedParks.length && p && !inAllowed(p)) { removed.push({ h: c.h, reason: 'wrong-park' }); continue; }
      }
      // 4. dupe (spaced key OR squash key -- respelled duplicates collide on squash)
      const k = normName(c.ride || c.h);
      const sk2 = squash(c.ride || c.h);
      if ((k && usedRide.has(k)) || (sk2 && usedRideSquash.has(sk2))) { removed.push({ h: c.h, reason: 'dupe' }); continue; }
      // 4b. variant dupe: the sibling variant of an attraction already placed
      // today (the other Soarin' film, the other Pal-A-Round gondola) is the
      // same ride to a guest -- never twice in one day.
      const gk = rideGroupKey(c.ride || c.h);
      if (gk && usedGroups.has(gk)) { removed.push({ h: c.h, reason: 'dupe-variant' }); continue; }
      if (k) usedRide.add(k);
      if (sk2) usedRideSquash.add(sk2);
      if (gk) usedGroups.add(gk);
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
        // A known show that plays in a park this day never visits cannot be on
        // the card (day-level backstop; applyFills enforces per-slot).
        const _sm = matchKnownShow(c.h, opts.shows);
        if (_sm) {
          if (!inAllowed(_sm.park)) { removed.push({ h: c.h, reason: 'wrong-park-show' }); continue; }
          c.h = _sm.name; // canonical full show name
        }
      }
      // non-ride placed types (dining/snack/show/character): unchanged landToPark wrong-park check
      const p = landToPark(c.land) || landToPark(c.h);
      if (p && !inAllowed(p)) { removed.push({ h: c.h, reason: 'wrong-park' }); continue; }
    }
    kept.push(c);
  }
  dezigzagRides(kept, catalog);
  const _finalCards = sortAndSpace(kept);
  if (opts.hasLLMP !== undefined || opts.hasILL !== undefined) {
    normalizeLLAssignments(_finalCards, { llmp: opts.hasLLMP === true, ill: opts.hasILL === true, catalog });
  }
  const _trim = trimInfeasible(_finalCards, { waitPatterns: opts.waitPatterns || null, catalog, landToPark });
  for (const r of _trim.trimmed) removed.push(r);
  return { cards: _trim.cards, removed };
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

export function closedNamesFromProse(prose, tripDate, catalogNames) {
  // The structured CLOSURES list has shipped EMPTY while the CURRENT_CLOSURES
  // prose carries the real refurbishment reporting -- so rides the cache itself
  // reports as closed (Indiana Jones from Sep 8 2026, Mad Tea Party through
  // Oct 26) were still being scheduled (found Oct 4, 2026 on BEAU01, whose Day 1
  // rope-dropped a closed ride). Derive closed names from the prose,
  // conservatively: a name counts only when it matches a catalog attraction AND
  // its entry carries an explicit Status that is CLOSED (or CLOSES on/before the
  // trip date). An explicit OPEN status wins, an explicit reopen date on/before
  // the trip date reopens, and a closure that starts after the trip date does
  // not close. Mirrors the structured list's null-date contract: closed now
  // with no known reopen date = closed on the trip date.
  if (!prose || typeof prose !== 'string' || !Array.isArray(catalogNames)) return [];
  const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
  const parseDate = (s) => {
    if (!s) return null;
    const m = String(s).match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
    if (!m) return null;
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo === undefined) return null;
    return Date.UTC(parseInt(m[3], 10), mo, parseInt(m[2], 10));
  };
  const tripMs = (() => {
    const s = String(tripDate || '');
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const p = s.slice(0, 10).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
    const dt = new Date(s);
    return isNaN(dt.getTime()) ? null : Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate());
  })();
  if (tripMs === null) return [];
  const byNorm = new Map();
  for (const n of catalogNames) { if (n) byNorm.set(normName(n), n); }
  const matchName = (candidate) => {
    if (!candidate) return null;
    let c = String(candidate).replace(/^[\s#*\d.)"“”'‘’]+/, '').replace(/["“”'‘’]+$/, '').trim();
    const paren = c.indexOf(' (');
    if (paren > 0) c = c.slice(0, paren);
    const tries = [c, c.split(':')[0].trim()];
    for (const t of tries) {
      const hit = byNorm.get(normName(t));
      if (hit) return hit;
    }
    const cn = normName(c);
    if (cn.length >= 6) {
      for (const [k, v] of byNorm) { if (cn.startsWith(k) || k.startsWith(cn)) return v; }
    }
    return null;
  };
  const out = [];
  const segments = String(prose).split(/\n#{2,3}\s+/);
  for (const seg of segments) {
    if (!seg || seg.length < 40) continue;
    const nl = seg.indexOf('\n');
    const name = matchName(nl > 0 ? seg.slice(0, nl) : seg.slice(0, 80));
    if (!name || out.includes(name)) continue;
    const body = seg.slice(0, 1600);
    const statusM = body.match(/\*\*Status:?\*\*\s*([^\n]+)/i) || body.match(/Status:\s*([^\n]+)/i);
    const status = statusM ? statusM[1] : '';
    const statusUp = status.toUpperCase();
    // Explicit OPEN with no CLOSED in the status line -> operating.
    if (/\bOPEN\b/.test(statusUp) && !/\bCLOSED\b/.test(statusUp)) continue;
    const reopenM = body.match(/reopen\w*[^.\n]{0,50}?([A-Z][a-z]+ \d{1,2}, \d{4})/i);
    const reopenMs = reopenM ? parseDate(reopenM[1]) : null;
    if (reopenMs !== null && reopenMs <= tripMs) continue; // reopened on/before the trip
    const closesM = status.match(/CLOSES?\s+([A-Z][a-z]+ \d{1,2}, \d{4})/);
    if (closesM) {
      const startMs = parseDate(closesM[1]);
      if (startMs !== null && tripMs >= startMs) out.push(name);
      continue;
    }
    if (/\bCLOSED\b/.test(statusUp)) {
      const startM = body.match(/(?:beginning|began|closed from|closed since|closure beginning)\s+([A-Z][a-z]+ \d{1,2}, \d{4})/i);
      const startMs = startM ? parseDate(startM[1]) : null;
      if (startMs !== null && startMs > tripMs) continue; // closure has not begun yet
      out.push(name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DETERMINISTIC BACKFILL (recommendation #3) -- no placeholder cards, ever.
// When the model fails a slot (missing/invalid fill), pick a real, cache-verified
// choice deterministically instead of shipping "Flex time" / "Open dining choice".
// Pure function of (slot, ctx): same inputs -> same card, every run.
// ctx: { catalog: [ordered attraction entries], venues: [ordered venue entries],
//        closedNames: [raw closed names], usedRideKeys: Set (mutated),
//        usedNames: Set of lowercased placed names (mutated) }

// ---------------------------------------------------------------------------
// RIDE VARIANT GROUPS + LAND GEOGRAPHY (deterministic strategy support).
// Some catalog entries are the SAME physical attraction in different dress:
// the two Soarin' films share one theater, and the Pixar Pal-A-Round swinging /
// non-swinging gondolas are one wheel. Scheduling both variants reads to a
// guest as the same ride twice in a row, so every dedupe layer (fill,
// backfill, verify, cross-day priors) keys variants by their group, not their
// name. Geography: land loops in walking order around each park's hub score
// how far a candidate ride is from the previous one (circular distance in
// land steps). It is a penalty, never a veto -- ride value still wins, but
// between comparable headliners the day stops zigzagging across the park.
// ---------------------------------------------------------------------------
// Keys are normName() outputs (normName strips filler words: 'the', 'a', ...).
const RIDE_VARIANT_GROUPS = {
  'soarin around world': 'soarin',
  'soarin across america': 'soarin',
  'pixar pal round swinging': 'pixar pal a round',
  'pixar pal round non swinging': 'pixar pal a round'
};
// Group key for a ride name (or an already-normalized name key -- normName is
// idempotent on its own output). Non-variant rides key by their own name.
export function rideGroupKey(name) {
  const k = normName(name);
  return RIDE_VARIANT_GROUPS[k] || k;
}
const LAND_LOOPS = {
  dl: ['Main Street, U.S.A.', 'Tomorrowland', "Mickey's Toontown", 'Fantasyland', "Star Wars: Galaxy's Edge", 'Frontierland', 'Bayou Country', 'Critter Country', 'New Orleans Square', 'Adventureland'],
  dca: ['Buena Vista Street', 'Hollywood Land', 'Avengers Campus', 'Cars Land', 'San Fransokyo Square', 'Paradise Gardens Park', 'Pixar Pier', 'Grizzly Peak', 'Performance Corridor']
};
function landDistance(parkKey, landA, landB) {
  const loop = LAND_LOOPS[parkKey] || [];
  if (!landA || !landB) return 2;
  const ka = normName(landA), kb = normName(landB);
  if (ka === kb) return 0;
  const ia = loop.findIndex(l => normName(l) === ka);
  const ib = loop.findIndex(l => normName(l) === kb);
  if (ia === -1 || ib === -1) return 2;
  const d = Math.abs(ia - ib);
  return Math.min(d, loop.length - d);
}

// ---------------------------------------------------------------------------
// ROPE-DROP PRIORITY + CHARACTER MEET PICKERS (deterministic strategy).
// Rope drop is the highest-leverage decision of the day: the first ride is
// ASSIGNED by priority, not left to the fill model. Disneyland: Indiana Jones,
// Space Mountain, Rise of the Resistance, then Runaway Railway. DCA: Radiator
// Springs Racers, Guardians, then the remaining headliners. A priority ride
// already done on an earlier day yields to the next un-done priority; if all
// are done, the top priority repeats (rope-dropping a headliner twice beats
// rope-dropping a filler ride). Bans (skip/water) are absolute.
const ROPE_DROP_PRIORITY = {
  dl: ['Indiana Jones Adventure', 'Space Mountain', 'Star Wars: Rise of the Resistance', "Mickey & Minnie's Runaway Railway"],
  dca: ['Radiator Springs Racers', 'Guardians of the Galaxy - Mission: BREAKOUT!', 'Incredicoaster', "Soarin' Around the World", 'WEB SLINGERS: A Spider-Man Adventure']
};
export function pickRopeDropRide(catalogIdx, parkName, priorNames, bannedNames, priorRopeDropNames, closedNames) {
  const idx = catalogIdx || {};
  const pk = normParkName(parkName);
  const priorKeys = new Set((priorNames || []).map(normName).filter(Boolean));
  const priorGroups = new Set((priorNames || []).map(rideGroupKey).filter(Boolean));
  const bannedKeys = new Set((bannedNames || []).map(normName).filter(Boolean));
  const bannedGroups = new Set((bannedNames || []).map(rideGroupKey).filter(Boolean));
  const closedKeys = new Set((closedNames || []).map(normName).filter(Boolean));
  const isBanned = (e) => bannedKeys.has(normName(e.name)) || bannedGroups.has(rideGroupKey(e.name));
  const entries = Object.values(idx).filter(e => e && e.name && normParkName(e.park) === pk && (!e.status || e.status === 'operating') && !isBanned(e) && !closedKeys.has(normName(e.name)));
  if (!entries.length) return null;
  const prio = ROPE_DROP_PRIORITY[pk] || [];
  // GUARANTEED ONCE: the park's #1 ride must be ROPE-DROPPED at least once in
  // the trip. Riding it casually on an earlier day (e.g. as a hop-afternoon
  // ride) does NOT satisfy this -- until it has headlined a rope drop, it
  // outranks the un-done priorities. Bans still override.
  const ropedKeys = new Set((priorRopeDropNames || []).map(normName).filter(Boolean));
  const ropedGroups = new Set((priorRopeDropNames || []).map(rideGroupKey).filter(Boolean));
  // A ride counts as done when it -- or its sibling variant (same attraction,
  // different film/gondola) -- was already ridden on an earlier day.
  const done = (e) => priorKeys.has(normName(e.name)) || priorGroups.has(rideGroupKey(e.name));
  if (prio.length) {
    const top = idx[normName(prio[0])];
    if (top && entries.indexOf(top) !== -1 && !ropedKeys.has(normName(top.name)) && !ropedGroups.has(rideGroupKey(top.name))) return top;
  }
  for (const name of prio) { const e = idx[normName(name)]; if (e && entries.indexOf(e) !== -1 && !done(e)) return e; }
  for (const name of prio) { const e = idx[normName(name)]; if (e && entries.indexOf(e) !== -1) return e; }
  const score = (e) => ((e.ropeDropValue === 'high' ? 3 : e.ropeDropValue === 'med' ? 2 : 1) * 1000) + (e.typicalPeakWait || 0);
  const fresh = entries.filter(e => !done(e)).sort((a, b) => score(b) - score(a));
  if (fresh.length) return fresh[0];
  return entries.slice().sort((a, b) => score(b) - score(a))[0];
}

// MORNING BLOCK ASSIGNMENT: the first 1-2 hours are the highest-leverage
// window of the day, so they are programmed deterministically like the rope
// drop -- not left to the fill model or to whatever the backfill has left by
// the last day of a trip. Returns up to `count` catalog entries for the
// day's start park, in ride order: the rope-drop pick first (same
// guaranteed-once logic), then the park's remaining priority headliners,
// scored by ride value with a land-distance penalty so the route sweeps
// through neighboring lands instead of crossing the park repeatedly.
// Headliners may repeat across days inside this window (a fresh rope-drop
// line beats a first-ever ride on a filler ride); bans, closures, and
// variant groups are absolute, and no attraction repeats within the block.
export function pickMorningRides(catalogIdx, parkName, count, opts) {
  opts = opts || {};
  if (!count || count < 1) return [];
  const idx = catalogIdx || {};
  const pk = normParkName(parkName);
  const bannedNames = opts.bannedNames || [];
  const closedNames = opts.closedNames || [];
  const bannedKeys = new Set(bannedNames.map(normName).filter(Boolean));
  const bannedGroups = new Set(bannedNames.map(rideGroupKey).filter(Boolean));
  const closedKeys = new Set(closedNames.map(normName).filter(Boolean));
  const picks = [];
  const first = pickRopeDropRide(idx, parkName, opts.priorNames, bannedNames, opts.priorRopeDropNames, closedNames);
  if (first) picks.push(first);
  const usedNames = new Set(picks.map(e => normName(e.name)));
  const usedGroups = new Set(picks.map(e => rideGroupKey(e.name)));
  const priorKeys = new Set((opts.priorNames || []).map(normName).filter(Boolean));
  const priorGroups = new Set((opts.priorNames || []).map(rideGroupKey).filter(Boolean));
  const prio = ROPE_DROP_PRIORITY[pk] || [];
  const pool = Object.values(idx).filter(e => e && e.name && normParkName(e.park) === pk &&
    (!e.status || e.status === 'operating') &&
    !bannedKeys.has(normName(e.name)) && !bannedGroups.has(rideGroupKey(e.name)) &&
    !closedKeys.has(normName(e.name)) && !NEVER_MORNING_KEYS.has(normName(e.name)));
  const value = (e) => {
    let v = 0;
    const pi = prio.findIndex(n => normName(n) === normName(e.name));
    if (pi !== -1) v += 1000 - pi * 100;
    v += (e.ropeDropValue === 'high' ? 300 : e.ropeDropValue === 'med' ? 150 : 0);
    v += (e.typicalPeakWait || 0);
    if (!priorKeys.has(normName(e.name)) && !priorGroups.has(rideGroupKey(e.name))) v += 120; // prefer fresh
    return v;
  };
  let lastLand = picks.length ? picks[0].land : null;
  while (picks.length < count) {
    let best = null, bestScore = -Infinity;
    for (const e of pool) {
      if (usedNames.has(normName(e.name)) || usedGroups.has(rideGroupKey(e.name))) continue;
      const s = value(e) - landDistance(pk, lastLand, e.land) * 45;
      if (s > bestScore) { bestScore = s; best = e; }
    }
    if (!best) break;
    picks.push(best);
    usedNames.add(normName(best.name));
    usedGroups.add(rideGroupKey(best.name));
    lastLand = best.land;
  }
  return picks;
}

// Pick the day's character meet from the character-intel list: wanted
// categories first, in one of the day's parks, preferring a category not yet
// covered earlier in the trip, then a character not yet met. Location text is
// mapped to a park via landToPark plus a keyword fallback for meet locations.
export function pickCharacterMeet(characters, categories, dayParks, priorNames, landToParkFn) {
  const pool = (Array.isArray(characters) ? characters : []).filter(c => c && c.name);
  if (!pool.length || !Array.isArray(dayParks) || !dayParks.length) return null;
  const cats = Array.isArray(categories) ? categories : [];
  const inCat = cats.length ? pool.filter(c => cats.indexOf(c.category) !== -1) : pool;
  const usable = inCat.length ? inCat : pool;
  const LAND_KEYS = [['galaxy', 'DL'], ['avengers', 'DCA'], ['cars land', 'DCA'], ['pixar pier', 'DCA'], ['toontown', 'DL'], ['main street', 'DL'], ['town square', 'DL'], ['fantasyland', 'DL'], ['grizzly', 'DCA'], ['paradise', 'DCA'], ['buena vista', 'DCA'], ['hollywood', 'DCA'], ['frontierland', 'DL'], ['adventureland', 'DL'], ['new orleans', 'DL'], ['critter', 'DL'], ['tomorrowland', 'DL'], ['star wars', 'DL'], ['marvel', 'DCA'], ['pixar', 'DCA'], ['animation', 'DCA']];
  const parkOf = (c) => {
    let p = null;
    try { p = landToParkFn ? landToParkFn(c.location || '') : null; } catch (e) { p = null; }
    if (p) return p;
    const s = String(c.location || '').toLowerCase();
    for (const pair of LAND_KEYS) { if (s.indexOf(pair[0]) !== -1) return pair[1]; }
    return null;
  };
  const inParks = usable.filter(c => { const p = parkOf(c); return p && dayParks.some(dp => sameParkName(dp, p)); });
  if (!inParks.length) return null;
  // Prior meets arrive as card headings ('Meet Rey', 'Rey Character Meet'):
  // match by containment, not equality, or rotation silently never engages.
  const priorNorms = (priorNames || []).map(n => normName(String(n || '').replace(/^meet\s+/i, ''))).filter(Boolean);
  const wasMet = (c) => { const k = normName(c.name); return priorNorms.some(p => p === k || p.indexOf(k) !== -1 || k.indexOf(p) !== -1); };
  const coveredCats = new Set();
  for (const c of pool) { if (wasMet(c)) coveredCats.add(c.category); }
  const score = (c) => (coveredCats.has(c.category) ? 2 : 0) + (wasMet(c) ? 1 : 0);
  const pick = inParks.slice().sort((a, b) => score(a) - score(b))[0];
  const parkMatch = dayParks.find(dp => sameParkName(dp, parkOf(pick)));
  return { name: pick.name, park: parkMatch || dayParks[0], land: pick.location || '', category: pick.category || '', wait: pick.typicalWait || 0, windows: Array.isArray(pick.typicalWindows) ? pick.typicalWindows : [] };
}

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
    // Rope-drop slots carry an ASSIGNED ride: the backfill honors it exactly.
    if (slot.preferRide) {
      const pe = catalog.find(e => e && e.name && normName(e.name) === normName(slot.preferRide) && inSlotPark(e.park) && !(ctx.bannedKeys && ctx.bannedKeys.has(normName(e.name))));
      if (pe) {
        usedRideKeys.add(normName(pe.name));
        usedNames.add(String(pe.name).toLowerCase());
        if (ctx.todayRideKeys instanceof Set) ctx.todayRideKeys.add(normName(pe.name));
        return { t: t0, h: pe.name, type: 'ride', n: 'Rope-drop priority: ride this first while the line is shortest.', land: pe.land || '', ride: pe.name };
      }
    }
    const usedGroups = new Set([...usedRideKeys].map(k => rideGroupKey(k)));
    const bannedGroups = (ctx.bannedKeys instanceof Set) ? new Set([...ctx.bannedKeys].map(k => rideGroupKey(k))) : null;
    const isBannedE = (e) => !!(ctx.bannedKeys && (ctx.bannedKeys.has(normName(e.name)) || (bannedGroups && bannedGroups.has(rideGroupKey(e.name)))));
    const morningSlot = winStart(slot.window) < 720;
    const cands = catalog.filter(e =>
      e && e.name && !usedRideKeys.has(normName(e.name)) && !usedGroups.has(rideGroupKey(e.name)) &&
      inSlotPark(e.park) && (!e.status || e.status === 'operating') &&
      !closedKeys.has(normName(e.name)) && !isBannedE(e) &&
      !(morningSlot && NEVER_MORNING_KEYS.has(normName(e.name))));
    // Deterministic: highest typical peak wait first (headliners earn the slot), ties by name.
    cands.sort((a, b) => ((b.typicalPeakWait || 0) - (a.typicalPeakWait || 0)) || String(a.name).localeCompare(String(b.name)));
    if (cands.length) {
      const pick = cands[0];
      usedRideKeys.add(normName(pick.name));
      usedNames.add(String(pick.name).toLowerCase());
      if (ctx.todayRideKeys instanceof Set) ctx.todayRideKeys.add(normName(pick.name));
      return { t: t0, h: pick.name, type: 'ride', n: 'Top standby-saver from the verified attraction list.', land: pick.land || '', ride: pick.name };
    }
    // Fresh pool exhausted (late-trip days, after cross-day dedupe has used the
    // whole park catalog): repeat a ride from an EARLIER day of this trip --
    // never one already placed today -- instead of degrading the slot into a
    // generic 'afternoon ride' tip card.
    const _priorKeys = (ctx.priorRideKeys instanceof Set) ? ctx.priorRideKeys : new Set();
    const _todayKeys = (ctx.todayRideKeys instanceof Set) ? ctx.todayRideKeys : new Set();
    const _todayGroups = new Set([..._todayKeys].map(k => rideGroupKey(k)));
    const reuse = catalog.filter(e =>
      e && e.name && _priorKeys.has(normName(e.name)) && !_todayKeys.has(normName(e.name)) && !_todayGroups.has(rideGroupKey(e.name)) &&
      inSlotPark(e.park) && (!e.status || e.status === 'operating') &&
      !closedKeys.has(normName(e.name)) && !isBannedE(e) &&
      !(morningSlot && NEVER_MORNING_KEYS.has(normName(e.name))));
    reuse.sort((a, b) => ((b.typicalPeakWait || 0) - (a.typicalPeakWait || 0)) || String(a.name).localeCompare(String(b.name)));
    if (reuse.length) {
      const pick = reuse[0];
      usedRideKeys.add(normName(pick.name));
      usedNames.add(String(pick.name).toLowerCase());
      _todayKeys.add(normName(pick.name));
      return { t: t0, h: pick.name, type: 'ride', n: 'Back for an encore -- a favorite from earlier in the trip.', land: pick.land || '', ride: pick.name };
    }
  }

  if (slot.type === 'dining' || slot.type === 'quickservice' || slot.type === 'snack') {
    const rankResv = (r) => r === 'walkup' ? 0 : r === 'recommended' ? 1 : 2;
    const rankSvc = (s) => (s === 'quickservice' || s === 'snack') ? 0 : 1;
    const cands = venues
      .filter(v => v && v.name && !v.exclude && inSlotPark(v.park) &&
        !usedNames.has(String(v.name).toLowerCase()) &&
        !closedVenueKeys.has(normName(v.name)) &&
        (v.service === 'quickservice' || v.service === 'snack' || (v.service === '' && v.reservationPolicy === 'walkup')) &&
        v.reservationPolicy !== 'never_meal' && v.reservationPolicy !== 'required')
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

  if (slot.type === 'show') {
    const shows = Array.isArray(ctx.shows) ? ctx.shows : [];
    const wantedK = (ctx.wantedShows || []).map(s => normName(s)).filter(Boolean);
    const inPark = shows.filter(s => s && s.name && inSlotPark(s.park) && !usedNames.has(String(s.name).toLowerCase()));
    const pick = inPark.find(s => wantedK.some(w => { const sn = normName(s.name); return sn === w || sn.startsWith(w) || w.startsWith(sn); })) || inPark[0];
    if (pick) {
      usedNames.add(String(pick.name).toLowerCase());
      return { t: t0, h: pick.name, type: 'show', n: 'Nighttime spectacular -- arrive early for a good spot.', land: '' };
    }
  }

  // Character slot: emit the day's planned meet verbatim.
  if (slot.type === 'character' && slot.meetName) {
    return { t: t0, h: 'Meet ' + slot.meetName, type: 'character', n: (slot.meetLand ? 'Find them at ' + slot.meetLand + '. ' : '') + 'A must-do meet for this group.', land: slot.meetLand || '' };
  }

  // Break slots: fixed guest-facing cards, emitted verbatim.
  if (slot.type === 'break') {
    let note = 'Restrooms, water refill, and a breather -- back to the fun in a few minutes.';
    let photoLinks = null;
    if (slot.block === 'photoPM' || slot.block === 'photoMidday') {
      // Specific photo ideas from the photo-ops cache (Beau, Oct 6, 2026):
      // the spots for the park this slot sits in, preferring the land the
      // group is already in (ctx.nearLand -- for the midday stop that is the
      // lunch venue's land) and shots that suit the time of day.
      const midday = slot.block === 'photoMidday';
      const spots = Array.isArray(ctx.photoSpots) ? ctx.photoSpots : [];
      const inPark = spots.filter(s => s && s.shot && sameParkName(s.park, slot.park));
      if (inPark.length) {
        const near = normName(ctx.nearLand || '');
        const score = (s) => {
          const bt = String(s.bestTime || '').toLowerCase();
          const ts = midday
            ? (/any|morning|midday/.test(bt) ? 1 : (/night/.test(bt) ? -1 : 0))
            : (/golden|sunset|evening|night|dusk/.test(bt) ? 1 : 0);
          return ((near && normName(s.land || '') === near) ? 2 : 0) + ts;
        };
        const picks = inPark.slice().sort((a, b) => score(b) - score(a)).slice(0, 2);
        // Short pattern (Beau picked ~28 words, Oct 6, 2026): a lead-in plus
        // one <=11-word phrase per spot. Falls back to compressing the long
        // shot sentence when a spot has no short phrase yet.
        const phrase = (s) => {
          const sh = String(s.short || '').trim().replace(/\.$/, '');
          if (sh) return sh;
          // Fallback for spots written before the short field existed: the
          // first sentence capped at 12 words, sentence-starter verbs
          // lower-cased (proper names keep their capitals).
          let t = String(s.shot || '').trim();
          const first = (t.split(/(?<=[.!?])\s/)[0] || t).replace(/\.$/, '');
          const words = first.split(/\s+/).slice(0, 12);
          let p = words.join(' ');
          if (/^(Stand|Face|Position|Head|Walk|Step|Gather|From|In|On|At|By)\b/.test(p)) p = p.charAt(0).toLowerCase() + p.slice(1);
          return p;
        };
        const lead = midday
          ? (picks.length > 1 ? 'Two easy shots near your lunch spot: ' : 'An easy shot near your lunch spot: ')
          : (picks.length > 1 ? 'Two easy shots nearby: ' : 'An easy shot nearby: ');
        note = lead + picks.map(phrase).join(', and ') + '.';
        const links = picks.filter(s => s.sampleUrl).map(s => ({ label: String(s.name), url: String(s.sampleUrl) }));
        if (links.length) photoLinks = links;
      } else if (midday) {
        note = 'A quick photo stop while you are in the area -- the backdrop where you just ate makes an easy group photo.';
      } else {
        note = 'Golden-hour photos and a souvenir stop while you are in the area -- the light is best right about now.';
      }
    }
    const breakCard = { t: t0, h: slot.breakTitle || 'Rest Break', type: 'break', n: note, land: '' };
    if (photoLinks) breakCard.photoLinks = photoLinks;
    return breakCard;
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
  // Variant groups: the two Soarin' films (and the two Pal-A-Round gondolas)
  // are ONE attraction. When both variants sit in mustDo (the picker emits
  // every member name), one placed variant satisfies the whole group --
  // otherwise the enforcer resurrects the sibling verify just removed as a
  // dupe-variant (BEAU01 Days 1+3, Oct 4, 2026: both films in one day).
  const cardGroups = new Set([...cardKeys].map(k => rideGroupKey(k)).filter(Boolean));
  for (const name of (params.mustDo || [])) {
    const k = normName(name);
    if (k && !cardKeys.has(k) && !cardGroups.has(rideGroupKey(k))) violations.push({ kind: 'mustdo-missing', name: String(name) });
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
// ctx: { catalog: {normKey: entry}, landToPark: fn, closedNames, bannedNames,
//        mustDoNames }. Never throws.
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
  // Swap-in guardrails (BEAU01, Oct 4, 2026): with 37 must-dos against ~13 ride
  // slots, the old loop renamed the SAME one or two cards dozens of times --
  // the surviving names were accidents of list order, and closed must-dos
  // (Indiana Jones, Mad Tea Party) sat in the swap chain one position away
  // from being resurrected into the final schedule. Rules now: a closed or
  // banned must-do is unfixable, never swapped in; a target card is used at
  // most once per pass; and a card already holding a must-do is never evicted
  // to make room for another must-do.
  const closedSet = new Set((ctx.closedNames || []).map(normName).filter(Boolean));
  const bannedSet = new Set((ctx.bannedNames || []).map(normName).filter(Boolean));
  const mustSet = new Set((ctx.mustDoNames || []).map(normName).filter(Boolean));
  const swappedTargets = new Set();

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
      // Variant-group guard: a sibling variant already placed today satisfies
      // this must-do (same physical attraction) -- never swap the second
      // film/gondola in over verify's dupe-variant removal.
      const presentGroups = new Set(out.filter(c => c && c.type === 'ride').map(c => rideGroupKey(c.ride || c.h)).filter(Boolean));
      if (presentGroups.has(rideGroupKey(v.name))) { fixed.push({ kind: v.kind, name: v.name, action: 'variant-present' }); continue; }
      // Closed or banned must-dos are unfixable, never resurrected by a swap.
      const vk = normName(v.name);
      if (closedSet.has(vk) || bannedSet.has(vk)) { unfixable.push(v); continue; }
      const wantPark = parkOfName(v.name);
      // Recompute per violation; targets are ride cards not already swapped
      // this pass and not already holding a must-do.
      const findTarget = () => {
        const rc = out.map((c, i) => ({ c, i })).filter(({ c, i }) => c.type === 'ride' && !swappedTargets.has(i) && !mustSet.has(normName(c.ride || c.h || '')) && !(NEVER_MORNING_KEYS.has(normName(v.name)) && (parseClock(c.t) || 9999) < 720));
        const fr = rc[0];
        return rc.find(({ c }) => c !== (fr && fr.c) && (!wantPark || parkOfCard(c) === wantPark))
          || rc.find(({ c }) => !wantPark || parkOfCard(c) === wantPark);
      };
      const target = findTarget();
      if (target) {
        swappedTargets.add(target.i);
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
