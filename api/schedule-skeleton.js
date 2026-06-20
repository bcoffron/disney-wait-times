// schedule-skeleton.js
// Deterministic anchor computation. These are PURE functions: given config + cache-derived
// inputs, they return the fixed, rule-governed parts of a day BEFORE the model runs. The model
// then fills the open ride time between anchors; it never decides an anchor, so it cannot get
// an anchor wrong, and there is no second authority to disagree with.
//
// This file imports every rule from schedule-rules.js. It defines no rule of its own.
// ESM only, ASCII only.

import {
  normRideName,
  ARRIVAL_LEAD_MIN,
  NOON,
  isMealTimeForbidden,
  nearestAllowedMealMin,
} from './schedule-rules.js';

// ---------------------------------------------------------------------------
// ROPE-DROP PICKER (the deterministic answer to "which ride opens this day")
// ---------------------------------------------------------------------------

// Pick the single rope-drop ride for ONE day, deterministically:
//   highest-ranked ride for this day's park that is (a) not excluded by the group,
//   (b) not already used as rope-drop on a PRIOR same-park day, and (c) available
//   (not closed) on this date. Falls back down the list, then (last resort) allows a
//   repeat rather than returning nothing.
//
// Inputs (all normalized name SETS are Sets of normRideName() strings):
//   park            : 'DL' | 'DCA'
//   ranking         : { DL:[names], DCA:[names] }  (from getRopeDropRanking)
//   excludedNorm    : Set of normalized excluded ride names
//   usedPriorNorm   : Set of normalized names already rope-dropped on prior same-park days
//   isAvailable     : (rideName) => boolean   (closure check for this date; default: all available)
//
// Returns { name, rank, reason } or null if the park has no ranked rides at all.
export function pickRopeDrop({ park, ranking, excludedNorm, usedPriorNorm, isAvailable }) {
  const list = (ranking && ranking[park]) || [];
  if (!list.length) return null;
  const excluded = excludedNorm || new Set();
  const usedPrior = usedPriorNorm || new Set();
  const avail = typeof isAvailable === 'function' ? isAvailable : () => true;

  const passes = (name, { allowRepeat = false } = {}) => {
    const n = normRideName(name);
    if (excluded.has(n)) return false;
    if (!allowRepeat && usedPrior.has(n)) return false;
    if (!avail(name)) return false;
    return true;
  };

  // Pass 1: ideal — not excluded, not repeated, available.
  for (let i = 0; i < list.length; i++) {
    if (passes(list[i])) return { name: list[i], rank: i + 1, reason: 'ranked-unused' };
  }
  // Pass 2: allow a repeat (every fresh option exhausted), still not excluded, still available.
  for (let i = 0; i < list.length; i++) {
    if (passes(list[i], { allowRepeat: true })) {
      return { name: list[i], rank: i + 1, reason: 'ranked-repeat-fallback' };
    }
  }
  // Pass 3: nothing available/allowed (e.g. all excluded or closed) -> caller handles (no rope drop).
  return null;
}

// Assign rope-drop rides across ALL days, carrying cross-day memory per park so the same park's
// rope-drop never repeats while fresh options remain. This is the deterministic replacement for
// the prompt's "repeat it if it's the best opener" + the catalog-based enforcer.
//
// days: array of { park: 'DL'|'DCA' }  (the STARTING park of each day)
// ranking, excludedNorm, isAvailableForDay(dayIndex, rideName) as above.
// Returns array aligned to days: [{ name, rank, reason } | null].
export function assignRopeDropsAcrossDays({ days, ranking, excludedNorm, isAvailableForDay }) {
  const usedByPark = { DL: new Set(), DCA: new Set() };
  return (days || []).map((d, idx) => {
    const park = d.park;
    const pick = pickRopeDrop({
      park,
      ranking,
      excludedNorm,
      usedPriorNorm: usedByPark[park] || new Set(),
      isAvailable: (rideName) =>
        typeof isAvailableForDay === 'function' ? isAvailableForDay(idx, rideName) : true,
    });
    if (pick) {
      if (!usedByPark[park]) usedByPark[park] = new Set();
      usedByPark[park].add(normRideName(pick.name));
    }
    return pick;
  });
}

// ---------------------------------------------------------------------------
// ARRIVAL ANCHOR
// ---------------------------------------------------------------------------

// The arrival card minute: ARRIVAL_LEAD_MIN before the starting park's open.
export function arrivalMin(startOpenMin) {
  return Math.max(0, startOpenMin - ARRIVAL_LEAD_MIN);
}

// ---------------------------------------------------------------------------
// MEAL-SLOT ANCHORS (which meals the code fixes a time for; the model fills the venue)
// ---------------------------------------------------------------------------

// Classify a reservation's minute as the meal it covers, so the skeleton does not also add an
// app meal slot for that meal. Returns 'lunch' | 'dinner' | null.
export function classifyReservationMeal(min) {
  if (typeof min !== 'number') return null;
  if (min >= 11 * 60 && min < 15 * 60) return 'lunch';   // 11:00-3:00
  if (min >= 16 * 60 && min <= 22 * 60) return 'dinner';  // 4:00-10:00
  return null;
}

// Decide lunch/dinner anchor slots for a day. A slot fixes the TIME only; the model picks a
// venue in the correct park for that time. Rules:
//  - If a reservation already covers a meal, no app slot for it.
//  - If the meal's natural time falls inside a VIP tour window, the tour covers it -> no slot.
//  - Otherwise place it at the nearest allowed (non-peak) clean time, within park bounds, and
//    (for dinner) after any VIP tour ends.
// Returns { lunch: slot|null, dinner: slot|null } where slot = { kind, min, needsVenue:true }.
export function placeMealSlots({ dayStartMin, dayEndMin, reservations = [], vipWindow = null }) {
  const covered = new Set();
  for (const r of (reservations || [])) {
    const m = classifyReservationMeal(typeof r.min === 'number' ? r.min : NaN);
    if (m) covered.add(m);
  }
  const inVip = (min) =>
    vipWindow && typeof vipWindow.startMin === 'number' &&
    min >= vipWindow.startMin && min < vipWindow.endMin;

  const slots = { lunch: null, dinner: null };

  // LUNCH -- natural target 11:30
  if (!covered.has('lunch')) {
    const target = 11 * 60 + 30;
    if (!inVip(target)) {
      const min = nearestAllowedMealMin(target, { minBound: dayStartMin, maxBound: dayEndMin });
      if (min !== null && !inVip(min)) slots.lunch = { kind: 'lunch', min, needsVenue: true };
    }
    // target inside VIP window -> the tour covers lunch -> no slot
  }

  // DINNER -- natural target 6:00, after any VIP tour
  if (!covered.has('dinner')) {
    let target = 18 * 60;
    let minBound = dayStartMin;
    if (vipWindow && typeof vipWindow.endMin === 'number') {
      minBound = Math.max(minBound, vipWindow.endMin);
      if (target < vipWindow.endMin) target = vipWindow.endMin + 60;
    }
    const min = nearestAllowedMealMin(target, { minBound, maxBound: dayEndMin });
    if (min !== null && !inVip(min)) slots.dinner = { kind: 'dinner', min, needsVenue: true };
  }

  return slots;
}
