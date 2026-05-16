const Pusher = require('pusher');

const BLOB_KEY = 'twize/vipnotes.json';

function getPusher() {
      return new Pusher({
              appId: process.env.PUSHER_APP_ID,
              key: process.env.PUSHER_KEY,
              secret: process.env.PUSHER_SECRET,
              cluster: process.env.PUSHER_CLUSTER,
              useTLS: true
      });
}

async function readFromBlob() {
      try {
              const { list } = await import('@vercel/blob');
              const { blobs } = await list({ prefix: BLOB_KEY });
              if (!blobs || blobs.length === 0) return null;
              const fetchUrl = blobs[0].url;
              const resp = await fetch(fetchUrl);
              if (!resp.ok) return null;
              return await resp.json();
      } catch (e) {
              console.error('vipnotes readFromBlob error', e.message);
              return null;
      }
}

async function writeToBlob(data) {
      const { put } = await import('@vercel/blob');
      const payload = JSON.stringify(data);
      await put(BLOB_KEY, payload, {
              access: 'public',
              addRandomSuffix: false,
              contentType: 'application/json'
      });
}

module.exports = async function handler(req, res) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') return res.status(200).end();

      if (req.method === 'POST') {
              try {
                        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
                        if (body.notes === undefined) {
                                    return res.status(400).json({ error: 'Missing notes' });
                        }
                        const now = new Date().toISOString();
                        const record = { notes: body.notes, updated: now };
                        await writeToBlob(record);
                        try {
                                    const pusher = getPusher();
                                    await pusher.trigger('trip-sync', 'notes-updated', { notes: body.notes });
                        } catch (pe) {
                                    console.error('Pusher error', pe.message);
                        }
                        return res.status(200).json({ ok: true, updated: now });
              } catch (e) {
                        return res.status(400).json({ error: e.message });
              }
      }

      if (req.method === 'GET') {
              const record = await readFromBlob();
              if (!record) {
                        return res.status(200).json({ notes: [], updated: null });
              }
              return res.status(200).json(record);
      }

      return res.status(405).json({ error: 'Method not allowed' });
};
