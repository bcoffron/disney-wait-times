import { put, list, del } from '@vercel/blob';

const SOURCE_AUTHORITY = `
VERIFIED SOURCES — use in priority order. Last 2 years only.
BY SECTION:
- Wait time data: TouringPlans.com, MickeyVisit.com
- Crowd calendars: TouringPlans.com, UndercoverTourist.com
- Touring/rope drop strategy: TouringPlans.com, UndercoverTourist.com, Unofficial Guide (Len Testa)
- Lightning Lane: AllEars.net, TouringPlans.com
- Dining: DisneyFoodBlog.com, AllEars.net
- Closures/hours: Disneyland.com (official), AllEars.net
- General strategy: DisneyTouristBlog.com, UndercoverTourist.com
- Guest experiences: Reddit r/Disneyland (last 2 years only)
- Park news: MickeyVisit.com, AllEars.net
UNIVERSAL RULES:
1. NEVER: Genie+, MaxPass, FastPass terminology
2. ALWAYS: Lightning Lane Multi Pass (LLMP), Individual Lightning Lane (ILL)
3. Specific numbers required — "60-90 min by 10 AM on summer Sundays"
4. No AI preamble — start with actual content immediately
5. No hedging — state consensus confidently
6. Complete sentences only — no truncation
7. When sources conflict — use primary source for that section
`;

const VALID_KEYS = [
  'park_intel','dining_intel','events_intel','park_hours_intel','character_intel',
  'park_intel_dl_stable','park_intel_dl_dynamic',
  'park_intel_wdw_stable','park_intel_wdw_dynamic'
];

const EXPIRY_DAYS = {
  park_intel:10, dining_intel:30, events_intel:7, park_hours_intel:7, character_intel:7,
  park_intel_dl_stable:30, park_intel_dl_dynamic:7,
  park_intel_wdw_stable:30, park_intel_wdw_dynamic:7
};

const LEGACY_PROMPTS = {
  park_intel:{system:'Disneyland expert. 2024-2026 only.',user:'Search TouringPlans AllEars MiceChat 2025-2026 for current Disneyland rope drop strategy, Lightning Lane Multi Pass order, late June crowds, top 10 tips, best times per land. Dense actionable guide.',maxTokens:1500},
  dining_intel:{system:'Disneyland dining expert. 2024-2026 only.',user:'Search Disney Food Blog AllEars 2024-2026. Blue Bayou Cafe Orleans Bengal Barbecue Mint Julep (DL). Carthay Circle Lamplight Lounge Flos V8 (DCA). Rating must-orders reservation tips each.',maxTokens:1500},
  events_intel:{system:'Disneyland events expert.',user:'Special events Disneyland June 25 - July 5 2026: ticketed events, closures, July 4th, shows, fireworks. Specific dates.',maxTokens:800},
  park_hours_intel:{system:'Return ONLY valid JSON, no markdown, no explanation.',user:'Search disneylandresort.com or isitpagdisney.com for Disneyland and DCA hours June 25 to July 5 2026. Return ONLY this exact JSON format: {"YYYY-MM-DD":{"dl":{"open":"HH:MM","close":"HH:MM"},"dca":{"open":"HH:MM","close":"HH:MM"}}} for all 11 dates.',maxTokens:1000},
  character_intel:{system:'Disneyland character meet and greet expert. 2024-2026 only.',user:'Search AllEars MiceChat DisneyTouristBlog 2024-2026 for current Disneyland character meet and greet information. Return only valid JSON.',maxTokens:6000}
};

