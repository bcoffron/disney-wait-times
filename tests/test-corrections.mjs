import { labelToMin, minToLabel } from '../api/schedule-rules.js';
import { enforceBreaks, enforceMealWindows } from '../api/schedule-corrections.js';
import { placeMealSlots, classifyReservationMeal } from '../api/schedule-skeleton.js';

let pass=0, fail=0;
const eq=(name,got,want)=>{ const g=JSON.stringify(got),w=JSON.stringify(want);
  if(g===w){pass++;console.log('  PASS '+name);} else {fail++;console.log('  FAIL '+name+'\n        got '+g+'\n        want '+w);} };

console.log('\n[A] TIME HELPERS round-trip incl. midnight close');
eq('8:00 AM -> 480', labelToMin('8:00 AM'), 480);
eq('5:30 PM -> 1050', labelToMin('5:30 PM'), 1050);
eq('12:00 AM close -> 1440', labelToMin('12:00 AM',{asCloseTime:true}), 1440);
eq('12:00 AM plain -> 0', labelToMin('12:00 AM'), 0);
eq('1440 -> 12:00 AM', minToLabel(1440), '12:00 AM');
eq('1080 -> 6:00 PM', minToLabel(1080), '6:00 PM');

console.log('\n[B] enforceBreaks: Day3 two morning breaks -> keep earliest, fix labels');
const d3 = [
  {t:'8:50 AM', type:'break', n:'whatever'},
  {t:'9:10 AM', type:'ride', h:'Radiator Springs Racers'},
  {t:'10:50 AM', type:'break', n:'Afternoon restroom stop. Good time...'}, // 2nd morning - REMOVE
  {t:'3:00 PM', type:'break', n:'x'},
];
const eb = enforceBreaks(d3);
eq('removed the 10:50 AM second morning break', eb.removed.map(r=>r.t), ['10:50 AM']);
eq('kept break count = 2 (1 morning + 1 afternoon)', eb.items.filter(i=>i.type==='break').length, 2);
eq('8:50 break labeled morning', eb.items.find(i=>i.t==='8:50 AM').n.startsWith('Quick morning'), true);
eq('3:00 break labeled afternoon', eb.items.find(i=>i.t==='3:00 PM').n.startsWith('Afternoon'), true);

console.log('\n[C] enforceBreaks: the classic mislabel (10:00 AM said "afternoon")');
const mis = enforceBreaks([{t:'10:00 AM', type:'break', n:'Afternoon restroom stop. Good time...'}]);
eq('10:00 AM corrected to morning note', mis.items[0].n.startsWith('Quick morning'), true);

console.log('\n[D] enforceMealWindows: Day2 5:30 app dinner -> 6:00; reserved 5:30 stays; 12:30 lunch -> 1:00');
const meals = [
  {t:'5:30 PM', type:'quickservice', h:'Wine Country Trattoria'},   // app-chosen, in 5-6 peak -> move
  {t:'12:30 PM', type:'dining', h:'Some Lunch'},                    // in 12-1 peak -> move
  {t:'7:00 PM', type:'dining', h:'Fine Dinner'},                    // allowed -> stays
];
const em = enforceMealWindows(meals, { isReserved: ()=>false });
eq('5:30 app dinner moved to 6:00', em.items[0].t, '6:00 PM');
eq('12:30 lunch moved to 1:00', em.items[1].t, '1:00 PM');
eq('7:00 dinner unchanged', em.items[2].t, '7:00 PM');
eq('two meals moved', em.moved.length, 2);
// reserved exception:
const emRes = enforceMealWindows([{t:'5:30 PM', type:'dining', h:'Cafe Orleans', isReserved:true}],
  { isReserved:(it)=>it.isReserved===true });
eq('reserved 5:30 dinner is NOT moved', emRes.items[0].t, '5:30 PM');

console.log('\n[E] classifyReservationMeal');
eq('5:30 PM -> dinner', classifyReservationMeal(1050), 'dinner');
eq('12:30 PM -> lunch', classifyReservationMeal(750), 'lunch');
eq('3:30 PM -> null (between meals)', classifyReservationMeal(930), null);

console.log('\n[F] placeMealSlots: normal DL day (8:00-midnight, no VIP, no reservations)');
const normal = placeMealSlots({ dayStartMin:480, dayEndMin:1440, reservations:[], vipWindow:null });
eq('lunch slot ~11:30', normal.lunch && minToLabel(normal.lunch.min), '11:30 AM');
eq('dinner slot ~6:00', normal.dinner && minToLabel(normal.dinner.min), '6:00 PM');

console.log('\n[G] placeMealSlots: Day2 VIP (tour 10:00-5:00) -> NO lunch slot (tour covers), dinner AFTER tour');
const vip = placeMealSlots({ dayStartMin:480, dayEndMin:1380, reservations:[],
  vipWindow:{ startMin:600, endMin:1020 } });
eq('no app lunch slot (inside tour window)', vip.lunch, null);
eq('dinner slot placed at 6:00 (after 5:00 tour, outside 5-6 peak)', vip.dinner && minToLabel(vip.dinner.min), '6:00 PM');

console.log('\n[H] placeMealSlots: Day3 with Cafe Orleans reservation 5:30 (dinner) -> no dinner slot, lunch present');
const d3slots = placeMealSlots({ dayStartMin:480, dayEndMin:1320,
  reservations:[{ min:1050 }], vipWindow:null }); // 5:30pm reservation
eq('no app dinner slot (reservation covers dinner)', d3slots.dinner, null);
eq('lunch slot present ~11:30', d3slots.lunch && minToLabel(d3slots.lunch.min), '11:30 AM');

console.log('\n==== '+pass+' passed, '+fail+' failed ====');
process.exit(fail? 1 : 0);
