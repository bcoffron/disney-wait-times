// schedule-rules.js
// SINGLE SOURCE OF TRUTH for every rule-governed schedule decision.
//
// Both the deterministic skeleton builder (schedule-skeleton.js) and the validator
// (validate-schedule.js) import their rules from HERE. Nothing about meal timing, breaks,
// arrival lead time, or rope-drop ranking is defined anywhere else. This is what eliminates
// the "prompt says one thing, cache says another, enforcer does a third" class of bug:
// there is exactly one place each rule is expressed.
//
// PHYSICS vs STRATEGY (Beau's principle):
//  - The RULE LOGIC (how to pick, where meals may go, how many breaks) lives in code here.
//  - The STRATEGY DATA that genuinely varies (the rope-drop ranking per park) lives in the
//    CACHE; this module READS it from the cache and only falls back to a documented default
//    when the cache is unavailable. So updating the ranking never requires a code change.
//
// ESM only (no require/module.exports), ASCII only.

// ---------------------------------------------------------------------------
// TIME HELPERS (minutes-since-midnight is the canonical internal unit)
// ---------------------------------------------------------------------------

export const NOON = 12 * 60;        // 720
export const MIDNIGHT = 24 * 60;    // 1440

// ---------------------------------------------------------------------------
// TIME FORMAT HELPERS (single home for "H:MM AM" <-> minutes-since-midnight)
// Kept here so the skeleton, corrections, and validator all parse/format times
// identically. "12:00 AM" as a CLOSE time is treated as 1440 (end of day) by
// labelToMin when asCloseTime is set; otherwise midnight = 0.
// ---------------------------------------------------------------------------

export function labelToMin(t, opts = {}) {
  if (typeof t !== 'string') return -1;
  const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return -1;
  let h = parseInt(m[1], 10) % 12;
  const min = parseInt(m[2], 10);
  if (/pm/i.test(m[3])) h += 12;
  let total = h * 60 + min;
  if (opts.asCloseTime && total === 0) total = MIDNIGHT; // midnight close = 1440
  return total;
}

export function minToLabel(min) {
  if (typeof min !== 'number' || min < 0) return '';
  let m = min % MIDNIGHT; // wrap 1440 -> 0 for display as 12:00 AM
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h24 < 12 ? 'AM' : 'PM';
  let h12 = h24 % 12; if (h12 === 0) h12 = 12;
  return h12 + ':' + String(mm).padStart(2, '0') + ' ' + ap;
}

// ---------------------------------------------------------------------------
// MEAL RULES
// Beau's confirmed, established rule: NO app-chosen meal may fall inside a peak window.
// Reservations are the ONLY exception (they are fixed points the guest chose).
// Forbidden windows are half-open [start, end): a meal AT 1:00 PM is allowed, AT 12:59 is not.
// ---------------------------------------------------------------------------

export const MEAL_FORBIDDEN_WINDOWS = [
  { startMin: 12 * 60, endMin: 13 * 60, label: 'midday peak (12-1)' }, // [720,780)
  { startMin: 17 * 60, endMin: 18 * 60, label: 'dinner peak (5-6)' },  // [1020,1080)
];

// Is a given minute inside ANY forbidden meal window?
export function isMealTimeForbidden(min) {
  if (typeof min !== 'number' || min < 0) return false;
  return MEAL_FORBIDDEN_WINDOWS.some(w => min >= w.startMin && min < w.endMin);
}