const STABLE_SECTION_PROMPTS = {
  LAND_MAP:{
    system:'You are a Disneyland mapping expert with current 2025-2026 knowledge. Return precise structured JSON only.',
    user:`Search for the current Disneyland park map (2025-2026) and return a complete JSON land map covering all 8 lands: Main Street USA, Fantasyland, Tomorrowland, Adventureland, New Orleans Square, Frontierland, Star Wars Galaxy's Edge, Mickey's Toontown. For each land include: adjacent lands array, attractions array (every ride/show/walkthrough). Include walking_minutes between land pairs and current_refurbs with expected return dates. Confirm Pirates of the Caribbean status. Format: {"lands":{"LandName":{"adjacent":[...],"attractions":[...],"notes":"..."}},"walking_minutes":{"Land A to Land B":minutes},"current_refurbs":{"attraction":"expected_return"}}`,
    maxTokens:2500
  },
  WAIT_PATTERNS:{
    system:'You are a Disneyland wait time expert using TouringPlans and Thrill-Data 2024-2026 data. Provide specific numbers confidently.',
    user:`Search TouringPlans.com and Thrill-Data.com for Disneyland wait time patterns 2024-2026. Return typical wait times for top attractions across time blocks and crowd levels. Time blocks: rope_drop(open-9AM), early(9-11AM), midday(11AM-1PM), afternoon(1-4PM), lull(4-6PM), evening(6-9PM), late(9PM+). Crowd levels: light(Mon-Thu off-peak), moderate(Mon-Thu summer), heavy(Fri-Sun summer), extreme(holidays). Cover 30 attractions across DL and DCA: Rise of the Resistance, Millennium Falcon Smugglers Run, Indiana Jones Adventure, Haunted Mansion, Space Mountain, Matterhorn Bobsleds, Big Thunder Mountain Railroad, Star Tours, Buzz Lightyear Astro Blasters, Roger Rabbit Car Toon Spin, Mickey Minnie Runaway Railway, Peter Pan Flight, Its a Small World, Alice in Wonderland, Mr Toads Wild Ride, Snow Whites Enchanted Wish, Jungle Cruise, Finding Nemo Submarine, Autopia, Chip Dale Gadget Coaster, WEB-SLINGERS Spider-Man, Radiator Springs Racers, Guardians of the Galaxy, Incredicoaster, Toy Story Midway Mania, Soarin Around the World, Luigis Rollickin Roadsters, Maters Junkyard Jamboree, Pixar Pal-A-Round, Monsters Inc Mike and Sulley. Format as JSON: {"attraction_name":{"crowd_level":{"time_block":wait_minutes}}}`,
    maxTokens:4000
  },
  CROWD_FLOW:{
    system:'You are a Disneyland crowd behavior expert. 2024-2026 specific knowledge. Be specific and actionable.',
    user:`Search TouringPlans, AllEars, and r/Disneyland for Disneyland crowd flow patterns on summer days. Describe hour-by-hour crowd behavior for a typical summer weekday and weekend. Cover: pre-opening crowd build at main gate; rope drop rush which lands fill first; morning prime 9-11AM crowd distribution; midday peak 11AM-2PM what to avoid; afternoon lull 2-4PM which rides benefit; parade effect on wait times before during after; fireworks pre-show 8-9PM crowd movement; post-fireworks window 9:15-10PM which rides drop dramatically; late night last hour. Include DCA-specific patterns. Give specific examples with actual wait time changes like Indiana Jones drops from 75 to 25 min during fireworks. Write as flowing descriptive prose sections.`,
    maxTokens:2000
  },
  ROPE_DROP_STRATEGY:{
    system:'You are a Disneyland rope drop strategy expert. 2024-2026 knowledge. Specific advice for a group of 9.',
    user:`Search TouringPlans, KennyThePirate.com, and r/Disneyland for the best Disneyland and DCA rope drop strategies 2024-2026. Provide a comprehensive rope drop guide for a group of 9 people including children. For Disneyland cover THREE paths: Path A Fantasyland first (Peter Pan then other classic rides then Matterhorn); Path B Adventureland first (Indiana Jones then Haunted Mansion area); Path C Tomorrowland and Galaxy Edge first (Space Mountain then Rise of the Resistance). For each path: exact attraction sequence with realistic timing, which path wins on light vs heavy crowd days, walk-in time needed before official park open, how boarding group system affects Rise of the Resistance if applicable, what to do in the 10-10:30AM window after rope drop completes, how to handle a group of 9 moving together. Cover DCA rope drop separately: Radiator Springs Racers strategy which reaches 90-120 min by 10AM, Guardians timing, best DCA morning sequence. Include Early Entry tips if staying onsite and recommended arrival time at main gate for summer weekend.`,
    maxTokens:2000
  },
  LIGHTNING_LANE_STRATEGY:{
    system:'You are a Disneyland Lightning Lane strategy expert. 2025-2026 only. Never use Genie+, FastPass, or MaxPass terminology. Only Lightning Lane Multi Pass (LLMP) and Individual Lightning Lane (ILL).',
    user:`Search AllEars, TouringPlans, and DisneyFoodBlog for current Disneyland Lightning Lane Multi Pass and Individual Lightning Lane strategy 2025-2026. Cover: Which rides at Disneyland are Individual Lightning Lane (pay per ride per person) vs Lightning Lane Multi Pass; current ILL price range for each eligible attraction; LLMP per-person price range for summer June dates; how LLMP booking works and when it opens (7AM resort guests); optimal booking order for a summer day at DL starting at 7AM; for a group of 9 the total ILL cost per attraction and when standby beats ILL; which rides should never use LL because waits are consistently short; best afternoon LLMP stacking strategy for evening rides; DCA LL strategy separately; any 2025-2026 changes to the LL system. Use only LLMP and ILL terminology throughout.`,
    maxTokens:2000
  },
  WALKING_ROUTES:{
    system:'You are a Disneyland navigation expert with detailed knowledge of shortcuts, back routes, and optimal routing for groups.',
    user:`Provide a comprehensive walking and routing guide for Disneyland and DCA with a focus on navigating as a group of 9 people. Cover: key shortcuts and back routes including the back route from Tomorrowland through the castle to Fantasyland, the Frontierland to Adventureland shortcut via Rivers of America, getting from Galaxy Edge to New Orleans Square quickly, DCA internal routing from Cars Land to Avengers Campus; land-to-land transition times realistic for a group from main gate to each land and between adjacent lands, how parade route closures affect routing; group of 9 routing tips including stroller management through the park, staying together at attractions, meeting point strategy if group splits; accessibility routing for wheelchair and ECV including alternate entrances; efficiency tips including which direction to traverse park, how to use the Disneyland app for live routing, best restroom locations by land to minimize detour time; any current 2025-2026 construction detours or reroutes.`,
    maxTokens:2000
  },
  DINING_TIMING:{
    system:'You are a Disneyland dining expert with current 2025-2026 knowledge. Give specific actionable advice.',
    user:`Search DisneyFoodBlog, AllEars, and r/Disneyland for Disneyland and DCA dining strategy 2025-2026 for a group of 9. Cover Quick Service timing: best QS restaurants at Disneyland by land with shortest waits and fastest mobile order fulfillment; optimal lunch window eat at 11AM or after 1:30PM which QS locations work best at each time; which QS restaurants have consistently long mobile order waits; QS spots that can seat 9 people together. Table service strategy: which TS restaurants take walk-ups (Blue Bayou, Carthay Circle etc) and when walk-ups work; which restaurants require reservations booked 60 days advance; for a group of 9 which restaurants can accommodate and reservation strategy. Mobile order tips: best time to place order, which QS has fastest pickup, mobile order vs walking up when each is better. Best snacks by land: must-try quick snacks at each land including Mint Julep Bar, Bengal Barbecue, Jolly Holiday, Lamplight Lounge apps. DCA dining: Lamplight Lounge walk-up vs reservation, Carthay Circle, Cars Land options, Pacific Wharf QS.`,
    maxTokens:2000
  },
  SHOW_AND_ENTERTAINMENT:{
    system:'You are a Disneyland entertainment expert. 2025-2026 knowledge of shows, parades, and fireworks.',
    user:`Search AllEars, official Disneyland site, and r/Disneyland for current entertainment at Disneyland and DCA 2025-2026. Cover Paint the Night Parade: current schedule if running in summer 2026, best viewing spots with trade-offs, how early to arrive, impact on wait times during parade. Fantasmic: current showtimes and frequency, viewing strategy river side vs hill side, is dining package worth it for group of 9, best time to arrive for each viewing area. Wondrous Journeys fireworks or current fireworks show: show name schedule best viewing spots in park. World of Color at DCA: how virtual viewing area works, is preferred viewing package worth it, best position, timing relative to DCA closing. The post-show ride window: which rides see dramatic wait drops during fireworks with specific numbers, the 20-30 minute window after fireworks ends which rides to target, same analysis after Fantasmic. Character shows and live entertainment: current regular shows on Main Street, Mickey Toontown character experience.`,
    maxTokens:2000
  },
  FAMILY_AND_ACCESSIBILITY:{
    system:'You are a Disneyland family and accessibility expert with current 2025-2026 knowledge.',
    user:`Search AllEars, TouringPlans, and r/Disneyland for family and accessibility information at Disneyland and DCA 2025-2026. Cover height restrictions: list every major ride with exact height requirement in inches, rides with no height requirement good for all ages, rides with partial restrictions some seats OK. Rider swap child swap: exactly how it works at Disneyland including how to request it and whether it works with Lightning Lane. DAS Disability Access Service: how to apply DAS Advance vs at park, which rides benefit most, how it interacts with Lightning Lane, any 2025-2026 changes to DAS system. Best rides for under 40 inch guests: complete list with why each is great for small children. Best for all ages including grandparents: rides and experiences that delight everyone from 3 to 80. Stroller info: parking locations by land, size restrictions, stroller as wheelchair option. Quiet areas and breaks: where to find quiet spots when kids are overwhelmed, baby care center location and services, best air-conditioned spots for midday break.`,
    maxTokens:2000
  },
  PHOTO_AND_EXPERIENCE:{
    system:'You are a Disneyland photography and hidden gems expert. 2025-2026 knowledge.',
    user:`Search TheDisneylandBlog, AllEars, and r/Disneyland for best photo locations, character meets, and hidden gems at Disneyland and DCA 2025-2026. Cover best photo locations by land and time of day with for each: land name, best time of day morning golden hour after dark, what to frame, crowd level impact. Locations to cover: Sleeping Beauty Castle morning light vs golden hour vs after dark projections; Main Street USA park opening walk and hub area; Big Thunder Mountain from Rivers of America; New Orleans Square balconies at golden hour; Matterhorn from Fantasyland; Millennium Falcon exterior in Galaxy Edge; Cars Land at night with neon signs; Pixar Pier boardwalk and Pal-A-Round; Avengers Campus; Buena Vista Street DCA entrance. Character meet locations and typical waits: Mickey and Minnie in Toontown, princesses current meet locations, Star Wars characters in Galaxy Edge, Marvel characters in Avengers Campus, which meets have longest waits vs are walk-up friendly, character dining options. Hidden gems and details most guests miss: interactive elements kids love, best off the beaten path experiences, Easter eggs on attractions.`,
    maxTokens:2000
  },
  PARK_HOP_STRATEGY:{
    system:'You are a Disneyland park hopping strategy expert. 2025-2026 knowledge.',
    user:`Search TouringPlans, AllEars, and r/Disneyland for Disneyland Resort park hopping strategy 2025-2026 for guests with DL and DCA tickets. Cover: when park hopping opens each day confirm current time usually after 11AM; best time to hop DL to DCA and DCA to DL; how park hopping affects LL bookings can you use DL LLs at DCA. Direction strategy: when to start at DL morning and hop to DCA afternoon vs starting at DCA morning and hopping to DL afternoon evening; for a group doing both parks which split makes most sense summer weekday vs weekend. Transportation between parks: walking route through Downtown Disney how long, monorail option current route, any shuttle between parks. Half day priorities: if only have DCA afternoon 4 hours what are non-negotiables; if only have DL evening 4 hours what to prioritize; for fireworks which park to be in. LL strategy for park hoppers: how to maximize LL across both parks, which park LL to book first, can you book LLs at second park before hopping.`,
    maxTokens:1500
  },
  WEATHER_AND_COMFORT:{
    system:'You are a Disneyland comfort and logistics expert with specific knowledge of June weather in Anaheim CA.',
    user:`Search weather data and Disneyland guest forums for June weather patterns and comfort strategies at Disneyland 2024-2026. Cover June weather: typical temperature range for late June highs lows morning vs afternoon, June Gloom phenomenon what it is and when it clears, humidity levels, rain probability in late June how rare, what to pack. Heat strategy: best shade routes through the park by land, best indoor air-conditioned rides for hot afternoon breaks, misting areas locations, indoor shows and experiences for midday cool-down, water refill stations where and if refills are free. Sunscreen and comfort: application spots locations near first aid, staying hydrated free water options. What to wear: comfortable shoes, layering strategy for morning cool and afternoon heat, what not to wear. If it rains: where to get ponchos cost and locations, which rides still operate in light rain, what closes in rain, note that crowds thin significantly. Evening comfort: temperature drop after dark bring a layer, best strategy for fireworks viewing comfort.`,
    maxTokens:1500
  }
};

