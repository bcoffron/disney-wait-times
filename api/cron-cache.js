const { put, list } = require('@vercel/blob');
const VALID_KEYS = ['park_intel','dining_intel','events_intel','park_hours_intel','character_intel'];
const EXPIRY_DAYS = {park_intel:10,dining_intel:30,events_intel:7,park_hours_intel:7,character_intel:7};
const PROMPTS = {
park_intel:{system:'Disneyland expert. 2024-2026 only.',user:'Search TouringPlans AllEars MiceChat 2025-2026 for current Disneyland rope drop strategy, Lightning Lane Multi Pass order, late June crowds, top 10 tips, best times per land. Dense actionable guide.\n\n## 📸 ICONIC PHOTO OP SPOTS Include a dedicated section covering the top 10–15 must-do photo op locations at Disneyland and DCA. For each spot include: - Location name and which land it\'s in - Best time of day (morning light, golden hour, after dark, etc.) - What to frame in the shot - How crowded it gets and when to go for the cleanest shot Cover both parks. Include: Sleeping Beauty Castle (morning and night), Main Street Hub, Big Thunder Mountain from Rivers of America, New Orleans Square balconies at golden hour, Tomorrowland with Space Mountain, Matterhorn from Fantasyland, Star Wars: Galaxy\'s Edge Millennium Falcon, Cars Land at night (DCA), Pixar Pier boardwalk, Pixar Pal-A-Round, Guardians of the Galaxy exterior, Avengers Campus, Buena Vista Street.',maxTokens:1500},
dining_intel:{system:'Disneyland dining expert. 2024-2026 only.',user:'Search Disney Food Blog AllEars 2024-2026. Blue Bayou Cafe Orleans Bengal Barbecue Mint Julep (DL). Carthay Circle Lamplight Lounge Flos V8 (DCA). Rating must-orders reservation tips each.',maxTokens:1500},
events_intel:{system:'Disneyland events expert.',user:'Special events Disneyland June 25 - July 5 2026: ticketed events, closures, July 4th, shows, fireworks. Specific dates.',maxTokens:800},
park_hours_intel:{system:'Return ONLY valid JSON, no markdown, no explanation.',user:'Search disneylandresort.com or isitpagdisney.com for Disneyland and DCA hours June 25 to July 5 2026. Return ONLY this exact JSON format: {"YYYY-MM-DD":{"dl":{"open":"HH:MM","close":"HH:MM"},"dca":{"open":"HH:MM","close":"HH:MM"}}} for all 11 dates.',maxTokens:1000},
character_intel:{system:'Disneyland character meet and greet expert. 2024-2026 only.',user:'Search AllEars MiceChat DisneyTouristBlog 2024-2026 for current Disneyland character meet and greet information. For each character return valid JSON including: name, category (princess|classic|starWars|marvel|pixar|villain|other), location, typicalWindows (array of time ranges), typicalWait (minutes), vipAccessible (boolean), locationType (indoor|outdoor), seasonal (boolean), seasonalNote (string or null), notes. Include a top-level disclaimer field: "Character schedules are planned in advance but can change without notice. Check with a cast member on the day." Return only valid JSON. No preamble or markdown.',maxTokens:1500}
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function isFresh(key) {
try {
const {blobs} = await list({prefix:'twize/'+key});
if(!blobs||!blobs.length) return false;
const blob = blobs.sort((a,b)=>new Date(b.uploadedAt)-new Date(a.uploadedAt))[0];
const fetchUrl = blob.downloadUrl||blob.url;
const data = await (await fetch(fetchUrl)).json();
return data&&data.ts&&(Date.now()-data.ts)/864e5 < EXPIRY_DAYS[key]*0.8;
} catch(e){return false;}
}

async function blobStore(key, data) {
const blob = await put('twize/'+key+'.json', JSON.stringify(data), {
access:'public',
addRandomSuffix:false,
contentType:'application/json',
allowOverwrite:true
});
return blob.url;
}

async function build(key, apiKey) {
const p=PROMPTS[key], useSearch=true;
const resp = await fetch('https://api.anthropic.com/v1/messages', {
method:'POST',
headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:p.maxTokens,system:p.system,tools:useSearch?[{type:'web_search_20250305',name:'web_search'}]:[],messages:[{role:'user',content:p.user}]})
});
const d = await resp.json();
if(d.error) throw new Error(d.error.message);
let text='';
for(const b of (d.content||[])) if(b.type==='text') text+=b.text;
if(text.length<50) throw new Error('Response too short');
let value = text;
if(key==='park_hours_intel'||key==='character_intel') {
const m = text.replace(/```[^]*?```/g,'').match(/\{[\s\S]+\}/);
if(m) try{value=JSON.parse(m[0]);}catch(e){}
}
await blobStore(key, {data:value, ts:Date.now()});
return {key, length:text.length};
}

const RATE_LIMIT_KEY = 'twize/rate_limit.json';

async function isRateLimited() {
try {
const {blobs} = await list({prefix:'twize/rate_limit'});
if(!blobs||!blobs.length) return false;
const blob = blobs.sort((a,b)=>new Date(b.uploadedAt)-new Date(a.uploadedAt))[0];
const fetchUrl = blob.downloadUrl||blob.url;
const data = await (await fetch(fetchUrl)).json();
return data&&data.ts&&(Date.now()-data.ts)/3600000 < 24;
} catch(e){return false;}
}

async function setRateLimit() {
try {
await put(RATE_LIMIT_KEY, JSON.stringify({ts:Date.now()}), {access:'public',addRandomSuffix:false,contentType:'application/json',allowOverwrite:true});
} catch(e){}
}

module.exports = async function(req,res) {
res.setHeader('Access-Control-Allow-Origin','*');
res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
if(req.method==='OPTIONS') return res.status(200).end();

const secret = process.env.CRON_SECRET;
const isAuthed = secret && req.headers.authorization === 'Bearer '+secret;
const isVercelCron = req.headers['x-vercel-cron'] === '1';

if(!isAuthed && !isVercelCron && !req.query.key) {
const limited = await isRateLimited();
if(limited) return res.status(429).json({error:'Rate limited - try again in 24 hours'});
await setRateLimit();
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if(!apiKey) return res.status(500).json({error:'No ANTHROPIC_API_KEY'});

const keys = req.query.key ? [req.query.key] : VALID_KEYS;
const results=[], errors=[];

for(const k of keys) {
if(!VALID_KEYS.includes(k)){errors.push({key:k,error:'Invalid key'});continue;}
if(await isFresh(k)){results.push({key:k,skipped:true});continue;}
try {
const blobUrl = await build(k, apiKey); results.push({key:k, length:blobUrl.length||0, blobUrl});
} catch(e) {
errors.push({key:k, error:e.message});
}
// Wait 25 seconds between builds to avoid rate limits
if(keys.indexOf(k) < keys.length-1) {
console.log('Waiting 65s before next cache build...');
await sleep(65000);
}
}

return res.status(200).json({ok:true,results,errors,ts:new Date().toISOString()});
};
