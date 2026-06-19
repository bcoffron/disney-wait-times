// api/build-ride-coords.js
// One-shot builder: fetches ThemeParks.wiki /children for DL + DCA, extracts each
// attraction's name + lat/lon + park, stores a static coordinate map in Blob at
// twize/ride_coords.json. Ride coordinates do not change, so this is refreshed rarely.
// The reroute engine reads this to compute real walking distance between rides.
//
// INTERNAL ONLY. Auth: Bearer CRON_SECRET, OR x-vercel-cron:1, OR admin key.

const ADMIN_KEY_DEFAULT = 'CWdis2026admin';
const DL_ID = '7340550b-c14d-4def-80bb-acdb51d49a66';
const DCA_ID = '832fcd51-ea19-4e77-85c7-75d5843b127c';
const COORDS_KEY = 'twize/ride_coords.json';

async function fetchChildren(entityId, park) {
	const r = await fetch('https://api.themeparks.wiki/v1/entity/' + entityId + '/children');
	const d = await r.json();
	const out = [];
	for (const c of (d.children || [])) {
		if (c.entityType !== 'ATTRACTION') continue;
		const loc = c.location;
		if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') continue;
		out.push({ name: c.name, park: park, lat: loc.latitude, lon: loc.longitude });
	}
	return out;
}

export default async function handler(req, res) {
	// ---- AUTH FIRST (internal only) ----
	const secret = process.env.CRON_SECRET;
	const isAuthed = secret && req.headers.authorization === ('Bearer ' + secret);
	const isVercelCron = req.headers['x-vercel-cron'] === '1';
	const ADMIN_KEY = (process.env.ADMIN_KEY || ADMIN_KEY_DEFAULT).toLowerCase();
	const isAdmin = (req.headers['x-admin-key'] || '').toLowerCase() === ADMIN_KEY;
	if (!isAuthed && !isVercelCron && !isAdmin) {
		console.warn('[ride-coords] unauthorized blocked');
		return res.status(401).json({ error: 'Unauthorized' });
	}
	res.setHeader('X-Content-Type-Options', 'nosniff');

	try {
		const [dl, dca] = await Promise.all([
			fetchChildren(DL_ID, 'DL'),
			fetchChildren(DCA_ID, 'DCA')
		]);
		const rides = dl.concat(dca);
		if (!rides.length) return res.status(502).json({ error: 'No coordinates returned from source' });

		const payload = {
			updated: new Date().toISOString(),
			source: 'ThemeParks.wiki/children',
			count: rides.length,
			rides: rides
		};

		const { put } = await import('@vercel/blob');
		await put(COORDS_KEY, JSON.stringify(payload), {
			access: 'public', addRandomSuffix: false, contentType: 'application/json'
		});

		console.log('[ride-coords] stored ' + rides.length + ' rides (DL ' + dl.length + ', DCA ' + dca.length + ')');
		return res.status(200).json({ ok: true, count: rides.length, dl: dl.length, dca: dca.length });
	} catch (e) {
		console.error('[ride-coords] error', e.message);
		return res.status(500).json({ error: e.message });
	}
}
