module.exports.config = { maxDuration: 60 };

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({error: "Method not allowed"});
  try {
    const { prompt, systemPrompt, useWebSearch, apiKey } = req.body;
    if (!prompt) return res.status(400).json({error: "Missing prompt"});
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(400).json({error: "No API key"});
    const tools = useWebSearch ? [{type: "web_search_20250305", name: "web_search"}] : [];
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: systemPrompt,
      tools: tools,
      messages: [{ role: "user", content: prompt }]
    });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: body
    });
    const data = await r.json();
    if (data.error) return res.status(200).json({error: data.error});
    let text = "";
    for (const block of (data.content || [])) {
      if (block.type === "text") text += block.text;
    }
    let sections = null, explanation = "Schedule optimized.";
    const js1 = text.indexOf("JSONSTART");
    if (js1 > -1) {
      const afterMark = text.substring(js1 + 9).trim();
      let dep = 0, arrEnd = -1;
      for (let i = 0; i < afterMark.length; i++) {
        if (afterMark[i] === "[") dep++;
        else if (afterMark[i] === "]") { dep--; if (dep === 0) { arrEnd = i; break; } }
      }
      if (arrEnd > -1) {
        try {
          const parsed = JSON.parse(afterMark.substring(0, arrEnd + 1));
          if (Array.isArray(parsed) && parsed.length > 0) {
            sections = parsed;
            const rest = afterMark.substring(arrEnd + 1).replace(/JSONEND/g, "").trim();
            if (rest.length > 3 && rest.length < 300) explanation = rest.replace(/^SUMMARY[:\s]*/, "").split("\n")[0].trim();
          }
        } catch(e) {}
      }
    }
    if (!sections) {
      const lb = text.lastIndexOf("]");
      if (lb > -1) {
        let d2 = 0, a2 = -1;
        for (let i = lb; i >= 0; i--) { if (text[i] === "]") d2++; else if (text[i] === "[") { d2--; if (d2 === 0) { a2 = i; break; } } }
        if (a2 > -1) { try { const p = JSON.parse(text.substring(a2, lb+1)); if (Array.isArray(p) && p.length > 0 && p[0].entries) sections = p; } catch(e) {} }
      }
    }
    res.status(200).json({ sections, explanation, rawLength: text.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
};
