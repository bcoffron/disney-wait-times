const { put, list, del } = require('@vercel/blob');

// ─────────────────────────────────────────────────────────────
// VALID KEYS — keep legacy keys + new two-cache architecture
// ─────────────────────────────────────────────────────────────
const VALID_KEYS = [
  'park_intel',
  'dining_intel',
  'events_intel',
  'park_hours_intel',
  'character_intel',
  'park_intel_dl_stable',
  'park_intel_dl_dynamic',
  'park_intel_wdw_stable',
  'park_intel_wdw_dynamic'
];

// Expiry in days for each key
const EXPIRY_DAYS = {
  park_intel: 10,
  dining_intel: 30,
  events_intel: 7,
  park_hours_intel: 7,
  character_intel: 7,
  park_intel_dl_stable: 30,
  park_intel_dl_dynamic: 7,
  park_intel_wdw_stable: 30,
  park_intel_wdw_dynamic: 7
};

// ─────────────────────────────────────────────────────────────
// LEGACY PROMPTS — kept unchanged for backward compatibility
// ─────────────────────────────────────────────────────────────
const LEGACY_PROMPTS = {
  park_intel: {system:'Disneyland expert. 2024-2026 only.',user:'Search TouringPlans AllEars MiceChat 2025-2026 for current Disneyland rope drop strategy, Lightning Lane Multi Pass order, late June crowds, top 10 tips, best times per land. Dense actionable guide.\n\n## 📸 ICONIC PHOTO OP SPOTS Include a dedicated section covering the top 10–15 must-do photo op locations at Disneyland and DCA.',maxTokens:1500},
  dining_intel: {system:'Disneyland dining expert. 2024-2026 only.',user:'Search Disney Food Blog AllEars 2024-2026. Blue Bayou Cafe Orleans Bengal Barbecue Mint Julep (DL). Carthay Circle Lamplight Lounge Flos V8 (DCA). Rating must-orders reservation tips each.',maxTokens:1500},
  events_intel: {system:'Disneyland events expert.',user:'Special events Disneyland June 25 - July 5 2026: ticketed events, closures, July 4th, shows, fireworks. Specific dates.',maxTokens:800},
  park_hours_intel: {system:'Return ONLY valid JSON, no markdown, no explanation.',user:'Search disneylandresort.com or isitpagdisney.com for Disneyland and DCA hours June 25 to July 5 2026. Return ONLY this exact JSON format: {"YYYY-MM-DD":{"dl":{"open":"HH:MM","close":"HH:MM"},"dca":{"open":"HH:MM","close":"HH:MM"}}} for all 11 dates.',maxTokens:1000},
  character_intel: {system:'Disneyland character meet and greet expert. 2024-2026 only.',user:'Search AllEars MiceChat DisneyTouristBlog 2024-2026 for current Disneyland character meet and greet information. Return only valid JSON.',maxTokens:6000}
};

