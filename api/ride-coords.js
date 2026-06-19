// api/ride-coords.js
// Public GET: returns the cached ride coordinate map (twize/ride_coords.json) so the
// client reroute logic can compute real walking distance between rides. Data is static
// and non-sensitive (ride names + lat/lon, same as ThemeParks.wiki public data).

const COORDS_KEY = 'twize/ride_coords.json';

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('X-Content-Type-Options', 'nosniff');
	if (req.method === 'OPTIONS') return res.status(200).end();
	if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

	try {
		const { list } = await import('@vercel/blob');
		const { blobs } = await list({ prefix: COORDS_KEY });
		if (!blobs || blobs.length === 0) return res.json({ hit: false, rides: [] });
		const r = await fetch(blobs[0].url + '?t=' + Date.now(), { cache: 'no-store' });
		if (!r.ok) return res.json({ hit: false, rides: [] });
		const data = await r.json();
		// coordinates change rarely -> allow short edge caching
		res.setHeader('Cache-Control', 'public, max-age=3600');
		return res.json({
			hit: true,
			count: data.count || (data.rides ? data.rides.length : 0),
			updated: data.updated || null,
			rides: Array.isArray(data.rides) ? data.rides : []
		});
	} catch (e) {
		console.error('[ride-coords] read error', e.message);
		return res.json({ hit: false, rides: [], error: e.message });
	}
}
