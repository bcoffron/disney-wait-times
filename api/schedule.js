const Pusher = require('pusher');

function getPusher() {
    return new Pusher({
          appId: process.env.PUSHER_APP_ID,
          key: process.env.PUSHER_KEY,
          secret: process.env.PUSHER_SECRET,
          cluster: process.env.PUSHER_CLUSTER,
          useTLS: true
    });
}

let scheduleStore = null;
let lastUpdated = null;

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const ADMIN_KEY = (process.env.ADMIN_KEY || 'CWdis2026admin').toLowerCase();

    if (req.method === 'POST') {
          const key = req.headers['x-admin-key'];
          if (!key || key.toLowerCase() !== ADMIN_KEY) {
                  return res.status(403).json({ error: 'Unauthorized' });
          }
          try {
                  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
                  scheduleStore = body.schedule;
                  lastUpdated = new Date().toISOString();
                  try {
                            const pusher = getPusher();
                            const dayIdx = body.dayIndex !== undefined ? body.dayIndex : 0;
                            await pusher.trigger('trip-sync', 'schedule-updated', {
                                        day: dayIdx,
                                        schedule: scheduleStore
                            });
                  } catch(pe) { console.error('Pusher error', pe.message); }
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