// ─────────────────────────────────────────────────────────────
// STABLE CACHE SECTION PROMPTS — 12 sections
// Terminology: ALWAYS use Lightning Lane Multi Pass (LLMP) and
// Individual Lightning Lane (ILL). NEVER use Genie+, FastPass, MaxPass.
// Sources: TouringPlans, Thrill-Data, AllEars, KennyThePirate,
//          DisneyFoodBlog, TheDisneylandBlog, r/Disneyland (2024-2026 only)
// ─────────────────────────────────────────────────────────────
const STABLE_SECTION_PROMPTS = {

  LAND_MAP: {
    system: 'You are a Disneyland mapping expert with current 2025-2026 knowledge. Return precise, structured JSON only.',
    user: `Search for the current Disneyland park map (2025-2026) and return a complete JSON land map. Include ALL 8 lands: Main Street USA, Fantasyland, Tomorrowland, Adventureland, New Orleans Square, Frontierland, Star Wars Galaxy's Edge, Mickey's Toontown. For each land include: adjacent lands, and every attraction (rides, shows, walkthrough experiences). Include accurate walking_minutes between all land pairs. Confirm current refurbishment status of Pirates of the Caribbean and any other closed attractions. Return as structured JSON matching this format:
{
  "lands": { "LandName": { "adjacent": [...], "attractions": [...], "notes": "..." } },
  "walking_minutes": { "Land A→Land B": minutes },
  "current_refurbs": { "attraction": "expected_return" }
}
Be thorough — include every attraction guests can experience. Note any seasonal or limited-time closures.`,
    maxTokens: 2000
  },

  WAIT_PATTERNS: {
    system: 'You are a Disneyland wait time analysis expert using TouringPlans and Thrill-Data historical data 2024-2026. Be specific with actual numbers.',
    user: `Search TouringPlans.com and Thrill-Data.com for Disneyland wait time patterns (2024-2026 data). Provide typical wait times for the top 30 attractions across different crowd levels and time blocks.

Time blocks: rope_drop (park open to 9AM), early (9-11AM), midday (11AM-1PM), afternoon (1-4PM), lull (4-6PM), evening (6-9PM), late (9PM+)
Crowd levels: light (Mon-Thu off-peak), moderate (Mon-Thu summer), heavy (Fri-Sun summer), extreme (holidays/events)

Cover all 30 attractions:
Disneyland: Rise of the Resistance, Millennium Falcon Smugglers Run, Indiana Jones Adventure, Haunted Mansion, Space Mountain, Matterhorn Bobsleds, Big Thunder Mountain Railroad, Star Tours, Buzz Lightyear Astro Blasters, Roger Rabbit's Car Toon Spin, Mickey and Minnie's Runaway Railway, Peter Pan's Flight, It's a Small World, Alice in Wonderland, Mr Toad's Wild Ride, Snow White's Enchanted Wish, Jungle Cruise, Finding Nemo Submarine Voyage, Autopia, Chip n Dale Gadget Coaster
DCA: WEB-SLINGERS A Spider-Man Adventure, Radiator Springs Racers, Guardians of the Galaxy Mission Breakout, Incredicoaster, Toy Story Midway Mania, Soarin Around the World, Luigi's Rollickin Roadsters, Mater's Junkyard Jamboree, Pixar Pal-A-Round, Monsters Inc Mike and Sulley

Return as JSON: { "attraction_name": { "crowd_level": { "time_block": wait_minutes } } }
State numbers confidently based on consensus data. Note if an attraction is typically low-wait regardless of crowds.`,
    maxTokens: 4000
  },

  CROWD_FLOW: {
    system: 'You are a Disneyland crowd behavior expert with 2024-2026 knowledge. Be specific and actionable.',
    user: `Search TouringPlans, AllEars, and r/Disneyland for Disneyland crowd flow patterns. Describe hour-by-hour crowd behavior for a typical summer weekday and weekend day.

Cover:
1. Pre-opening (before rope drop): parking, security, main gate crowd build
2. Rope drop rush (park open to 9AM): which lands fill first, where crowds surge
3. Morning prime (9-11AM): crowd distribution across the park
4. Midday peak (11AM-2PM): highest wait times, where to avoid, what still has short waits
5. Afternoon lull (2-4PM): which rides benefit most, the nap/hotel strategy
6. Parade effect: how Paint the Night Parade affects wait times before/during/after
7. Fireworks pre-show (8-9PM): crowd movement toward Main Street hub
8. Post-fireworks window (9:15-10PM): which rides drop dramatically
9. Late night (last hour): wait times, crowd behavior
10. DCA-specific patterns: how DCA crowds differ from DL

Include specific examples: 'Indiana Jones wait drops from 75 min to 25 min during fireworks' etc.
Write as flowing prose sections, not lists.`,
    maxTokens: 2000
  },

  ROPE_DROP_STRATEGY: {
    system: 'You are a Disneyland rope drop strategy expert. 2024-2026 knowledge. Your advice is for a group of 9 including children.',
    user: `Search TouringPlans, KennyThePirate, and r/Disneyland for the best rope drop strategies at Disneyland and DCA (2024-2026).

Provide a comprehensive rope drop guide for a group of 9 people (mixed ages, including children):

DISNEYLAND ROPE DROP - THREE PATHS:
Path A: Fantasyland first (Peter Pan, Seven Dwarfs area attractions, then Matterhorn)
Path B: Adventureland/New Orleans Square first (Indiana Jones, then Haunted Mansion area)
Path C: Tomorrowland/Galaxy's Edge first (Space Mountain, then Rise of the Resistance)

For each path:
- Exact sequence of attractions with realistic timing
- Which path wins on light vs heavy crowd days
- Walk-in time needed before official park open (15 min? 30 min? 45 min?)
- How the virtual queue or boarding group system affects Rise of the Resistance
- What to do in the 10-10:30AM window after your rope drop sequence completes
- How to handle the group of 9 moving together efficiently

DCA ROPE DROP:
- Radiator Springs Racers strategy (goes to 90-120 min by 10AM)
- Guardians of the Galaxy and Incredicoaster timing
- Best sequence for DCA morning

Also cover: Early Entry benefit (if staying at Disneyland hotel), what time to arrive at main gate for a summer weekend.`,
    maxTokens: 2000
  },

  LIGHTNING_LANE_STRATEGY: {
    system: 'You are a Disneyland Lightning Lane strategy expert. 2025-2026 knowledge only. Never use Genie+, FastPass, or MaxPass terminology.',
    user: `Search AllEars, TouringPlans, and DisneyFoodBlog for current Disneyland Lightning Lane Multi Pass (LLMP) and Individual Lightning Lane (ILL) strategy (2025-2026).

Cover:
1. ILL ATTRACTIONS at Disneyland: Which rides are Individual Lightning Lane (pay per person per ride)? Current typical prices. Which ILL rides are worth it for a group of 9 vs just riding standby?
2. LLMP STRATEGY: How Lightning Lane Multi Pass works. What time bookings open (7AM for resort guests, park open for day guests). Which rides to book first. When you can book your next LLMP after using one.
3. BOOKING ORDER for a summer day at DL: First booking at 7AM should be... then...
4. GROUP OF 9 COST IMPLICATIONS: Total ILL cost for a family of 9 on Rise of the Resistance. At what point does the cost become unreasonable vs standby?
5. SKIP LL STRATEGY: Which rides never need LL (usually short waits). When standby is the better choice.
6. LLMP STACKING: Best afternoon LL stack for maximizing evening rides.
7. DCA LL STRATEGY: Same breakdown for Disney California Adventure.
8. PRICE RANGE: Current LLMP per-person price for summer June dates.

Use ONLY current terminology: Lightning Lane Multi Pass (LLMP), Individual Lightning Lane (ILL). Never Genie+.`,
    maxTokens: 2000
  },

  WALKING_ROUTES: {
    system: 'You are a Disneyland navigation expert with detailed knowledge of park layout, shortcuts, and routing.',
    user: `Provide a comprehensive walking and routing guide for Disneyland and DCA, specific to navigating as a group of 9 people.

Cover:
1. KEY SHORTCUTS AND BACK ROUTES:
   - The back route from Tomorrowland through the castle to Fantasyland
   - The Frontierland-to-Adventureland shortcut via the Rivers of America
   - Getting from Galaxy's Edge to New Orleans Square quickly
   - The DCA internal routing from Cars Land to Avengers Campus

2. LAND-TO-LAND TRANSITION TIMES (realistic, with a group):
   - Main gate to each land (walking time in minutes)
   - Between all adjacent land pairs
   - Impact of parade route closure on routing (which paths get blocked)

3. GROUP OF 9 ROUTING TIPS:
   - Stroller management through the park
   - Staying together at attractions with multiple ride vehicles
   - Meeting point strategy if the group splits

4. ACCESSIBILITY ROUTING:
   - Wheelchair/ECV accessible routes between all lands
   - Attractions with alternate entrances
   - Areas to avoid with mobility aids

5. EFFICIENCY TIPS:
   - Which direction to traverse the park (clockwise vs counterclockwise)
   - How to use the Disneyland app map for live routing
   - Best restroom locations by land to minimize detour time

Be specific with time estimates. Include any current construction detours or reroutes in 2025-2026.`,
    maxTokens: 2000
  },

  DINING_TIMING: {
    system: 'You are a Disneyland dining expert with current 2025-2026 knowledge. Specific, actionable advice.',
    user: `Search DisneyFoodBlog, AllEars, and r/Disneyland for Disneyland and DCA dining strategy (2025-2026).

Provide a comprehensive dining timing guide for a group of 9:

QUICK SERVICE TIMING:
- Best QS restaurants at Disneyland by land (which have shortest wait, best food, fastest mobile order fulfillment)
- Optimal lunch window: eat at 11AM OR after 1:30PM to avoid peak — which QS locations work best at each time
- Which QS restaurants have consistently long mobile order waits even when "accepted"
- QS spots that can seat 9 people together (large group seating)

TABLE SERVICE STRATEGY:
- Which Disneyland TS restaurants can take walk-ups (Blue Bayou, Carthay, etc. — when does it work?)
- When you MUST have a reservation (60-day advance booking window for which restaurants?)
- For a group of 9: which restaurants can accommodate? Reservation strategy.

MOBILE ORDER TIPS:
- Best time to place mobile order (before you're hungry)
- Which QS restaurants have fastest pickup
- Mobile order vs walking up: when each is better

BEST SNACKS BY LAND:
- Must-try quick snacks at each land (Mint Julep Bar, Bengal Barbecue, Jolly Holiday, Lamplight Lounge apps, etc.)
- Best value vs most popular

DCA DINING:
- Lamplight Lounge (walk-up vs reservation strategy)
- Carthay Circle (worth it?)
- Cars Land dining options
- Pacific Wharf QS options`,
    maxTokens: 2000
  },

  SHOW_AND_ENTERTAINMENT: {
    system: 'You are a Disneyland entertainment and show scheduling expert. 2025-2026 knowledge.',
    user: `Search AllEars, Disneyland official site, and r/Disneyland for current entertainment at Disneyland and DCA (2025-2026).

Cover:
1. PAINT THE NIGHT PARADE (if running):
   - Current schedule (days/times it runs in summer 2026)
   - Best viewing spots with trade-offs (Main Street hub vs other locations)
   - How early to arrive to get a good spot
   - Impact on wait times: which rides get shorter during parade?

2. FANTASMIC:
   - Current showtimes and frequency
   - Viewing strategy: River side vs hill side
   - Is the Fantasmic dining package worth it for a group of 9?
   - Best time to arrive for each viewing area

3. WONDROUS JOURNEYS FIREWORKS (or current fireworks show):
   - Current show name and schedule
   - Best viewing spots in the park
   - How to balance fireworks viewing with ride time

4. WORLD OF COLOR (DCA):
   - How the virtual viewing area system works
   - Is the preferred viewing package worth it?
   - Best position within the viewing area
   - Timing relative to DCA closing

5. THE POST-SHOW RIDE WINDOW:
   - Which rides see dramatic wait drops during fireworks (specific numbers)
   - The 20-30 minute window after fireworks ends: best rides to target
   - Same analysis for after Fantasmic

6. CHARACTER SHOWS AND LIVE ENTERTAINMENT:
   - Current regular shows on Main Street or elsewhere
   - Mickey's Toontown character experience`,
    maxTokens: 2000
  },

  FAMILY_AND_ACCESSIBILITY: {
    system: 'You are a Disneyland family and accessibility expert. Current 2025-2026 knowledge. Practical, specific advice.',
    user: `Search AllEars, TouringPlans, and r/Disneyland for family and accessibility information at Disneyland and DCA (2025-2026).

Provide a complete family and accessibility guide:

HEIGHT RESTRICTIONS (exact inches):
- List every major ride with its height requirement in inches
- Which rides have NO height requirement (good for all ages)
- Which rides have partial height restrictions (some seats OK, some not)

RIDER SWAP / CHILD SWAP:
- Exactly how it works at Disneyland (different from WDW)
- Which attractions offer rider swap
- How to request it at the attraction
- Does it work with Lightning Lane?

DAS (DISABILITY ACCESS SERVICE):
- How to apply (DAS Advance vs at park)
- Which rides benefit most from DAS
- How it interacts with Lightning Lane
- Any 2025-2026 changes to the DAS system

BEST RIDES FOR UNDER-40-INCH GUESTS:
- Complete list with why each is great for small children
- Which are must-dos for under-40-inch guests

BEST FOR ALL AGES (including grandparents):
- Rides and experiences that delight everyone from 3 to 80
- Shows and walkthrough experiences that work for all mobility levels

STROLLER INFO:
- Stroller parking locations by land
- Stroller size restrictions
- Stroller as wheelchair option
- Best stroller to rent vs bring

QUIET AREAS AND BREAKS:
- Where to find quiet spots when kids are overwhelmed
- Baby care center location and services
- Best air-conditioned spots for a midday break
- The afternoon nap/hotel strategy for families`,
    maxTokens: 2000
  },

  PHOTO_AND_EXPERIENCE: {
    system: 'You are a Disneyland photography and hidden gems expert. 2025-2026 knowledge.',
    user: `Search TheDisneylandBlog, AllEars, and r/Disneyland for the best photo locations, character meets, and hidden gems at Disneyland and DCA (2025-2026).

Cover:

BEST PHOTO LOCATIONS BY LAND AND TIME OF DAY:
For each location provide: land, best time of day, what to frame, crowd level impact
- Sleeping Beauty Castle: morning light vs golden hour vs after dark (projections)
- Main Street USA: park opening walk, hub area, evening lights
- Big Thunder Mountain from Rivers of America
- New Orleans Square balconies at golden hour
- Matterhorn from Fantasyland (reflection in Small World area?)
- Millennium Falcon exterior in Galaxy's Edge
- Cars Land at night (DCA) — neon signs
- Pixar Pier boardwalk and Pal-A-Round
- Avengers Campus
- Buena Vista Street (DCA entrance area)

CHARACTER MEET LOCATIONS AND WAITS:
- Mickey and Minnie (Toontown meet — typical wait times)
- Princesses: current meet locations
- Star Wars characters in Galaxy's Edge
- Marvel characters in Avengers Campus
- Which meets have longest waits, which are walk-up friendly
- Character dining options at DL resort

HIDDEN GEMS AND DETAILS:
- Details most guests walk past
- Interactive elements kids love
- The best 'off the beaten path' experiences
- Easter eggs on attractions`,
    maxTokens: 2000
  },

  PARK_HOP_STRATEGY: {
    system: 'You are a Disneyland park hopping strategy expert. 2025-2026 knowledge.',
    user: `Search TouringPlans, AllEars, and r/Disneyland for Disneyland Resort park hopping strategy (2025-2026).

Provide a complete park hopping guide for guests with DL+DCA tickets:

PARK HOP TIMING:
- When does park hopping open each day? (Currently after 11AM — confirm)
- Best time to hop DL→DCA (afternoon? after lunch?)
- Best time to hop DCA→DL (for evening fireworks?)
- How park hopping affects LL bookings (can you use DL LLs at DCA?)

DIRECTION STRATEGY:
- When to start at DL (morning) and hop to DCA (afternoon)
- When to start at DCA (morning) and hop to DL (afternoon/evening)
- For a group doing both parks: which split makes most sense on a summer weekday vs weekend

TRANSPORTATION BETWEEN PARKS:
- Walking route between parks (how long, through Downtown Disney)
- Monorail option (DL→Downtown Disney only — confirm current route)
- Is there a shuttle between parks?

HALF-DAY PRIORITIES:
- If you only have a DCA afternoon (4 hours): what are the non-negotiables?
- If you only have DL evening (4 hours): what should you prioritize?
- For fireworks: which park to be in?

LL STRATEGY FOR PARK HOPPERS:
- How to maximize LL across both parks
- Which park's LLs to book first
- Can you book LLs at your second park before hopping?`,
    maxTokens: 1500
  },

  WEATHER_AND_COMFORT: {
    system: 'You are a Disneyland comfort and logistics expert with specific knowledge of June weather patterns in Anaheim, CA.',
    user: `Search weather data and Disneyland guest forums for June weather patterns and comfort strategies at Disneyland (2024-2026).

Cover:

JUNE WEATHER AT DISNEYLAND:
- Typical temperature range for late June (highs, lows, morning vs afternoon)
- June Gloom phenomenon: what it is, when it clears
- Humidity levels
- Rain probability in late June (rare — how rare exactly?)
- What to pack for a June visit

HEAT STRATEGY:
- Best shade routes through the park by land
- Best indoor/air-conditioned rides for hot afternoon breaks
- Misting areas locations in the park
- Indoor shows and experiences for a midday cool-down
- Water refill stations (where, if refills are free)
- Best time blocks to be in outdoor queues vs covered queues

SUNSCREEN AND COMFORT:
- Sunscreen application spots (first aid locations)
- Best hat/sunscreen combos for different areas
- Staying hydrated: free water options

WHAT TO WEAR:
- Comfortable shoes recommendations
- Layering strategy for morning cool + afternoon heat
- What NOT to wear (poor choices)

IF IT RAINS:
- Where to get ponchos (cost, locations)
- Which rides still operate in light rain
- What closes in rain
- Upside: crowds thin significantly if it rains

EVENING COMFORT:
- Temperature drop after dark (bring a layer?)
- Best strategy for fireworks viewing comfort`,
    maxTokens: 1500
  }
};

