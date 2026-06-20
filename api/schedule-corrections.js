// schedule-corrections.js
// After-model deterministic transforms. PURE functions: given a model-produced item array (and
// context), return a corrected array plus a record of what changed. These enforce the physics the
// model may have gotten wrong, using ONLY the rules in schedule-rules.js. The refactored validator
// applies these; nothing here defines a rule of its own.
//
// Item shape (the generator's schema): { t:"H:MM AM", h, type, n, land, ... }
// ESM only, ASCII only.

import {
  labelToMin,
  minToLabel,
  BREAK_MORNING_CUTOFF,
  MAX_MORNING_BREAKS,
  MAX_AFTERNOON_BREAKS,
  breakNoteForMin,
  isMealTimeForbidden,
  nearestAllowedMealMin,
} from './schedule-rules.js';

// ---------------------------------------------------------------------------
// BREAKS: cap at <=1 morning and <=1 afternoon, and make every break note match its actual time.
// Fixes (a) "two morning breaks" and (b) a 10 AM break reading "Afternoon restroom stop".
// Keeps the EARLIEST break in each half (by time); removes the rest. Non-break items untouched.
// ---------------------------------------------------------------------------
export function enforceBreaks(items) {
  const list = Array.isArray(items) ? items : [];
  const breaks = list
    .map((it, idx) => ({ it, idx, min: it && it.type === 'break' ? labelToMin(it.t) : -1 }))
    .filter(x => x.it && x.it.type === 'break' && x.min >= 0)
    .sort((a, b) => a.min - b.min);

  const morning = breaks.filter(b => b.min < BREAK_MORNING_CUTOFF);
  const afternoon = breaks.filter(b => b.min >= BREAK_MORNING_CUTOFF);
  const keepIdx = new Set([
    ...morning.slice(0, MAX_MORNING_BREAKS).map(b => b.idx),
    ...afternoon.slice(0, MAX_AFTERNOON_BREAKS).map(b => b.idx),
  ]);

  const removed = [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (it && it.type === 'break' && labelToMin(it.t) >= 0) {
      if (!keepIdx.has(i)) { removed.push({ t: it.t }); continue; }
      // kept break: normalize the note to the actual time
      out.push(Object.assign({}, it, { n: breakNoteForMin(labelToMin(it.t)) }));
    } else {
      out.push(it);
    }
  }
  return { items: out, removed };
}

// ---------------------------------------------------------------------------
// MEAL WINDOWS: no app-chosen meal inside a forbidden window (12-1, 5-6). Reservations are exempt.
// Moves a violating dining/quickservice item to the nearest allowed clean time. The caller passes
// isReserved(item) -> boolean (a reservation is a fixed point the guest chose).
// dayBounds optionally constrains where a meal may be moved: { startMin, endMin }.
// ---------------------------------------------------------------------------
export function enforceMealWindows(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const isReserved = typeof opts.isReserved === 'function' ? opts.isReserved : () => false;
  const bounds = opts.dayBounds || {};
  const moved = [];
  const out = list.map(it => {
    if (!it || (it.type !== 'dining' && it.type !== 'quickservice')) return it;
    if (isReserved(it)) return it; // reservations are the only exception
    const min = labelToMin(it.t);
    if (min < 0 || !isMealTimeForbidden(min)) return it;
    const newMin = nearestAllowedMealMin(min, {
      minBound: typeof bounds.startMin === 'number' ? bounds.startMin : 0,
      maxBound: typeof bounds.endMin === 'number' ? bounds.endMin : undefined,
    });
    if (newMin === null || newMin === min) return it;
    moved.push({ from: it.t, to: minToLabel(newMin), h: it.h });
    return Object.assign({}, it, { t: minToLabel(newMin) });
  });
  return { items: out, moved };
}
