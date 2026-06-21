// api/schedule-shows.js
// Deterministic, itinerary-aware nighttime SHOW + PARADE assignment.
//
// DATA / PHYSICS boundary (Beau's principle): this module owns only the no-repeat,
// park/time-feasible ASSIGNMENT of nighttime spectaculars and parades. The show
// CATALOG (names, parks, showtimes, fireworks cadence) is DATA from the cache
// (dynamicSections.SHOWS). A verified DEFAULT_SHOWS seed is carried as a FALLBACK
// ONLY -- exactly mirroring schedule-rules.js DEFAULT_ROPE_DROP_RANKING -- so the
// feature degrades gracefully when the cache section is absent. The assignment
// itself is pure + deterministic: scarcest-feasibility-first, spread across nights,
// no trip-wide repeats, up to 2 shows/night, fireworks only on a flagged fireworks
// night where the group is physically in that park at showtime.

import { whichParkAt, parseHourMin } from './schedule-engine.js';

// --- verified seed (FALLBACK only; cache SHOWS is the source of truth when present) ---
// Disneyland Resort 70th window (through ~Aug 2026). Showtimes are TYPICAL summer
// times; exact nightly times vary and are confirmed in-app day-of.
export const DEFAULT_SHOWS = {
  shows: [
    { name: 'World of Color - Happiness!', park: 'DCA', type: 'spectacular', showtimes: ['9:00 PM'] },
    { name: 'Fantasmic!',                  park: 'DL',  type: 'spectacular', showtimes: ['9:00 PM', '10:30 PM'] },
    { name: 'Wondrous Journeys',           park: 'DL',  type: 'fireworks',   showtimes: ['9:35 PM'] },
    { name: 'Paint the Night Parade',      park: 'DL',  type: 'parade',      showtimes: ['8:45 PM'] }
  ],
  // Fireworks cadence: nightly in peak summer, weekends (Fri-Sun) otherwise.
  // Verified: nightly @ 9:35 PM ~2026-05-22 through ~2026-08-09.
  fireworksRule: { summerNightlyStart: '2026-05-22', summerNightlyEnd: '2026-08-09' }
};

const EVENING_MIN = 17 * 60; // 1020 -- a nighttime show starts at/after 5 PM
const MIN_GAP = 45;          // two shows on one night must be >= 45 min apart

