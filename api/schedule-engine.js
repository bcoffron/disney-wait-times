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
// Normalize an attraction name for matching against closure-override entries.
function normAttr(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// Parse a date that may be ISO ('2026-06-26') or a display string ('Jun 28, 2026') into a
// comparable number YYYYMMDD (e.g. 20260626), or null if unparseable. Used for closure date math.
function toComparableDate(d) {
  if (!d) return null;
  const s = String(d).trim();
  // ISO yyyy-mm-dd (optionally with time)
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Number(m[1] + m[2] + m[3]);
  // Display 'Mon DD, YYYY' / 'Month DD YYYY'
  const MON = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const mm = MON[m[1].toLowerCase()];
    if (mm) return Number(m[3] + mm + (m[2].length === 1 ? '0' + m[2] : m[2]));
  }
  // Last resort: Date.parse
  const t = Date.parse(s);
  if (!isNaN(t)) {
    const dt = new Date(t);
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return Number('' + dt.getUTCFullYear() + mm + dd);
  }
  return null;
}

// DATE-AWARE AVAILABILITY (physics): is this attraction open on the trip day?
// A ride is AVAILABLE unless it is closed THROUGH the trip date.
//   - effective status/reopen come from the closureOverrides map (fresh, weekly CLOSURES) when present,
//     else from the attraction's own catalog fields (monthly CATALOG status/reopenDate).
//   - operating status  -> available.
//   - closed, no reopen date / confidence 'unknown' -> NOT available (we can't promise it opens).
//   - closed WITH a reopenDate on/before the trip day -> available IF confidence is 'confirmed' or
//     'rumored' (the caller has chosen to show rumored reopenings); 'unknown' stays hidden.
//   - closed WITH a reopenDate AFTER the trip day -> NOT available (still closed when we visit).
// tripDate is an ISO 'YYYY-MM-DD' string for the day being built; when absent, fall back to the
// old behavior (operating status only) so callers that don't pass a date are unchanged.
export function isAttractionAvailable(attraction, tripDate, closureOverrides) {
  const a = attraction || {};
  // resolve effective closure info: override map wins over catalog fields
  let status = a.status, reopenDate = a.reopenDate, reopenConfidence = a.reopenConfidence;
  if (closureOverrides) {
    const ov = closureOverrides[normAttr(a.name)];
    if (ov) {
      status = ov.status != null ? ov.status : status;
      reopenDate = ov.reopenDate != null ? ov.reopenDate : reopenDate;
      reopenConfidence = ov.reopenConfidence != null ? ov.reopenConfidence : reopenConfidence;
    }
  }
  const st = status ? String(status).toLowerCase().trim() : '';
  const operating = !st || st === 'open' || st === 'operating' || st === 'operational';
  if (operating) return true;
  // closed in some form from here on
  if (!tripDate) return false; // no date context -> conservative (old behavior): closed = hidden
  if (!reopenDate) return false; // closed, no known reopen -> hidden
  const conf = reopenConfidence ? String(reopenConfidence).toLowerCase().trim() : 'unknown';
  if (conf === 'unknown') return false; // closed with a date we don't trust -> hidden
  // available if it reopens on or before the trip day (parse both ISO and display date formats)
  const rd = toComparableDate(reopenDate);
  const td = toComparableDate(tripDate);
  if (rd == null || td == null) return false; // can't compare dates reliably -> stay hidden (conservative)
  return rd <= td;
}

export function buildCatalogFilter(catalog, park, tripDate, closureOverrides) {
  if (!catalog || typeof park !== 'string') {
    return { attractions: [], venues: [] };
  }
  const p = park.toUpperCase();
  return {
    attractions: (catalog.attractions || []).filter(a =>
      a && String(a.park).toUpperCase() === p && a.exclude !== true
        && isAttractionAvailable(a, tripDate, closureOverrides)),
    venues:      (catalog.venues      || []).filter(v => v && String(v.park).toUpperCase() === p && v.exclude !== true)
  };
}

// ---------------------------------------------------------------------------
// appendEveningHopBack
// Park-hopper optimization (PHYSICS-adjacent, additive): a guest with hoppers should END the day in
// the park that closes LATEST. When the configured single hop leaves them in the EARLIER-closing
// park for the evening (e.g. DL morning -> DCA afternoon, but DCA closes 10pm while DL is open until
// midnight), append a final block that hops them BACK to the later-closing park for the late night.
// Without this, the day correctly fills only to the earlier park's close and ends ~30 min before
// that -- hours before the resort actually closes.
//
// Rule: if the start park (the one they'd hop back to) closes >= minGap minutes LATER than the park
// the last block ends in, append { park: startPark, startMin: <end of last block>, endMin:
// startParkClose, hopBack: true }. Otherwise return blocks unchanged. Only applies to 2-park hop
// days; single-park days and days that already end in the later-closing park are untouched.
//
// Pure. Does not mutate the input array. parkHoursForDate is the { DL:{closeMin}, DCA:{closeMin} }
// shape from parseParkHoursForDate; when absent, returns blocks unchanged (no hop-back guessed).
export function appendEveningHopBack(blocks, parkHoursForDate, opts) {
  const minGap = (opts && typeof opts.minGapMin === 'number') ? opts.minGapMin : 60;
  if (!Array.isArray(blocks) || blocks.length < 2) return blocks;       // single-park day: nothing to do
  if (!parkHoursForDate) return blocks;                                  // unknown hours: don't guess
  const startPark = blocks[0].park;
  const last = blocks[blocks.length - 1];
  const lastPark = last.park;
  if (startPark === lastPark) return blocks;                             // already ends where it started
  const startClose = (parkHoursForDate[startPark] || {}).closeMin;
  const endParkClose = (parkHoursForDate[lastPark] || {}).closeMin;
  if (typeof startClose !== 'number' || typeof endParkClose !== 'number') return blocks;
  if (startClose <= endParkClose + minGap) return blocks;                // end park closes last (or close enough): keep as-is
  // hop back to the later-closing start park for the remaining evening
  return blocks.concat([{ park: startPark, startMin: last.endMin, endMin: startClose, hopBack: true }]);
}