const DYNAMIC_SECTION_PROMPTS = {
  CURRENT_CLOSURES:{
    system:'You are a Disneyland current operations expert. Only use confirmed 2025-2026 information. Be specific about status and expected return dates.',
    user:`Search disneylandresort.com, AllEars.net, and TouringPlans.com for ALL current ride closures and refurbishments at Disneyland and DCA as of today 2026. For each closed or refurbished attraction provide: attraction name and park DL or DCA, closure type scheduled refurbishment unplanned seasonal or permanent, expected reopening date if known or best estimate, what caused the closure if known, alternative recommendation for guests who planned to ride it. Pay special attention to Pirates of the Caribbean current status and expected return date. List any major E-ticket closures. Note any new closures announced for summer 2026. Format as clear readable text that could be read to a guest planning their visit.`,
    maxTokens:1500
  },
  SPECIAL_EVENTS:{
    system:'You are a Disneyland special events expert. Focus specifically on June 28-30 2026.',
    user:`Search Disneyland official site, AllEars, and MiceChat for special events hard ticket events seasonal overlays or entertainment changes at Disneyland Resort during or surrounding June 28-30 2026. Investigate: Disneyland 70th Anniversary the park opens July 17 2026 (opened July 17 1955) are there summer 2026 anniversary celebrations starting before July 17 what special entertainment decorations or experiences happening in late June; Summer 2026 events any summer-specific entertainment special dining events or unique experiences; 4th of July proximity June 28-30 is just before July 4th week are there any early celebrations starting that weekend any extra fireworks or patriotic overlays; Hard ticket events any separately ticketed evening events that would affect park access on June 28-30; Entertainment changes any shows or parades recently added changed or removed for summer 2026. Be specific with dates. Note if something was announced but not yet confirmed.`,
    maxTokens:1500
  },
  CURRENT_LL_PRICING:{
    system:'You are a Disneyland Lightning Lane pricing expert. Current 2025-2026 pricing only. Never use Genie+ terminology.',
    user:`Search AllEars, TouringPlans, and official Disneyland sources for current Lightning Lane pricing at Disneyland Resort 2025-2026. Provide: Individual Lightning Lane ILL which specific attractions are ILL at Disneyland not LLMP with current price range per person for each and for a group of 9 the total cost, price range for a peak summer day late June early July. Lightning Lane Multi Pass LLMP: current per-person price range for Disneyland LLMP in late June 2026, current per-person price range for DCA LLMP, combined price if purchasing for both parks. Recent changes: any changes to LL system in 2025-2026, new attractions added or removed from LL, any pricing changes from previous year. Booking tips: when prices are lowest vs highest within a day, whether to buy LLMP at park open or wait, multi-day ticket LL discounts if any. Use only Lightning Lane Multi Pass LLMP and Individual Lightning Lane ILL terminology throughout.`,
    maxTokens:1200
  },
  TRIP_CONTEXT:{
    system:'You are a brilliant specific Disneyland trip advisor writing for a specific group: 9 guests, June 28-30 2026, Disneyland plus DCA, park hopping, Day 2 June 29 is a VIP tour. Write in warm specific confident voice like a knowledgeable friend who has been dozens of times. No generic advice. Be specific to these exact dates this group size and this itinerary.',
    user:`Search for Disneyland crowd predictions, historical patterns, and any known events for June 28-30 2026. Write a personalized trip context for 9 guests with June 28 Sunday at Disneyland, June 29 Monday at Disneyland with VIP Tour, June 30 Tuesday at Disney California Adventure.

Write three day-specific briefings in warm brilliant-friend voice:

DAY 1 JUNE 28 SUNDAY: Crowd level assessment explaining Sunday June 28 will be your most crowded day with specific reasons (weekend, pre-4th week, summer). Give a specific rope drop strategy for a group of 9 naming exactly which rides to target first second third. Warn about specific pain points for this day. Give 2-3 specific insider tips for surviving a heavy crowd Sunday.

DAY 2 JUNE 29 MONDAY VIP TOUR: Explain what the VIP tour changes about the day. Realistic expectations your guide handles all queuing and routing your job is to show up and have fun. Note the crowd difference between Sunday and Monday. Tips for working with the VIP guide.

DAY 3 JUNE 30 TUESDAY DCA: Crowd level assessment explaining Tuesday is reliably one of the least crowded days of summer. Specific DCA rope drop strategy for a group of 9 naming exactly which rides to target in order. Specific DCA dining recommendations for a group of 9. Best World of Color viewing strategy. What time to consider park hopping back to DL if they want.

GROUP NOTES for 9 guests: best quick service restaurants that can seat 9 together, rider swap strategy for height-restricted rides, meeting point strategy in each park, app tips for managing a group of 9.

End with one sentence that captures the whole trip and gets them excited.`,
    maxTokens:3000
  }
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
    access:'public', addRandomSuffix:false, contentType:'application/json', allowOverwrite:true
  });
  return blob.url;
}

