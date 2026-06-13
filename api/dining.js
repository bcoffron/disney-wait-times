// api/dining.js
// Routes fetchDiningRecs through Vercel with dining_intel_dl cache (falls back to legacy dining_intel during transition)
import { list } from '@vercel/blob';

async function getCacheSlice(key, maxChars = 4000) {
  try {
    const { blobs } = await list({ prefix: 'twize/' + key + '.json' });
    if (!blobs || blobs.length === 0) return null;
    const blob = blobs[0];
    const fetchUrl = blob.downloadUrl || blob.url;
    const dataResp = await fetch(fetchUrl);
    if (!dataResp.ok) return null;
    const text = await dataResp.text();
    const parsed = JSON.parse(text);
    if (!parsed || !parsed.data) return null;
    const raw = typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data);
    return raw.substring(0, maxChars);
  } catch (e) {
    console.error('Cache fetch error for', key, e.message);
    return null;
  }
}

function extractJSON(text) {
  // Try 1: extract from inside code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch(e) {}
  }
  // Try 2: raw parse
  try { return JSON.parse(text.trim()); } catch(e) {}
  // Try 3: find first { ... }
  const objMatch = text.match(/\{[\s\S]+\}/);
  if (objMatch) try { return JSON.parse(objMatch[0]); } catch(e) {}
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-trip-code');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // -- AUTH CHECK -----------------------------------------------------------
  const _adminKey = (process.env.ADMIN_KEY || 'CWdis2026admin').toLowerCase();
  const _sentAdmin = (req.headers['x-admin-key'] || req.body && req.body.adminKey || '').toLowerCase();
  const _tripCode = (req.body && req.body.tripCode) || req.headers['x-trip-code'] || '';
  const _isAdmin = _sentAdmin === _adminKey;
  const _isValidTrip = _tripCode && typeof _tripCode === 'string' && _tripCode.length >= 8;
  if (!_isAdmin && !_isValidTrip) {
    console.warn('[auth] Unauthorized request blocked');
    return res.status(401).json({ error: 'Authentication required.' });
  }
  // -------------------------------------------------------------------------

  try {
    const { prompt, park, maxTokens = 1500 } = req.body || {};
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    const diningIntel = (await getCacheSlice('dining_intel_dl', 4000)) || (await getCacheSlice('dining_intel', 4000));

    let system = 'You are a Disneyland and Disney California Adventure dining expert. Provide concise, practical dining recommendations. Respond in valid JSON only. No markdown, no explanation - just JSON in this format: {"recommendations":[{"name":"Restaurant Name","park":"DL|DCA","type":"table|quick","mustOrder":"item","tip":"short tip","rating":"4/5"}]}';
    if (diningIntel) {
      system += '\n\n=== CURRENT DINING INTELLIGENCE (use this - do not search the web) ===\n' + diningIntel;
    }

    console.log('dining recs for park:', park || 'all', 'dining_intel_dl_injected:', !!diningIntel);

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt.substring(0, 2000) }] })
    });

    const data = await anthropicRes.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    let text = '';
    for (const block of (data.content || [])) {
      if (block.type === 'text') text += block.text;
    }

    if (!text) return res.status(200).json({ error: 'Empty response' });

    const parsed = extractJSON(text);
    return res.status(200).json({ ok: true, text, parsed, model: data.model });

  } catch (e) {
    console.error('dining endpoint error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

handler.config = { maxDuration: 15 };
