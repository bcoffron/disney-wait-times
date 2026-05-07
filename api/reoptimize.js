
const Anthropic = require('@anthropic-ai/sdk');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({error: 'Method not allowed'});

  try {
    const { prompt, systemPrompt, useWebSearch, apiKey } = req.body;
    if (!prompt) return res.status(400).json({error: 'Missing prompt'});

    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(400).json({error: 'No API key'});

    const client = new Anthropic({ apiKey: key });

    const tools = useWebSearch ? [{type: 'web_search_20250305', name: 'web_search'}] : [];
    
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: systemPrompt || 'You are an expert Disneyland touring planner. Output JSONSTART[sections array]JSONEND then SUMMARY: [max 15 words].',
      tools: tools,
      messages: [{ role: 'user', content: prompt }]
    });

    // Extract text from all content blocks
    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
    }

    // Parse server-side where JSON.parse is reliable
    let sections = null;
    let explanation = 'Schedule optimized.';

    const js1 = text.indexOf('JSONSTART');
    if (js1 > -1) {
      const afterMark = text.substring(js1 + 9).trim();
      let dep = 0, arrEnd = -1;
      for (let i = 0; i < afterMark.length; i++) {
        if (afterMark[i] === '[') dep++;
        else if (afterMark[i] === ']') { dep--; if (dep === 0) { arrEnd = i; break; } }
      }
      if (arrEnd > -1) {
        try {
          const parsed = JSON.parse(afterMark.substring(0, arrEnd + 1));
          if (Array.isArray(parsed) && parsed.length > 0) {
            sections = parsed;
            const rest = afterMark.substring(arrEnd + 1).replace(/JSONEND/g, '').trim();
            if (rest.length > 3 && rest.length < 300) {
              explanation = rest.replace(/^SUMMARY[:\s]*/,'').split('\n')[0].trim();
            }
          }
        } catch(e) {}
      }
    }

    res.status(200).json({ sections, explanation, rawLength: text.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
};
