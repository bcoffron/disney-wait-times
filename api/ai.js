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

// --------- fetchLiveWaits: current standby waits straight from ThemeParks.wiki -------------------
// Same source and entity IDs as api/waittimes.js. Ask AI was told (in its system prompt) that it has
// "live wait data" but nothing ever supplied it, so "what's the wait right now" fell back to historical
// patterns and the model hedged. This makes the claim true. Returns a compact text block the model can
// read directly, plus a flag so the prompt can adapt. Distinguishes three states per ride: a live
// number (operating), DOWN (temporarily not running -- report as down, do not invent a number), and
// simply absent (not in today's live feed -- only then fall back to historical). Fail-soft: on any
// error returns { text: '', ok: false } so a live-data outage never breaks Ask AI.
async function fetchLiveWaits() {
      const DL_ID = '7340550b-c14d-4def-80bb-acdb51d49a66';
      const DCA_ID = '832fcd51-ea19-4e77-85c7-75d5843b127c';
      try {
              const ctrl = new AbortController();
              const to = setTimeout(() => ctrl.abort(), 8000);
              const [dlResp, dcaResp] = await Promise.all([
                      fetch('https://api.themeparks.wiki/v1/entity/' + DL_ID + '/live', { signal: ctrl.signal }),
                      fetch('https://api.themeparks.wiki/v1/entity/' + DCA_ID + '/live', { signal: ctrl.signal })
              ]);
              clearTimeout(to);
              const [dlData, dcaData] = await Promise.all([dlResp.json(), dcaResp.json()]);
              const rows = [];
              const collect = (data, park) => {
                      (data.liveData || [])
                              .filter(r => r.entityType === 'ATTRACTION')
                              .forEach(r => {
                                      const w = (r.queue && r.queue.STANDBY && typeof r.queue.STANDBY.waitTime === 'number') ? r.queue.STANDBY.waitTime : null;
                                      rows.push({ name: r.name, wait: w, status: r.status || '', park });
                              });
              };
              collect(dlData, 'DL');
              collect(dcaData, 'DCA');
              if (!rows.length) return { text: '', ok: false };
              // operating rides with a number, sorted by park then name; plus a separate down/closed list
              const operating = rows.filter(r => r.status === 'OPERATING' && r.wait !== null)
                      .sort((a, b) => (a.park + a.name).localeCompare(b.park + b.name))
                      .map(r => r.park + ' ' + r.name + ': ' + r.wait + ' min');
              const down = rows.filter(r => r.status && r.status !== 'OPERATING')
                      .map(r => r.park + ' ' + r.name + ' (' + r.status + ')');
              const stamp = new Date().toISOString();
              let text = 'LIVE STANDBY WAITS (real-time from ThemeParks.wiki, fetched ' + stamp + '):\n';
              text += operating.length ? operating.join('\n') : '(no operating standby waits reported right now)';
              if (down.length) text += '\nCURRENTLY DOWN / NOT OPERATING: ' + down.join('; ');
              return { text: text, ok: true };
      } catch (e) {
              return { text: '', ok: false };
      }
}

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
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key, x-trip-code');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      if (req.method === 'OPTIONS') return res.status(200).end();
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const MAX_REQUEST_SIZE = 500 * 1024; // 500KB
        const contentLength = parseInt(req.headers['content-length'] || '0');
        if (contentLength > MAX_REQUEST_SIZE) {
                  return res.status(413).json({ error: 'Request too large' });
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
  const _adminKey = (process.env.ADMIN_KEY).toLowerCase();
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
                 'PHOTO_AND_EXPERIENCE', 'PARK_HOP_STRATEGY', 'WEATHER_AND_COMFORT', 'PARK_SERVICES'],
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

  // ------ Fetch LIVE standby waits (real-time) so "what's the wait right now" works ---------------
  // Historical WAIT PATTERNS already live in the cache context below; this adds the actual current
  // numbers. Fail-soft: if the live feed is unavailable, liveWaits.ok is false and we tell the model
  // to use historical patterns instead (rather than letting it hedge or invent a number).
  const liveWaits = await fetchLiveWaits();

  // ------ Build all-sections context string, capped proportionally ---------------------------------------------
  const fullContext = [
          'TRIP CONTEXT:\n' + (cacheCtx.TRIP_CONTEXT || '').substring(0, 1500),
          (liveWaits.ok ? liveWaits.text.substring(0, 2500) : 'LIVE STANDBY WAITS: unavailable right now -- use the historical WAIT PATTERNS below to estimate, and say the estimate is based on typical patterns for this time.'),
          'ROPE DROP STRATEGY:\n' + (cacheCtx.ROPE_DROP_STRATEGY || '').substring(0, 800),
          'WAIT PATTERNS:\n' + (cacheCtx.WAIT_PATTERNS || '').substring(0, 800),
          'CROWD FLOW:\n' + (cacheCtx.CROWD_FLOW || '').substring(0, 500),
          'CURRENT CLOSURES:\n' + (cacheCtx.CURRENT_CLOSURES || '').substring(0, 1000),
          'LIGHTNING LANE:\n' + (cacheCtx.LIGHTNING_LANE_STRATEGY || '').substring(0, 400),
          'DINING TIMING:\n' + (cacheCtx.DINING_TIMING || '').substring(0, 300),
         'LAND MAP (brief):\n' + (cacheCtx.LAND_MAP || '').substring(0, 300),
          'PARK SERVICES:\n' + (cacheCtx.PARK_SERVICES || '').substring(0, 900),
          'CLIENT TRIP DATA:\n' + (context || '').substring(0, 800),
          parkHours
      ].join('\n\n').substring(0, 9000);

  // -- Inject ride preferences context (sent from client via context field) ------
  const ridePrefsHeader = (context || '').startsWith('GUEST RIDE PREFERENCES:')
        ? (context || '').split('\n\n')[0] + '\n\n' : '';

  // ------ Build system prompt --- inject cache context ---------------------------------------------------------------------------------------
  let systemPrompt = system || 'You are a helpful Disneyland trip planning assistant with deep knowledge of wait times, crowd patterns, rope drop strategy, Lightning Lane, dining, and all aspects of a Disneyland Resort visit. You speak like a brilliant knowledgeable friend --- specific, warm, and actionable.';
      systemPrompt += '\n\nCRITICAL RULE \u2014 NEVER hedge or say information is unavailable:\nYou have complete park intelligence including park hours, live wait data, current closures, and trip-specific context.\nNEVER say: "I cannot retrieve", "wasn\'t available", "check the website", "I don\'t have that information", or any similar hedge.\nLIVE WAITS: The LIVE STANDBY WAITS section holds real-time standby times fetched just now. When asked "what\'s the wait right now" for a ride, READ ITS NUMBER FROM THAT SECTION and give it directly. If the ride is listed under CURRENTLY DOWN / NOT OPERATING, say it is currently down right now (do NOT invent a wait number for it), then add what the typical wait is when it is running. ONLY if a ride is not in the LIVE STANDBY WAITS section at all should you estimate from the historical WAIT PATTERNS, and when you do, say the number is a typical-pattern estimate, not a live reading. If the LIVE STANDBY WAITS section says it is unavailable, estimate from WAIT PATTERNS and say so.\nPARK HOURS: Always read from the PARK HOURS section in your context. That is the authoritative source.\nROPE DROP STRATEGY: Use the ROPE DROP STRATEGY section in your context \u2014 it is the authoritative, verified source and is updated regularly. Do NOT recite a fixed ride order from memory; the best rope-drop pick varies by park and conditions, so read it from the context.\nCLOSURES: Use the CURRENT CLOSURES section in your context as the authoritative, weekly-updated source for what is closed. Do NOT state any specific ride is closed from memory \u2014 a ride is only closed if the CURRENT CLOSURES context says so, and a ride with a reopening date on or before the trip is OPEN. If a ride is not mentioned as closed in your context, treat it as operating.\nYou are a brilliant knowledgeable friend. Answer every question directly and confidently using the data in your context.';
      systemPrompt += '\n\nCHARACTER ENCODING RULE (ABSOLUTE): Respond in plain ASCII text ONLY. NEVER use emoji, emoticons, pictographs, decorative symbols, checkmarks, stars, arrows, or any non-ASCII characters anywhere in your response. No exceptions. Use plain words and standard punctuation only.';
      systemPrompt += '\n\nSERVICES AND TIMING: Answer questions about park services, first aid, buying over-the-counter medicine, baby care, guest relations, lockers, and locations directly from the context and your knowledge. If a trip-day status is given above, honor it: when the guest is in the park right now, answer for this moment. NEVER tell the guest to call ahead, check before their visit, ask a cast member when they arrive, or phone Guest Services to confirm --- give the answer plainly.';
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
