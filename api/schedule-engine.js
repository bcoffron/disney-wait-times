// api/schedule-engine.js
// Pure schedule physics functions — no imports, no network, fully unit-testable.
// ESM module (package.json "type":"module"). Verify with: node --check api/schedule-engine.js

// ---------------------------------------------------------------------------
// parseHourMin
// Converts a 12-hour time string to minutes-since-midnight.
// "8:00 AM"  -> 480
// "11:00 PM" -> 1380
// "12:00 AM" -> 1440  (midnight closing time, treated as end-of-day)
// "12:00 PM" -> 720   (noon)
// ---------------------------------------------------------------------------
export function parseHourMin(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const pm = m[3].toUpperCase() === 'PM';
  // 12-hour -> 24-hour conversion
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;   // 12:xx AM -> 0:xx (midnight start)
  const result = h * 60 + min;
  // Special case: midnight closing time is represented as 1440 (end of day),
  // not 0 (start of day). If result === 0 and original was "12:xx AM", return 1440.
  if (result === 0 && m[3].toUpperCase() === 'AM' && parseInt(m[1], 10) === 12) {
    return 1440;
  }
  return result;
}

// ---------------------------------------------------------------------------
// parseParkHoursForDate
// Reads the PARK_HOURS structured array already in the cache.
// Each element has shape: { dl: "8:00 AM   12:00 AM", dca: "8:00 AM   10:00 PM", note: "..." }
// Times are separated by MULTIPLE SPACES (not a dash). Split on /\s{2,}|\s+-\s+/ and
// take the first token as open time and the last token as close time.
// Returns { DL: { openMin, closeMin }, DCA: { openMin, closeMin } } for the given dayIndex.
// Returns null if the day is not found or the array is empty/invalid.
// ---------------------------------------------------------------------------
export function parseParkHoursForDate(parkHoursArray, dayIndex) {
  if (!Array.isArray(parkHoursArray) || dayIndex < 0 || dayIndex >= parkHoursArray.length) {
    return null;
  }
  const day = parkHoursArray[dayIndex];
  if (!day) return null;

  function parseField(raw) {
    if (!raw || typeof raw !== 'string') return { openMin: 0, closeMin: 0 };
    // Split on 2+ spaces or " - " separator
    const parts = raw.trim().split(/\s{2,}|\s+-\s+/).map(s => s.trim()).filter(s => s.length > 0);
    if (parts.length < 2) {
      // Try splitting on single space boundary between AM/PM and next digit
      // e.g. "8:00 AM 10:00 PM" — fallback: match all time tokens
      const tokens = raw.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/gi);
      if (!tokens || tokens.length < 2) return { openMin: 0, closeMin: 0 };
      return {
        openMin:  parseHourMin(tokens[0]),
        closeMin: parseHourMin(tokens[tokens.length - 1])
      };
    }
    return {
      openMin:  parseHourMin(parts[0]),
      closeMin: parseHourMin(parts[parts.length - 1])
    };
  }

  return {
    DL:  parseField(day.dl  || day.DL  || ''),
    DCA: parseField(day.dca || day.DCA || '')
  };
}

// ---------------------------------------------------------------------------
// deriveBlocks
// Converts a dayIntent + resolved park hours into time blocks.
//
// dayIntent: {
//   startPark: "DL" | "DCA",
//   hop:  { toPark: "DL"|"DCA", atMin: number } | null,
//   vip:  { startMin: number, endMin: number }   | null
// }
//
// VIP does NOT change park blocks — it is a time overlay handled later.
//
// Returns:
//   no hop: [ { park, startMin, endMin } ]           (1 block: open -> close)
//   hop:    [ { park:startPark, startMin:open, endMin:hop.atMin },
//             { park:hop.toPark, startMin:hop.atMin, endMin:close2 } ]
// ---------------------------------------------------------------------------
export function deriveBlocks(dayIntent, parkHoursForDate) {
  const startPark = (dayIntent && dayIntent.startPark) ? String(dayIntent.startPark).toUpperCase() : 'DL';
  const hop = (dayIntent && dayIntent.hop && typeof dayIntent.hop === 'object' && dayIntent.hop.toPark && dayIntent.hop.atMin != null)
    ? dayIntent.hop
    : null;

  const hours = parkHoursForDate || { DL: { openMin: 480, closeMin: 1260 }, DCA: { openMin: 480, closeMin: 1320 } };
  const startHours = hours[startPark] || { openMin: 480, closeMin: 1260 };

  if (!hop) {
    // Single-park day
    return [{
      park:     startPark,
      startMin: startHours.openMin,
      endMin:   startHours.closeMin
    }];
  }

  // Hop: two blocks
  const toPark = String(hop.toPark).toUpperCase();
  const atMin  = Number(hop.atMin);
  const toHours = hours[toPark] || { openMin: 480, closeMin: 1260 };

  return [
    { park: startPark, startMin: startHours.openMin, endMin:   atMin },
    { park: toPark,    startMin: atMin,               endMin:   toHours.closeMin }
  ];
}

// ---------------------------------------------------------------------------
// whichParkAt
// Returns the park name for a given minute by scanning the blocks array.
// Clamps to the last block if min is past its endMin.
// ---------------------------------------------------------------------------
export function whichParkAt(blocks, min) {
  if (!blocks || blocks.length === 0) return 'DL';
  for (let i = 0; i < blocks.length; i++) {
    if (min < blocks[i].endMin) return blocks[i].park;
  }
  // Past all block ends — clamp to last block
  return blocks[blocks.length - 1].park;
}

// ---------------------------------------------------------------------------
// buildCatalogFilter
// Filters catalog attractions and venues for a specific park.
// CRITICAL: venues with exclude === true are always dropped (e.g. Magic Key Terrace).
// ---------------------------------------------------------------------------
export function buildCatalogFilter(catalog, park) {
  if (!catalog || typeof park !== 'string') {
    return { attractions: [], venues: [] };
  }
  const p = park.toUpperCase();
  // An attraction is OPERATING unless its catalog `status` is set to a non-operating value.
  // Closed/refurb rides (e.g. status 'closed_for_refurbishment') must NEVER become candidates --
  // recommending a closed ride is a trust-breaking error. Treat any status that isn't explicitly
  // open/operating as closed, so future refurbs the cache adds are excluded with no code change.
  const isOperating = a => {
    const st = a && a.status ? String(a.status).toLowerCase().trim() : '';
    if (!st) return true;
    return st === 'open' || st === 'operating' || st === 'operational';
  };
  return {
    attractions: (catalog.attractions || []).filter(a => a && String(a.park).toUpperCase() === p && a.exclude !== true && isOperating(a)),
    venues:      (catalog.venues      || []).filter(v => v && String(v.park).toUpperCase() === p && v.exclude !== true)
  };
}
