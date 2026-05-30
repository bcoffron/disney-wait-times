import { list } from '@vercel/blob';

// âââ buildCacheContext ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function buildCacheContext(sectionNames, includeDynamic = false) {
    const results = {};

  try {
        const { blobs: sb } = await list({ prefix: 'twize/park_intel_dl_stable.json' });
        if (sb && sb.length) {
                const fetchUrl = sb[0].downloadUrl || sb[0].url;
                const stableData = await fetch(fetchUrl).then(r => r.json());
                const sections = stableData.data.sections || {};
                sectionNames.forEach(name => {
                          if (sections[name]) {
                                      results[name] = typeof sections[name] === 'string'
                                        ? sections[name]
                                                    : JSON.stringify(sections[name]);
                          }
                });
        }
  } catch (e) {
        console.error('[cache] stable read error:', e.message);
  }

  if (includeDynamic) {
        try {
                const { blobs: db } = await list({ prefix: 'twize/park_intel_dl_dynamic.json' });
                if (db && db.length) {
                          const fetchUrl = db[0].downloadUrl || db[0].url;
                          const dynamicData = await fetch(fetchUrl).then(r => r.json());
                          const sections = dynamicData.data.sections || {};
                          ['CURRENT_CLOSURES', 'TRIP_CONTEXT', 'CURRENT_LL_PRICING', 'SPECIAL_EVENTS'].forEach(name => {
                                      if (sections[name]) {
                                                    results[name] = typeof sections[name] === 'string'
                                                      ? sections[name]
                                                                    : JSON.stringify(sections[name]);
                                      }
                          });
                }
        } catch (e) {
                console.error('[cache] dynamic read error:', e.message);
        }
  }

  return results;
}

