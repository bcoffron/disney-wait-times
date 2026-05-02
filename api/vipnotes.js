let notesStore = { 0: '', 1: '', 2: '' };
let lastUpdated = null;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (body.day !== undefined && body.notes !== undefined) {
        notesStore[body.day] = body.notes;
        lastUpdated = new Date().toISOString();
      }
      return res.status(200).json({ ok: true, updated: lastUpdated });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  if (req.method === 'GET') {
    return res.status(200).json({ notes: notesStore, updated: lastUpdated });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
