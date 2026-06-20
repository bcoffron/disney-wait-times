import { normRideName } from '../api/schedule-rules.js';
import { enforceExclusions } from '../api/schedule-corrections.js';
let pass=0,fail=0;
const ok=(n,c)=>{if(c){pass++;console.log('  PASS '+n);}else{fail++;console.log('  FAIL '+n);}};

console.log('\n[X] enforceExclusions hard output-side guarantee (real skip list)');
const excludedNorm = new Set(["Grizzly River Run","Finding Nemo","Roger Rabbit's Car Toon Spin"].map(normRideName));
const items = [
  {t:'9:00 AM', type:'ride', h:"Radiator Springs Racers"},
  {t:'10:00 AM', type:'ride', h:"Roger Rabbit's Car Toon Spin"},     // excluded exact -> remove
  {t:'11:00 AM', type:'ride', h:"Finding Nemo Submarine Voyage"},    // excluded substring -> remove
  {t:'12:00 PM', type:'tip', h:"Heads up: Grizzly River Run gets you soaked"}, // tip -> KEEP (not an attraction card)
  {t:'1:00 PM', type:'ride', h:"Incredicoaster"},                    // keep
];
const r = enforceExclusions(items, { excludedNorm });
const present = r.items.map(x=>x.h);
ok('Roger Rabbit removed', !present.includes("Roger Rabbit's Car Toon Spin"));
ok('Finding Nemo Submarine Voyage removed (substring match)', !present.includes("Finding Nemo Submarine Voyage"));
ok('Radiator Springs kept', present.includes("Radiator Springs Racers"));
ok('Incredicoaster kept', present.includes("Incredicoaster"));
ok('non-attraction tip is NOT removed', present.some(h=>/Grizzly River Run gets you soaked/.test(h)));
ok('removed exactly 2', r.removed.length===2);
ok('empty exclusion set -> no-op', enforceExclusions(items,{excludedNorm:new Set()}).items.length===items.length);

console.log('\n==== '+pass+' passed, '+fail+' failed ====');
process.exit(fail?1:0);
