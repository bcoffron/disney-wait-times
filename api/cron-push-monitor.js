// api/cron-push-monitor.js
// Wait-spike monitor. Runs frequently during park hours, watches every trip that
// has push subscriptions, and notifies a trip when a ride ON THAT TRIP'S SCHEDULE
// FOR TODAY spikes from low to high. Built for scale: discovers all trips, pulls
// live waits once, checks each trip's planned rides against per-trip last-known state.
//
// INTERNAL ONLY. Auth: Bearer CRON_SECRET, OR x-vercel-cron:1, OR admin key.
// Storage:
//   twize/push-subs/<tripCode>.json   -- subscriptions (read; reuse push-send logic)
//   twize/trip_registry.json          -- code -> { tripId, status, expires }
//   twize/trip_<tripId>.json          -- tripData.tripConfig.schedule + .days[].isVip
//   twize/wait-state/<tripId>.json    -- last-known waits + per-ride alert cooldowns
//
// Spike definition mirrors the in-app toast: was <= LOW_MAX, now >= SPIKE_MIN.

import webpush from 'web-push';

const ADMIN_KEY_DEFAULT = 'CWdis2026admin';

// ThemeParks.wiki entity ids -- identical to api/waittimes.js
const DL_ID = '7340550b-c14d-4def-80bb-acdb51d49a66';
const DCA_ID = '832fcd51-ea19-4e77-85c7-75d5843b127c';

// Spike thresholds (mirror client spike toast)
const LOW_MAX = 30;     // previous wait must have been <= this (spike)
const SPIKE_MIN = 45;   // current wait must be >= this (spike)
const ALERT_COOLDOWN_MIN = 90; // do not re-alert the same ride within this many minutes
// Drop detection (opportunistic, sparing): ride was high, now genuinely short.
const DROP_PREV_MIN = 45;   // previous wait must have been >= this
const DROP_NOW_MAX = 15;    // current wait must be <= this (genuinely short, not just lower)
const DROP_DELTA_MIN = 35;  // must have dropped at least this much (avoid 50->40 noise)
const DROP_DAY_CUTOFF_MIN = 21 * 60; // do not send drop alerts after 9 PM (little day left to use it)
// High-wait nudge: planned ride already busy (not just a sudden spike). Once per ride per day, gated per-trip.
const HIGH_MIN = 60;           // current wait must be >= this to nudge
const HIGH_COOLDOWN_MIN = 75;  // per-trip: at most one high-wait nudge this often

// Ride-down nudge: a planned rope-drop ride is not operating this morning.
const ROPE_DROP_END_MIN = 10 * 60 + 30;   // 10:30 AM PT -- only alert about a down ride during the morning rope-drop window
const DOWN_STATUSES = { DOWN: 1, REFURBISHMENT: 1 }; // ThemeParks.wiki statuses that mean a planned ride is unavailable

// Park hours guard (Pacific). Outside this window, skip entirely.
const PARK_OPEN_HOUR_PT = 6; // 6 AM PT (allow early-entry pre-open ride-down / refurb alerts)
const PARK_CLOSE_HOUR_PT = 24; // midnight PT (rides can run to ~midnight)

// Parse a schedule item time like "8:00 AM" into minutes since midnight; -1 if unparseable.
function hmToMin(t) {
	if (!t) return -1;
	const m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
	if (!m) return -1;
	let h = parseInt(m[1], 10); const mn = parseInt(m[2], 10);
	const pm = m[3].toUpperCase() === 'PM';
	if (pm && h !== 12) h += 12;
	if (!pm && h === 12) h = 0;
	return h * 60 + mn;
}

function safeTripId(raw) {
	if (typeof raw !== 'string') return '';
	const t = raw.trim();
	if (!/^[A-Za-z0-9_-]{3,60}$/.test(t)) return '';
	return t;
}
function safeTripCode(raw) {
	if (typeof raw !== 'string') return '';
	const t = raw.trim();
	if (!/^[A-Za-z0-9-]{8,40}$/.test(t)) return '';
	return t;
}

