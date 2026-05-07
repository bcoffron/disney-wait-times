async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { schedule, dayLabel, useWebSearch, parkIntelCtx, diningCtx, eventsCtx } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });
    if (!schedule) return res.status(400).json({ error: 'Missing schedule' });

    const contextBlock = [
      parkIntelCtx ? 'PARK INTEL:\n' + parkIntelCtx : '',
      diningCtx ? 'DINING INTEL:\n' + diningCtx : '',
      eventsCtx ? 'EVENTS INTEL:\n' + eventsCtx : ''
    ].filter(Boolean).join('\n\n');

    const systemPrompt = 'You are a Disneyland touring expert. Optimize this schedule for minimum wait times and maximum enjoyment.'
      + (contextBlock ? ' Use this current intelligence:\n' + contextBlock : '')
      + ' Return ONLY valid JSON: {"sections":[{"title":"string","entries":[{"t":"H:MM AM/PM","name":"string","type":"ride|show|dining|break","note":"string","land":"string"}]}],"explanation":"string"} No markdown, no extra text.';

    const tools = useWebSearch ? [{type:'web_search_20250305',name:'web_search'}] : [];

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: systemPrompt,
        tools: tools,
        messages: [{ role: 'user', content: 'Optimize this ' + (dayLabel||'') + ' schedule:\n' + schedule }]
      })
    });

    const data = await r.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    let text = '';
    for (const block of (data.content || [])) if (block.type === 'text') text += block.text;

    const match = text.replace(/```json|```/g,'').match(/\{[\s\S]+\}/);
    if (!match) return res.status(500).json({ error: 'No JSON found', raw: text.substring(0,200) });

    const parsed = JSON.parse(match[0]);
    return res.status(200).json({ sections: parsed.sections, explanation: parsed.explanation });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

handler.config = { maxDuration: 60 };
module.exports = handler;