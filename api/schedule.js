import Pusher from 'pusher';
import { put, list } from '@vercel/blob';

const SCHEDULE_BLOB_KEY = 'twize/current_schedule.json';

function getPusher() {
        return new Pusher({
                    appId: process.env.PUSHER_APP_ID,
                    key: process.env.PUSHER_KEY,
                    secret: process.env.PUSHER_SECRET,
                    cluster: process.env.PUSHER_CLUSTER,
                    useTLS: true
        });
}

/// In-memory cache — warm on first GET, evicted on cold start
let scheduleStore = null;
let lastUpdated = null;

async function readScheduleBlob() {
        try {
                    const { blobs } = await list({ prefix: SCHEDULE_BLOB_KEY });
                    if (!blobs || blobs.length === 0) return null;
                    const resp = await fetch(blobs[0].url + '?t=' + Date.now());
                    if (!resp.ok) return null;
                    return await resp.json();
        } catch (e) {
                    console.error('[schedule] blob read error:', e.message);
                    return null;
        }
}

async function writeScheduleBlob(data) {
        await put(SCHEDULE_BLOB_KEY, JSON.stringify(data), {
                    access: 'public',
                    addRandomSuffix: false,
                    contentType: 'application/json'
        });
}

export default async function handler(req, res) {
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
                                // Persist to Vercel Blob so schedule survives cold starts
                    try {
                                        await writeScheduleBlob({ schedule: scheduleStore, updated: lastUpdated });
                    } catch (blobErr) {
                                        console.error('[schedule] blob write error:', blobErr.message);
                                        // Non-fatal -- in-memory write still succeeded
                    }
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
                // Serve from in-memory cache if warm
            if (scheduleStore) {
                            return res.status(200).json({ schedule: scheduleStore, updated: lastUpdated });
            }
                // Cold start: read from blob
            const blobData = await readScheduleBlob();
                if (blobData && blobData.schedule) {
                                scheduleStore = blobData.schedule;
                                lastUpdated = blobData.updated || null;
                                return res.status(200).json({ schedule: scheduleStore, updated: lastUpdated });
                }
                return res.status(404).json({ empty: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