// ---- name normalization so schedule item.h matches the live-wait name ----
function normName(s) {
	return (s || '')
		.toLowerCase()
		// strip a leading "Rope Drop" marker the schedule prepends to some items
		.replace(/^\s*rope\s*drop\s*[-:\u2013\u2014]?\s*/i, '')
		.replace(/\s*\((?:llmp|ll|lightning lane)\s*return\)\s*/i, ' ')
		.replace(/\s*[-\u2013\u2014]\s*(?:llmp|ll|lightning lane)\s*return\s*/i, ' ')
		.replace(/\s*(?:llmp|ll|lightning lane)\s*return\s*/i, ' ')
		.replace(/[\u2019']/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

// Aliases for rides whose schedule name and live-feed name genuinely differ
// (not just punctuation). Keys/values are normName() outputs.
const NAME_ALIASES = {
	'soarin around the world': 'soarin over california'
};

// Resolve a schedule ride name to a live-wait record. Tries, in order:
// exact normalized match, alias, then bidirectional prefix (handles live names
// with extra suffixes like "Pixar Pal-A-Round - Swinging").
function resolveLive(scheduleName, liveByName, liveKeys) {
	const k = normName(scheduleName);
	if (liveByName[k]) return liveByName[k];
	if (NAME_ALIASES[k] && liveByName[NAME_ALIASES[k]]) return liveByName[NAME_ALIASES[k]];
	// prefix match: schedule "pixar pal a round" vs live "pixar pal a round swinging"
	for (let i = 0; i < liveKeys.length; i++) {
		const lk = liveKeys[i];
		if (lk === k) return liveByName[lk];
		if (lk.indexOf(k + ' ') === 0 || k.indexOf(lk + ' ') === 0) return liveByName[lk];
	}
	return null;
}

// Parse a per-day date that may be ISO ("2026-06-28") or human ("Jun 28, 2026")
// into a normalized "YYYY-MM-DD" string for comparison. Returns '' if unparseable.
const MONTHS = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
	jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
function normDate(raw) {
	if (!raw || typeof raw !== 'string') return '';
	const s = raw.trim();
	const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
	// "Jun 28, 2026" / "June 28 2026"
	const hm = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
	if (hm) {
		const mo = MONTHS[hm[1].slice(0, 3).toLowerCase()];
		if (mo) return hm[3] + '-' + mo + '-' + (hm[2].length === 1 ? '0' + hm[2] : hm[2]);
	}
	return '';
}

// ---- Pacific-time helpers (Disneyland local) ----
function pacificParts(now) {
	// Returns { y, m, d, hour, minute } in America/Los_Angeles
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/Los_Angeles',
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', hour12: false
	});
	const parts = {};
	for (const p of fmt.formatToParts(now)) { parts[p.type] = p.value; }
	return {
		ymd: parts.year + '-' + parts.month + '-' + parts.day,
		hour: parseInt(parts.hour, 10),
		minute: parseInt(parts.minute, 10)
	};
}

// ---- blob helpers (match house pattern, @vercel/blob 0.27.3) ----
async function readJsonBlob(key) {
	try {
		const { list } = await import('@vercel/blob');
		const { blobs } = await list({ prefix: key });
		if (!blobs || blobs.length === 0) return null;
		const resp = await fetch(blobs[0].url + '?t=' + Date.now(), { cache: 'no-store' });
		if (!resp.ok) return null;
		return await resp.json();
	} catch (e) {
		console.error('[push-monitor] read error', key, e.message);
		return null;
	}
}
async function writeJsonBlob(key, obj) {
	const { put } = await import('@vercel/blob');
	await put(key, JSON.stringify(obj), {
		access: 'public', addRandomSuffix: false, contentType: 'application/json'
	});
}
async function listTripCodesWithSubs() {
	try {
		const { list } = await import('@vercel/blob');
		const { blobs } = await list({ prefix: 'twize/push-subs/' });
		const codes = [];
		for (const b of (blobs || [])) {
			const m = (b.pathname || b.url || '').match(/push-subs\/([^/]+)\.json/);
			if (m) { const c = safeTripCode(m[1]); if (c) codes.push(c); }
		}
		return Array.from(new Set(codes));
	} catch (e) {
		console.error('[push-monitor] list subs error', e.message);
		return [];
	}
}

// ---- send to one trip's subscriptions (mirrors push-send) ----
async function sendToTrip(tripCode, payloadObj) {
	const subsBlob = await readJsonBlob('twize/push-subs/' + tripCode + '.json');
	const subs = (subsBlob && Array.isArray(subsBlob.subscriptions)) ? subsBlob.subscriptions : [];
	if (!subs.length) return { sent: 0, failed: 0, pruned: 0 };
	const payload = JSON.stringify(payloadObj);
	let sent = 0, failed = 0;
	const survivors = [];
	for (const s of subs) {
		try {
			await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload);
			sent++; survivors.push(s);
		} catch (err) {
			const code = err && err.statusCode;
			failed++;
			if (code !== 404 && code !== 410) survivors.push(s); // keep on transient errors only
			console.warn('[push-monitor] send fail', code || (err && err.message));
		}
	}
	let pruned = 0;
	if (survivors.length !== subs.length) {
		pruned = subs.length - survivors.length;
		try {
			await writeJsonBlob('twize/push-subs/' + tripCode + '.json',
				{ tripCode: tripCode, subscriptions: survivors, updated: new Date().toISOString() });
		} catch (e) { console.error('[push-monitor] prune write failed', e.message); }
	}
	return { sent, failed, pruned };
}

