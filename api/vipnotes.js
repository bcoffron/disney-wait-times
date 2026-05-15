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

let notesStore = [];
let lastUpdated = null;

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method === 'POST') {
          try {
                  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
                  if (body.notes !== undefined) {
                            notesStore = body.notes;
                            lastUpdated = new Date().toISOString();
                            try {
                                        const pusher = getPusher();
                                        await pusher.trigger('trip-sync', 'notes-updated', { notes: notesStore });
                            } catch(pe) { console.error('Pusher error', pe.message); }
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