// Nearest allowed minute for an app-chosen meal. The ONLY constraint is "outside the forbidden
// windows" (plus optional caller bounds for context, e.g. a dinner must fall after a VIP tour
// ends -> caller passes minBound = tourEndMin). Snaps to clean quarter-hours and searches
// outward from the desired time, so the result is the closest sensible legal slot. Pure.
// opts: { minBound = 0, maxBound = MIDNIGHT }. Returns minute or null if none fits the bounds.
export function nearestAllowedMealMin(desiredMin, opts = {}) {
  const minBound = typeof opts.minBound === 'number' ? opts.minBound : 0;
  const maxBound = typeof opts.maxBound === 'number' ? opts.maxBound : MIDNIGHT;
  const snap = (m) => Math.round(m / 15) * 15;
  const d = snap(desiredMin);
  for (let step = 0; step <= 24 * 4; step++) {
    const cands = step === 0 ? [d] : [d + step * 15, d - step * 15];
    for (const c of cands) {
      if (c < minBound || c > maxBound) continue;
      if (!isMealTimeForbidden(c)) return c;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// BREAK RULES
// At most ONE restroom break in the morning (before noon) and at most ONE in the afternoon.
// A single cutoff (noon) governs BOTH the dedup and the "is this a morning break" test, so
// they can never disagree (the historical bug: dedup used noon, detection used 11:00).
// ---------------------------------------------------------------------------

export const BREAK_MORNING_CUTOFF = NOON; // 720. Before this = morning; at/after = afternoon/evening.
export const MAX_MORNING_BREAKS = 1;
export const MAX_AFTERNOON_BREAKS = 1;

// Correct, time-accurate note text for a break at a given minute. The historical bug was a
// hardcoded "Afternoon restroom stop" applied to a 10 AM break; here the note is always derived
// from the actual time, so it can never be wrong.
export function breakNoteForMin(min) {
  if (min < BREAK_MORNING_CUTOFF) return 'Quick morning restroom stop. Facilities are nearby.';
  if (min < 17 * 60) return 'Afternoon restroom stop. A good moment to regroup before the evening.';
  return 'Evening restroom stop. Facilities are nearby.';
}

// ---------------------------------------------------------------------------
// ARRIVAL RULE
// Guests should arrive at the gates a full hour before official open for rope drop.
// (Historical onboarding copy said "30 minutes"; the schedule's arrival card is the source of
// truth and says one hour.)
// ---------------------------------------------------------------------------

export const ARRIVAL_LEAD_MIN = 60;

// ---------------------------------------------------------------------------
// ROPE-DROP RANKING (strategy DATA — read from cache, code only holds the LOGIC)
// ---------------------------------------------------------------------------

// Documented fallback ONLY. Used when the cache section is missing/unparseable. Kept in sync
// with the cache by Beau's stated global policy. The cache is authoritative when present.
export const DEFAULT_ROPE_DROP_RANKING = {
  DL: [
    "Peter Pan's Flight",
    "Rise of the Resistance",
    "Space Mountain",
    "Mickey & Minnie's Runaway Railway",
    "Indiana Jones Adventure",
  ],
  DCA: [
    "Radiator Springs Racers",
    "Guardians of the Galaxy - Mission: BREAKOUT!",
    "Web Slingers",
    "Incredicoaster",
    "Toy Story Midway Mania!",
  ],
};

// Normalize a ride name for comparison: lowercase, strip a leading "Rope Drop:"/"Rope Drop -"
// prefix, drop everything that isn't a letter or digit. Shared by picker + validator so name
// matching is identical everywhere.
export function normRideName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^\s*rope drop\s*[:\u2013\u2014-]?\s*/i, '')
    .replace(/^\s*star wars\s*[:\u2013\u2014-]?\s*/i, '')
    .replace(/[^a-z0-9]/g, '');
}

// Parse the cache's ROPE_DROP_STRATEGY prose into { DL:[...], DCA:[...] }.
// Tolerant: finds the "DISNEYLAND order:" and "DCA order:" segments and extracts the ride names
// between the "N)" rank markers. Returns null if it cannot find both lists, so callers fall back.
export function parseRopeDropRanking(proseText) {
  if (!proseText || typeof proseText !== 'string') return null;
  const grab = (labelRegex) => {
    const m = proseText.match(labelRegex);
    if (!m) return null;
    // segment runs from after the label to the next double-newline or end.
    let seg = proseText.slice(m.index + m[0].length);
    const stop = seg.search(/\n\s*\n|\bRULE\b/i);
    if (stop !== -1) seg = seg.slice(0, stop);
    // split on "N)" markers; keep the text after each marker up to the next marker.
    const parts = seg.split(/\s*\d+\)\s*/).map(s => s.trim()).filter(Boolean);
    // each part may end with a trailing period or stray punctuation; clean lightly.
    const names = parts.map(p => p.replace(/[.;]\s*$/, '').trim()).filter(Boolean);
    return names.length ? names : null;
  };
  const DL = grab(/DISNEYLAND[^:]*:/i);
  const DCA = grab(/\bDCA[^:]*:/i);
  if (!DL || !DCA) return null;
  return { DL, DCA };
}

// Resolve the ranking from cache sections, with documented fallback. Prefers a STRUCTURED
// field (cacheSections.ROPE_DROP_RANKING = {DL:[],DCA:[]}) if a future cache provides one;
// else parses the prose; else the default constant.
export function getRopeDropRanking(cacheSections) {
  const cs = cacheSections || {};
  if (cs.ROPE_DROP_RANKING && Array.isArray(cs.ROPE_DROP_RANKING.DL) && Array.isArray(cs.ROPE_DROP_RANKING.DCA)) {
    return { DL: cs.ROPE_DROP_RANKING.DL.slice(), DCA: cs.ROPE_DROP_RANKING.DCA.slice(), source: 'cache-structured' };
  }
  const parsed = parseRopeDropRanking(cs.ROPE_DROP_STRATEGY);
  if (parsed) return Object.assign(parsed, { source: 'cache-prose' });
  return Object.assign({ DL: DEFAULT_ROPE_DROP_RANKING.DL.slice(), DCA: DEFAULT_ROPE_DROP_RANKING.DCA.slice() }, { source: 'default' });
}
