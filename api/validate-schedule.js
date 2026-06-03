// api/validate-schedule.js
// Post-generation schedule validator â structural rules enforced in code
// Called after every generation and before every save

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

// Fallback hardcoded closures — used only if cache is unavailable
// When cache CURRENT_CLOSURES is passed in at call time, it overrides this list
const CLOSED_ATTRACTIONS_FALLBACK = [
  'Pirates of the Caribbean',
  'Buzz Lightyear Astro Blasters',
  'Inside Out Emotional Whirlwind',
  'Silly Symphony Swings'
];

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

function validateSchedule(schedule, tripConfig, closedAttractionsFromCache) {
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
      // Remove extra morning snacks — max 1 before noon
      const morningSnackItems = items.filter(i => i.type === 'snack' && timeToMinutes(i.t) < 720);
      if (morningSnackItems.length > 1) {
        // Keep only the first one, remove the rest
        let kept = false;
        items = items.filter(i => {
          if (i.type === 'snack' && timeToMinutes(i.t) < 720) {
            if (!kept) { kept = true; return true; }
            corrections.push({ rule: 'duplicate-morning-snack', day: dayNum, item: i.h, action: 'removed duplicate morning snack' });
            return false;
          }
          return true;
        });
        day.items = items;
      }
      // Remove extra afternoon snacks — max 1 after noon
      const afternoonSnackItems = items.filter(i => i.type === 'snack' && timeToMinutes(i.t) >= 720);
      if (afternoonSnackItems.length > 1) {
        let kept = false;
        items = items.filter(i => {
          if (i.type === 'snack' && timeToMinutes(i.t) >= 720) {
            if (!kept) { kept = true; return true; }
            corrections.push({ rule: 'duplicate-afternoon-snack', day: dayNum, item: i.h, action: 'removed duplicate afternoon snack' });
            return false;
          }
          return true;
        });
        day.items = items;
      }
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
        i.type === 'break' && timeToMinutes(i.t) >= 0 && timeToMinutes(i.t) < 660
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
    }

    // RULE 7: Schedule ends too early â soft warning
    const sortedItems = [...items].sort((a, b) => timeToMinutes(a.t) - timeToMinutes(b.t));
    const last = sortedItems[sortedItems.length - 1];
    const lastMin = last ? timeToMinutes(last.t) : -1;
    const closeMin = PARK_CLOSE[idx] !== undefined ? PARK_CLOSE[idx] : 22 * 60;
    if (lastMin >= 0 && lastMin < closeMin - 60) {
      corrections.push({
        rule: 'ends-early-warning',
        day: dayNum,
        detail: 'Schedule ends at ' + (last ? last.t : '?') +
          ', park closes at ' + minutesToTime(closeMin) +
          ' (gap: ' + Math.round((closeMin - lastMin) / 60) + ' hrs)',
        action: 'flagged â manual regen recommended'
      });
    }

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

  // Rule 10: Time bounds — remove items before 7:00 AM
  const PARK_OPEN_MIN = 420; // 7:00 AM
  days.forEach((day, dayNum) => {
    if (day.isVip) return;
    day.items = day.items.filter(item => {
      const itemMin = timeToMinutes(item.t);
      if (itemMin >= 0 && itemMin < PARK_OPEN_MIN) {
        corrections.push({ rule: 'time-bounds', day: dayNum + 1, item: item.h, action: 'removed — time ' + item.t + ' is before 7:00 AM' });
        return false;
      }
      return true;
    });
  });

  return {
    valid: hardViolations.length === 0,
    schedule,
    corrections,
    hardViolations
  };
}

export { validateSchedule, parseClosedFromCache };
