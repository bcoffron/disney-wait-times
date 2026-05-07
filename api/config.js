// api/config.js - API key distribution to guest users
// Admin pushes key via POST, guests pull via GET
// Falls back to ANTHROPIC_API_KEY env var after cold starts

let storedApiKey = null;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_KEY = process.env.ADMIN_KEY || 'CWdis2026admin';

  if (req.method === 'POST') {
    // Admin pushes API key to server
    if (req.headers['x-admin-key'] !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { apiKey } = req.body;
    if (apiKey) {
      storedApiKey = apiKey;
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Missing apiKey' });
  }

  if (req.method === 'GET') {
    // Return stored key, or fall back to env var
    const key = storedApiKey || process.env.ANTHROPIC_API_KEY || null;
    if (!key) return res.status(200).json({ empty: true });
    return res.status(200).json({ apiKey: key });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};