export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No API key' });

  const { prompt, system, context, maxTokens = 1000, model = 'claude-sonnet-4-6' } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  // Build system prompt — inject cache context if provided, capped at 4000 chars
  let systemPrompt = system || 'You are a helpful Disneyland trip planning assistant.';
  if (context) {
    const trimmedContext = typeof context === 'string' ? context.substring(0, 4000) : String(context).substring(0, 4000);
    systemPrompt += '\n\n=== CURRENT DISNEYLAND INTELLIGENCE (use this instead of searching) ===\n' + trimmedContext;
  }

  try {
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