// ─────────────────────────────────────────────────────────────
// DYNAMIC CACHE SECTION PROMPTS — 4 sections
// ─────────────────────────────────────────────────────────────
const DYNAMIC_SECTION_PROMPTS = {

  CURRENT_CLOSURES: {
    system: 'You are a Disneyland current operations expert. Only use confirmed 2025-2026 information. Be specific about status and expected return dates.',
    user: `Search disneylandresort.com, AllEars.net, and TouringPlans.com for ALL current ride closures and refurbishments at Disneyland and DCA as of today.

For each closed or refurbished attraction provide:
- Attraction name and park (DL or DCA)
- Closure type (scheduled refurbishment, unplanned, seasonal, permanent)
- Expected reopening date (if known) or best estimate
- What caused the closure (if known)
- Alternative recommendation for guests who planned to ride it

Pay special attention to:
- Pirates of the Caribbean — current status and expected return
- Any major E-ticket closures
- Any new closures announced for summer 2026

Format as clear, readable text that could be read aloud to a guest.`,
    maxTokens: 1500
  },

  SPECIAL_EVENTS: {
    system: 'You are a Disneyland special events expert. Focus on June 28-30 2026 specifically.',
    user: `Search Disneyland official site, AllEars, and MiceChat for any special events, hard ticket events, seasonal overlays, or entertainment changes at Disneyland Resort during or immediately surrounding June 28-30 2026.

Specifically investigate:
1. DISNEYLAND 70TH ANNIVERSARY: The park's 70th anniversary is July 17, 2026 (opened July 17, 1955). Are there summer 2026 anniversary celebrations? What special entertainment, decorations, or experiences are happening in late June? Check if any special nighttime spectaculars or limited shows were announced.

2. SUMMER 2026 EVENTS: Any summer-specific entertainment (like Oogie Boogie Bash is Halloween — is there a summer equivalent?), special dining events, or unique experiences.

3. 4TH OF JULY PROXIMITY: June 28-30 is just before July 4th week. Are there any early July 4th celebrations starting that weekend? Any extra fireworks or patriotic overlays?

4. HARD TICKET EVENTS: Any separately ticketed evening events (like MNSSHP or similar) that would affect park access on those dates?

5. ENTERTAINMENT CHANGES: Any shows or parades that were recently added, changed, or removed for summer 2026?

Be specific with dates. Note if something was announced but not yet confirmed.`,
    maxTokens: 1500
  },

  CURRENT_LL_PRICING: {
    system: 'You are a Disneyland Lightning Lane pricing expert. Use only current 2025-2026 pricing. Never use Genie+ terminology.',
    user: `Search AllEars, TouringPlans, and official Disneyland sources for current Lightning Lane pricing at Disneyland Resort (2025-2026).

Provide:

INDIVIDUAL LIGHTNING LANE (ILL) — rides where you pay per person:
- Which specific attractions are ILL at Disneyland (not LLMP)?
- Current price range for each ILL attraction (prices vary by date/demand)
- For a group of 9: total ILL cost at each attraction
- Price range for a peak summer day (late June/early July)

LIGHTNING LANE MULTI PASS (LLMP):
- Current per-person price range for Disneyland LLMP in late June 2026
- Current per-person price range for DCA LLMP
- Combined price if purchasing for both parks

RECENT CHANGES:
- Any changes to the LL system announced or implemented in 2025-2026
- Any new attractions added to or removed from LL
- Any pricing changes from previous year

BOOKING TIPS:
- When prices are lowest vs highest within a day (early morning bookings)
- Whether to buy LLMP at park open or wait
- Multi-day ticket LL discounts if any

Note: Use ONLY Lightning Lane Multi Pass (LLMP) and Individual Lightning Lane (ILL) terminology.`,
    maxTokens: 1200
  },

  TRIP_CONTEXT: {
    system: 'You are a brilliant, specific Disneyland trip advisor. You know this specific trip: 9 guests, June 28-30 2026, Disneyland + DCA, park hopping, Day 2 (June 29) is a VIP tour. Write in warm, specific, confident voice — like a knowledgeable friend who has been to Disneyland dozens of times. No generic advice. Be specific to these exact dates, this group size, and this itinerary.',
    user: `Search for Disneyland crowd predictions, historical patterns, and any known events for June 28-30 2026 specifically.

Write a personalized trip context for this specific group:
- 9 guests total (assume mixed ages, including some children)
- June 28 (Sunday): Disneyland, likely busiest day
- June 29 (Monday): Disneyland, VIP Tour day (guide handles logistics)
- June 30 (Tuesday): Disney California Adventure, likely lightest crowd day

Write THREE day-specific briefings in a warm, brilliant-friend voice:

DAY 1 — JUNE 28 (SUNDAY):
Start with a crowd level assessment: "Sunday June 28 will be your most crowded day..." Give specific reasons (weekend, pre-4th week, summer).
Give a specific minute-by-minute rope drop strategy for a group of 9.
Name exactly which rides to target first, second, third.
Warn about the specific pain points for this day.
Give 2-3 specific insider tips for surviving a heavy crowd Sunday.

DAY 2 — JUNE 29 (MONDAY VIP TOUR):
Explain what the VIP tour changes about the day.
Give realistic expectations: "Your guide will handle all the queuing and routing — your job is to show up and have fun."
Note the crowd difference between Sunday and Monday.
Any tips for working WITH the VIP guide.

DAY 3 — JUNE 30 (TUESDAY DCA):
Start with a crowd level assessment: "Tuesday is reliably one of the least crowded days of the summer..."
Give specific DCA rope drop strategy for a group of 9.
Name exactly which rides to target at DCA in order.
Specific DCA dining recommendations for a group of 9.
Best viewing strategy for World of Color if they want to see it.
What time to consider park hopping back to DL (if they want).

GROUP-SPECIFIC NOTES:
- Best quick service restaurants that can seat 9 together
- Rider swap strategy for any height-restricted rides
- Meeting point strategy in each park
- App tips for managing a group of 9

End with one sentence that captures the whole trip perfectly — the kind of thing a brilliant friend says to get you excited.`,
    maxTokens: 3000
  }
};

