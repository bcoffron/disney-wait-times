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

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt, apiKey: clientKey } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY || clientKey;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    const existingMatch = prompt.match(/JSONSTART(\[\s\S]*?\])JSONEND/);
    const existingSections = existingMatch ? existingMatch[1] : null;

    const cleanPrompt = prompt
      .replace(/You are an expert[^\n]*/i, '')
      .replace(/Walking times[\s\S]{0,500}/i, '')
      .replace(/Show positioning[\s\S]{0,300}/i, '')
      .replace(/DINING TIMING RULES[\s\S]{0,300}/i, '')
      .trim()
      .substring(0, 1500);

    const parkIntel = await getCacheSlice('park_intel', 3000);

    // Use Haiku for speed — full schedule must complete within 30s Vercel limit
    const model = 'claude-haiku-4-5-20251001';
    let system = 'You are a Disneyland schedule optimizer. Output ONLY raw JSON, no markdown, no explanation. Required format: {"sections":[{"title":"Morning","entries":[{"t":"8:00 AM","h":"Ride Name","type":"ride","n":"short tip","land":"Land Name"}]}],"explanation":"one sentence"} Return ALL entries for the full day — do not truncate.';

    if (parkIntel) {
      system += '\n\n=== PARK INTELLIGENCE ===\n' + parkIntel;
    }

    const existingSectionsStr = existingSections ? existingSections.substring(0, 5000) : null;
    const userMsg = existingSectionsStr
      ? 'Optimize for minimum waits. Return COMPLETE full-day schedule, no omissions. JSON only.\nCurrent schedule:' + existingSectionsStr + '\nContext:' + cleanPrompt
      : 'Build optimized full-day plan. JSON only.\n' + cleanPrompt;

    function normalizeEntry(e) {
      return { t: e.t || e.time || '', h: e.h || e.name || e.title || e.attraction || '', type: e.type || 'ride', n: e.n || e.note || e.tip || e.description || '', land: e.land || '' };
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: userMsg }] })
    });
    const data = await anthropicRes.json();

    if (data.error) {
      console.error('Anthropic error:', JSON.stringify(data.error));
      return res.status(500).json({ error: data.error.message || JSON.stringify(data.error) });
    }

    console.log('model:', data.model, 'stop:', data.stop_reason, 'park_intel:', !!parkIntel);

    let text = '';
    for (const block of (data.content || [])) {
      if (block.type === 'text') text += block.text;
    }

    if (!text) return res.status(200).json({ error: 'Empty response', stop_reason: data.stop_reason });

    // Extract JSON — handle fences or raw
    let parsed = null;
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (fenceMatch) try { parsed = JSON.parse(fenceMatch[1].trim()); } catch(e) {}
    if (!parsed) try { parsed = JSON.parse(text.trim()); } catch(e) {}
    if (!parsed) {
      const m = text.match(/\{[\s\S]+\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch(e) {}
    }

    if (parsed && parsed.sections && Array.isArray(parsed.sections)) {
      const normalized = parsed.sections.map(s => ({ title: s.title || '', entries: (s.entries || []).map(normalizeEntry) }));
      return res.status(200).json({ sections: normalized, explanation: parsed.explanation || 'Schedule optimized.' });
    }

    return res.status(200).json({ error: 'Parse failed', raw: text.substring(0, 600) });

  } catch (e) {
    console.error('Handler error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

handler.config = { maxDuration: 30 };
module.exports = handler;
