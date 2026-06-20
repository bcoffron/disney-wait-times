import { getRopeDropRanking, parseRopeDropRanking, normRideName,
         isMealTimeForbidden, nearestAllowedMealMin, breakNoteForMin } from '../api/schedule-rules.js';
import { assignRopeDropsAcrossDays, pickRopeDrop } from '../api/schedule-skeleton.js';

let pass=0, fail=0;
const eq=(name,got,want)=>{ const g=JSON.stringify(got),w=JSON.stringify(want);
  if(g===w){pass++;console.log('  PASS '+name);} else {fail++;console.log('  FAIL '+name+'\n        got '+g+'\n        want '+w);} };

// ---- the REAL cache prose (reconstructed from the live base64) ----
const REAL_PROSE =
"ROPE DROP PRIORITY \u2014 RANKED LISTS (global default; vary by day, never repeat a park's rope-drop across days).\n\n"+
"DISNEYLAND order: 1) Peter Pan's Flight 2) Rise of the Resistance 3) Space Mountain 4) Mickey & Minnie's Runaway Railway 5) Indiana Jones Adventure.\n\n"+
"DCA order: 1) Radiator Springs Racers 2) Guardians of the Galaxy \u2013 Mission: BREAKOUT! 3) Web Slingers 4) Incredicoaster 5) Toy Story Midway Mania!\n\n"+
"RULE: Each day rope-drop the highest-ranked ride for that day's park that the group hasn't excluded and wasn't already used on a prior same-park day.";

console.log('\n[1] PARSER reads the real cache prose into correct ranked lists');
const parsed = parseRopeDropRanking(REAL_PROSE);
eq('DL list', parsed && parsed.DL, ["Peter Pan's Flight","Rise of the Resistance","Space Mountain","Mickey & Minnie's Runaway Railway","Indiana Jones Adventure"]);
eq('DCA list', parsed && parsed.DCA, ["Radiator Springs Racers","Guardians of the Galaxy \u2013 Mission: BREAKOUT!","Web Slingers","Incredicoaster","Toy Story Midway Mania!"]);

console.log('\n[2] getRopeDropRanking prefers cache prose, source tagged');
const ranking = getRopeDropRanking({ ROPE_DROP_STRATEGY: REAL_PROSE });
eq('source', ranking.source, 'cache-prose');

console.log('\n[3] THE BUG: rope-drop across the real trip (D1 DL, D2 DL, D3 DCA), real exclusions');
const excluded = new Set(["Grizzly River Run","Finding Nemo","Roger Rabbit's Car Toon Spin"].map(normRideName));
const trip = assignRopeDropsAcrossDays({
  days:[{park:'DL'},{park:'DL'},{park:'DCA'}], ranking, excludedNorm: excluded });
eq('Day1 = Peter Pan (DL #1)', trip[0].name, "Peter Pan's Flight");
eq('Day2 = Rise (DL #2, no repeat)', trip[1].name, "Rise of the Resistance");
eq('Day3 = Radiator Springs (DCA #1)', trip[2].name, "Radiator Springs Racers");

console.log('\n[4] cross-day memory is PER PARK (a 4th DCA day advances to Guardians)');
const trip4 = assignRopeDropsAcrossDays({
  days:[{park:'DL'},{park:'DL'},{park:'DCA'},{park:'DCA'}], ranking, excludedNorm: excluded });
eq('Day4 = Guardians (DCA #2)', trip4[3].name, "Guardians of the Galaxy \u2013 Mission: BREAKOUT!");

console.log('\n[5] exclusions respected (if Peter Pan were excluded, DL day -> Rise)');
const exclPP = new Set(["Peter Pan's Flight"].map(normRideName));
const pick = pickRopeDrop({ park:'DL', ranking, excludedNorm: exclPP, usedPriorNorm: new Set() });
eq('excluded #1 -> #2', pick.name, "Rise of the Resistance");

console.log('\n[6] closures respected (Radiator Springs closed -> Guardians on a DCA day)');
const pickC = pickRopeDrop({ park:'DCA', ranking, excludedNorm:new Set(), usedPriorNorm:new Set(),
  isAvailable:(n)=> normRideName(n)!==normRideName("Radiator Springs Racers") });
eq('closed #1 -> #2', pickC.name, "Guardians of the Galaxy \u2013 Mission: BREAKOUT!");

console.log('\n[7] MEAL peak windows: 12-1 and 5-6 forbidden, edges correct');
eq('12:00 forbidden', isMealTimeForbidden(720), true);
eq('12:59 forbidden', isMealTimeForbidden(779), true);
eq('1:00 allowed', isMealTimeForbidden(780), false);
eq('5:30 forbidden (the Day2 bug)', isMealTimeForbidden(1050), true);
eq('6:00 allowed', isMealTimeForbidden(1080), false);
eq('11:30 allowed', isMealTimeForbidden(690), false);

console.log('\n[8] MEAL relocation: real conflicts move to nearest allowed clean slot');
eq('5:30 dinner -> 6:00 (nearest allowed, 6-7 is fine)', nearestAllowedMealMin(1050), 1080);
eq('Day2: dinner bounded after 5:00 tour-end -> 6:00', nearestAllowedMealMin(1050,{minBound:1020}), 1080);
eq('12:30 lunch -> 1:00', nearestAllowedMealMin(750), 780);
eq('result is allowed (dinner)', isMealTimeForbidden(nearestAllowedMealMin(1050)), false);
eq('result is allowed (lunch)', isMealTimeForbidden(nearestAllowedMealMin(750)), false);
eq('non-conflict 7:00 stays 7:00', nearestAllowedMealMin(1140), 1140);

console.log('\n[9] BREAK note text always matches actual time (10 AM != "afternoon")');
eq('10:00 AM -> morning note', breakNoteForMin(600).startsWith('Quick morning'), true);
eq('10:50 AM -> morning note (was the bug)', breakNoteForMin(650).startsWith('Quick morning'), true);
eq('2:00 PM -> afternoon note', breakNoteForMin(840).startsWith('Afternoon'), true);
eq('8:00 PM -> evening note', breakNoteForMin(1200).startsWith('Evening'), true);

console.log('\n==== '+pass+' passed, '+fail+' failed ====');
process.exit(fail? 1 : 0);
