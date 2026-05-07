let storedApiKey = null;

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const key = storedApiKey || process.env.ANTHROPIC_API_KEY || null;
    if (!key) return res.status(200).json({ empty: true });
    return res.status(200).json({ apiKey: key });
  }

  if (req.method === 'POST') {
    const adminKey = (process.env.ADMIN_KEY || 'CWdis2026admin').toLowerCase();
    const sentKey = (req.headers['x-admin-key'] || '').toLowerCase();
    if (sentKey !== adminKey) return res.status(401).json({ error: 'Unauthorized' });
    const { apiKey } = req.body;
    if (apiKey) { storedApiKey = apiKey; return res.status(200).json({ ok: true }); }
    return res.status(400).json({ error: 'Missing apiKey' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

handler.config = { maxDuration: 10 };
module.exports = handler;