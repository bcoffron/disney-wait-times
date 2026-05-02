// Simple in-memory + file-based schedule store
// Uses Vercel's tmp directory for persistence within a deployment

let scheduleStore = null;
let lastUpdated = null;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_KEY = 'CWdis2026admin';

  if (req.method === 'POST') {
    // Only admin can push schedule
    const key = req.headers['x-admin-key'];
    if (key !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      scheduleStore = body.schedule;
      lastUpdated = new Date().toISOString();
      return res.status(200).json({ ok: true, updated: lastUpdated });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  if (req.method === 'GET') {
    if (!scheduleStore) {
      return res.status(404).json({ empty: true });
    }
    return res.status(200).json({
      schedule: scheduleStore,
      updated: lastUpdated
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
