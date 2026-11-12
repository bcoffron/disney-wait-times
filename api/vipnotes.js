import Pusher from 'pusher';

// Secret path-prefix hardening (mirrors api/trip.js). When BLOB_PATH_SALT
// is set, the notes record lives behind the same unguessable path segment
// as the trip blobs, so its fixed public URL is no longer guessable. When
// unset, the key falls back to the bare path (current behavior -- no
// lockout). Never log the salted key or full pathname.
const SALT = (process.env.BLOB_PATH_SALT || '').trim();

// Bare key (also used as the transition-fallback for reads).
const BLOB_KEY = 'twize/vipnotes.json';

// Salted key -- salted when SALT is set, bare otherwise.
const notesSaltedKey = () => SALT ? ('twize/' + SALT + '/vipnotes.json') : BLOB_KEY;

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
      // salted-first, bare-fallback (transition-safe, same as api/trip.js)
      const key = notesSaltedKey();
      const record = await readFromBlobAt(key);
      if (record || key === BLOB_KEY) return record;
      return readFromBlobAt(BLOB_KEY);
}

async function readFromBlobAt(key) {
      try {
              const { list } = await import('@vercel/blob');
              const { blobs } = await list({ prefix: key });
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
      await put(notesSaltedKey(), payload, {
              access: 'public',
              allowOverwrite: true,
              addRandomSuffix: false,
              contentType: 'application/json',
              cacheControlMaxAge: 0
      });
}

export default async function handler(req, res) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') return res.status(200).end();

      if (req.method === 'POST') {
              try {
                        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
                        // Auth check - require trip code or admin key
                        const ADMIN_KEY = (process.env.ADMIN_KEY).toLowerCase();
                        const sentAdmin = (req.headers['x-admin-key'] || body.adminKey || '').toLowerCase();
                        const tripCode = body.tripCode || req.headers['x-trip-code'] || '';
                        const isAdmin = sentAdmin === ADMIN_KEY;
                        const isValidTrip = tripCode && tripCode.length >= 8;
                        if (!isAdmin && !isValidTrip) {
                                    return res.status(401).json({ error: 'Unauthorized' });
                        }
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
