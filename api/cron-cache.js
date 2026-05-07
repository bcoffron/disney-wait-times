const { put, list } = require('@vercel/blob');
const VALID_KEYS = ['park_intel','dining_intel','events_intel','park_hours_intel'];
const EXPIRY_DAYS = {park_intel:10,dining_intel:30,events_intel:7,park_hours_intel:7};
const PROMPTS = {
  park_intel:{system:'Disneyland expert. 2024-2026 only.',user:'Search TouringPlans AllEars MiceChat 2025-2026 for current Disneyland rope drop strategy, Lightning Lane Multi Pass order, late June crowds, top 10 tips, best times per land. Dense actionable guide.',maxTokens:1500},
  dining_intel:{system:'Disneyland dining expert. 2024-2026 only.',user:'Search Disney Food Blog AllEars 2024-2026. Blue Bayou Cafe Orleans Bengal Barbecue Mint Julep (DL). Carthay Circle Lamplight Lounge Flos V8 (DCA). Rating must-orders reservation tips each.',maxTokens:1500},
  events_intel:{system:'Disneyland events expert.',user:'Special events Disneyland June 25 - July 5 2026: ticketed events, closures, July 4th, shows, fireworks. Specific dates.',maxTokens:800},
  park_hours_intel:{system:'Return ONLY valid JSON.',user:'Disneyland DCA hours June 25 - July 5 2026. ONLY: {"YYYY-MM-DD":{"dl":{"open":"HH:MM","close":"HH:MM"},"dca":{"open":"HH:MM","close":"HH:MM"}}}',maxTokens:1000}
};

// Rate limit: track last manual trigger in blob
const RATE_LIMIT_KEY = 'twize/rate_limit.json';
const RATE_LIMIT_HOURS = 24;

async function isRateLimited() {
  try {
    const {blobs} = await list({prefix:'twize/rate_limit'});
    if (!blobs||!blobs.length) return false;
    const blob = blobs.sort((a,b)=>new Date(b.uploadedAt)-new Date(a.uploadedAt))[0];
    const data = await (await fetch(blob.url)).json();
    if (!data||!data.ts) return false;
    const hoursAgo = (Date.now()-data.ts)/3600000;
    return hoursAgo < RATE_LIMIT_HOURS;
  } catch(e) { return false; }
}

async function setRateLimit() {
  try {
    await put(RATE_LIMIT_KEY, JSON.stringify({ts:Date.now()}), {access:'public',addRandomSuffix:false,contentType:'application/json'});
  } catch(e) {}
}

async function isFresh(key) {
  try {
    const {blobs} = await list({prefix:'twize/'+key});
    if(!blobs||!blobs.length) return false;
    const blob = blobs.sort((a,b)=>new Date(b.uploadedAt)-new Date(a.uploadedAt))[0];
    const data = await (await fetch(blob.url)).json();
    return data&&data.ts&&(Date.now()-data.ts)/864e5 < EXPIRY_DAYS[key]*0.8;
  } catch(e){return false;}
}

async function build(key,apiKey) {
  const p=PROMPTS[key],useSearch=key!=='park_hours_intel';
  const resp=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:p.maxTokens,system:p.system,tools:useSearch?[{type:'web_search_20250305',name:'web_search'}]:[],messages:[{role:'user',content:p.user}]})});
  const d=await resp.json();
  if(d.error) throw new Error(d.error.message);
  let text='';for(const b of(d.content||[]))if(b.type==='text')text+=b.text;
  if(text.length<50) throw new Error('Too short');
  let value=text;
  if(key==='park_hours_intel'){const m=text.replace(/```[^]*?```/g,'').match(/\{[\s\S]+\}/);if(m)try{value=JSON.parse(m[0]);}catch(e){}}
  await put('twize/'+key+'.json',JSON.stringify({value,ts:Date.now()}),{access:'public',addRandomSuffix:false,contentType:'application/json'});
  return {key,length:typeof text==='string'?text.length:0};
}

module.exports = async function(req,res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(200).end();

  // Auth check - allow if secret matches OR if not rate limited (open GET)
  const secret = process.env.CRON_SECRET;
  const isAuthed = secret && req.headers.authorization === 'Bearer '+secret;
  const isVercelCron = req.headers['x-vercel-cron'] === '1';

  // For unauthenticated requests, enforce rate limit
  if (!isAuthed && !isVercelCron) {
    const limited = await isRateLimited();
    if (limited) {
      return res.status(429).json({error:'Rate limited - caches were rebuilt within the last 24 hours. Try again later.'});
    }
    await setRateLimit();
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey) return res.status(500).json({error:'No API key configured'});

  const keys = req.query.key ? [req.query.key] : VALID_KEYS;
  const results=[],errors=[];

  for(const k of keys){
    if(!VALID_KEYS.includes(k)){errors.push({key:k,error:'Invalid key'});continue;}
    if(await isFresh(k)){results.push({key:k,skipped:true,reason:'Still fresh'});continue;}
    try{results.push(await build(k,apiKey));}catch(e){errors.push({key:k,error:e.message});}
  }

  return res.status(200).json({ok:true,results,errors,ts:new Date().toISOString()});
};