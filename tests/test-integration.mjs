// Replicates the v2 rope-drop block logic to verify end-to-end with the REAL config day shape.
import { getRopeDropRanking, normRideName } from '../api/schedule-rules.js';
import { assignRopeDropsAcrossDays } from '../api/schedule-skeleton.js';

let pass=0, fail=0;
const eq=(n,g,w)=>{const a=JSON.stringify(g),b=JSON.stringify(w);if(a===b){pass++;console.log('  PASS '+n);}else{fail++;console.log('  FAIL '+n+'\n    got '+a+'\n    want '+b);}};

const REAL_PROSE =
"ROPE DROP PRIORITY \u2014 RANKED LISTS (global default; vary by day, never repeat a park's rope-drop across days).\n\n"+
"DISNEYLAND order: 1) Peter Pan's Flight 2) Rise of the Resistance 3) Space Mountain 4) Mickey & Minnie's Runaway Railway 5) Indiana Jones Adventure.\n\n"+
"DCA order: 1) Radiator Springs Racers 2) Guardians of the Galaxy \u2013 Mission: BREAKOUT! 3) Web Slingers 4) Incredicoaster 5) Toy Story Midway Mania!\n\n"+
"RULE: rope-drop highest-ranked unused per park.";
const sections = { ROPE_DROP_STRATEGY: REAL_PROSE };

// REAL trip config day shape (park field as the live blob has it; day3 starts DCA then hops)
const tripConfig = { days:[
  { park:'Disneyland', intent:{startPark:'DL'} },
  { park:'Disneyland', intent:{startPark:'DL'} },
  { park:'DCA', intent:{startPark:'DCA'} },
], ridePreferences:{ skip:["Grizzly River Run","Finding Nemo","Roger Rabbit's Car Toon Spin"] } };

// minimal catalog incl. the ranked rides (name + land) so canonical lookup resolves
const catalog = { attractions:[
  {name:"Peter Pan's Flight", land:'Fantasyland', park:'DL'},
  {name:"Rise of the Resistance", land:"Galaxy's Edge", park:'DL'},
  {name:"Radiator Springs Racers", land:'Cars Land', park:'DCA'},
]};

// --- replicate the v2 block for each dayIndex ---
function computeOpener(dayIndex){
  const ranking = getRopeDropRanking(sections);
  const excludedNorm = new Set(((((tripConfig.ridePreferences||{}).skip)||tripConfig.neverSchedule||[])||[]).map(normRideName));
  const attrByNorm = new Map();
  (catalog.attractions||[]).forEach(a=>attrByNorm.set(normRideName(a.name),a));
  const dayParks = tripConfig.days.map(d=>({park:(/dca|california/i.test((d&&(d.startPark||d.park))||'')?'DCA':'DL')}));
  const dayDates = tripConfig.days.map(()=>null);
  const isAvailableForDay = (idx,name)=>{ const a=attrByNorm.get(normRideName(name)); return a?true:true; };
  const assignment = assignRopeDropsAcrossDays({ days:dayParks, ranking, excludedNorm, isAvailableForDay });
  const myPick = assignment[dayIndex];
  const attr = myPick && attrByNorm.get(normRideName(myPick.name));
  return { name: myPick && myPick.name, canonical: attr?attr.name:(myPick&&myPick.name), land: attr&&attr.land };
}

console.log('\n[INTEGRATION] v2 rope-drop block with REAL config day shape, per dayIndex');
eq('dayIndex 0 (DL) -> Peter Pan', computeOpener(0).canonical, "Peter Pan's Flight");
eq('dayIndex 1 (DL) -> Rise (no repeat)', computeOpener(1).canonical, "Rise of the Resistance");
eq('dayIndex 2 (DCA) -> Radiator Springs', computeOpener(2).canonical, "Radiator Springs Racers");
eq('day0 land resolved from catalog', computeOpener(0).land, 'Fantasyland');
eq('day2 park derived from "DCA" park field', computeOpener(2).canonical, "Radiator Springs Racers");

console.log('\n==== '+pass+' passed, '+fail+' failed ====');
process.exit(fail?1:0);
