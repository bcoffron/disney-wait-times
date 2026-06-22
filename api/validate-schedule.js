// api/validate-schedule.js
// Post-generation schedule validator â structural rules enforced in code
// Called after every generation and before every save

import { normRideName } from './schedule-rules.js';

function timeToMinutes(t) {
  if (!t) return -1;
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return -1;
  let h = parseInt(m[1]), mn = parseInt(m[2]);
  const pm = m[3].toUpperCase() === 'PM';
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return h * 60 + mn;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const displayH = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return displayH + ':' + String(m).padStart(2, '0') + ' ' + period;
}

// Normalize a ride title for dedup matching: strip "Rope Drop:" / em-dash prefixes and
// "(LL...)" / "(Night Ride)" suffixes, then normRideName() (which also bridges the
// "Star Wars: Rise" == "Rise" alias) collapses the rest. Mirrors the generator's cleanRideName
// so the save-time validator and the v2 engine treat ride identity identically.
function cleanRideName(h) {
  return String(h || '')
    .replace(/^rope drop\s*[\u2014-]\s*/i, '')
    .replace(/^rope drop[^:]*:\s*/i, '')
    .replace(/\s*\((ll|lightning)[^)]*\)\s*$/i, '')
    .replace(/\s*\(night[^)]*\)\s*$/i, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// Fallback hardcoded closures — used only if cache is unavailable
// When cache CURRENT_CLOSURES is passed in at call time, it overrides this list
const CLOSED_ATTRACTIONS_FALLBACK = [
  // Last-resort fallback, used ONLY when no live closures are passed to validateSchedule.
  // The live CLOSURES cache (date-aware, with reopen dates) is the real source of truth.
  // Keep ONLY attractions genuinely closed for the trip window. Pirates (reopened 6/26),
  // Buzz (6/12) and Inside Out (6/17) are OPEN -- leaving them here deleted open rides on save.
  'Silly Symphony Swings'
];

// LAND -> PARK map for park-presence enforcement.
// DCA lands and DL lands. Lowercased substring match against item.land (and item.h as fallback).
const DCA_LANDS = ['cars land','cozy cone','radiator springs','pixar pier','paradise gardens','incredicoaster','avengers campus','grizzly peak','san fransokyo','hollywood land','buena vista street','pacific wharf','pixar pal'];
const DL_LANDS = ['main street','adventureland','new orleans square','frontierland','bayou country','critter country','fantasyland','mickey','toontown','tomorrowland','galaxy','star wars','pixie hollow'];
function landToPark(land) {
  const s = (land || '').toLowerCase();
  if (!s) return null;
  for (const k of DCA_LANDS) { if (s.indexOf(k) !== -1) return 'DCA'; }
  for (const k of DL_LANDS) { if (s.indexOf(k) !== -1) return 'DL'; }
  return null; // unknown land -> don't flag
}
// Hotel / Downtown Disney dining (OUTSIDE the parks) - never an in-park meal unless user-reserved.
const HOTEL_DTD_VENUES = ['goofy\'s kitchen','storytellers cafe','storytellers','napa rose','steakhouse 55','disney\'s pch grill','pch grill','gch craftsman','craftsman grill','tangaroa terrace','ballast point','trader sam','catal','naples ristorante','naples','splitsville','black tap','tortilla jo','salt & straw','salt and straw','earl of sandwich','ralph brennan','jazz kitchen','la brea bakery','wetzel','sprinkles','marceline','centrico','paseo','ballast'];
function isHotelOrDtdVenue(name) {
  const s = (name || '').toLowerCase();
  if (!s) return false;
  return HOTEL_DTD_VENUES.some(v => s.indexOf(v) !== -1);
}
function normPark(p) {
  const s = (p || '').toLowerCase();
  if (s.indexOf('california') !== -1 || s.indexOf('dca') !== -1 || s.indexOf('adventure') !== -1) return 'DCA';
  if (s.indexOf('disneyland') !== -1 || s === 'dl') return 'DL';
  return null;
}

