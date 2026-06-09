import { list } from '@vercel/blob';

// --------- Per-IP daily AI cap (50 requests per IP per 24 hours) -----------
const aiDailyLimit = new Map();

function checkAILimit(ip) {
      const now = Date.now();
      const windowMs = 24 * 60 * 60 * 1000;
      const max = 50;
      if (!aiDailyLimit.has(ip)) {
              aiDailyLimit.set(ip, { count: 1, resetAt: now + windowMs });
              return true;
      }
      const record = aiDailyLimit.get(ip);
      if (now > record.resetAt) {
              aiDailyLimit.set(ip, { count: 1, resetAt: now + windowMs });
              return true;
      }
      if (record.count >= max) return false;
      record.count++;
      return true;
}

// --------- Hardcoded model allowlist — never trust client-supplied model ---
const MODEL = 'claude-haiku-4-5-20251001';

// --------- buildCacheContext ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
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

// --------- getCache ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
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

    const MAX_REQUEST_SIZE = 500 * 1024; // 500KB
        const contentLength = parseInt(req.headers['content-length'] || '0');
        if (contentLength > MAX_REQUEST_SIZE) {
                  return res.status(413).json({ error: 'Request too large' });
        }
      
      // -- A: Request size limit (10k chars) -------------------------------------------
  const MAX_REQUEST_SIZE = 10000;
      if (JSON.stringify(req.body).length > MAX_REQUEST_SIZE) {
              return res.status(400).json({ error: 'Request too large' });
      }

  // -- C: Per-IP daily AI cap -------------------------------------------------------
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
      if (!checkAILimit(ip)) {
                    console.warn('[SECURITY] Rate limit exceeded:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', time: new Date().toISOString() });
            return res.status(429).json({ error: 'Too many requests' });
      }

  // -- Security logging -------------------------------------------------------------
  console.log('[AI] Request:', {
          endpoint: req.url,
          ip,
          time: new Date().toISOString()
  });

  // -- AUTH CHECK -----------------------------------------------------------
  const _adminKey = (process.env.ADMIN_KEY || 'CWdis2026admin').toLowerCase();
      const _sentAdmin = (req.headers['x-admin-key'] || req.body && req.body.adminKey || '').toLowerCase();
      const _tripCode = (req.body && req.body.tripCode) || req.headers['x-trip-code'] || '';
      const _isAdmin = _sentAdmin === _adminKey;
      const _isValidTrip = _tripCode && typeof _tripCode === 'string' && _tripCode.length >= 8;
      if (!_isAdmin && !_isValidTrip) {
                  console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
            return res.status(401).json({ error: 'Authentication required.' });
      }
      // -------------------------------------------------------------------------

  const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'No API key' });

  // -- B: Model allowlist — never use req.body.model or any client value --------
  // const MODEL is hardcoded above; req.body.model is intentionally ignored
  const { prompt, system, maxTokens = 1000, context } = req.body || {};
      if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  // ------ Build full park intelligence from new two-cache architecture ------------------------------------
  const cacheCtx = await buildCacheContext(
          ['LAND_MAP', 'WAIT_PATTERNS', 'CROWD_FLOW', 'ROPE_DROP_STRATEGY',
                 'LIGHTNING_LANE_STRATEGY', 'WALKING_ROUTES', 'DINING_TIMING',
                 'SHOW_AND_ENTERTAINMENT', 'FAMILY_AND_ACCESSIBILITY',
                 'PHOTO_AND_EXPERIENCE', 'PARK_HOP_STRATEGY', 'WEATHER_AND_COMFORT'],
          true // include all dynamic sections
        );
      console.log('[ai] cacheCtx sections:', Object.keys(cacheCtx));
      // -- Cache assertion (Safeguard 2) ---------------------------------
  const sectionCount = Object.keys(cacheCtx).length;
      console.log('cache_sections:', Object.keys(cacheCtx).join(','));
      if (sectionCount < 8) {
              console.error('[ai] CACHE EMPTY - aborting AI call. Got', sectionCount, 'sections, need 8');
              return res.status(503).json({ error: 'Park intelligence cache unavailable. Please try again.', cache_sections: Object.keys(cacheCtx), sections_found: sectionCount });
      }

  // ------ Fetch park hours from dedicated blob key ---------------------------------------------------------------------------------------------
  let parkHours = '';
      try {
              const hoursCache = await getCache('park_hours_intel');
              if (hoursCache) parkHours = '\nPARK HOURS:\n' + JSON.stringify(hoursCache).substring(0, 400);
      } catch(e) {}

  // ------ Build all-sections context string, capped proportionally ---------------------------------------------
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

  // -- Inject ride preferences context (sent from client via context field) ------
  const ridePrefsHeader = (context || '').startsWith('GUEST RIDE PREFERENCES:')
        ? (context || '').split('\n\n')[0] + '\n\n' : '';

  // ------ Build system prompt --- inject cache context ---------------------------------------------------------------------------------------
  let systemPrompt = system || 'You are a helpful Disneyland trip planning assistant with deep knowledge of wait times, crowd patterns, rope drop strategy, Lightning Lane, dining, and all aspects of a Disneyland Resort visit. You speak like a brilliant knowledgeable friend --- specific, warm, and actionable.';
      systemPrompt += '\n\nCRITICAL RULE \u2014 NEVER hedge or say information is unavailable:\nYou have complete park intelligence including park hours, live wait data, current closures, and trip-specific context.\nNEVER say: "I cannot retrieve", "wasn\'t available", "check the website", "I don\'t have that information", or any similar hedge.\nPARK HOURS: Always read from the PARK HOURS section in your context. That is the authoritative source.\nROPE DROP STRATEGY (always use this): Arrive at the park gates 60 minutes before official open. For Disneyland: go straight to Star Wars Galaxy\'s Edge and ride Rise of the Resistance first \u2014 it has the longest waits all day. Then Millennium Falcon. Then cross to Fantasyland before 10 AM. For DCA: Radiator Springs Racers rope drop first, then Guardians or Incredicoaster.\nCURRENTLY CLOSED FOR REFURBISHMENT (NEVER schedule or recommend these as operating): Pirates of the Caribbean (DL). Check CURRENT CLOSURES in your context for the full up-to-date list \u2014 it is updated weekly.\nYou are a brilliant knowledgeable friend. Answer every question directly and confidently using the data in your context.';
      systemPrompt += '\n\n=== CURRENT DISNEYLAND PARK INTELLIGENCE (2025-2026 verified data) ===\n' + fullContext;
      if (ridePrefsHeader) systemPrompt += '\n\n' + ridePrefsHeader;

  // -- D: 30-second timeout on Anthropic API calls ----------------------------------
  const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
              console.log('[ai] fullContext length:', fullContext.length);
              console.log('[ai] fullContext sample:', fullContext.substring(0, 400));
              console.log('[ai] systemPrompt length:', systemPrompt.length);

        // ------ Sanitize strings to remove lone surrogates and control chars ------------------------------------
        function sanitizeForJSON(str) {
                  if (typeof str !== 'string') return str;
                  return str
                    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
                    .replace(/[\uD800-\uDFFF]/g, '')
                    .replace(/\u2028|\u2029/g, ' ');
        }
              systemPrompt = sanitizeForJSON(systemPrompt);

        const resp = await fetch('https://api.anthropic.com/v1/messages', {
                  signal: controller.signal,
                  method: 'POST',
                  headers: {
                              'Content-Type': 'application/json',
                              'x-api-key': apiKey,
                              'anthropic-version': '2023-06-01'
                  },
                  body: JSON.stringify({
                              model: MODEL,
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
              if (e.name === 'AbortError') {
                        return res.status(504).json({ error: 'AI request timed out' });
              }
              return res.status(500).json({ error: e.message });
      } finally {
              clearTimeout(timeout);
      }
}
