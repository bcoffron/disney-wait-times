import { appendEveningHopBack, whichParkAt } from '../api/schedule-engine.js';
let pass=0,fail=0;
const eq=(n,g,w)=>{const a=JSON.stringify(g),b=JSON.stringify(w);if(a===b){pass++;console.log('  PASS '+n);}else{fail++;console.log('  FAIL '+n+'\n    got '+a+'\n    want '+b);}};

const PH = { DL:{openMin:480,closeMin:1440}, DCA:{openMin:480,closeMin:1320} }; // DL midnight, DCA 10pm

console.log('\n[H] appendEveningHopBack');
// Day 1 & 2 shape: DL morning -> DCA afternoon (ends in DCA, the earlier-closing park)
const d1 = [{park:'DL',startMin:480,endMin:780},{park:'DCA',startMin:780,endMin:1320}];
const d1h = appendEveningHopBack(d1, PH);
eq('Day1/2 gets a 3rd DL evening block', d1h.length, 3);
eq('hop-back block is DL 1320-1440', d1h[2], {park:'DL',startMin:1320,endMin:1440,hopBack:true});
eq('original blocks not mutated', d1.length, 2);

// Day 3 shape: DCA morning -> DL afternoon (already ends in DL, the later-closing park)
const d3 = [{park:'DCA',startMin:480,endMin:780},{park:'DL',startMin:780,endMin:1440}];
eq('Day3 unchanged (already ends in later park)', appendEveningHopBack(d3, PH).length, 2);

// single-park day
eq('single-park day unchanged', appendEveningHopBack([{park:'DL',startMin:480,endMin:1440}], PH).length, 1);

// when closes are equal-ish (within minGap), no hop-back
const PHclose = { DL:{closeMin:1380}, DCA:{closeMin:1320} }; // only 60 min apart -> NOT > 60
eq('closes within minGap -> no hop-back', appendEveningHopBack(d1, PHclose).length, 2);
const PHwide = { DL:{closeMin:1410}, DCA:{closeMin:1320} }; // 90 min apart -> hop-back
eq('closes >60 apart -> hop-back', appendEveningHopBack(d1, PHwide).length, 3);

// unknown hours -> unchanged
eq('null hours -> unchanged', appendEveningHopBack(d1, null).length, 2);

console.log('\n[H2] whichParkAt with the 3-block day (guard correctness)');
eq('10:00am -> DL (morning)', whichParkAt(d1h, 600), 'DL');
eq('3:00pm -> DCA (afternoon)', whichParkAt(d1h, 900), 'DCA');
eq('11:00pm -> DL (evening hop-back)', whichParkAt(d1h, 1380), 'DL');
eq('past midnight clamps to DL', whichParkAt(d1h, 1500), 'DL');

console.log('\n==== '+pass+' passed, '+fail+' failed ====');
process.exit(fail?1:0);