// Parse ride names out of a CURRENT_CLOSURES cache text block
function parseClosedFromCache(closuresText) {
  if (!closuresText || typeof closuresText !== 'string') return null;
  const rides = [];
  const lines = closuresText.split('\n');
  lines.forEach(line => {
    // Match lines that name an attraction — look for known patterns
    // e.g. "- Pirates of the Caribbean (DL) — closed..."
    // or "Pirates of the Caribbean: closed..."
    const m = line.match(/^[-*•]?\s*([A-Z][^:(—\-]+?)(?:\s*\((?:DL|DCA)\))?\s*(?:—|-|:)/);
    if (m) {
      const name = m[1].trim();
      if (name.length > 4 && !name.toLowerCase().includes('note') && !name.toLowerCase().includes('check')) {
        rides.push(name);
      }
    }
  });
  return rides.length > 0 ? rides : null;
}

const VEG_DEFAULTS = {
  'jolly holiday': 'Veggie Sandwich with hummus and roasted vegetables',
  'stage door': 'Garden Salad with vinaigrette',
  'river belle': 'Plant-Based Ratatouille with seasonal vegetables',
  'rancho del zocalo': 'Cheese Enchiladas with salsa verde',
  'cafe orleans': 'Corn and Brie Tamale with roasted corn salsa',
  'galactic grill': 'Veggie Burger with fries',
  'alien pizza': 'Cheese Flatbread Pizza with marinara',
  'pym': 'Shawarma Falafel Pita with tahini',
  'lucky fortune': 'Tofu Stir Fry with fried rice',
  'cocina cucamonga': 'Cheese Quesadilla with guacamole',
  'pacific wharf': 'Tomato Basil Soup in a Sourdough Bread Bowl',
  'hungry bear': 'Garden Salad with ranch dressing',
  'bengal barbecue': 'Vegetable Skewer with dipping sauce',
  'smokejumpers': 'Garden Burger with fries'
};

const KIDS_DEFAULTS = {
  'jolly holiday': 'Kids PB&J Sandwich with apple slices',
  'stage door': 'Kids Chicken Tenders with applesauce',
  'river belle': 'Mac and Cheese Kids Plate',
  'rancho del zocalo': 'Kids Cheese Quesadilla with apple slices',
  'cafe orleans': 'Kids Grilled Cheese with seasonal fruit',
  'galactic grill': 'Kids Grilled Cheese with fries',
  'alien pizza': 'Kids Cheese Pizza with applesauce',
  'pym': 'Kids Chicken Shawarma Wrap',
  'lucky fortune': 'Chicken Teriyaki Kids Bowl',
  'cocina cucamonga': 'Kids Chicken Taco with rice',
  'pacific wharf': 'Kids Grilled Cheese Sandwich with seasonal fruit',
  'hungry bear': 'Kids Corn Dog Nuggets with applesauce',
  'bengal barbecue': 'Kids Chicken Skewer with rice',
  'smokejumpers': 'Kids Corn Dog with applesauce'
};

function getVegDefault(h, itemTime) {
  const lower = (h || '').toLowerCase();
  const timeMin = timeToMinutes(itemTime || '12:00 PM');
  const isMorning = timeMin >= 0 && timeMin < 660;
  if (lower.includes('jolly holiday')) {
    return isMorning
      ? 'Oatmeal with seasonal berries and brown sugar'
      : 'Veggie Sandwich with hummus and roasted vegetables';
  }
  for (const key of Object.keys(VEG_DEFAULTS)) {
    if (lower.includes(key)) return VEG_DEFAULTS[key];
  }
  return 'Garden Salad with seasonal vegetables';
}

function getKidsDefault(h, itemTime) {
  const lower = (h || '').toLowerCase();
  const timeMin = timeToMinutes(itemTime || '12:00 PM');
  const isMorning = timeMin >= 0 && timeMin < 660;
  if (lower.includes('jolly holiday')) {
    return isMorning
      ? 'Kids Mickey Waffle with maple syrup'
      : 'Kids PB&J Sandwich with apple slices';
  }
  for (const key of Object.keys(KIDS_DEFAULTS)) {
    if (lower.includes(key)) return KIDS_DEFAULTS[key];
  }
  return 'Kids Grilled Cheese with seasonal fruit';
}

// Known park close times in minutes since midnight â D1, D2, D3
const PARK_CLOSE = [24 * 60, 23 * 60, 22 * 60];

// LL-return detection: matches "X (LLMP Return)", "X (Lightning Lane Return)", "X - Lightning Lane Return", "X LL Return", etc.
function llReturnBaseName(h) {
  const s = (h || '');
  if (!/(ll|llmp|lightning lane)\s*return/i.test(s)) return null;
  // strip the LL-return suffix/parenthetical to get the base ride name
  let base = s
    .replace(/\s*\((?:llmp|ll|lightning lane)\s*return\)\s*/i, '')
    .replace(/\s*[-\u2013\u2014]\s*(?:llmp|ll|lightning lane)\s*return\s*/i, '')
    .replace(/\s*(?:llmp|ll|lightning lane)\s*return\s*/i, '')
    .trim();
  return base.toLowerCase();
}

function validateSchedule(schedule, tripConfig, closedAttractionsFromCache, priorDining) {
  const corrections = [];
  const hardViolations = [];

  // Build the authoritative closed list:
  // Cache-derived list takes priority. Fallback if cache unavailable.
  const cacheClosures = closedAttractionsFromCache && closedAttractionsFromCache.length
    ? closedAttractionsFromCache : null;
  const CLOSED_ATTRACTIONS = cacheClosures || CLOSED_ATTRACTIONS_FALLBACK;

  if (!schedule || !Array.isArray(schedule.days)) {
    return { valid: true, schedule, corrections, hardViolations };
  }

  const days = schedule.days;

  days.forEach((day, idx) => {
    const dayNum = idx + 1;
    let items = Array.isArray(day.items) ? day.items : [];

    const isVipDay = tripConfig &&
      tripConfig.days &&
      tripConfig.days[idx] &&
      tripConfig.days[idx].isVip === true;

    // RULE 1: Empty or boolean veg/kids/topPick on QS and dining cards
    items.forEach(item => {
      if (item.type !== 'quickservice' && item.type !== 'dining') return;

      if (!item.veg || item.veg.trim().length === 0 ||
          item.veg === 'true' || item.veg === 'false') {
        item.veg = getVegDefault(item.h, item.t);
        corrections.push({ rule: 'veg-empty', day: dayNum, item: item.h, action: 'set to: ' + item.veg });
      }

      if (!item.kids || item.kids.trim().length === 0 ||
          item.kids === 'true' || item.kids === 'false') {
        item.kids = getKidsDefault(item.h, item.t);
        corrections.push({ rule: 'kids-empty', day: dayNum, item: item.h, action: 'set to: ' + item.kids });
      }

      if (item.topPick === true || item.topPick === false ||
          item.topPick === 'true' || item.topPick === 'false') {
        delete item.topPick;
        corrections.push({ rule: 'bool-topPick', day: dayNum, item: item.h, action: 'deleted boolean value' });
      // Set morning-appropriate topPick default for Jolly Holiday
      if (!item.topPick && (item.h || '').toLowerCase().includes('jolly holiday')) {
        const timeMin = timeToMinutes(item.t || '12:00 PM');
        const isMorning = timeMin >= 0 && timeMin < 660;
        item.topPick = isMorning
          ? 'Butter Croissant with fresh fruit cup'
          : 'Caprese Sandwich on Focaccia with Pesto';
        corrections.push({ rule: 'jolly-holiday-topPick', day: dayNum, item: item.h, action: 'set to: ' + item.topPick });
      }
      }
    });

    // RULE 2: Snack within 90 minutes of a meal
    const mealMins = items
      .filter(i => i.type === 'quickservice' || i.type === 'dining')
      .map(i => timeToMinutes(i.t))
      .filter(m => m >= 0);

    items.forEach(item => {
      if (item.type !== 'snack') return;
      const snackMin = timeToMinutes(item.t);
      if (snackMin < 0) return;

      const tooClose = mealMins.some(mt => Math.abs(mt - snackMin) < 90);
      if (tooClose) {
        const isMorning = snackMin < 12 * 60;
        const primaryTime = isMorning ? '9:30 AM' : '2:30 PM';
        const primaryMin = timeToMinutes(primaryTime);
        const primaryOk = !mealMins.some(mt => Math.abs(mt - primaryMin) < 90);

        if (primaryOk) {
          corrections.push({ rule: 'snack-timing', day: dayNum, item: item.h,
            action: 'moved from ' + item.t + ' to ' + primaryTime });
          item.t = primaryTime;
        } else {
          const fallbackMin = timeToMinutes('3:00 PM');
          const fallbackOk = !mealMins.some(mt => Math.abs(mt - fallbackMin) < 90);
          if (fallbackOk) {
            corrections.push({ rule: 'snack-timing', day: dayNum, item: item.h,
              action: 'moved from ' + item.t + ' to 3:00 PM (fallback)' });
            item.t = '3:00 PM';
          }
        }
      }
    });

    // RULE 3: Closed attractions in ride cards
    items.forEach(item => {
      if (item.type !== 'ride') return;
      const isClosed = CLOSED_ATTRACTIONS.some(name => (item.h || '').includes(name));
      if (isClosed) {
        corrections.push({ rule: 'closed-attraction', day: dayNum,
          item: item.h, action: 'removed â currently closed' });
        item._remove = true;
      }
    });
    day.items = items.filter(i => !i._remove);
    items = day.items;

    // RULE 4: Morning snack required (non-VIP days only)
    if (!isVipDay) {
      // (Morning-snack dedup handled by Rule 9q final cleanup, which keeps the venue-named one.)
      // (Afternoon-snack dedup handled by Rule 9q final cleanup, which keeps the venue-named one.)
      // Remove consecutive snack + break or break + snack (within 30 minutes of each other)
      for (let ci = 0; ci < items.length - 1; ci++) {
        const curr = items[ci];
        const next = items[ci + 1];
        if (!curr || !next) continue;
        const currIsSnackOrBreak = curr.type === 'snack' || curr.type === 'break';
        const nextIsSnackOrBreak = next.type === 'snack' || next.type === 'break';
        if (currIsSnackOrBreak && nextIsSnackOrBreak) {
          const gap = timeToMinutes(next.t) - timeToMinutes(curr.t);
          if (gap <= 30) {
            // Remove the break (keep the snack)
            const toRemove = curr.type === 'break' ? ci : ci + 1;
            corrections.push({ rule: 'consecutive-snack-break', day: dayNum, item: items[toRemove].h, action: 'removed consecutive snack/break within 30 min' });
            items.splice(toRemove, 1);
            day.items = items;
            ci--; // recheck this position
          }
        }
      }
      const morningSnacks = items.filter(i => {
        const m = timeToMinutes(i.t);
        return i.type === 'snack' && m >= 540 && m <= 630;
      });
      if (morningSnacks.length === 0) {
        const morningRides = items
          .filter(i => i.type === 'ride' && timeToMinutes(i.t) < 660)
          .sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));

        let insertTime = '9:30 AM';
        if (morningRides.length >= 2) {
          const after2nd = timeToMinutes(morningRides[1].t) + 15;
          if (after2nd >= 540 && after2nd <= 630) {
            insertTime = minutesToTime(after2nd);
          }
        }
        const snackCard = {
          t: insertTime,
          h: 'Morning Snack',
          type: 'snack',
          n: 'Quick grab-and-go snack to fuel the group. Pick up something from a nearby cart or stand.'
        };
        items.push(snackCard);
        items.sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));
        day.items = items;
        corrections.push({ rule: 'morning-snack-missing', day: dayNum,
          action: 'inserted morning snack at ' + insertTime });
      }
    }

    // RULE 5: Restroom breaks required (non-VIP days only)
    if (!isVipDay) {
      // Remove extra morning breaks — max 1 before noon
      const morningBreakItems = items.filter(i => i.type === 'break' && timeToMinutes(i.t) < 720);
      if (morningBreakItems.length > 1) {
        let kept = false;
        items = items.filter(i => {
          if (i.type === 'break' && timeToMinutes(i.t) < 720) {
            if (!kept) { kept = true; return true; }
            corrections.push({ rule: 'duplicate-morning-break', day: dayNum, item: i.h, action: 'removed duplicate morning break' });
            return false;
          }
          return true;
        });
        day.items = items;
      }
      // Remove extra afternoon breaks — max 1 after noon
      const afternoonBreakItems = items.filter(i => i.type === 'break' && timeToMinutes(i.t) >= 720);
      if (afternoonBreakItems.length > 1) {
        let kept = false;
        items = items.filter(i => {
          if (i.type === 'break' && timeToMinutes(i.t) >= 720) {
            if (!kept) { kept = true; return true; }
            corrections.push({ rule: 'duplicate-afternoon-break', day: dayNum, item: i.h, action: 'removed duplicate afternoon break' });
            return false;
          }
          return true;
        });
        day.items = items;
      }
      const morningBreaks = items.filter(i =>
        i.type === 'break' && timeToMinutes(i.t) >= 0 && timeToMinutes(i.t) < 720
      );
      if (morningBreaks.length === 0) {
        const rides = items.filter(i => i.type === 'ride')
          .sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));
        const insertAfter = rides[2] || rides[rides.length - 1];
        const insertMin = insertAfter ? timeToMinutes(insertAfter.t) + 20 : 570;
        const breakCard = {
          t: minutesToTime(insertMin),
          h: 'Restroom Break',
          type: 'break',
          n: 'Quick restroom stop. Facilities are nearby.'
        };
        items.push(breakCard);
        items.sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));
        day.items = items;
        corrections.push({ rule: 'morning-break-missing', day: dayNum,
          action: 'inserted morning break at ' + minutesToTime(insertMin) });
      }

      const afternoonBreaks = items.filter(i => {
        const m = timeToMinutes(i.t);
        return i.type === 'break' && m >= 780 && m <= 960;
      });
      if (afternoonBreaks.length === 0) {
        const rides = items.filter(i => i.type === 'ride')
          .sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));
        const insertAfter = rides[5] || rides[rides.length - 1];
        const insertMin = insertAfter ? timeToMinutes(insertAfter.t) + 20 : 870;
        const breakCard = {
          t: minutesToTime(insertMin),
          h: 'Restroom Break',
          type: 'break',
          n: 'Afternoon restroom stop. Good time for the group to regroup before the evening.'
        };
        items.push(breakCard);
        items.sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));
        day.items = items;
        corrections.push({ rule: 'afternoon-break-missing', day: dayNum,
          action: 'inserted afternoon break at ' + minutesToTime(insertMin) });
      }

      // Normalize break NOTE wording to match the break's actual time. The model sometimes writes an
      // "Afternoon restroom stop..." note on a 10 AM break (mislabeled). This runs on every break (model-
      // authored or validator-inserted) so the wording always matches the clock. Only rewrites the note;
      // leaves the title ("Restroom Break") and timing untouched.
      items.forEach(i => {
        if (i.type !== 'break') return;
        const m = timeToMinutes(i.t);
        if (m < 0) return;
        let note;
        if (m < 720) note = 'Quick morning restroom stop. Facilities are nearby.';
        else if (m < 1020) note = 'Afternoon restroom stop. A good moment to regroup before the evening.';
        else note = 'Evening restroom stop. Facilities are nearby.';
        if (i.n !== note) {
          i.n = note;
          corrections.push({ rule: 'break-note-time-label', day: dayNum, item: i.h,
            action: 'normalized break note to match ' + i.t });
        }
      });
      day.items = items;
    }

    // RULE 7: Schedule ends too early â soft warning
    const sortedItems = [...items].sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));
    const last = sortedItems[sortedItems.length - 1];
    const lastMin = last ? timeToMinutes(last.t) : -1;
    const fallbackClose = PARK_CLOSE[idx] !== undefined ? PARK_CLOSE[idx] : 22 * 60;
    const effectiveClose = (typeof day.latestCloseMin === 'number' && day.latestCloseMin > 0)
      ? day.latestCloseMin
      : ((typeof day.closeMin === 'number' && day.closeMin > 0) ? day.closeMin : fallbackClose);
    const realLast = [...items]
      .filter(i => ['ride','show','dining','quickservice','snack','character','vip'].indexOf(i.type) !== -1)
      .sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t)).pop();
    const realLastMin = realLast ? timeToMinutes(realLast.t) : lastMin;
    if (realLastMin >= 0 && realLastMin < effectiveClose - 60) {
      corrections.push({
        rule: 'ends-early',
        day: dayNum,
        action: 'flagged (non-blocking)',
 var _fp = normPark(day.finalPark) || ((_ih && _ih.toPark) ? normPark(_ih.toPark) || _sp : ((_dc && _dc.hopTo) ? normPark(_dc.hopTo) || _sp : _sp));       detail: 'Last activity ' + (realLast ? ('"' + realLast.h + '" at ' + realLast.t) : '?') +
          ' but park open until ' + minutesToTime(effectiveClose) +
          ' (underfilled by ~' + Math.round((effectiveClose - realLastMin) / 60) + ' hr); fill evening to ~30 min before close' +
          ((day.latestCloseMin && day.closeMin && day.latestCloseMin > day.closeMin) ? ' (late hop to later-closing park available)' : '') + '.'
      });
    }
    // Rule 7b: Fill-to-close (universal, all days including park-hop).
    // Determines the final active park after all hops and fills the evening
    // with ride cards until ~30 min before that park's close time.
    // Unique rides from the pool drawn first; re-rides allowed once pool exhausted.
    try {
      if (!isVipDay) {
        var _dc = (tripConfig && tripConfig.days && tripConfig.days[idx]) || null;
        var _ih = _dc && _dc.intent && _dc.intent.hop;
        var _sp = normPark(day.park) || 'DL';
        var _fp = _sp;
        if (_ih && _ih.toPark) _fp = normPark(_ih.toPark) || _sp;
        else if (_dc && _dc.hopTo) _fp = normPark(_dc.hopTo) || _sp;
        var _fc = (_fp === 'DCA')
          ? ((typeof day.dcaCloseMin === 'number' && day.dcaCloseMin > 0) ? day.dcaCloseMin
            : (_sp === 'DCA' && typeof day.closeMin === 'number' ? day.closeMin : 22 * 60))
          : ((typeof day.dlCloseMin === 'number' && day.dlCloseMin > 0) ? day.dlCloseMin
            : (_sp === 'DL' && typeof day.closeMin === 'number' ? day.closeMin
              : (typeof day.latestCloseMin === 'number' && day.latestCloseMin > 0 ? day.latestCloseMin : 24 * 60)));
        var _ha = (_ih && typeof _ih.atMin === 'number') ? _ih.atMin
          : (_dc && typeof _dc.hopAtMin === 'number' ? _dc.hopAtMin : -1);
        var _fpItems = items.filter(function(it) {
          var m = timeToMinutes(it.t);
          return m >= 0 && ['ride','show','dining','quickservice','snack','character'].indexOf(it.type) !== -1
            && (_ha < 0 || m >= _ha);
        });
        var _sorted = _fpItems.slice().sort(function(a,b){return timeToMinutes(a.t)-timeToMinutes(b.t);});
        var _lastIt = _sorted.length ? _sorted[_sorted.length-1] : null;
        var _lm = _lastIt ? timeToMinutes(_lastIt.t) : -1;
        var _tgt = _fc - 30;
        if (_fc > 0 && _lm >= 0 && _lm < _tgt) {
          var _pdl = [
            {h:'Big Thunder Mountain Railroad (Night Ride)',n:'Overnight-low waits -- prime re-ride window.',land:'Frontierland'},
            {h:'Haunted Mansion (Night Ride)',n:'Eerie after dark -- near-zero wait late night.',land:'New Orleans Square'},
            {h:'Space Mountain (Night Ride)',n:'Late-night waits drop to near zero.',land:'Tomorrowland'},
            {h:'Indiana Jones Adventure (Night Ride)',n:'Night-owl window -- minimal standby.',land:'Adventureland'},
            {h:'Pirates of the Caribbean (Night Ride)',n:'Virtually no wait after 10 PM.',land:'New Orleans Square'},
            {h:'Matterhorn Bobsleds (Night Ride)',n:'Glows after dark -- short late-night line.',land:'Fantasyland'},
            {h:'Tiana\'s Bayou Adventure (Night Ride)',n:'Evening ride -- waits lowest near close.',land:'New Orleans Square'},
            {h:'Jungle Cruise (Night Ride)',n:'Skipper jokes -- walk-on late night.',land:'Adventureland'},
            {h:'Star Wars: Rise of the Resistance (Night Ride)',n:'Long waits drop here -- overnight-low window.',land:'Star Wars: Galaxy\'s Edge'},
            {h:"Mickey & Minnie's Runaway Railway (Night Ride)",n:'Near-zero wait late evening.',land:'Mickey and Friends / Toontown'}
          ];
          var _pdca = [
            {h:'Guardians of the Galaxy -- Mission: BREAKOUT! (Night Ride)',n:'Overnight-low waits -- great late ride.',land:'Avengers Campus'},
            {h:'Incredicoaster (Night Ride)',n:'Short lines after dark.',land:'Pixar Pier'},
            {h:'Radiator Springs Racers (Night Ride)',n:'Late-night waits hit overnight low.',land:'Cars Land'},
            {h:'Web Slingers: A Spider-Man Adventure (Night Ride)',n:'Evening waits drop sharply.',land:'Avengers Campus'},
            {h:'Toy Story Midway Mania! (Night Ride)',n:'Fun evening games -- minimal late wait.',land:'Pixar Pier'},
            {h:'Soarin\' Around the World (Night Ride)',n:'Peaceful evening flight -- waits ease near close.',land:'Grizzly Peak'}
          ];
          var _pool = (_fp === 'DCA') ? _pdca : _pdl;
          var _rset = new Set();
          items.forEach(function(it){
            if (it.type === 'ride') _rset.add(normRideName(cleanRideName(it.h)));
          });
          var _sk = ((tripConfig && tripConfig.ridePreferences && Array.isArray(tripConfig.ridePreferences.skip))
            ? tripConfig.ridePreferences.skip : []).map(function(s){
              return String(s||''  ).toLowerCase().replace(/^rope drop[^:]*:?\s*/i,'').replace(/[^a-z0-9]/g,'');
          }).filter(function(x){return x.length>=4;});
          var _cur = _lm + 30, _ui = 0, _ri = 0, _ad = 0;
          while (_cur <= _tgt && _ad < 20) {
            var _e = null, _isu = false;
            while (_ui < _pool.length && !_e) {
              var _c = _pool[_ui], _cn = normRideName(cleanRideName(_c.h));
              var _ex = _sk.some(function(x){return _cn===x||_cn.indexOf(x)!==-1||x.indexOf(_cn)!==-1;});
              if (!_rset.has(_cn) && !_ex){_e=_c;_isu=true;}
              _ui++;
            }
            if (!_e && _pool.length > 0) {
              var _rc = _pool[_ri % _pool.length], _rcn = normRideName(cleanRideName(_rc.h));
              var _rex = _sk.some(function(x){return _rcn===x||_rcn.indexOf(x)!==-1||x.indexOf(_rcn)!==-1;});
              if (!_rex) _e = _rc;
              _ri++;
            }
            if (!_e){_cur+=30;continue;}
            items.push({t:minutesToTime(_cur),h:_e.h,type:'ride',n:_e.n,land:_e.land||''});
            if (_isu) _rset.add(normRideName(cleanRideName(_e.h)));
            corrections.push({rule:'evening-fill',day:dayNum,item:_e.h,
              action:'added evening fill at '+minutesToTime(_cur)+' (park:'+_fp+')'});
            _cur+=30; _ad++;
          }
          if (_ad > 0){
            items.sort(function(a,b){return timeToMinutes(a.t)-timeToMinutes(b.t);});
            day.items = items;
          }
        }
      }
    } catch (_eveErr) {}
        // RULE 8: Peak lunch auto-correct (12:00 PM - 1:00 PM)
        items.forEach(item => {
                if (item.type !== 'quickservice' && item.type !== 'dining') return;
                const cardMin = timeToMinutes(item.t);
                if (cardMin < 0) return;
                const isPeakLunch = cardMin >= 720 && cardMin <= 780; // 12:00-1:00 PM
                if (isPeakLunch) {
                          const newTime = cardMin < 750 ? '11:30 AM' : '1:30 PM';
                          corrections.push({ rule: 'peak-lunch', day: dayNum,
                                                      item: item.h, action: 'moved from ' + item.t + ' to ' + newTime });
                          item.t = newTime;
                }
        });
        items.sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));
        day.items = items;

        // RULE 9: Gap filler â no gaps longer than 90 minutes (non-VIP days)
        if (!isVipDay) {
                items = day.items;
                for (let i = 1; i < items.length; i++) {
                          const prev = timeToMinutes(items[i - 1].t);
                          const curr = timeToMinutes(items[i].t);
                          if (prev < 0 || curr < 0) continue;
                          if (curr - prev > 90) {
                                      const midMin = Math.round((prev + curr) / 2);
                                      const fillerCard = {
                                                    t: minutesToTime(midMin),
                                                    h: 'Explore + Recharge',
                                                    type: 'tip',
                                                    n: 'Good window to grab a snack, browse a shop, or find a shaded spot to regroup before the next attraction. Check the Disneyland app for any Lightning Lane availability.',
                                                    land: items[i - 1].land || items[i].land || ''
                                      };
                                      items.splice(i, 0, fillerCard);
                                      corrections.push({ rule: 'gap-filled', day: dayNum,
                                                                    action: 'inserted filler at ' + fillerCard.t + ' (gap was ' + (curr - prev) + ' min)' });
                                      i++;
                          }
                }
                day.items = items;
        }
  });

  // Rule 9s: EXCLUDED RIDES (structural). The group explicitly opted out of certain attractions during
  // onboarding (tripConfig.ridePreferences.skip, a.k.a. neverSchedule). The prompt asks the model to
  // avoid them, but the model occasionally schedules one anyway (e.g. as a late-evening filler). Remove
  // any ride/show card whose name matches an excluded attraction. Matching is normalized (lowercase,
  // alphanumerics only) and substring-tolerant so "Rope Drop: Grizzly River Run" or "Grizzly River Run
  // (single rider)" still match the excluded "Grizzly River Run".
  const _exNorm = s => String(s || '').toLowerCase().replace(/^rope drop[^:]*:?\s*/i, '').replace(/[^a-z0-9]/g, '');
  const excludedRaw = (tripConfig && tripConfig.ridePreferences && Array.isArray(tripConfig.ridePreferences.skip) && tripConfig.ridePreferences.skip)
    || (tripConfig && Array.isArray(tripConfig.neverSchedule) && tripConfig.neverSchedule)
    || [];
  const excludedNorm = excludedRaw.map(_exNorm).filter(x => x.length >= 4);
  if (excludedNorm.length) {
    days.forEach((day, idx) => {
      const items = day.items || [];
      let removed = 0;
      const kept = items.filter(it => {
        if (!it || (it.type !== 'ride' && it.type !== 'show')) return true;
        const h = _exNorm(it.h);
        const hit = excludedNorm.some(ex => h === ex || h.indexOf(ex) !== -1 || ex.indexOf(h) !== -1);
        if (hit) {
          removed++;
          corrections.push({ rule: 'excluded-ride', day: idx + 1, item: it.h,
            action: 'removed - on the group exclusion list' });
          return false;
        }
        return true;
      });
      if (removed) day.items = kept;
    });
  }

  // RULE 6: Confirmed reservations must be present â HARD VIOLATION
  const reservations = (tripConfig && tripConfig.dining && tripConfig.dining.reservations) || [];
  reservations.forEach(reservation => {
    const targetDayIdx = reservation.day;
    const targetDay = schedule.days[targetDayIdx];
    if (!targetDay) return;
    const found = targetDay.items.some(i =>
      i.type === 'dining' &&
      (i.h || '').toLowerCase().includes(reservation.name.toLowerCase())
    );
    if (!found) {
      hardViolations.push({
        rule: 'reservation-missing',
        day: targetDayIdx + 1,
        detail: reservation.name + ' not found on Day ' + (targetDayIdx + 1)
      });
    }
  });

  // Rule 9b: PARK PRESENCE (structural, TIME-AWARE, REMOVES wrong-park items + leaves a gap marker).
  // Non-hopper day: every item must be in day.park.
  // Hopper day: items BEFORE the hop must be in startPark; items AT/AFTER the hop must be in the hop (destination) park.
  // A Disneyland restaurant scheduled after hopping to DCA is wrong even though DL is "visited" that day.
  days.forEach((day, idx) => {
    if (tripConfig && tripConfig.days && tripConfig.days[idx] && tripConfig.days[idx].isVip === true) return; // VIP day handled by the guide
    const items = day.items || [];
    const startPark = normPark(day.park) || 'DL';
    // Detect the hop. AUTHORITATIVE SOURCE: the per-day intent object the generator itself uses
    // (tripConfig.days[idx].intent.hop = { toPark, atMin }). The generator derives its park BLOCKS from
    // this, so the validator must read the SAME thing or the two disagree. The previous version only
    // detected a hop from a literal "hop to" tip card in the items -- but the generator does not emit
    // such a card (it encodes the hop in block structure), so hopMin stayed -1, the whole day was forced
    // to startPark, and a correct DL-morning -> DCA-afternoon day had its entire post-hop block deleted.
    let hopMin = -1, hopPark = null;
    const dayCfg = (tripConfig && tripConfig.days && tripConfig.days[idx]) || null;
    const intentHop = dayCfg && dayCfg.intent && dayCfg.intent.hop;
    if (intentHop && typeof intentHop.atMin === 'number' && intentHop.toPark) {
      hopMin = intentHop.atMin;
      hopPark = normPark(intentHop.toPark);
    } else if (dayCfg && dayCfg.hopTo && typeof dayCfg.hopAtMin === 'number' && dayCfg.toPark) {
      // secondary: explicit hop fields on the day config
      hopMin = dayCfg.hopAtMin;
      hopPark = normPark(dayCfg.toPark);
    } else {
      // legacy fallback: detect a "hop to" tip card in the items (older trips without intent)
      items.forEach(it => {
        if (/\bhop\b/i.test(it.h || '') && /to /i.test(it.h || '')) {
          const m = timeToMinutes(it.t);
          if (m >= 0) { hopMin = m; hopPark = normPark(it.h) || normPark(day.hopTo); }
        }
      });
    }
    const isHopper = !!(tripConfig && tripConfig.parkHopping) && hopMin >= 0 && !!hopPark;
    items.forEach(item => {
      if (['tip','break'].indexOf(item.type) !== -1) return; // tips/breaks have no firm park
      const p = landToPark(item.land) || landToPark(item.h);
      if (!p) return; // unknown land -> don't touch
      let expectedPark;
      if (isHopper) {
        const im = timeToMinutes(item.t);
        expectedPark = (im >= 0 && im >= hopMin) ? hopPark : startPark;
      } else {
        expectedPark = startPark;
      }
      if (p !== expectedPark) {
        item._remove = true;
        corrections.push({
          rule: 'park-presence',
          day: idx + 1,
          item: item.h,
          action: 'removed - in ' + p + ' but should be in ' + expectedPark + (isHopper ? ' at this time (relative to the hop)' : ''),
          gap: true,
          t: item.t
        });
      }
    });
    // Remove wrong-park items SILENTLY. Do NOT insert a user-visible placeholder: an apologetic
    // "a suggestion was in the wrong park and was removed" card must never face the user (it reads as
    // a defect). v2's enforcement pass already drops wrong-park RIDES against the authoritative catalog
    // before save; this rule is a backstop for non-ride wrong-park items (dining/show/character) that
    // v2's rides-only drop doesn't cover. If silent drops ever leave a visible hole, that's a signal to
    // fix the FILL at the source (v2 night-fill / generation), not to re-announce the removal here.
    const _removedCount = items.filter(i => i._remove).length;
    if (_removedCount) {
      day.items = items.filter(i => !i._remove);
      corrections.push({ rule: 'park-presence-cleanup', day: idx + 1, action: 'removed ' + _removedCount + ' wrong-park item(s) silently (no placeholder)' });
    }
  });

  // Rule 9c: HOTEL/DTD DINING (structural) - remove hotel & Downtown Disney restaurants that slipped
  // through, UNLESS the user entered a confirmed reservation for that venue.
  const reservedNames = [];
  if (tripConfig && Array.isArray(tripConfig.reservations)) {
    tripConfig.reservations.forEach(r => {
      const rn = (typeof r === 'string' ? r : (r && (r.name || r.venue || r.restaurant) || '')).toLowerCase();
      if (rn) reservedNames.push(rn);
    });
  }
  days.forEach((day, idx) => {
    let kept = (day.items || []);
    kept = kept.filter(item => {
      if (item.type !== 'dining' && item.type !== 'quickservice') return true;
      if (!isHotelOrDtdVenue(item.h)) return true;
      // It's a hotel/DTD venue. Keep ONLY if user reserved it.
      const isReserved = reservedNames.some(rn => (item.h || '').toLowerCase().indexOf(rn) !== -1 || rn.indexOf((item.h || '').toLowerCase()) !== -1);
      if (isReserved) return true;
      corrections.push({ rule: 'hotel-dtd-dining', day: idx + 1, item: item.h, action: 'removed - hotel/Downtown Disney venue, not an in-park meal and not user-reserved' });
      return false;
    });
    day.items = kept;
  });

  // Rule 9g: SINGLE PASS correction (structural). Rise of the Resistance + Radiator Springs Racers are
  // Lightning Lane Single Pass (ILL), never Multi Pass. Force ll.t='single' and fix LLMP/Multi Pass wording.
  function isSinglePassRide(name) {
    const s = (name || '').toLowerCase();
    return s.indexOf('rise of the resistance') !== -1 || s.indexOf('radiator springs') !== -1;
  }
  days.forEach((day, idx) => {
    (day.items || []).forEach(item => {
      const refersSingle = isSinglePassRide(item.h) || isSinglePassRide(item.ride) || (item.ll && isSinglePassRide(item.ll.a));
      if (!refersSingle) return;
      let changed = false;
      if (item.ll && typeof item.ll === 'object') {
        if (item.ll.t !== 'single') { item.ll.t = 'single'; changed = true; }
        if (typeof item.ll.a === 'string' && /llmp|multi pass/i.test(item.ll.a)) {
          item.ll.a = item.ll.a.replace(/lightning lane multi pass/ig, 'Lightning Lane Single Pass').replace(/multi pass/ig, 'Single Pass').replace(/\bLLMP\b/g, 'Single Pass');
          changed = true;
        }
      }
      if (typeof item.h === 'string' && /llmp|multi pass/i.test(item.h)) {
        item.h = item.h.replace(/lightning lane multi pass/ig, 'Lightning Lane Single Pass').replace(/multi pass/ig, 'Single Pass').replace(/\bLLMP\b/g, 'Single Pass');
        changed = true;
      }
      if (typeof item.n === 'string' && /llmp|multi pass/i.test(item.n)) {
        item.n = item.n.replace(/lightning lane multi pass/ig, 'Lightning Lane Single Pass').replace(/multi pass/ig, 'Single Pass').replace(/\bLLMP\b/g, 'Single Pass');
        changed = true;
      }
      if (changed) corrections.push({ rule: 'single-pass-fix', day: idx + 1, item: item.h, action: 'forced Single Pass (ILL) for Rise/Radiator Springs - not Multi Pass' });
    });
  });

  // Rule 9d: DE-DUP near-back-to-back identical Lightning Lane RETURNS for the SAME ride.
  // The model sometimes emits two LL-return cards for the same ride close together (e.g. 2 Rise returns).
  // Keep the first, remove a second return for the same base ride within 120 minutes.
  days.forEach((day, idx) => {
    const items = (day.items || []);
    const seen = []; // { base, min }
    const removeIdx = [];
    items.forEach((item, i) => {
      const base = llReturnBaseName(item.h);
      if (!base) return;
      const min = timeToMinutes(item.t);
      const dup = seen.find(s => s.base === base && Math.abs(s.min - min) <= 120);
      if (dup) {
        removeIdx.push(i);
        corrections.push({ rule: 'duplicate-ll-return', day: idx + 1, item: item.h, action: 'removed second LL return for same ride within 120 min' });
      } else {
        seen.push({ base, min });
      }
    });
    if (removeIdx.length) {
      day.items = items.filter((_, i) => removeIdx.indexOf(i) === -1);
    }
  });

  // Rule 9e: MEAL LABEL correctness (structural) - strip contradictory early/late words.
  // "early" valid: lunch <= 11:45 AM, dinner 4:30-5:30 PM. "late" valid: lunch 1:30-2:30 PM, dinner >= 7:30 PM.
  days.forEach((day, idx) => {
    (day.items || []).forEach(item => {
      if (item.type !== 'dining' && item.type !== 'quickservice') return;
      const title = item.h || '';
      if (!/\b(early|late)\b/i.test(title)) return;
      const min = timeToMinutes(item.t);
      const hasEarly = /\bearly\b/i.test(title);
      const hasLate = /\blate\b/i.test(title);
      const isLunchTime = min >= 660 && min < 900;   // 11:00 AM - 3:00 PM
      const isDinnerTime = min >= 900;               // 3:00 PM onward
      let earlyOk = false, lateOk = false;
      if (isLunchTime) { earlyOk = min <= 705; lateOk = min >= 810 && min <= 870; } // early<=11:45, late 1:30-2:30
      else if (isDinnerTime) { earlyOk = min >= 990 && min <= 1050; lateOk = min >= 1170; } // early 4:30-5:30, late>=7:30
      const stripEarly = hasEarly && !earlyOk;
      const stripLate = hasLate && !lateOk;
      if (stripEarly || stripLate) {
        let newTitle = title;
        if (stripEarly) newTitle = newTitle.replace(/\bearly\s+/i, '').replace(/\bearly\b/i, '');
        if (stripLate) newTitle = newTitle.replace(/\blate\s+/i, '').replace(/\blate\b/i, '');
        newTitle = newTitle.replace(/\s{2,}/g, ' ').trim();
        // Capitalize a leading lowercased meal word left after stripping (e.g. "dinner: X" -> "Dinner: X")
        newTitle = newTitle.replace(/^([a-z])/, (m) => m.toUpperCase());
        item.h = newTitle;
        corrections.push({ rule: 'meal-label-time', day: idx + 1, item: title, action: 'relabeled to: ' + newTitle + ' (early/late contradicted time ' + item.t + ')' });
      }
    });
  });

  // Rule 9f: MEAL must name a venue (structural flag) - a bare meal title with no restaurant is unhelpful.
  days.forEach((day, idx) => {
    (day.items || []).forEach(item => {
      if (item.type !== 'dining' && item.type !== 'quickservice') return;
      const t = (item.h || '').trim();
      // bare = exactly a generic meal word, optionally with a leading "Quick", and NO venue (no colon/at/-)
      const bare = /^(quick\s+)?(breakfast|brunch|lunch|dinner|meal|snack)$/i.test(t);
      if (bare) {
        corrections.push({ rule: 'meal-no-venue', day: idx + 1, item: t, action: 'flagged (non-blocking)', detail: 'meal card has no venue name at ' + item.t });
      }
    });
  });

  // Rule 10: drop hallucinated pre-dawn cards — e.g. an LL reminder stamped 12:45 AM
  // that sorts above the morning arrival. 5:00 AM = 300 min floor. Removal-only.
  // Uses 300 min, not park-open (~420-480), so arrival at ~6:30-7:00 AM is never removed.
  const PREDAWN_FLOOR_MIN = 300; // 5:00 AM
  days.forEach((day, dayNum) => {
    if (tripConfig && tripConfig.days && tripConfig.days[dayNum] && tripConfig.days[dayNum].isVip === true) return;
    day.items = day.items.filter(item => {
      const itemMin = timeToMinutes(item.t);
      if (itemMin < 0) return true; // unparseable -> leave it (don't guess)
      if (itemMin >= PREDAWN_FLOOR_MIN) return true; // >= 5:00 AM: keep
      corrections.push({ rule: 'predawn-card', day: dayNum + 1, item: item.h, action: 'removed — time ' + item.t + ' is before 5:00 AM' });
      return false; // drop 00:00-04:59 cards
    });
  });

  // Rule 9h: RENAME correction (structural) - Splash Mountain is now Tiana's Bayou Adventure.
  // The model keeps emitting the retired name; replace it in-place rather than relying on the prompt.
  const RENAMES = [
    { from: /splash\s*mountain/ig, to: "Tiana's Bayou Adventure" }
  ];
  days.forEach((day, idx) => {
    (day.items || []).forEach(item => {
      RENAMES.forEach(rn => {
        ['h', 'n', 'ride'].forEach(f => {
          if (typeof item[f] === 'string' && rn.from.test(item[f])) {
            item[f] = item[f].replace(rn.from, rn.to);
            corrections.push({ rule: 'attraction-rename', day: idx + 1, item: item.h, action: 'renamed to current attraction name' });
          }
        });
      });
    });
  });

  // Rule 9l: SEASONAL OVERLAY correction (structural) - Haunted Mansion Holiday is a fall/winter overlay
  // (roughly Sep-Jan). For a summer trip it is just Haunted Mansion. Strip the "Holiday" qualifier unless
  // the cache closures/events confirm the overlay is running. We don't have the date here, so we rely on
  // tripConfig: if no overlay flag is set, normalize to the base ride name.
  const overlayActive = tripConfig && tripConfig._hauntedMansionHoliday === true;
  if (!overlayActive) {
    days.forEach((day, idx) => {
      (day.items || []).forEach(item => {
        ['h', 'n', 'ride'].forEach(f => {
          if (typeof item[f] === 'string' && /haunted\s*mansion\s*holiday/ig.test(item[f])) {
            item[f] = item[f].replace(/haunted\s*mansion\s*holiday/ig, 'Haunted Mansion');
            corrections.push({ rule: 'seasonal-overlay', day: idx + 1, item: item.h, action: 'Haunted Mansion Holiday overlay not running this trip - normalized to Haunted Mansion' });
          }
        });
      });
    });
  }

  // Rule 9i: CROSS-DAY DINING DEDUP (structural). The validator runs per-day, so prior days' venues are
  // passed in via priorDining. Remove a dining/quickservice/snack card whose venue was already used on a
  // previous day (the no-repeat rule the prompt keeps violating, e.g. Tiana's Palace twice).
  function venueBase(h) {
    return (h || '')
      .replace(/^((Early|Late)\s+)?(Lunch|Dinner|Breakfast|Brunch|Snack|Morning Snack|Afternoon Snack|Meal)\s*:\s*/i, '')
      .replace(/\s*\(.*?\)\s*$/, '')
      .trim()
      .toLowerCase();
  }
  const priorVenues = Array.isArray(priorDining) ? priorDining.map(v => (v || '').toLowerCase().trim()).filter(Boolean) : [];
  if (priorVenues.length) {
    days.forEach((day, idx) => {
      const items = day.items || [];
      items.forEach(item => {
        if (['dining', 'quickservice', 'snack'].indexOf(item.type) === -1) return;
        // never remove a confirmed reservation
        const isReserved = (tripConfig && tripConfig.dining && tripConfig.dining.reservations || []).some(r => r && r.name && (item.h || '').toLowerCase().includes(r.name.toLowerCase()));
        if (isReserved) return;
        const vb = venueBase(item.h);
        if (vb && priorVenues.some(pv => pv === vb || pv.indexOf(vb) !== -1 || vb.indexOf(pv) !== -1)) {
          item._remove = true;
          corrections.push({ rule: 'cross-day-dining-repeat', day: idx + 1, item: item.h, action: 'removed - venue already used on a prior day' });
        }
      });
      day.items = items.filter(i => !i._remove);
    });
  }

  // Rule 9j: LL BOOKING SPACING (structural). Two Lightning Lane BOOKING tips within 60 min is unworkable
  // (you can only hold a limited number / must wait between bookings). Keep the first, flag/space the rest.
  days.forEach((day, idx) => {
    const items = day.items || [];
    const llBookings = items
      .filter(i => i.ll && /book/i.test((i.h || '') + (i.ll && i.ll.a || '')))
      .sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));
    for (let i = 1; i < llBookings.length; i++) {
      const prevMin = timeToMinutes(llBookings[i - 1].t);
      const curMin = timeToMinutes(llBookings[i].t);
      if (prevMin >= 0 && curMin >= 0 && (curMin - prevMin) < 60) {
        corrections.push({ rule: 'll-booking-too-close', day: idx + 1, item: llBookings[i].h, action: 'two LL bookings within 60 min - space them out (flagged)' });
      }
    }
  });

  // Rule 9k: ROPE-DROP + LL CONFLICT (structural). If a ride is rope-dropped (ridden in the first ~45 min),
  // do NOT also book a Lightning Lane for the SAME ride - it is contradictory (e.g. rope-drop Radiator
  // Springs Racers AND buy its Single Pass). Remove the redundant LL booking for that ride.
  days.forEach((day, idx) => {
    const items = day.items || [];
    // find earliest real ride time = rope drop window start
    const rideTimes = items.filter(i => i.type === 'ride').map(i => timeToMinutes(i.t)).filter(m => m >= 0);
    if (!rideTimes.length) return;
    const firstRide = Math.min.apply(null, rideTimes);
    const ropeDropEnd = firstRide + 45;
    // rides ridden during rope drop
    const ropeDropped = items
      .filter(i => i.type === 'ride' && timeToMinutes(i.t) >= 0 && timeToMinutes(i.t) <= ropeDropEnd)
      .map(i => (i.h || '').toLowerCase().replace(/\s*\(.*?\)\s*$/, '').trim());
    items.forEach(item => {
      if (!item.ll) return;
      const llRide = ((item.ride || item.h || '')).toLowerCase().replace(/^book\s+/i, '').replace(/\s+via lightning lane.*/i, '').replace(/\s*\(.*?\)\s*$/, '').trim();
      if (!llRide) return;
      if (ropeDropped.some(rd => rd && (rd === llRide || rd.indexOf(llRide) !== -1 || llRide.indexOf(rd) !== -1))) {
        item._remove = true;
        corrections.push({ rule: 'ropedrop-ll-conflict', day: idx + 1, item: item.h, action: 'removed redundant LL - ride is rope-dropped, no LL needed' });
      }
    });
    day.items = items.filter(i => !i._remove);
  });

  // Rule 9m: TITLE CLEANUP (structural). Strip a leading "Ride:" / "Show:" prefix the model sometimes
  // prepends to titles, and fix malformed either/or cards like "Ride: X or Y (Snack)".
  days.forEach((day, idx) => {
    (day.items || []).forEach(item => {
      if (typeof item.h !== 'string') return;
      const before = item.h;
      // remove a leading type-word prefix that duplicates the card type
      item.h = item.h.replace(/^\s*(Ride|Show|Attraction)\s*:\s*/i, '');
      // a snack card that still says "(Snack)" or offers a ride either/or is malformed - flag it
      if (item.type === 'snack' && /\bor\b/i.test(item.h) && /\(snack\)/i.test(before)) {
        corrections.push({ rule: 'malformed-snack-card', day: idx + 1, item: before, action: 'flagged - snack card written as a ride either/or; needs a real snack venue' });
      }
      if (item.h !== before) {
        corrections.push({ rule: 'title-prefix-cleanup', day: idx + 1, item: before, action: 'removed redundant type prefix from title' });
      }
    });
  });

  // Rule 9n: SAME-RIDE LL DEDUP (structural). Do not book a Lightning Lane for the SAME ride more than once
  // in a day (e.g. Big Thunder Mountain booked as LL twice). Keep the first booking, remove later duplicates.
  days.forEach((day, idx) => {
    const items = day.items || [];
    const seenLLRides = {};
    items.forEach(item => {
      if (!item.ll) return;
      const ride = ((item.ride || item.h || '')).toLowerCase().replace(/^book\s+/i, '').replace(/\s+via lightning lane.*/i, '').replace(/lightning lane.*/i, '').replace(/\s*\(.*?\)\s*$/, '').trim();
      if (!ride) return;
      if (seenLLRides[ride]) {
        item._remove = true;
        corrections.push({ rule: 'duplicate-ll-same-ride', day: idx + 1, item: item.h, action: 'removed - LL already booked for ' + ride + ' earlier today' });
      } else {
        seenLLRides[ride] = true;
      }
    });
    day.items = items.filter(i => !i._remove);
  });

  // Rule 9o: LL TITLE NAMING (structural). Replace generic "Book Lightning Lane Multi Pass #N" titles with
  // the actual ride name so the card is useful: "Book Big Thunder Mountain (Lightning Lane)".
  days.forEach((day, idx) => {
    (day.items || []).forEach(item => {
      if (!item.ll) return;
      if (typeof item.h === 'string' && /lightning lane (multi|single) pass\s*#?\d*/i.test(item.h) && item.ride) {
        const passType = item.ll.t === 'single' ? 'Single Pass' : 'Lightning Lane';
        item.h = 'Book ' + item.ride + ' (' + passType + ')';
        corrections.push({ rule: 'll-title-naming', day: idx + 1, item: item.ride, action: 'named the ride in the LL booking title' });
      }
    });
  });

  // Rule 9p: HEIGHT / RIDER-SWAP (structural). The prompt applies this inconsistently (some days got swap
  // notes, others none). Here we guarantee it: for any ride whose height minimum exceeds the group's
  // shortest member, ensure the card note flags a rider swap. Height table uses well-established DLR minimums.
  const HEIGHT_REQ = [
    { min: 48, names: ['incredicoaster'] },
    { min: 42, names: ['matterhorn', 'goofy\'s sky school', 'goofys sky school'] },
    { min: 40, names: ['big thunder', 'space mountain', 'tiana', 'rise of the resistance', 'guardians of the galaxy', 'mission breakout', 'radiator springs racers'] },
    { min: 35, names: ['gadget', 'go coaster', 'luigi'] },
    { min: 32, names: ['mater\'s junkyard', 'maters junkyard', 'jumpin jellyfish', 'golden zephyr'] }
  ];
  const groupMinHeight = (function() {
    const mh = tripConfig && tripConfig.minHeight;
    if (mh === 'under40') return 38;   // shortest member under 40in -> treat as 38
    if (mh === '40to46') return 43;    // 40-46in -> use 43 midpoint
    if (mh === '46to48' || mh === '46to48') return 47;
    return 48;                          // over48 / default -> everyone can ride, no swaps
  })();
  function rideHeightMin(name) {
    const s = (name || '').toLowerCase();
    for (const tier of HEIGHT_REQ) {
      if (tier.names.some(n => s.indexOf(n) !== -1)) return tier.min;
    }
    return 0; // no height requirement
  }
  if (groupMinHeight < 48) {
    days.forEach((day, idx) => {
      (day.items || []).forEach(item => {
        if (item.type !== 'ride') return;
        const req = rideHeightMin(item.h);
        if (req > 0 && req > groupMinHeight) {
          const note = (item.n || '');
          if (!/rider swap|rider switch|too short|height/i.test(note)) {
            item.n = (note ? note.replace(/\s*$/, '') + ' ' : '') + 'Rider swap: requires ' + req + 'in; shortest member cannot board.';
            // keep note within the 80-char guidance where possible
            corrections.push({ rule: 'height-rider-swap', day: idx + 1, item: item.h, action: 'added rider-swap note (ride requires ' + req + 'in)' });
          }
        }
      });
    });
  }

  // Rule 9q: FINAL MEAL/SNACK CLEANUP (runs LAST so earlier rules + the gap-filler can't re-introduce dupes).
  // Enforces: max 1 morning snack, max 1 afternoon snack, max 1 lunch, max 1 dinner per day; and flags any
  // meal/snack card that names no venue (vague "Morning Snack" / "Dinner" with no restaurant).
  days.forEach((day, idx) => {
    if (tripConfig && tripConfig.days && tripConfig.days[idx] && tripConfig.days[idx].isVip === true) return;
    let items = day.items || [];
    const NOON = 720;
    function mealSlot(it) {
      const h = (it.h || '').toLowerCase();
      const m = timeToMinutes(it.t);
      if (it.type === 'snack') return m >= 0 && m < NOON ? 'morning-snack' : 'afternoon-snack';
      if (it.type === 'dining' || it.type === 'quickservice') {
        if (/breakfast/.test(h)) return 'breakfast';
        if (/dinner/.test(h)) return 'dinner';
        if (/lunch/.test(h)) return 'lunch';
        // infer by time if not labeled
        if (m >= 0 && m < 11 * 60) return 'breakfast';
        if (m >= 16 * 60) return 'dinner';
        return 'lunch';
      }
      return null;
    }
    function isReserved(it) {
      return (tripConfig && tripConfig.dining && tripConfig.dining.reservations || []).some(r => r && r.name && (it.h || '').toLowerCase().includes(r.name.toLowerCase()));
    }
    function hasVenue(it) {
      const v = (it.h || '').replace(/^((early|late|morning|afternoon|evening)\s+)?(breakfast|brunch|lunch|dinner|snack|meal)\s*[:\-]?\s*/i, '').trim();
      return v.length >= 3;
    }
    // Group meal/snack items by slot, keep the BEST one (reserved > has-venue > earliest), remove the rest.
    const bySlot = {};
    items.forEach((it, i) => {
      const slot = mealSlot(it);
      if (!slot) return;
      (bySlot[slot] = bySlot[slot] || []).push(i);
    });
    const removeIdx = {};
    Object.keys(bySlot).forEach(slot => {
      const idxs = bySlot[slot];
      if (idxs.length <= 1) return;
      // score: reserved=2, has-venue=1, else 0; tie-break earliest time
      let bestI = idxs[0], bestScore = -1, bestMin = Infinity;
      idxs.forEach(i => {
        const it = items[i];
        const score = isReserved(it) ? 2 : (hasVenue(it) ? 1 : 0);
        const m = timeToMinutes(it.t); const mm = m < 0 ? Infinity : m;
        if (score > bestScore || (score === bestScore && mm < bestMin)) { bestScore = score; bestMin = mm; bestI = i; }
      });
      idxs.forEach(i => {
        if (i === bestI) return;
        removeIdx[i] = true;
        corrections.push({ rule: 'duplicate-meal-slot', day: idx + 1, item: items[i].h, action: 'removed extra ' + slot + ' (kept the best one for that slot)' });
      });
    });
    items = items.filter((it, i) => !removeIdx[i]);
    // Flag vague meal/snack cards with no venue named.
    items.forEach(it => {
      const slot = mealSlot(it);
      if (!slot) return;
      const h = (it.h || '');
      // strip the meal-word prefix; if nothing meaningful remains, there's no venue
      const venuePart = h.replace(/^((early|late|morning|afternoon|evening)\s+)?(breakfast|brunch|lunch|dinner|snack|meal)\s*[:\-]?\s*/i, '').trim();
      if (!venuePart || venuePart.length < 3) {
        corrections.push({ rule: 'meal-no-venue', day: idx + 1, item: h, action: 'flagged - names no venue (vague meal/snack card)' });
      }
    });
    day.items = items;
  });

  // Rule 9r: OFF-PEAK DINING (structural flag). The app is smarter than the crowd: it does NOT eat at peak
  // times. Lunch peak = 12:00-1:00 PM, dinner peak = 6:00-7:00 PM. Smart windows are just outside those
  // (e.g. lunch 11:00-11:45 or 1:00-1:45; dinner 4:30-5:30 or 7:30+). Flag any meal landing in the peak so
  // it can be nudged. Never flags a confirmed reservation (the guest chose that time). NOTE: this is a flag,
  // not an auto-move, because the smart alternative window is a strategic call the cache/model should make;
  // the scaffold will place meals in off-peak windows up front so this rarely fires.
  days.forEach((day, idx) => {
    if (tripConfig && tripConfig.days && tripConfig.days[idx] && tripConfig.days[idx].isVip === true) return;
    (day.items || []).forEach(item => {
      if (['dining', 'quickservice'].indexOf(item.type) === -1) return;
      const isReserved = (tripConfig && tripConfig.dining && tripConfig.dining.reservations || []).some(r => r && r.name && (item.h || '').toLowerCase().includes(r.name.toLowerCase()));
      if (isReserved) return;
      const m = timeToMinutes(item.t);
      if (m < 0) return;
      const inLunchPeak = m >= 12 * 60 && m < 13 * 60;     // 12:00-12:59 PM
      const inDinnerPeak = m >= 18 * 60 && m < 19 * 60;    // 6:00-6:59 PM
      if (inLunchPeak || inDinnerPeak) {
        corrections.push({
          rule: 'dining-peak-hour',
          day: idx + 1,
          item: item.h,
          action: 'flagged - meal at ' + item.t + ' is in the ' + (inLunchPeak ? 'lunch (12-1)' : 'dinner (6-7)') + ' peak; smarter to shift just outside the rush'
        });
      }
    });
  });

  // Rule 9t: GENERAL RIDE DE-DUP (alias-aware). Each attraction appears at most once per day. The
  // model (and the legacy generator) sometimes list the same ride twice, often under alias names the
  // earlier rope-drop dedup misses -- e.g. "Star Wars: Rise of the Resistance" and "Rise of the
  // Resistance", or "Big Thunder Mountain Railroad (Night Ride)" and "Big Thunder Mountain Railroad".
  // Keep the FIRST occurrence in time order; drop later duplicates of the same normalized ride name.
  // This is the durable, save-time home for the rule the v2 engine also applies in-handler, so a clean
  // schedule is guaranteed no matter which generator (v2, legacy, in-app rebuild, manual edit) produced it.
  // Runs on ALL days incl. VIP -- a ride double-booked on a VIP day is still a physics error.
  days.forEach((day, idx) => {
    const items = day.items || [];
    if (!items.length) return;
    const ordered = items.slice().sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));
    const seen = new Set();
    const dropRefs = new Set();
    ordered.forEach(it => {
      if (!it || it.type !== 'ride') return;
      const n = normRideName(cleanRideName(it.h));
      if (!n) return;
      if (seen.has(n)) {
        dropRefs.add(it);
        corrections.push({ rule: 'ride-dedup', day: idx + 1, item: it.h, action: 'removed duplicate ride (kept earlier occurrence)' });
      } else {
        seen.add(n);
      }
    });
    if (dropRefs.size) day.items = items.filter(it => !dropRefs.has(it));
  });

  // Rule 9u: GENERAL RIDE DE-COLLISION (physics). No two RIDE cards may share the same minute -- you
  // cannot be on two attractions at once (observed: a rope-drop opener and Rise both at 8:00 AM, and
  // Haunted Mansion + Jungle Cruise both at 11:15 PM). Walk the time-sorted cards and, for any ride at
  // or before the previous ride's minute, nudge it +10 (capped just under midnight) so ride times
  // strictly increase. Only rides move; meals/shows/tips/LL reminders may legitimately overlap a ride.
  // Runs AFTER dedup so it never wastes a slot resolving a duplicate that should have been removed.
  days.forEach((day, idx) => {
    const items = day.items || [];
    if (!items.length) return;
    items.sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));
    let lastRide = -1;
    items.forEach(it => {
      if (!it || it.type !== 'ride' || !it.t) return;
      const m = timeToMinutes(it.t);
      if (m < 0) return;
      if (m <= lastRide) {
        const nm = Math.min(lastRide + 10, 1439);
        if (nm > m) {
          corrections.push({ rule: 'ride-decollision', day: idx + 1, item: it.h, action: 'moved from ' + it.t + ' to ' + minutesToTime(nm) + ' (two rides shared a minute)' });
          it.t = minutesToTime(nm);
        }
        lastRide = Math.max(nm, m);
      } else {
        lastRide = m;
      }
    });
    items.sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));
    day.items = items;
  });

  // Rule 9v: ILL / Single Pass not enabled -> strip purchase reminders the model added anyway.
  // If a day's config has hasILL falsy, the user never bought Individual Lightning Lane / Single Pass,
  // so any "Purchase Lightning Lane Single Pass: X" reminder is wrong and could push a guest to pay
  // for something they declined. The underlying ride stays (ridden standby); only the tip is removed.
  // "Multi Pass" is never matched (only "single pass"/"individual lightning lane"), so LLMP is untouched.
  try {
    const _illRe = /lightning lane single|single\s*pass|individual lightning lane/i;
    days.forEach((day, idx) => {
      const cfgDay = (tripConfig && tripConfig.days && tripConfig.days[idx]) || {};
      if (cfgDay.hasILL) return;
      const items = day.items || [];
      const kept = items.filter(it => !(it && _illRe.test(it.h || '')));
      if (kept.length !== items.length) {
        corrections.push({ rule: 'ill-not-enabled', day: idx + 1, action: 'removed ' + (items.length - kept.length) + ' Single Pass reminder(s); ILL not enabled for this day' });
        day.items = kept;
      }
    });
  } catch (e) {}

  // Rule 9w: REASONING-LEAKAGE STRIP (quality). The model occasionally leaks its own planning
  // monologue into a card -- e.g. a card titled "Haunted Mansion" with note "Wait -- Haunted Mansion
  // was already ridden this morning; skip to the next." Incoherent (a card for a ride you are told to
  // skip) and it breaks the calm friendly voice. Strip any card whose note OR title reads as think-aloud.
  // High-precision: a leakage opener (Wait/Hmm/Actually/On second thought/Let me reconsider|think/
  // Scratch that/Oops) with trailing punctuation; the phrase "skip to the next"; or "already (been)
  // ridden/done/scheduled/visited/covered" paired with a skip/instead/move/next marker. Real warm notes
  // ("Waits typically lowest before...", "Skip the line with your Lightning Lane") do NOT match.
  // Removal only -- never adds an item, never raises a hard violation.
  try {
    const _leakOpener = /^\s*(wait|hmm|actually|on second thought|let me reconsider|let me think|scratch that|oops)\b\s*[\u2014\-:,]/i;
    const _leakSkipNext = /\bskip to the next\b/i;
    const _leakAlready = /\balready (been\s+)?(ridden|done|did|scheduled|visited|covered)\b[\s\S]{0,40}\b(skip|instead|move on|next)\b/i;
    const _isLeak = (v) => { if (!v) return false; const t = String(v); return _leakOpener.test(t) || _leakSkipNext.test(t) || _leakAlready.test(t); };
    days.forEach((day, idx) => {
      const items = day.items || [];
      const kept = items.filter(it => !(it && (_isLeak(it.n) || _isLeak(it.h))));
      if (kept.length !== items.length) {
        corrections.push({ rule: 'reasoning-leakage', day: idx + 1, action: 'removed ' + (items.length - kept.length) + ' think-aloud card(s) (model reasoning leaked into a card)' });
        day.items = kept;
      }
    });
  } catch (e) {}

  // Rule 9x: VIP-DAY POST-TOUR PARK PRESENCE (structural backstop). Rule 9b skips VIP days entirely
  // because the VIP tour moves between parks WITHOUT a hop marker -- walking markers across the whole
  // day would wrongly force everything to the start park and delete the real post-tour rides. But once
  // the tour ENDS the day behaves like a normal evening: the group is dropped at the tour's destination
  // park (intent.hop.toPark) and any later "Park Hop to X" card flips them. So enforce park presence
  // ONLY after the tour end time, starting from the tour-destination park and flipping on evening hop
  // cards -- catching e.g. a Disneyland ride scheduled in the DCA evening before the 10 PM hop back.
  // v2's gen-time wrong-park drop already covers fresh generation; this is the SAVE-time backstop
  // (reoptimize / manual edits) the validator owns. Conservative: only RIDE/SHOW cards are checked;
  // dining is EXEMPT so a reserved meal can never be removed; pre-tour and in-tour items are untouched
  // (the host owns them); a card whose land we cannot resolve is left alone. Removal-only, idempotent.
  try {
    days.forEach((day, idx) => {
      const dayCfg = (tripConfig && tripConfig.days && tripConfig.days[idx]) || null;
      if (!dayCfg || dayCfg.isVip !== true) return;
      const vip = (dayCfg.intent && dayCfg.intent.vip) || dayCfg.vip || null;
      const tourEnd = (vip && typeof vip.endMin === 'number') ? vip.endMin : null;
      if (tourEnd === null) return; // no bounded tour window -> cannot safely enforce
      // Park the tour drops you in = the hop destination if the hop occurs by tour end, else start park.
      let curPark = normPark(day.park) || 'DL';
      const hop = dayCfg.intent && dayCfg.intent.hop;
      if (hop && typeof hop.atMin === 'number' && hop.toPark && hop.atMin <= tourEnd) {
        curPark = normPark(hop.toPark) || curPark;
      }
      const items = day.items || [];
      items.sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));
      let removed = 0;
      items.forEach(item => {
        if (!item || !item.t) return;
        const im = timeToMinutes(item.t);
        if (im < 0 || im < tourEnd) return; // only post-tour items
        const h = item.h || '';
        // an evening hop card flips the current park (and the card itself stays)
        if (/\bpark hop to\b/i.test(h) || (/\bhop\b/i.test(h) && /\bto\b/i.test(h))) {
          const hp = normPark(h);
          if (hp) curPark = hp;
          return;
        }
        if (item.type !== 'ride' && item.type !== 'show') return; // dining/tip/break/snack exempt
        const p = landToPark(item.land) || landToPark(item.h);
        if (!p) return; // unknown land -> do not touch
        if (p !== curPark) {
          item._vremove = true;
          removed++;
          corrections.push({ rule: 'vip-park-presence', day: idx + 1, item: item.h, action: 'removed - ' + p + ' item in the ' + curPark + ' post-tour block at ' + item.t, t: item.t });
        }
      });
      if (removed) day.items = items.filter(i => !i._vremove);
    });
  } catch (e) {}

  return {
    valid: hardViolations.length === 0,
    schedule,
    corrections,
    hardViolations
  };
}

export { validateSchedule, parseClosedFromCache };