function extractJson(text) {
  const fenceMatch = text.match(/\`\`\`(?:json)?\s*([\s\S]+?)\s*\`\`\`/);
  if(fenceMatch) { try { return JSON.parse(fenceMatch[1]); } catch(e) {} }
  const jsonStart = text.indexOf('{', text.indexOf('\`\`\`') >= 0 ? text.indexOf('\`\`\`') : 0);
  if(jsonStart < 0) return null;
  const candidate = text.substring(jsonStart);
  try { return JSON.parse(candidate); } catch(e) {}
  return null;
}

async function callClaude(prompt, apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:prompt.maxTokens,system:prompt.system,tools:[{type:'web_search_20250305',name:'web_search'}],messages:[{role:'user',content:prompt.user}]})
  });
  const d = await resp.json();
  if(d.error) throw new Error(d.error.message);
  let text='';
  for(const b of (d.content||[])) if(b.type==='text') text+=b.text;
  if(text.length<100) throw new Error('Response too short: '+text.length+' chars');
  return text;
}

// Build a single section and merge into existing blob
async function buildSingleSection(cacheKey, sectionName, apiKey) {
  const isStable = cacheKey.includes('stable');
  const promptMap = isStable ? STABLE_SECTION_PROMPTS : DYNAMIC_SECTION_PROMPTS;
  if(!promptMap[sectionName]) throw new Error('Unknown section: '+sectionName);
  
  const prompt = promptMap[sectionName];
  const augmentedPrompt = Object.assign({}, prompt, {user: SOURCE_AUTHORITY + '

Now build the ' + sectionName + ' section:

' + prompt.user});
    const text = await callClaude(augmentedPrompt, apiKey);
  
  let sectionData;
  if(sectionName==='LAND_MAP'||sectionName==='WAIT_PATTERNS') {
    const parsed = extractJson(text);
    sectionData = parsed || text;
  } else {
    sectionData = text;
  }
  
  // Read existing blob to merge
  let existingCache = null;
  try {
    const {blobs} = await list({prefix:'twize/'+cacheKey+'.json'});
    if(blobs&&blobs.length) {
      const blob = blobs[0];
      const fetchUrl = blob.downloadUrl||blob.url;
      existingCache = await (await fetch(fetchUrl)).json();
    }
  } catch(e) { console.log('No existing cache, starting fresh'); }
  
  const isStableCache = cacheKey.includes('stable');
  const cacheData = existingCache || {
    built_at:new Date().toISOString(),
    park:'Disneyland',
    cache_type: isStableCache ? 'stable' : 'dynamic',
    trip_code: isStableCache ? null : 'BCDIS2026',
    sections:{},
    section_meta:{}
  };
  
  if(!cacheData.sections) cacheData.sections={};
  if(!cacheData.section_meta) cacheData.section_meta={};
  
  cacheData.sections[sectionName] = sectionData;
  cacheData.section_meta[sectionName] = {built:true, length:text.length, built_at:new Date().toISOString()};
  cacheData.last_section_built = sectionName;
  cacheData.last_updated = new Date().toISOString();
  cacheData.sections_built = Object.values(cacheData.section_meta).filter(m=>m.built).length;
  
  await blobStore(cacheKey, cacheData);
  
  return {
    section:sectionName,
    length:text.length,
    sections_built:cacheData.sections_built,
    sample: (typeof sectionData === 'string' ? sectionData : JSON.stringify(sectionData)).substring(0,400)
  };
}

async function buildLegacy(key, apiKey) {
  const p=LEGACY_PROMPTS[key];
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:p.maxTokens,system:p.system,tools:[{type:'web_search_20250305',name:'web_search'}],messages:[{role:'user',content:p.user}]})
  });
  const d = await resp.json();
  if(d.error) throw new Error(d.error.message);
  let text='';
  for(const b of (d.content||[])) if(b.type==='text') text+=b.text;
  if(text.length<50) throw new Error('Response too short');
  let value = text;
  if(key==='park_hours_intel'||key==='character_intel') {
    const parsed = extractJson(text);
    if(parsed) value = parsed;
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

export default async function handler(req, res) {
  // AUTH FIRST — before anything else, before any imports or blob calls
  const secret = process.env.CRON_SECRET;
  const isAuthed = secret && req.headers.authorization === ('Bearer '+secret);
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  if (!isAuthed && !isVercelCron) {
    console.warn('[cron-cache] Unauthorized request blocked — ip:', req.headers['x-forwarded-for'] || 'unknown');
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(200).end();

  // Auth already handled at top of function

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey) return res.status(500).json({error:'No ANTHROPIC_API_KEY'});

  // ── DAILY RUN CAP ────────────────────────────────────────────────────────
  // Track how many times cron has run today via Vercel Blob
  // Max 2 runs per day to prevent runaway costs
  try {
    const today = new Date().toISOString().split('T')[0];
    const capKey = 'twize/daily_run_count_' + today + '.json';
    const { blobs: capBlobs } = await list({ prefix: 'twize/daily_run_count_' + today });
    let runCount = 0;
    if (capBlobs && capBlobs.length) {
      const capData = await (await fetch(capBlobs[0].downloadUrl || capBlobs[0].url)).json();
      runCount = capData.count || 0;
    }
    if (runCount >= 2) {
      console.warn('[cron-cache] Daily run cap reached (' + runCount + ' runs today) — aborting');
      return res.status(429).json({ error: 'Daily run cap reached. Max 2 cron runs per day.' });
    }
    await put(capKey, JSON.stringify({ count: runCount + 1, lastRun: new Date().toISOString() }), {
      access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true
    });
    console.log('[cron-cache] Daily run count:', runCount + 1);
  } catch(capErr) {
    console.warn('[cron-cache] Could not check run cap:', capErr.message);
  }
  // ─────────────────────────────────────────────────────────────────────────

  const force = req.query.force === '1';
  const requestedKey = req.query.key;
  const requestedSection = req.query.section;

  // ── SECTION-BY-SECTION BUILD MODE ──
  // GET /api/cron-cache?key=park_intel_dl_stable&section=LAND_MAP&force=1
  if(requestedKey && (requestedKey.includes('_dl_') || requestedKey.includes('_wdw_')) && requestedSection) {
    if(!VALID_KEYS.includes(requestedKey)) return res.status(400).json({error:'Invalid key'});
    try {
      const result = await buildSingleSection(requestedKey, requestedSection, apiKey);
      return res.status(200).json({ok:true, ...result, ts:new Date().toISOString()});
    } catch(e) {
      return res.status(500).json({ok:false, section:requestedSection, error:e.message});
    }
  }

  // ── LEGACY KEYS ──
  const legacyKeys = requestedKey ? [requestedKey] : ['park_intel','dining_intel','events_intel','park_hours_intel'];
  const results=[], errors=[];

  for(const k of legacyKeys) {
    if(!VALID_KEYS.includes(k)){errors.push({key:k,error:'Invalid key'});continue;}
    if(!LEGACY_PROMPTS[k]){errors.push({key:k,error:'No prompt for key'});continue;}
    if(!force && await isFresh(k)){results.push({key:k,skipped:true});continue;}
    if(force) {
      try {
        const {blobs} = await list({prefix:'twize/'+k+'.json'});
        if(blobs&&blobs.length) await del(blobs.map(b=>b.url));
      } catch(e){}
    }
    try {
      const blobUrl = await buildLegacy(k, apiKey);
      results.push({key:k, length:blobUrl.length||0});
    } catch(e) {
      errors.push({key:k, error:e.message});
    }
    if(legacyKeys.indexOf(k) < legacyKeys.length-1) {
      console.log('Waiting 65s before next cache build...');
      await sleep(65000);
    }
  }

  return res.status(200).json({ok:true,results,errors,ts:new Date().toISOString()});
};