// ─────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function isFresh(key) {
  try {
    const { blobs } = await list({ prefix: 'twize/' + key });
    if (!blobs || !blobs.length) return false;
    const blob = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    const fetchUrl = blob.downloadUrl || blob.url;
    const data = await (await fetch(fetchUrl)).json();
    return data && data.ts && (Date.now() - data.ts) / 864e5 < EXPIRY_DAYS[key] * 0.8;
  } catch (e) { return false; }
}

async function blobStore(key, data) {
  const blob = await put('twize/' + key + '.json', JSON.stringify(data), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    allowOverwrite: true
  });
  return blob.url;
}

function extractJson(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenceMatch) { try { return JSON.parse(fenceMatch[1]); } catch (e) {} }
  const jsonStart = text.indexOf('{', text.indexOf('```') >= 0 ? text.indexOf('```') : 0);
  if (jsonStart < 0) return null;
  const candidate = text.substring(jsonStart);
  try { return JSON.parse(candidate); } catch (e) {}
  return null;
}

// Call Claude API with web search for a single section
async function buildSection(sectionName, prompt, apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: prompt.maxTokens,
      system: prompt.system,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt.user }]
    })
  });
  const d = await resp.json();
  if (d.error) throw new Error(d.error.message);
  let text = '';
  for (const b of (d.content || [])) if (b.type === 'text') text += b.text;
  if (text.length < 100) throw new Error('Section response too short: ' + text.length + ' chars');
  return text;
}

