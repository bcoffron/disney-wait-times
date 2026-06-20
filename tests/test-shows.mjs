import { assignShowsAcrossDays, applyShowAssignment, isFireworksNight, normShowName, DEFAULT_SHOWS } from '../api/schedule-shows.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL: ' + m); } };
const names = arr => (arr || []).map(s => s.name + '@' + s.t);

// real trip blocks (post-hop-back physics)
const D1 = { dayIndex: 0, dateISO: '2026-06-28', blocks: [ // Sun: DL am -> DCA 1pm -> hop-back DL 10pm
  { park:'DL', startMin:480, endMin:780 }, { park:'DCA', startMin:780, endMin:1320 }, { park:'DL', startMin:1320, endMin:1440, hopBack:true } ], vip:null };
const D2 = { dayIndex: 1, dateISO: '2026-06-29', blocks: [ // Mon: VIP 10-5, DL am -> DCA -> hop-back DL 10pm
  { park:'DL', startMin:480, endMin:780 }, { park:'DCA', startMin:780, endMin:1320 }, { park:'DL', startMin:1320, endMin:1440, hopBack:true } ], vip:{ startMin:600, endMin:1020 } };
const D3 = { dayIndex: 2, dateISO: '2026-06-30', blocks: [ // Tue: DCA am -> DL 1pm (ends in later-closing DL, no hop-back)
  { park:'DCA', startMin:480, endMin:780 }, { park:'DL', startMin:780, endMin:1440 } ], vip:null };

console.log('== assignment on the real itinerary (default catalog) ==');
const A = assignShowsAcrossDays({ days: [D1, D2, D3], showsData: null });
console.log('  D1:', names(A[0]));
console.log('  D2:', names(A[1]));
console.log('  D3:', names(A[2]));
ok(A[0].length === 1 && /World of Color/.test(A[0][0].name) && A[0][0].t === '9:00 PM', 'D1 = World of Color 9:00 PM');
ok(A[1].length === 1 && /Fantasmic/.test(A[1][0].name) && A[1][0].t === '10:30 PM', 'D2 = Fantasmic 10:30 PM (late, after hop-back)');
ok(A[2].length === 2, 'D3 has 2 shows');
ok(A[2].some(s => /Paint the Night/.test(s.name) && s.t === '8:45 PM'), 'D3 has Paint the Night 8:45 PM');
ok(A[2].some(s => /Wondrous Journeys/.test(s.name) && s.t === '9:35 PM'), 'D3 has Wondrous Journeys 9:35 PM');

// NO TRIP-WIDE REPEATS
const all = [...A[0], ...A[1], ...A[2]].map(s => normShowName(s.name));
ok(new Set(all).size === all.length, 'no show repeats anywhere in the trip');
// fireworks only where group is in DL at showtime AND it is a fireworks night
const fw = [...A[0], ...A[1], ...A[2]].filter(s => s.type === 'fireworks');
ok(fw.length === 1 && fw[0].name.includes('Wondrous'), 'exactly one fireworks show, on the DL-evening night');

console.log('== fireworks-night gating ==');
ok(isFireworksNight('2026-06-30', DEFAULT_SHOWS.fireworksRule) === true, 'Jun 30 (summer) = fireworks night');
ok(isFireworksNight('2026-06-28', DEFAULT_SHOWS.fireworksRule) === true, 'Jun 28 (summer) = fireworks night');
ok(isFireworksNight('2026-02-10', DEFAULT_SHOWS.fireworksRule) === false, 'Feb 10 (Tue, off-season) = NO fireworks');
ok(isFireworksNight('2026-02-13', DEFAULT_SHOWS.fireworksRule) === true, 'Feb 13 (Fri, off-season weekend) = fireworks');

console.log('== fireworks NOT forced on a non-fireworks night ==');
const A2 = assignShowsAcrossDays({ days: [
  { ...D3, dateISO: '2026-02-10' } // a non-fireworks Tuesday in DL evening
], showsData: null });
ok(!A2[2].some(s => s.type === 'fireworks'), 'no fireworks card when the night has no fireworks');

