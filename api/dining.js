// api/dining.js
// Routes fetchDiningRecs through Vercel with dining_intel cache context
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt, park, maxTokens = 1500 } = req.body || {};
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    const diningIntel = await getCacheSlice('dining_intel', 4000);

    let system = 'You are a Disneyland and Disney California Adventure dining expert. Provide concise, practical dining recommendations. Respond in valid JSON only. No markdown, no explanation — just JSON in this format: {"recommendations":[{"name":"Restaurant Name","park":"DL|DCA","type":"table|quick","mustOrder":"item","tip":"short tip","rating":"4/5"}]}';
    if (diningIntel) {
      system += '\n\n=== CURRENT DINING INTELLIGENCE (use this — do not search the web) ===\n' + diningIntel;
    }

    console.log('dining recs for park:', park || 'all', 'dining_intel_injected:', !!diningIntel);

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

    const clean = text.replace(/```json[\s\S]*?```/g, '').replace(/```/g, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(clean); }
    catch (e1) {
      const m = clean.match(/\{[\s\S]+\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch (e2) { }
    }

    return res.status(200).json({ ok: true, text, parsed, model: data.model });
  } catch (e) {
    console.error('dining endpoint error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.config = { maxDuration: 15 };