// ─────────────────────────────────────────────────────────────
// BUILD STABLE CACHE (12 sections)
// ─────────────────────────────────────────────────────────────
async function buildStableCache(apiKey, res) {
  const sectionNames = Object.keys(STABLE_SECTION_PROMPTS);
  const sections = {};
  const sectionMeta = {};
  
  console.log('[stable] Starting build of ' + sectionNames.length + ' sections');
  
  for (let i = 0; i < sectionNames.length; i++) {
    const name = sectionNames[i];
    const prompt = STABLE_SECTION_PROMPTS[name];
    
    try {
      console.log('[stable] Building section ' + (i + 1) + '/' + sectionNames.length + ': ' + name);
      const text = await buildSection(name, prompt, apiKey);
      
      // For LAND_MAP, try to parse as JSON
      if (name === 'LAND_MAP') {
        const parsed = extractJson(text);
        sections[name] = parsed || text;
      } else if (name === 'WAIT_PATTERNS') {
        const parsed = extractJson(text);
        sections[name] = parsed || text;
      } else {
        sections[name] = text;
      }
      
      sectionMeta[name] = { built: true, length: text.length };
      console.log('[stable] Section ' + name + ' complete: ' + text.length + ' chars');
    } catch (e) {
      console.error('[stable] Section ' + name + ' FAILED: ' + e.message);
      sectionMeta[name] = { built: false, error: e.message };
      sections[name] = null;
    }
    
    // Wait 30s between sections to avoid rate limits (except after last)
    if (i < sectionNames.length - 1) {
      console.log('[stable] Waiting 30s before next section...');
      await sleep(30000);
    }
  }
  
  const cacheData = {
    built_at: new Date().toISOString(),
    park: 'Disneyland',
    cache_type: 'stable',
    section_count: sectionNames.length,
    sections_built: Object.values(sectionMeta).filter(m => m.built).length,
    section_meta: sectionMeta,
    sections
  };
  
  await blobStore('park_intel_dl_stable', cacheData);
  const totalChars = Object.values(sections).reduce((acc, v) => {
    if (typeof v === 'string') return acc + v.length;
    if (v && typeof v === 'object') return acc + JSON.stringify(v).length;
    return acc;
  }, 0);
  
  console.log('[stable] Build complete. Total section chars: ' + totalChars);
  return { key: 'park_intel_dl_stable', sections_built: cacheData.sections_built, totalChars, sectionMeta };
}