// âââ getCache âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function getCache(key) {
    const { blobs } = await list({ prefix: 'twize/' + key + '.json' });
    if (!blobs || !blobs.length) return null;
    const fetchUrl = blobs[0].downloadUrl || blobs[0].url;
    return await fetch(fetchUrl).then(r => r.json());
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });

  const { prompt, system, maxTokens = 1000, model = 'claude-sonnet-4-6', context } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  // ââ Build full park intelligence from new two-cache architecture ââââââââââââ
  const cacheCtx = await buildCacheContext(
        ['LAND_MAP', 'WAIT_PATTERNS', 'CROWD_FLOW', 'ROPE_DROP_STRATEGY',
              'LIGHTNING_LANE_STRATEGY', 'WALKING_ROUTES', 'DINING_TIMING',
              'SHOW_AND_ENTERTAINMENT', 'FAMILY_AND_ACCESSIBILITY',
              'PHOTO_AND_EXPERIENCE', 'PARK_HOP_STRATEGY', 'WEATHER_AND_COMFORT'],
        true // include all dynamic sections
      );
    console.log('[ai] cacheCtx sections:', Object.keys(cacheCtx));
  // ── Cache assertion (Safeguard 2) ─────────────────────────────────
  const sectionCount = Object.keys(cacheCtx).length;
  console.log('cache_sections:', Object.keys(cacheCtx).join(','));
  if (sectionCount < 8) {
    console.error('[ai] CACHE EMPTY — aborting AI call. Got', sectionCount, 'sections, need 8');
    return res.status(503).json({ error: 'Park intelligence cache unavailable. Please try again.', cache_sections: Object.keys(cacheCtx), sections_found: sectionCount });
  }

  // ââ Fetch park hours from dedicated blob key âââââââââââââââââââââââââââââââ
  let parkHours = '';
    try {
          const hoursCache = await getCache('park_hours_intel');
          if (hoursCache) parkHours = '\nPARK HOURS:\n' + JSON.stringify(hoursCache).substring(0, 400);
    } catch(e) {}

  // ââ Build all-sections context string, capped proportionally âââââââââââââââ
  const fullContext = [
        'TRIP CONTEXT:\n' + (cacheCtx.TRIP_CONTEXT || '').substring(0, 1500),
        'ROPE DROP STRATEGY:\n' + (cacheCtx.ROPE_DROP_STRATEGY || '').substring(0, 800),
        'WAIT PATTERNS:\n' + (cacheCtx.WAIT_PATTERNS || '').substring(0, 800),
        'CROWD FLOW:\n' + (cacheCtx.CROWD_FLOW || '').substring(0, 500),
        'CURRENT CLOSURES:\n' + (cacheCtx.CURRENT_CLOSURES || '').substring(0, 1000),
        'LIGHTNING LANE:\n' + (cacheCtx.LIGHTNING_LANE_STRATEGY || '').substring(0, 400),
        'DINING TIMING:\n' + (cacheCtx.DINING_TIMING || '').substring(0, 300),
        'LAND MAP (brief):\n' + (cacheCtx.LAND_MAP || '').substring(0, 300),
        'CLIENT TRIP DATA:\n' + (context || '').substring(0, 800),
        parkHours
      ].join('\n\n').substring(0, 8000);

  // ── Inject ride preferences context (sent from client via context field) ──────
  const ridePrefsHeader = (context || '').startsWith('GUEST RIDE PREFERENCES:')
    ? (context || '').split('\n\n')[0] + '\n\n' : '';

  // ââ Build system prompt â inject cache context âââââââââââââââââââââââââââââ
  let systemPrompt = system || 'You are a helpful Disneyland trip planning assistant with deep knowledge of wait times, crowd patterns, rope drop strategy, Lightning Lane, dining, and all aspects of a Disneyland Resort visit. You speak like a brilliant knowledgeable friend â specific, warm, and actionable.';
    systemPrompt += '\n\nCRITICAL RULE \u2014 NEVER hedge or say information is unavailable:\nYou have complete park intelligence including park hours, live wait data, current closures, and trip-specific context.\nNEVER say: "I cannot retrieve", "wasn\'t available", "check the website", "I don\'t have that information", or any similar hedge.\nPARK HOURS: Always read from the PARK HOURS section in your context. That is the authoritative source.\nROPE DROP STRATEGY (always use this): Arrive at the park gates 60 minutes before official open. For Disneyland: go straight to Star Wars Galaxy\'s Edge and ride Rise of the Resistance first \u2014 it has the longest waits all day. Then Millennium Falcon. Then cross to Fantasyland before 10 AM. For DCA: Radiator Springs Racers rope drop first, then Guardians or Incredicoaster.\nCURRENTLY CLOSED FOR REFURBISHMENT (NEVER schedule or recommend these as operating): Pirates of the Caribbean (DL). Check CURRENT CLOSURES in your context for the full up-to-date list \u2014 it is updated weekly.\nYou are a brilliant knowledgeable friend. Answer every question directly and confidently using the data in your context.';
    systemPrompt += '\n\n=== CURRENT DISNEYLAND PARK INTELLIGENCE (2025-2026 verified data) ===\n' + fullContext;
  if (ridePrefsHeader) systemPrompt += '\n\n' + ridePrefsHeader;

  try {
        console.log('[ai] fullContext length:', fullContext.length);
        console.log('[ai] fullContext sample:', fullContext.substring(0, 400));
        console.log('[ai] systemPrompt length:', systemPrompt.length);

      // ââ Sanitize strings to remove lone surrogates and control chars ââââââââââââ
      function sanitizeForJSON(str) {
              if (typeof str !== 'string') return str;
              return str
                .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
                .replace(/[\uD800-\uDFFF]/g, '')
                .replace(/\u2028|\u2029/g, ' ');
      }
        systemPrompt = sanitizeForJSON(systemPrompt);

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01'
              },
              body: JSON.stringify({
                        model,
                        max_tokens: maxTokens,
                        system: systemPrompt,
                        messages: [{ role: 'user', content: prompt }]
              })
      });

      const data = await resp.json();
        if (data.error) return res.status(500).json({ error: data.error.message });

      let text = '';
        for (const block of (data.content || [])) {
                if (block.type === 'text') text += block.text;
        }

      return res.status(200).json({ ok: true, text, model: data.model });
  } catch (e) {
        return res.status(500).json({ error: e.message });
  }
}
