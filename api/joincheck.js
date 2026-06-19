// api/joincheck.js  -- THROWAWAY diagnostic, delete after use.
// Server-side three-way name join: schedule rides <-> live waits <-> coords cache.
// Admin-gated. Returns only miss lists (no sensitive data).

const ADMIN_KEY_DEFAULT = 'CWdis2026admin';
const DL_ID = '7340550b-c14d-4def-80bb-acdb51d49a66';
const DCA_ID = '832fcd51-ea19-4e77-85c7-75d5843b127c';

function normName(s){return (s||'').toLowerCase().replace(/^\s*rope\s*drop\s*[-:\u2013\u2014]?\s*/i,'').replace(/\s*\((?:llmp|ll|lightning lane)\s*return\)\s*/i,' ').replace(/\s*[-\u2013\u2014]\s*(?:llmp|ll|lightning lane)\s*return\s*/i,' ').replace(/\s*(?:llmp|ll|lightning lane)\s*return\s*/i,' ').replace(/[\u2019']/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
const ALIAS={'soarin around the world':'soarin over california'};
function resolve(n,map,keys){const k=normName(n);if(map[k])return map[k];if(ALIAS[k]&&map[ALIAS[k]])return map[ALIAS[k]];for(const x of keys){if(x===k)return map[x];if(x.indexOf(k+' ')===0||k.indexOf(x+' ')===0)return map[x];}return null;}

async function readJsonBlob(key){
	try{
		const { list } = await import('@vercel/blob');
		const { blobs } = await list({ prefix: key });
		if(!blobs||!blobs.length) return null;
		const r = await fetch(blobs[0].url + '?t=' + Date.now(), { cache:'no-store' });
		if(!r.ok) return null;
		return await r.json();
	}catch(e){ return null; }
}

export default async function handler(req, res){
	const ADMIN_KEY=(process.env.ADMIN_KEY||ADMIN_KEY_DEFAULT).toLowerCase();
	if((req.headers['x-admin-key']||'').toLowerCase()!==ADMIN_KEY) return res.status(401).json({error:'Unauthorized'});
	try{
		// schedule rides for BCDIS2026-A
		const reg = await readJsonBlob('twize/trip_registry.json') || {};
		const entry = reg['BCDIS2026-A'];
		const tripId = entry && entry.tripId;
		const trip = tripId ? await readJsonBlob('twize/trip_'+tripId+'.json') : null;
		const days = trip && trip.tripConfig && trip.tripConfig.schedule && trip.tripConfig.schedule.days || [];
		const sched = new Set();
		days.forEach(d=>(d.items||[]).forEach(it=>{ if(it&&it.type==='ride'&&it.h) sched.add(it.h); }));

		// live
		const [dl,dca]=await Promise.all([
			fetch('https://api.themeparks.wiki/v1/entity/'+DL_ID+'/live').then(r=>r.json()),
			fetch('https://api.themeparks.wiki/v1/entity/'+DCA_ID+'/live').then(r=>r.json())
		]);
		const liveMap={};
		[...(dl.liveData||[]),...(dca.liveData||[])].forEach(r=>{ if(r.entityType==='ATTRACTION') liveMap[normName(r.name)]={name:r.name}; });
		const liveKeys=Object.keys(liveMap);

		// coords cache
		const coords = await readJsonBlob('twize/ride_coords.json');
		const coordMap={}; (coords&&coords.rides||[]).forEach(r=>{ coordMap[normName(r.name)]={name:r.name,park:r.park}; });
		const coordKeys=Object.keys(coordMap);

		const liveMiss=[], coordMiss=[];
		sched.forEach(h=>{ if(!resolve(h,liveMap,liveKeys)) liveMiss.push(h); if(!resolve(h,coordMap,coordKeys)) coordMiss.push(h); });

		return res.status(200).json({
			totalSchedRides: sched.size,
			liveMissCount: liveMiss.length, liveMiss,
			coordMissCount: coordMiss.length, coordMiss,
			coordCacheCount: (coords&&coords.count)||0
		});
	}catch(e){ return res.status(500).json({error:e.message}); }
}