// ─────────────────────────────────────────────────────────────
// BUILD DYNAMIC CACHE (4 sections)
// ─────────────────────────────────────────────────────────────
async function buildDynamicCache(apiKey, res) {
  const sectionNames = Object.keys(DYNAMIC_SECTION_PROMPTS);
  const sections = {};
  const sectionMeta = {};
  
  console.log('[dynamic] Starting build of ' + sectionNames.length + ' sections');
  
  for (let i = 0; i < sectionNames.length; i++) {
    const name = sectionNames[i];
    const prompt = DYNAMIC_SECTION_PROMPTS[name];
    
    try {
      console.log('[dynamic] Building section ' + (i + 1) + '/' + sectionNames.length + ': ' + name);
      const text = await buildSection(name, prompt, apiKey);
      sections[name] = text;
      sectionMeta[name] = { built: true, length: text.length };
      console.log('[dynamic] Section ' + name + ' complete: ' + text.length + ' chars');
    } catch (e) {
      console.error('[dynamic] Section ' + name + ' FAILED: ' + e.message);
      sectionMeta[name] = { built: false, error: e.message };
      sections[name] = null;
    }
    
    if (i < sectionNames.length - 1) {
      console.log('[dynamic] Waiting 30s before next section...');
      await sleep(30000);
    }
  }
  
  const cacheData = {
    built_at: new Date().toISOString(),
    park: 'Disneyland',
    cache_type: 'dynamic',
    trip_code: 'BCDIS2026',
    section_count: sectionNames.length,
    sections_built: Object.values(sectionMeta).filter(m => m.built).length,
    section_meta: sectionMeta,
    sections
  };
  
  await blobStore('park_intel_dl_dynamic', cacheData);
  const totalChars = Object.values(sections).reduce((acc, v) => {
    if (typeof v === 'string') return acc + v.length;
    if (v && typeof v === 'object') return acc + JSON.stringify(v).length;
    return acc;
  }, 0);
  
  console.log('[dynamic] Build complete. Total section chars: ' + totalChars);
  return { key: 'park_intel_dl_dynamic', sections_built: cacheData.sections_built, totalChars, sectionMeta };
}