// Canonical name normalizer -- mirrors pretrip.html _normShow and v2 _normShowName EXACTLY
// so an inserted card compares equal to the canonical name stored for other days.
export function normShowName(h) {
  return String(h || '')
    .replace(/\s*\((Confirmed Reservation|Reservation)\)\s*/ig, ' ')
    .replace(/\s*[-\u2013\u2014]\s*(Dinner|Lunch|Breakfast)\s*$/i, '')
    .replace(/\s+(at|in)\s+(Disneyland|Disney California Adventure|DCA|California Adventure|Galaxy'?s Edge)\b.*$/i, '')
    .replace(/\s*[-\u2013\u2014:]\s*(Happiness!?|A Disney Spectacular|Nighttime Spectacular|The Musical)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Nighttime spectaculars/parades we STRIP from model output (includes outdated/improvised
// names the model invents). Daytime cavalcades are intentionally NOT matched.
const SHOW_STRIP_RX = /(world of color|fantasmic|wondrous journeys|disneyland forever|mickey'?s mix magic|magic happens|together forever|main street electrical parade|paint the night|tapestry of happiness|fireworks|nighttime spectacular)/i;

const MONTHS = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
function toISO(d) {
  const s = String(d || '');
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  const m2 = s.match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})/);
  if (m2) { const mm = MONTHS[m2[1].toLowerCase()]; if (mm) return m2[3] + '-' + mm + '-' + String(m2[2]).padStart(2, '0'); }
  return null;
}

export function isFireworksNight(dateISO, fireworksRule) {
  const iso = toISO(dateISO);
  if (!iso) return false;
  const rule = fireworksRule || DEFAULT_SHOWS.fireworksRule;
  if (rule.summerNightlyStart && rule.summerNightlyEnd && iso >= rule.summerNightlyStart && iso <= rule.summerNightlyEnd) return true;
  const dt = new Date(iso + 'T12:00:00Z');
  const dow = dt.getUTCDay(); // 0 Sun .. 6 Sat
  return dow === 0 || dow === 5 || dow === 6; // weekends only outside peak summer
}

// Best feasible showtime for a show on one day's blocks, or null.
// Feasible = at/after 5 PM, group is in the show's park at that minute, not inside VIP window.
// Prefers the EARLIEST feasible showtime.
function feasibleShowtime(show, day) {
  let best = null;
  for (const label of (show.showtimes || [])) {
    const min = parseHourMin(label);
    if (!min || min < EVENING_MIN) continue;
    if (whichParkAt(day.blocks, min) !== show.park) continue;
    if (day.vip && typeof day.vip.startMin === 'number' && min >= day.vip.startMin && min <= day.vip.endMin) continue;
    if (best === null || min < best.min) best = { label, min };
  }
  return best;
}

// MAIN: itinerary-aware no-repeat assignment.
// days: [{ dayIndex, dateISO, blocks, vip }]  (blocks already include any hop-back)
// returns { [dayIndex]: [ { name, park, type, t, min } ] }  (time-sorted per day)
export function assignShowsAcrossDays({ days, showsData, skipNames, wantNames }) {
  const data = (showsData && Array.isArray(showsData.shows) && showsData.shows.length) ? showsData : DEFAULT_SHOWS;
  const fireworksRule = data.fireworksRule || DEFAULT_SHOWS.fireworksRule;
  // SKIP = hard exclude from the pool (no backfill: fewer shows simply means fewer show-nights).
  // WANT = priority bump in assignment. No-repeat + spread are inherent (each pool show placed once).
  const _skipSet = new Set((skipNames || []).map(normShowName));
  const _wantSet = new Set((wantNames || []).map(normShowName));
  const _pool = (data.shows || []).filter(s => s && s.name && !_skipSet.has(normShowName(s.name)));
  const out = {};
  const dateByIdx = {};
  (days || []).forEach(d => { out[d.dayIndex] = []; dateByIdx[d.dayIndex] = toISO(d.dateISO) || ''; });

  // feasibility per show
  const feas = _pool.map(show => {
    const options = [];
    (days || []).forEach(d => {
      if (show.type === 'fireworks' && !isFireworksNight(d.dateISO, fireworksRule)) return;
      const st = feasibleShowtime(show, d);
      if (st) options.push({ dayIndex: d.dayIndex, min: st.min, label: st.label });
    });
    return { show, options };
  });

  // assign most-constrained first (fewest feasible nights), to the night with the FEWEST shows
  // so far (spread), ties by earliest date then earliest showtime.
  feas.sort((a, b) => ((_wantSet.has(normShowName(b.show.name)) ? 1 : 0) - (_wantSet.has(normShowName(a.show.name)) ? 1 : 0)) || (a.options.length - b.options.length) || a.show.name.localeCompare(b.show.name));
  feas.forEach(({ show, options }) => {
    const cands = options
      .filter(o => out[o.dayIndex].length < 2)
      .filter(o => out[o.dayIndex].every(s => Math.abs(s.min - o.min) >= MIN_GAP))
      .sort((x, y) =>
        (out[x.dayIndex].length - out[y.dayIndex].length) ||
        (dateByIdx[x.dayIndex] < dateByIdx[y.dayIndex] ? -1 : dateByIdx[x.dayIndex] > dateByIdx[y.dayIndex] ? 1 : 0) ||
        (x.min - y.min)
      );
    if (cands.length) {
      const p = cands[0];
      out[p.dayIndex].push({ name: show.name, park: show.park, type: show.type, t: p.label, min: p.min });
    }
  });

  Object.keys(out).forEach(k => out[k].sort((a, b) => a.min - b.min));
  return out;
}

// Apply assignment to a day's parsed items: strip model nighttime show/parade cards,
// insert the assigned ones as type:'show', time-sorted.
export function applyShowAssignment(parsed, assignedForDay) {
  const items = Array.isArray(parsed) ? parsed.slice() : [];
  const assigned = Array.isArray(assignedForDay) ? assignedForDay : [];
  const stripped = [];
  const kept = items.filter(it => {
    if (!it) return false;
    const isShowType = it.type === 'show';
    const looksLikeShow = SHOW_STRIP_RX.test(String(it.h || ''));
    if ((isShowType || looksLikeShow) && it.type !== 'dining') { stripped.push({ t: it.t, h: it.h, type: it.type }); return false; }
    return true;
  });
  const TAIL = {
    fireworks:   ' Stake out a viewing spot about 20 minutes early; showtimes shift night to night, so confirm the exact time in the app tonight.',
    spectacular: ' Grab a good viewing spot about 20 minutes early; showtimes shift night to night, so confirm the exact time in the app tonight.',
    parade:      ' Find a curbside spot about 15 minutes early along the route; step-off can shift, so confirm the exact time in the app tonight.'
  };
  const inserted = [];
  assigned.forEach(s => {
    const lead = (s.type === 'parade')
      ? s.name + ' lights up the parade route -- a signature night of the trip.'
      : s.name + ' is the nighttime spectacular tonight.';
    kept.push({ t: s.t, h: s.name, type: 'show', n: lead + (TAIL[s.type] || TAIL.spectacular) });
    inserted.push({ t: s.t, h: s.name });
  });
  kept.sort((a, b) => {
    const ma = a && a.t ? parseHourMin(a.t) : 100000;
    const mb = b && b.t ? parseHourMin(b.t) : 100000;
    return ma - mb;
  });
  return { parsed: kept, stripped, inserted };
}
