// api/push-subscribe.js
// Stores a Web Push subscription for a trip, keyed by trip code.
// Auth: valid trip code (>=8 chars) OR admin key - matches vipnotes pattern.
// Storage: one blob per trip at twize/push-subs/<tripCode>.json holding an array
// of subscriptions, de-duped by endpoint. The wait-monitor loads this to notify
// all devices subscribed for a trip.

const ADMIN_KEY_DEFAULT = 'CWdis2026admin';
const MAX_BODY = 50 * 1024; // 50KB - a push subscription is tiny
const MAX_SUBS_PER_TRIP = 50;

function blobKeyFor(tripCode) {
	// tripCode already validated to a safe charset before this is called
	return 'twize/push-subs/' + tripCode + '.json';
}

function safeTripCode(raw) {
	if (typeof raw !== 'string') return '';
	var t = raw.trim();
	// allow letters, digits, dash; 8..40 chars (e.g. BCDIS2026-A)
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
		console.error('[push-subscribe] read error', e.message);
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

function validSubscription(sub) {
	return !!(sub && typeof sub === 'object' &&
		typeof sub.endpoint === 'string' && sub.endpoint.indexOf('https://') === 0 &&
		sub.keys && typeof sub.keys === 'object' &&
		typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string');
}

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-trip-code, x-admin-key');
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

	if (req.method === 'OPTIONS') return res.status(200).end();
	if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

	try {
		var raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
		if (raw && raw.length > MAX_BODY) return res.status(413).json({ error: 'Payload too large' });
		var body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

		// ---- AUTH FIRST ----
		const ADMIN_KEY = (process.env.ADMIN_KEY || ADMIN_KEY_DEFAULT).toLowerCase();
		const sentAdmin = (req.headers['x-admin-key'] || body.adminKey || '').toLowerCase();
		const tripCode = safeTripCode(body.tripCode || req.headers['x-trip-code'] || '');
		const isAdmin = sentAdmin === ADMIN_KEY;
		if (!tripCode) return res.status(400).json({ error: 'Missing or invalid trip code' });
		if (!isAdmin && !(tripCode.length >= 8)) return res.status(401).json({ error: 'Unauthorized' });

		// ---- VALIDATE SUBSCRIPTION ----
		const sub = body.subscription;
		if (!validSubscription(sub)) return res.status(400).json({ error: 'Invalid subscription' });

		// ---- STORE (de-dupe by endpoint) ----
		var subs = await readSubs(tripCode);
		var existingIdx = subs.findIndex(function (s) { return s && s.endpoint === sub.endpoint; });
		var entry = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: new Date().toISOString() };
		if (existingIdx > -1) {
			subs[existingIdx] = entry;
		} else {
			subs.push(entry);
		}
		if (subs.length > MAX_SUBS_PER_TRIP) subs = subs.slice(-MAX_SUBS_PER_TRIP);
		await writeSubs(tripCode, subs);

		console.log('[push-subscribe] stored sub for trip', tripCode, '| total', subs.length);
		return res.status(200).json({ ok: true, count: subs.length });
	} catch (e) {
		console.error('[push-subscribe] error', e.message);
		return res.status(400).json({ error: e.message });
	}
}