// ─────────────────────────────────────────────────────────────
// LEGACY BUILD FUNCTION (unchanged behavior for old keys)
// ─────────────────────────────────────────────────────────────
async function buildLegacy(key, apiKey) {
  const p = LEGACY_PROMPTS[key];
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: p.maxTokens, system: p.system, tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [{ role: 'user', content: p.user }] })
  });
  const d = await resp.json();
  if (d.error) throw new Error(d.error.message);
  let text = '';
  for (const b of (d.content || [])) if (b.type === 'text') text += b.text;
  if (text.length < 50) throw new Error('Response too short');
  let value = text;
  if (key === 'park_hours_intel' || key === 'character_intel') {
    const parsed = extractJson(text);
    if (parsed) value = parsed;
  }
  await blobStore(key, { data: value, ts: Date.now() });
  return { key, length: text.length };
}

// ─────────────────────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────────────────────
const RATE_LIMIT_KEY = 'twize/rate_limit.json';

async function isRateLimited() {
  try {
    const { blobs } = await list({ prefix: 'twize/rate_limit' });
    if (!blobs || !blobs.length) return false;
    const blob = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    const fetchUrl = blob.downloadUrl || blob.url;
    const data = await (await fetch(fetchUrl)).json();
    return data && data.ts && (Date.now() - data.ts) / 3600000 < 24;
  } catch (e) { return false; }
}

