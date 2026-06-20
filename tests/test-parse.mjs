import { normRideName } from '../api/schedule-rules.js';
// --- copy of extractFirstJsonArray (must mirror v2) ---
function extractFirstJsonArray(text){
  if(!text) return null;
  const start=text.indexOf('['); if(start===-1) return null;
  let depth=0,inStr=false,esc=false;
  for(let i=start;i<text.length;i++){const c=text[i];
    if(inStr){if(esc)esc=false;else if(c==='\\')esc=true;else if(c==='"')inStr=false;continue;}
    if(c==='"'){inStr=true;continue;}
    if(c==='[')depth++; else if(c===']'){depth--;if(depth===0)return text.slice(start,i+1);}}
  return null;
}
const strip = t => t.trim().replace(/^```json\s*/,'').replace(/\s*```$/,'');
let pass=0,fail=0;
const ok=(n,c)=>{if(c){pass++;console.log('  PASS '+n);}else{fail++;console.log('  FAIL '+n);}};

console.log('\n[P] robust JSON extraction');
// clean array
ok('clean array parses', JSON.parse(extractFirstJsonArray(strip('```json\n[{"a":1},{"b":2}]\n```'))).length===2);
// array + trailing prose containing a bracket (the Day-2 failure shape)
let d2='```json\n[{"t":"8:00 AM","h":"Rise"},{"t":"9:00 AM","h":"X"}]\n```\nNote: the guide leads [skip-the-line] during the tour.';
const ex2=extractFirstJsonArray(strip(d2));
ok('array+trailing prose -> extracts just the array', ex2==='[{"t":"8:00 AM","h":"Rise"},{"t":"9:00 AM","h":"X"}]');
ok('array+trailing prose parses to 2 items', JSON.parse(ex2).length===2);
// old approach would FAIL on this (demonstrate the contrast)
let oldFails=false; try{ const s=strip(d2); JSON.parse(s.substring(s.indexOf('['), s.lastIndexOf(']')+1)); }catch(e){ oldFails=true; }
ok('old indexOf/lastIndexOf approach DID fail here', oldFails);
// brackets inside string values must not break depth
ok('brackets inside strings handled', JSON.parse(extractFirstJsonArray('[{"n":"ride [A] then [B]"},{"n":"ok"}]')).length===2);
// second array later in text is ignored
ok('second array ignored', JSON.parse(extractFirstJsonArray('[{"a":1}] junk [{"b":2}]')).length===1);
// truncated array -> null (caller leaves parsed null, no throw)
ok('truncated array -> null', extractFirstJsonArray('[{"a":1},{"b":2')===null);

console.log('\n[R] robust _isReserved (the Cafe Orleans fix)');
const _resList=[{name:'Cafe Orleans', time:'5:30pm', day:3}];
const _reservedNames=Array.from(new Set(_resList.map(r=>normRideName((r&&(typeof r==='string'?r:(r.name||r.venue)))||'')).filter(Boolean)));
const _isReserved=(it)=>{ if(!it)return false; if(it.isReserved===true||it.isConfirmed===true)return true; if(/reservation/i.test(String(it.h||'')))return true; const n=normRideName(it.h); return !!n&&_reservedNames.some(rn=>rn&&(n.indexOf(rn)!==-1||rn.indexOf(n)!==-1)); };
ok('Cafe Orleans -- Dinner Reservation IS reserved (label)', _isReserved({h:'Cafe Orleans \u2014 Dinner Reservation', type:'dining'})===true);
ok('substring match works too', _isReserved({h:'Cafe Orleans', type:'dining'})===true);
ok('a normal app meal is NOT reserved', _isReserved({h:'Pym Test Kitchen', type:'quickservice'})===false);
ok('flagged item is reserved', _isReserved({h:'Whatever', isReserved:true})===true);

console.log('\n==== '+pass+' passed, '+fail+' failed ====');
process.exit(fail?1:0);
