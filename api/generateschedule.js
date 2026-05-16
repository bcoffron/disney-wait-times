// api/generateschedule.js
// Routes generateFromSetup and aiChooseRides through Vercel with park_intel cache context
const { list } = require('@vercel/blob');

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
  // Try 3: find first { ... } or [ ... ]
  const objMatch = text.match(/\{[\s\S]+\}|\[[\s\S]+\]/);
  if (objMatch) try { return JSON.parse(objMatch[0]); } catch(e) {}
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt, mode, maxTokens = 4000 } = req.body || {};
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    const parkIntel = await getCacheSlice('park_intel', 4000);

    let system = 'You are a Disneyland and Disney California Adventure theme park scheduling expert with deep knowledge of wait time patterns, rope drop strategies, and crowd flow. Generate detailed, realistic day schedules in valid JSON only. No markdown, no explanation, just JSON.';
    if (parkIntel) {
      system += '\n\n=== CURRENT PARK INTELLIGENCE (use this — do not search the web) ===\n' + parkIntel;
    }

    console.log('generateschedule mode:', mode || 'default', 'park_intel_injected:', !!parkIntel);

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt.substring(0, 8000) }] })
    });

    const data = await anthropicRes.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    let text = '';
    for (const block of (data.content || [])) {
      if (block.type === 'text') text += block.text;
    }

    if (!text) return res.status(200).json({ error: 'Empty response', stop_reason: data.stop_reason });

    const parsed = extractJSON(text);
    return res.status(200).json({ ok: true, text, parsed, model: data.model });

  } catch (e) {
    console.error('generateschedule error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.config = { maxDuration: 30 };
