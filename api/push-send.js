// api/push-send.js
// Sends a Web Push notification to all devices subscribed for a trip.
// INTERNAL ONLY. Auth: Bearer CRON_SECRET, OR x-vercel-cron:1, OR admin key.
// Called by the wait-monitor cron (Step 5) and usable by admin for testing.
// Reads twize/push-subs/<tripCode>.json, sends via web-push, prunes dead subs.

import webpush from 'web-push';

const ADMIN_KEY_DEFAULT = 'CWdis2026admin';

function blobKeyFor(tripCode) {
	return 'twize/push-subs/' + tripCode + '.json';
}

function safeTripCode(raw) {
	if (typeof raw !== 'string') return '';
	var t = raw.trim();
	if (!/^[A-Za-z0-9-]{8,40}$/.test(t)) return '';
	return t;
}

async function readSubs(tripCode) {
	try {
		const { list } = await import('@vercel/blob');
		const { blobs } = await list({ prefix: blobKeyFor(tripCode) });
		if (!blobs || blobs.length === 0) return [];
		const resp = await fetch(blobs[0].url, { cache: 'no-store' });
		if (!resp.ok) return [];
		const data = await resp.json();
		return Array.isArray(data.subscriptions) ? data.subscriptions : [];
	} catch (e) {
		console.error('[push-send] read error', e.message);
		return [];
	}
}

async function writeSubs(tripCode, subs) {
	const { put } = await import('@vercel/blob');
	const payload = JSON.stringify({ tripCode: tripCode, subscriptions: subs, updated: new Date().toISOString() });
	await put(blobKeyFor(tripCode), payload, {
		access: 'public',
		addRandomSuffix: false,
		contentType: 'application/json'
	});
}

export default async function handler(req, res) {
	// ---- AUTH FIRST (internal only) ----
	const secret = process.env.CRON_SECRET;
	const isAuthed = secret && req.headers.authorization === ('Bearer ' + secret);
	const isVercelCron = req.headers['x-vercel-cron'] === '1';
	const ADMIN_KEY = (process.env.ADMIN_KEY || ADMIN_KEY_DEFAULT).toLowerCase();
	const isAdmin = (req.headers['x-admin-key'] || '').toLowerCase() === ADMIN_KEY;
	if (!isAuthed && !isVercelCron && !isAdmin) {
		console.warn('[push-send] unauthorized blocked');
		return res.status(401).json({ error: 'Unauthorized' });
	}

	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
	res.setHeader('X-Content-Type-Options', 'nosniff');
	if (req.method === 'OPTIONS') return res.status(200).end();
	if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

	// ---- VAPID config ----
	const pub = process.env.VAPID_PUBLIC_KEY;
	const priv = process.env.VAPID_PRIVATE_KEY;
	const subj = process.env.VAPID_SUBJECT || 'mailto:hello@themeparkcopilot.com';
	if (!pub || !priv) return res.status(500).json({ error: 'VAPID keys not configured' });
	try {
		webpush.setVapidDetails(subj, pub, priv);
	} catch (e) {
		return res.status(500).json({ error: 'VAPID config invalid: ' + e.message });
	}

	try {
		const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
		const tripCode = safeTripCode(body.tripCode || '');
		if (!tripCode) return res.status(400).json({ error: 'Missing or invalid trip code' });

		const title = (typeof body.title === 'string' && body.title) ? body.title : 'Theme Park Co-Pilot';
		const message = (typeof body.body === 'string') ? body.body : '';
		const url = (typeof body.url === 'string' && body.url) ? body.url : '/app.html';
		const tag = (typeof body.tag === 'string' && body.tag) ? body.tag : 'tpcp-alert';
		const payload = JSON.stringify({ title: title, body: message, url: url, tag: tag });

		const subs = await readSubs(tripCode);
		if (!subs.length) return res.status(200).json({ ok: true, sent: 0, failed: 0, note: 'no subscriptions' });

		let sent = 0;
		let failed = 0;
		const survivors = [];
		for (let i = 0; i < subs.length; i++) {
			const s = subs[i];
			const pushSub = { endpoint: s.endpoint, keys: s.keys };
			try {
				await webpush.sendNotification(pushSub, payload);
				sent++;
				survivors.push(s);
			} catch (err) {
				const code = err && err.statusCode;
				if (code === 404 || code === 410) {
					// subscription is gone -- drop it (do not keep)
					failed++;
				} else {
					// transient failure -- keep the sub for next time
					failed++;
					survivors.push(s);
				}
				console.warn('[push-send] send fail', code || (err && err.message));
			}
		}

		// prune dead subs if any were dropped
		if (survivors.length !== subs.length) {
			try { await writeSubs(tripCode, survivors); } catch (e) { console.error('[push-send] prune write failed', e.message); }
		}

		console.log('[push-send] trip', tripCode, '| sent', sent, '| failed', failed, '| remaining', survivors.length);
		return res.status(200).json({ ok: true, sent: sent, failed: failed, remaining: survivors.length });
	} catch (e) {
		console.error('[push-send] error', e.message);
		return res.status(400).json({ error: e.message });
	}
}