export default async function handler(req, res) {
	// ---- AUTH FIRST (internal only) ----
	const secret = process.env.CRON_SECRET;
	const isAuthed = secret && req.headers.authorization === ('Bearer ' + secret);
	const isVercelCron = req.headers['x-vercel-cron'] === '1';
	const ADMIN_KEY = (process.env.ADMIN_KEY || ADMIN_KEY_DEFAULT).toLowerCase();
	const isAdmin = (req.headers['x-admin-key'] || '').toLowerCase() === ADMIN_KEY;
	if (!isAuthed && !isVercelCron && !isAdmin) {
		console.warn('[push-monitor] unauthorized blocked');
		return res.status(401).json({ error: 'Unauthorized' });
	}
	res.setHeader('X-Content-Type-Options', 'nosniff');

	const now = new Date();
	const pt = pacificParts(now);
	const force = req.query && (req.query.force === '1'); // admin manual run bypasses hours guard

	// ---- PARK HOURS GUARD ----
	if (!force && (pt.hour < PARK_OPEN_HOUR_PT || pt.hour >= PARK_CLOSE_HOUR_PT)) {
		return res.status(200).json({ ok: true, skipped: 'outside park hours', ptHour: pt.hour });
	}

	// ---- VAPID config ----
	const pub = process.env.VAPID_PUBLIC_KEY;
	const priv = process.env.VAPID_PRIVATE_KEY;
	const subj = process.env.VAPID_SUBJECT || 'mailto:hello@themeparkcopilot.com';
	if (!pub || !priv) return res.status(500).json({ error: 'VAPID keys not configured' });
	try { webpush.setVapidDetails(subj, pub, priv); }
	catch (e) { return res.status(500).json({ error: 'VAPID config invalid: ' + e.message }); }

	try {
		// ---- 1. discover trips with subscriptions ----
		const tripCodes = await listTripCodesWithSubs();
		if (!tripCodes.length) return res.status(200).json({ ok: true, trips: 0, note: 'no subscribed trips' });

		// ---- 2. registry: code -> tripId ----
		const registry = await readJsonBlob('twize/trip_registry.json') || {};

		// ---- 3. live waits once (shared across all trips) ----
		const [dlResp, dcaResp] = await Promise.all([
			fetch('https://api.themeparks.wiki/v1/entity/' + DL_ID + '/live'),
			fetch('https://api.themeparks.wiki/v1/entity/' + DCA_ID + '/live')
		]);
		const [dlData, dcaData] = await Promise.all([dlResp.json(), dcaResp.json()]);
		const liveByName = {};
		const ingest = (data) => {
			for (const r of (data.liveData || [])) {
				if (r.entityType !== 'ATTRACTION') continue;
				const w = (r.queue && r.queue.STANDBY && typeof r.queue.STANDBY.waitTime === 'number')
					? r.queue.STANDBY.waitTime : null;
				if (w === null && !DOWN_STATUSES[r.status]) continue;
				liveByName[normName(r.name)] = { wait: w, status: r.status, name: r.name };
			}
		};
		ingest(dlData); ingest(dcaData);
		const liveKeys = Object.keys(liveByName);

		const summary = [];

		// ---- 4. per trip ----
		for (const code of tripCodes) {
			const entry = registry[code];
			if (!entry || entry.status !== 'active') { summary.push({ code, skip: 'inactive' }); continue; }
			const tripId = safeTripId(entry.tripId || '');
			if (!tripId) { summary.push({ code, skip: 'bad tripId' }); continue; }

			const tripData = await readJsonBlob('twize/trip_' + tripId + '.json');
			const cfg = tripData && tripData.tripConfig;
			const schedule = cfg && cfg.schedule;
			if (!schedule || !Array.isArray(schedule.days)) { summary.push({ code, skip: 'no schedule' }); continue; }

			// which day index is "today" in Pacific? dates live in cfg.days[i].date
			// (human "Jun 28, 2026" or ISO), index-aligned with schedule.days[i].
			let todayIdx = -1;
			const cfgDays = Array.isArray(cfg.days) ? cfg.days : [];
			for (let i = 0; i < schedule.days.length; i++) {
				const rawDate = (cfgDays[i] && cfgDays[i].date) ||
					(schedule.days[i] && (schedule.days[i].date || schedule.days[i].isoDate)) || '';
				if (normDate(rawDate) === pt.ymd) { todayIdx = i; break; }
			}
			if (todayIdx === -1) { summary.push({ code, skip: 'no day for today (' + pt.ymd + ')' }); continue; }

			// skip VIP days -- the guide handles optimization
			const isVip = cfgDays[todayIdx] && cfgDays[todayIdx].isVip === true;
			if (isVip) { summary.push({ code, skip: 'VIP day' }); continue; }

			const items = Array.isArray(schedule.days[todayIdx].items) ? schedule.days[todayIdx].items : [];
			const rideItems = items.filter(it => it && it.type === 'ride' && it.h);

			// load per-trip wait state (last-known waits + cooldowns)
			const stateKey = 'twize/wait-state/' + tripId + '.json';
			const state = (await readJsonBlob(stateKey)) || { ymd: pt.ymd, rides: {} };
			if (state.ymd !== pt.ymd) { state.ymd = pt.ymd; state.rides = {}; state.lastHighAlertMin = -99999; } // new day -> reset

			const nowMin = pt.hour * 60 + pt.minute;
			let firedThisTrip = 0;
			const spikes = [];
			const drops = [];
			const highs = [];
			const downs = [];
			const lastHigh = (typeof state.lastHighAlertMin === 'number') ? state.lastHighAlertMin : -99999;

			for (const it of rideItems) {
				const live = resolveLive(it.h, liveByName, liveKeys);
				// DOWN detector: a ride you planned to ride this morning is not operating (rope-drop window only,
				// once per ride per day -- state.rides resets daily). Runs before the OPERATING bail below.
				if (nowMin <= ROPE_DROP_END_MIN && live && DOWN_STATUSES[live.status]) {
					const dkey = normName(live.name);
					const schedMin = hmToMin(it.t);
					const alreadyDown = (state.rides[dkey] || {}).downAlerted === true;
					if (schedMin >= 0 && schedMin <= ROPE_DROP_END_MIN && !alreadyDown && !downs.some(d => d.key === dkey)) {
						downs.push({ name: live.name, key: dkey, status: live.status });
					}
				}
				if (!live || live.status !== 'OPERATING') continue;
				const key = normName(live.name); // key state by the stable live name
				const cur = live.wait;
				const prevRec = state.rides[key] || {};
				const prev = (typeof prevRec.wait === 'number') ? prevRec.wait : null;
				const lastAlert = (typeof prevRec.lastAlertMin === 'number') ? prevRec.lastAlertMin : -99999;
				const lastDrop = (typeof prevRec.lastDropMin === 'number') ? prevRec.lastDropMin : -99999;

				// spike: had a previous low reading, now high, and not in spike cooldown
				const isSpike = prev !== null && prev <= LOW_MAX && cur >= SPIKE_MIN
					&& (nowMin - lastAlert) >= ALERT_COOLDOWN_MIN;

				// high: planned ride already busy, no low->high jump needed. Once per ride per day,
				// gated by a per-trip cooldown in the send block so busy rides don't stack alerts.
				const highDone = prevRec.highAlerted === true;
				const isHigh = !isSpike && !highDone && cur >= HIGH_MIN
					&& (nowMin - lastHigh) >= HIGH_COOLDOWN_MIN;

				// drop: was high, now genuinely short, dropped a lot, day not over, not in drop cooldown.
				// Spikes take priority -- a ride can't be both (cur can't be >=45 and <=15), but guard anyway.
				const isDrop = !isSpike && !isHigh && prev !== null && cur !== null && prev >= DROP_PREV_MIN && cur <= DROP_NOW_MAX
					&& (prev - cur) >= DROP_DELTA_MIN
					&& nowMin < DROP_DAY_CUTOFF_MIN
					&& (nowMin - lastDrop) >= ALERT_COOLDOWN_MIN;

				if (isHigh) highs.push({ name: live.name, key: key, to: cur });
				if (isSpike) {
					spikes.push({ name: live.name, from: prev, to: cur });
					state.rides[key] = { wait: cur, lastAlertMin: nowMin, lastDropMin: lastDrop, highAlerted: highDone };
				} else if (isDrop) {
					drops.push({ name: live.name, from: prev, to: cur });
					state.rides[key] = { wait: cur, lastAlertMin: lastAlert, lastDropMin: nowMin, highAlerted: highDone };
				} else {
					state.rides[key] = { wait: cur, lastAlertMin: lastAlert, lastDropMin: lastDrop, highAlerted: highDone };
				}
			}

			// fire one notification per trip. A planned ride down at rope drop wins; then spikes, busy nudges, drops.
			if (downs.length) {
				const d = downs[0];
				const more = downs.length > 1 ? (' (+' + (downs.length - 1) + ' more)') : '';
				const body = (d.status === 'REFURBISHMENT')
					? (d.name + ' is closed for refurbishment' + more + '. Tap to rework your morning.')
					: (d.name + ' is temporarily down right now' + more + '. Tap to rework your morning.');
				const payload = {
					title: 'Planned ride is down',
					body: body,
					url: '/app.html',
					tag: 'tpcp-ride-down'
				};
				const r = await sendToTrip(code, payload);
				firedThisTrip = r.sent;
				if (r.sent > 0) {
					for (const dn of downs) {
						const rec = state.rides[dn.key] || {};
						rec.downAlerted = true;
						state.rides[dn.key] = rec;
					}
				}
			} else if (spikes.length) {
				spikes.sort((a, b) => b.to - a.to);
				const worst = spikes[0];
				const more = spikes.length > 1 ? (' (+' + (spikes.length - 1) + ' more)') : '';
				const payload = {
					title: 'Wait spike on your plan',
					body: worst.name + ' just jumped to ~' + worst.to + ' min' + more + '. Tap for better options.',
					url: '/app.html',
					tag: 'tpcp-wait-spike'
				};
				const r = await sendToTrip(code, payload);
				firedThisTrip = r.sent;
			} else if (highs.length) {
				highs.sort((a, b) => b.to - a.to);
				const worst = highs[0];
				const payload = {
					title: 'Heads up on your plan',
					body: worst.name + ' is running ~' + worst.to + ' min right now \u2014 want to rework your next move?',
					url: '/app.html',
					tag: 'tpcp-wait-high'
				};
				const r = await sendToTrip(code, payload);
				firedThisTrip = r.sent;
				if (r.sent > 0) {
					state.lastHighAlertMin = nowMin;
					if (state.rides[worst.key]) state.rides[worst.key].highAlerted = true;
				}
			} else if (drops.length) {
				// opportunistic, gentle: pick the biggest drop (lowest current wait)
				drops.sort((a, b) => a.to - b.to);
				const best = drops[0];
				const payload = {
					title: 'Short wait on your plan',
					body: best.name + ' just dropped to ~' + best.to + ' min and it\u2019s on your plan \u2014 want to grab it now?',
					url: '/app.html',
					tag: 'tpcp-wait-drop'
				};
				const r = await sendToTrip(code, payload);
				firedThisTrip = r.sent;
			}

			await writeJsonBlob(stateKey, state);
			summary.push({ code, tripId, dayIdx: todayIdx, ridesChecked: rideItems.length, downs: downs.length, spikes: spikes.length, highs: highs.length, drops: drops.length, sent: firedThisTrip });
		}

		console.log('[push-monitor] ' + pt.ymd + ' ' + pt.hour + ':' + pt.minute + ' PT | ' + JSON.stringify(summary));
		return res.status(200).json({ ok: true, ptHour: pt.hour, trips: tripCodes.length, summary });
	} catch (e) {
		console.error('[push-monitor] error', e.message);
		return res.status(500).json({ error: e.message });
	}
}