async function setRateLimit() {
  try {
    await put(RATE_LIMIT_KEY, JSON.stringify({ ts: Date.now() }), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true });
  } catch (e) {}
}

// ─────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────
module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = process.env.CRON_SECRET;
  const isAuthed = secret && req.headers.authorization === 'Bearer ' + secret;
  const isVercelCron = req.headers['x-vercel-cron'] === '1';

  if (!isAuthed && !isVercelCron && !req.query.key) {
    const limited = await isRateLimited();
    if (limited) return res.status(429).json({ error: 'Rate limited - try again in 24 hours' });
    await setRateLimit();
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No ANTHROPIC_API_KEY' });

  const force = req.query.force === '1';
  const requestedKey = req.query.key;

  // Handle new two-cache architecture keys
  if (requestedKey === 'park_intel_dl_stable' || requestedKey === 'park_intel_wdw_stable') {
    if (!force && await isFresh(requestedKey)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'Cache is fresh', key: requestedKey });
    }
    if (force) {
      try {
        const { blobs } = await list({ prefix: 'twize/' + requestedKey + '.json' });
        if (blobs && blobs.length) await del(blobs.map(b => b.url));
      } catch (e) {}
    }
    try {
      const result = await buildStableCache(apiKey, res);
      return res.status(200).json({ ok: true, ...result, ts: new Date().toISOString() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  if (requestedKey === 'park_intel_dl_dynamic' || requestedKey === 'park_intel_wdw_dynamic') {
    if (!force && await isFresh(requestedKey)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'Cache is fresh', key: requestedKey });
    }
    if (force) {
      try {
        const { blobs } = await list({ prefix: 'twize/' + requestedKey + '.json' });
        if (blobs && blobs.length) await del(blobs.map(b => b.url));
      } catch (e) {}
    }
    try {
      const result = await buildDynamicCache(apiKey, res);
      return res.status(200).json({ ok: true, ...result, ts: new Date().toISOString() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // Legacy keys — original behavior
  const legacyKeys = requestedKey ? [requestedKey] : ['park_intel', 'dining_intel', 'events_intel', 'park_hours_intel'];
  const results = [], errors = [];

  for (const k of legacyKeys) {
    if (!VALID_KEYS.includes(k)) { errors.push({ key: k, error: 'Invalid key' }); continue; }
    if (!LEGACY_PROMPTS[k]) { errors.push({ key: k, error: 'No prompt for this key' }); continue; }
    if (!force && await isFresh(k)) { results.push({ key: k, skipped: true }); continue; }
    if (force) {
      try {
        const { blobs } = await list({ prefix: 'twize/' + k + '.json' });
        if (blobs && blobs.length) await del(blobs.map(b => b.url));
      } catch (e) {}
    }
    try {
      const result = await buildLegacy(k, apiKey);
      results.push(result);
    } catch (e) {
      errors.push({ key: k, error: e.message });
    }
    if (legacyKeys.indexOf(k) < legacyKeys.length - 1) {
      console.log('Waiting 65s before next cache build...');
      await sleep(65000);
    }
  }

  return res.status(200).json({ ok: true, results, errors, ts: new Date().toISOString() });
};