console.log('== canonical name match (cross-day accumulation) ==');
ok(normShowName('World of Color - Happiness!') === normShowName('World of Color'), 'WoC editions normalize equal');
ok(normShowName('Fantasmic! at Disneyland') === normShowName('Fantasmic!'), 'Fantasmic location suffix normalizes equal');

console.log('== applyShowAssignment strips improvised/duplicate shows + inserts assigned (Day 3) ==');
const modelDay3 = [
  { t:'8:00 AM', h:'Rope Drop: Radiator Springs Racers', type:'ride', n:'go' },
  { t:'12:30 PM', h:'Lunch at Carthay Circle', type:'dining', n:'eat' },
  { t:'9:00 PM', h:'Disneyland Forever Fireworks', type:'show', n:'wrong name, improvised' }, // outdated -> strip
  { t:'9:15 PM', h:'World of Color', type:'show', n:'wrong park for DL night -> strip' },
  { t:'10:15 PM', h:'Big Thunder Mountain', type:'ride', n:'late ride keep' }
];
const R = applyShowAssignment(modelDay3, A[2]);
ok(R.stripped.length === 2, 'stripped the 2 model show cards');
ok(R.inserted.length === 2, 'inserted the 2 assigned shows');
ok(R.parsed.some(it => it.type==='ride' && /Radiator/.test(it.h)), 'kept rope-drop ride');
ok(R.parsed.some(it => it.type==='dining' && /Carthay/.test(it.h)), 'kept dining (never stripped)');
ok(R.parsed.some(it => it.type==='ride' && /Big Thunder/.test(it.h)), 'kept late ride');
ok(!R.parsed.some(it => /Disneyland Forever/.test(it.h)), 'improvised fireworks name removed');
const showsInOrder = R.parsed.filter(it => it.type==='show').map(it => it.h + '@' + it.t);
console.log('  final shows on D3:', showsInOrder);
ok(showsInOrder.length === 2 && /Paint the Night/.test(showsInOrder[0]) && /Wondrous/.test(showsInOrder[1]), 'D3 shows are Paint the Night then Wondrous Journeys, time-sorted');
// time order sanity: parade 8:45 before fireworks 9:35, both before 10:15 ride
const times = R.parsed.map(it => it.t);
const idxParade = R.parsed.findIndex(it => /Paint the Night/.test(it.h));
const idxRideLate = R.parsed.findIndex(it => /Big Thunder/.test(it.h));
ok(idxParade < idxRideLate, 'parade card sorts before the 10:15 PM ride');

console.log('');

// ---- REGRESSION: real tripConfig uses DISPLAY-format dates ("Jun 30, 2026"), not ISO ----
console.log('== regression: display-format dates ("Jun 30, 2026") still gate fireworks ==');
const Ddisp = assignShowsAcrossDays({ days: [
  { dayIndex:0, dateISO:'Jun 28, 2026', blocks: D1.blocks, vip:null },
  { dayIndex:1, dateISO:'Jun 29, 2026', blocks: D2.blocks, vip:{startMin:600,endMin:1020} },
  { dayIndex:2, dateISO:'Jun 30, 2026', blocks: D3.blocks, vip:null }
], showsData:null });
ok(Ddisp[2].some(s => /Wondrous Journeys/.test(s.name) && s.type==='fireworks'), 'display-date Jun 30 -> Wondrous Journeys fireworks assigned on Day 3');
ok(Ddisp[0].some(s=>/World of Color/.test(s.name)) && Ddisp[1].some(s=>/Fantasmic/.test(s.name)) && Ddisp[2].some(s=>/Paint the Night/.test(s.name)), 'display-date assignment matches ISO assignment');
ok(isFireworksNight('Jun 30, 2026', DEFAULT_SHOWS.fireworksRule) === true, 'isFireworksNight parses display format');

console.log(fail === 0 ? ('ALL ' + pass + ' SHOW TESTS PASS') : (pass + ' pass / ' + fail + ' FAIL'));
process.exit(fail === 0 ? 0 : 1);
