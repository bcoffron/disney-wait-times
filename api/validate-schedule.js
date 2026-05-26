// api/validate-schedule.js
// Post-generation schedule validator — structural rules enforced in code
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

const CLOSED_ATTRACTIONS = [
  'Pirates of the Caribbean'
];

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

// Known park close times in minutes since midnight — D1, D2, D3
const PARK_CLOSE = [24 * 60, 23 * 60, 22 * 60];

function validateSchedule(schedule, tripConfig) {
  const corrections = [];
  const hardViolations = [];

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
          item: item.h, action: 'removed — currently closed' });
        item._remove = true;
      }
    });
    day.items = items.filter(i => !i._remove);
    items = day.items;

    // RULE 4: Morning snack required (non-VIP days only)
    if (!isVipDay) {
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

    // RULE 7: Schedule ends too early — soft warning
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
        action: 'flagged — manual regen recommended'
      });
    }
  });

  // RULE 6: Confirmed reservations must be present — HARD VIOLATION
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

  return {
    valid: hardViolations.length === 0,
    schedule,
    corrections,
    hardViolations
  };
}

module.exports = { validateSchedule };
