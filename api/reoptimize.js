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

async function getCharacterIntel() {
  try {
    const { blobs } = await list({ prefix: 'twize/character_intel.json' });
    if (!blobs || blobs.length === 0) return null;
    const blob = blobs[0];
    const fetchUrl = blob.downloadUrl || blob.url;
    const dataResp = await fetch(fetchUrl);
    if (!dataResp.ok) return null;
    const text = await dataResp.text();
    const parsed = JSON.parse(text);
    if (!parsed || !parsed.data) return null;
    const dataObj = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data;
    const disclaimer = dataObj.disclaimer || 'Character schedules are planned in advance but can change without notice. Check with a cast member on the day.';
    const characters = Array.isArray(dataObj.characters) ? dataObj.characters : [];
    return { disclaimer, characters };
  } catch (e) {
    console.error('Character intel fetch error:', e.message);
    return null;
  }
}

function buildCharacterContext(charIntel, maxChars) {
  if (!charIntel) return null;
  const { disclaimer, characters } = charIntel;
  if (!characters.length) return null;
  const lines = [];
  for (const c of characters) {
    const windows = Array.isArray(c.typicalWindows) ? c.typicalWindows.join(', ') : (c.typicalWindows || '');
    lines.push('- ' + c.name + ' | ' + (c.location || '') + ' | Windows: ' + windows + ' | Typical wait: ' + (c.typicalWait || 0) + ' min');
  }
  const body = lines.join('\n');
  const full = 'CHARACTER INTEL (from cache â do not fabricate):\nDisclaimer: ' + disclaimer + '\n\nCharacter windows to avoid conflicts:\n' + body;
  return full.substring(0, maxChars);
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt, scheduleItems, dayLabel, apiKey: clientKey } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY || clientKey;
    if (!apiKey) return res.status(500).json({ error: 'No API key' });
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // Use scheduleItems from POST body directly (current day's items only — not all 3 days)
    const existingSections = (scheduleItems && Array.isArray(scheduleItems) && scheduleItems.length > 0)
      ? JSON.stringify([{ title: dayLabel || 'Schedule', entries: scheduleItems }])
      : null;

    console.log('[reoptimize] scheduleItems received:', scheduleItems ? scheduleItems.length : 'null', '| dayLabel:', dayLabel || 'none', '| existingSections:', existingSections ? 'built' : 'null');

    const cleanPrompt = prompt
      .replace(/You are an expert[^\n]*/i, '')
      .replace(/Walking times[\s\S]{0,500}/i, '')
      .replace(/Show positioning[\s\S]{0,300}/i, '')
      .replace(/DINING TIMING RULES[\s\S]{0,300}/i, '')
      .trim()
      .substring(0, 4000);

    const [parkIntel, charIntel] = await Promise.all([
      getCacheSlice('park_intel', 3000),
      getCharacterIntel()
    ]);

    const charContext = buildCharacterContext(charIntel, 2000);

    const model = 'claude-haiku-4-5-20251001';
    let system = 'You are a Disneyland schedule optimizer. Output ONLY raw JSON, no markdown, no explanation. Required format: {"sections":[{"title":"Morning","entries":[{"t":"8:00 AM","h":"Ride Name","type":"ride","n":"short tip","land":"Land Name"}]}],"explanation":"one sentence"} Return ALL entries for the full day â do not truncate. Preserve all character meet entries (type: "character") in their correct positions relative to other entries. Never schedule a character meet outside their listed appearance windows.';

    if (parkIntel) {
      system += '\n\n=== PARK INTELLIGENCE ===\n' + parkIntel;
    }
    if (charContext) {
      system += '\n\n=== ' + charContext + ' ===';
    }

    // PART 4: Dining and show preservation rules
    system += '\n\n=== DINING AND SHOW PRESERVATION RULES ===';
    system += '\nWhen reordering the schedule, NEVER modify the content of dining or show cards.';
    system += '\nRules:';
    system += '\n1. Preserve ALL fields on type "dining" and type "quickservice" cards:';
    system += '\n   h, n, topPick, veg, kids, land — copy them exactly, word for word';
    system += '\n7. topPick, veg, and kids fields MUST be copied as exact strings — NEVER substitute with true, false, or any boolean value';
    system += '\n2. Preserve ALL fields on type "show" cards: h, n, land';
    system += '\n3. You MAY adjust the time slot of a quickservice card if needed for schedule flow';
    system += '\n4. NEVER move a confirmed reservation (type "dining") more than 30 minutes from its original time — it is a fixed anchor';
    system += '\n5. NEVER replace a rich multi-line note with a generic one-liner';
    system += '\n6. If you cannot preserve the original content, keep the card exactly as-is and do not move it';
    system += '\n7. Preserve ALL fields on type "tip" cards: the entire note field must be kept exactly word for word.';
    system += '\n   Tip notes contain strategic park advice. Never shorten, summarize, or replace tip notes.';
    system += '\n8. Preserve ALL fields on type "snack", type "photo", and type "character" cards exactly as-is.';
    system += '\n   These non-ride card types must never have their notes replaced with one-liners.';
    system += '\n9. ONLY ride cards (type: "ride") may have their time slots adjusted during optimization.';
    system += '\n   Never replace any card note with a shorter version. Never genericize a specific note.';

    const existingSectionsStr = existingSections ? existingSections.substring(0, 8000) : null;
    const userMsg = existingSectionsStr
      ? 'Optimize for minimum waits. Return COMPLETE full-day schedule, no omissions. JSON only.\nCurrent schedule:' + existingSectionsStr + '\nContext:' + cleanPrompt
      : 'Build optimized full-day plan. JSON only.\n' + cleanPrompt;

    function normalizeEntry(e) {
      var base = { t: e.t || e.time || '', h: e.h || e.name || e.title || e.attraction || '', type: e.type || 'ride', n: e.n || e.note || e.tip || e.description || '', land: e.land || '' };
      // PART 4: Preserve dining/quickservice rich fields
      if (e.type === 'dining' || e.type === 'quickservice') {
        if (e.topPick) base.topPick = e.topPick;
        if (e.veg) base.veg = e.veg;
        if (e.kids) base.kids = e.kids;
        if (e.reservationTime) base.reservationTime = e.reservationTime;
        // Guard: strip boolean values — AI must always return dish name strings
        if (base.topPick === true || base.topPick === false || base.topPick === 'true' || base.topPick === 'false') { delete base.topPick; }
        if (base.veg === true || base.veg === false || base.veg === 'true' || base.veg === 'false') { delete base.veg; }
        if (base.kids === true || base.kids === false || base.kids === 'true' || base.kids === 'false') { delete base.kids; }
      }
      // Preserve character fields
      if (e.type === 'character') {
        base.typicalWait = e.typicalWait || 0;
        base.vipAccessible = !!e.vipAccessible;
        base.disclaimer = true;
      }
      // FIX 4: Guard tip/snack/photo/character note length — never replace with shorter version
      if (e.type === 'tip' || e.type === 'snack' || e.type === 'photo' || e.type === 'character') {
        const origNote = e.n || e.note || e.tip || e.description || '';
        if (base.n && origNote && base.n.length < origNote.length) {
          base.n = origNote;
        }
      }
            return base;
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 6000, system, messages: [{ role: 'user', content: userMsg }] })
    });
    const data = await anthropicRes.json();

    if (data.error) {
      console.error('Anthropic error:', JSON.stringify(data.error));
      return res.status(500).json({ error: data.error.message || JSON.stringify(data.error) });
    }

    console.log('model:', data.model, 'stop:', data.stop_reason, 'park_intel:', !!parkIntel, 'char_intel:', !!charIntel);

    let text = '';
    for (const block of (data.content || [])) {
      if (block.type === 'text') text += block.text;
    }

    if (!text) return res.status(200).json({ error: 'Empty response', stop_reason: data.stop_reason });

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

    return res.status(200).json({ error: 'Parse failed', raw: text.substring(0, 8000) });

  } catch (e) {
    console.error('Handler error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

handler.config = { maxDuration: 30 };
module.exports = handler;