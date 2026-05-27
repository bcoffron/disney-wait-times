import { list } from '@vercel/blob';

// ─── buildCacheContext ────────────────────────────────────────────────────────
async function buildCacheContext(sectionNames, includeDynamic = false) {
  const results = {};

  try {
    const { blobs: sb } = await list({ prefix: 'twize/park_intel_dl_stable.json' });
    if (sb && sb.length) {
      const fetchUrl = sb[0].downloadUrl || sb[0].url;
      const stableData = await fetch(fetchUrl).then(r => r.json());
      const sections = stableData.sections || {};
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
        const sections = dynamicData.sections || {};
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

  // ── Build full park intelligence from new two-cache architecture ────────────
  const cacheCtx = await buildCacheContext(
    ['LAND_MAP', 'WAIT_PATTERNS', 'CROWD_FLOW', 'ROPE_DROP_STRATEGY',
     'LIGHTNING_LANE_STRATEGY', 'WALKING_ROUTES', 'DINING_TIMING',
     'SHOW_AND_ENTERTAINMENT', 'FAMILY_AND_ACCESSIBILITY',
     'PHOTO_AND_EXPERIENCE', 'PARK_HOP_STRATEGY', 'WEATHER_AND_COMFORT'],
    true // include all dynamic sections
  );
  console.log('[ai] cacheCtx sections:', Object.keys(cacheCtx));

  // ── Build all-sections context string, capped proportionally ───────────────
  const allSections = Object.entries(cacheCtx)
    .map(([k, v]) => k + ':\n' + (v || '').substring(0, 500))
    .join('\n\n');
  const parkIntelContext = allSections.substring(0, 8000);
    const fullContext = [parkIntelContext, context || ''].join('\n\n').substring(0, 8000);

  // ── Build system prompt — inject cache context ─────────────────────────────
  let systemPrompt = system || 'You are a helpful Disneyland trip planning assistant with deep knowledge of wait times, crowd patterns, rope drop strategy, Lightning Lane, dining, and all aspects of a Disneyland Resort visit. You speak like a brilliant knowledgeable friend — specific, warm, and actionable.';
  systemPrompt += '\n\n=== CURRENT DISNEYLAND PARK INTELLIGENCE (2025-2026 verified data) ===\n' + fullContext;

  try {
    console.log('[ai] fullContext length:', fullContext.length);
console.log('[ai] fullContext sample:', fullContext.substring(0, 400));
console.log('[ai] systemPrompt length:', systemPrompt.length);
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
