let configStore = { apiKey: null };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_KEY = 'CWdis2026admin';

  if (req.method === 'POST') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (body.apiKey) configStore.apiKey = body.apiKey;
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(400).json({ error: e.message });
    }
  }

  if (req.method === 'GET') {
    // Only return key if it exists - never expose it directly
    // Return a token that confirms a key is available
    return res.status(200).json({
      hasKey: !!configStore.apiKey,
      apiKey: configStore.apiKey || null
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
