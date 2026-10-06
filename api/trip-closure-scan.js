// api/trip-closure-scan.js
// Vercel cron (Bearer CRON_SECRET, attached by Vercel to cron invocations) + admin-key manual runs. The bare x-vercel-cron header stopped authenticating Oct 6, 2026 -- it is spoofable by anyone.
// Twice-weekly closure impact scan (Mon + Thu, scheduled after the section rebuilds):
//   1. Read CLOSURES + DINING_CLOSURES from the dynamic cache.
//   2. Diff against the previous snapshot -> material changes
//      (added, removed, or closeDate/reopenDate/status shifted).
//   3. On material change (after the first baseline run): scan every trip in the
//      registry; for each dated itinerary item whose closure window covers the trip
//      date, append a closureAlerts entry (deduped by stable id). Suggested swaps use
//      deterministicBackfill with a synthetic slot -- the same picker as generation.
//   4. Write a public scan report blob for the Muse-side watcher cron.
// POLICY: annotate, never rewrite. Saved itineraries are never modified; alerts and
// suggested swaps sit on top and the app renders them as a banner.
import { list, put } from '@vercel/blob';
import { closedNamesForDate, deterministicBackfill, buildCatalogIndex, parseCatalogVenues, closureKey, diffClosureLists, alertIdFor } from './scaffold.js';

const DYNAMIC_PREFIX = 'twize/park_intel_dl_dynamic.json';
const STABLE_PREFIX = 'twize/park_intel_dl_stable.json';
const STATE_KEY = 'twize/closure_scan_state.json';
const REPORT_KEY = 'twize/closure_scan_report.json';
const SALT = (process.env.BLOB_PATH_SALT || '').trim();
const tripKey = (id) => SALT ? ('twize/' + SALT + '/trip_' + id + '.json') : ('twize/trip_' + id + '.json');
const registryKey = () => SALT ? ('twize/' + SALT + '/trip_registry.json') : 'twize/trip_registry.json';

// ---------------------------------------------------------------------------
// (Pure diff helpers live in scaffold.js: closureKey, diffClosureLists, alertIdFor.)
// ---------------------------------------------------------------------------

function describeChange(kind, change, entry) {
  const e = change === 'changed' ? entry.after : entry;
  const d = { kind, change, name: e.name, park: e.park || '', closeDate: e.closeDate || null, reopenDate: e.reopenDate || null };
  if (change === 'changed') d.was = { closeDate: entry.before.closeDate || null, reopenDate: entry.before.reopenDate || null };
  return d;
}

// ---------------------------------------------------------------------------
// Blob helpers.
// ---------------------------------------------------------------------------
async function readFirstJson(prefix) {
  const { blobs } = await list({ prefix });
  if (!blobs || !blobs.length) return null;
  const url = blobs[0].downloadUrl || blobs[0].url;
  const r = await fetch(url + '?t=' + Date.now());
  if (!r.ok) return null;
  return r.json();
}

async function readTripBlob(id) {
  const d = await readFirstJson(tripKey(id));
  if (d) return d;
  if (SALT) return readFirstJson('twize/trip_' + id + '.json'); // bare fallback
  return null;
}

async function writeJson(key, obj) {
  await put(key, JSON.stringify(obj), {
    access: 'public', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json',
  });
}

// Find the closure entry covering an itinerary item on a date (null-date contract
// via closedNamesForDate: null closeDate = already closed as of the cache build).
function coveringEntry(entries, date, itemName) {
  const hL = String(itemName || '').toLowerCase();
  if (!hL) return null;
  const closed = new Set(closedNamesForDate(entries, date).map(s => String(s).toLowerCase()));
  return (entries || []).find(e => {
    const n = String((e && e.name) || '').toLowerCase();
    return n && closed.has(n) && hL.indexOf(n) !== -1;
  }) || null;
}

function suggestSwap(kind, dayPark, date, items, catList, venues, closures, diningClosures) {
  try {
    const slot = { type: kind === 'ride' ? 'ride' : 'dining', park: dayPark, window: [600, 660], block: 'tip' };
    const usedNames = new Set(items.map(it => String(it.h || '').toLowerCase()).filter(Boolean));
    const card = deterministicBackfill(slot, {
      catalog: catList, venues,
      closedNames: closedNamesForDate(closures, date),
      closedVenueNames: closedNamesForDate(diningClosures, date),
      usedRideKeys: new Set(), usedNames,
    });
    if (!card || !card.h) return null;
    // Backfill returns a tip fallback when nothing fits -- only keep real picks.
    const want = kind === 'ride' ? ['ride'] : ['dining', 'quickservice', 'snack'];
    if (!want.includes(card.type)) return null;
    if (usedNames.has(String(card.h).toLowerCase())) return null; // dupe guard
    return { name: card.h, land: card.land || '', note: card.n || '' };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const isAuthed = !!cronSecret && req.headers.authorization === ('Bearer ' + cronSecret);
    const adminKey = (process.env.ADMIN_KEY || '').toLowerCase();
    const isAdmin = adminKey && String(req.headers['x-admin-key'] || '').toLowerCase() === adminKey;
    if (!isAuthed && !isAdmin) return res.status(401).json({ ok: false, error: 'Unauthorized.' });

    const dyn = await readFirstJson(DYNAMIC_PREFIX);
    const sections = ((dyn && dyn.data) || dyn || {}).sections || {};
    const closures = Array.isArray(sections.CLOSURES) ? sections.CLOSURES : [];
    const diningClosures = Array.isArray(sections.DINING_CLOSURES) ? sections.DINING_CLOSURES : [];

    const prevState = (await readFirstJson(STATE_KEY)) || {};
    const prevSnap = prevState.snapshot || null;
    const firstRun = !prevSnap;
    const rideDiff = diffClosureLists(prevSnap ? prevSnap.closures : [], closures);
    const diningDiff = diffClosureLists(prevSnap ? prevSnap.diningClosures : [], diningClosures);
    const materialChanges = [
      ...rideDiff.added.map(e => describeChange('ride', 'added', e)),
      ...rideDiff.removed.map(e => describeChange('ride', 'removed', e)),
      ...rideDiff.changed.map(e => describeChange('ride', 'changed', e)),
      ...diningDiff.added.map(e => describeChange('dining', 'added', e)),
      ...diningDiff.removed.map(e => describeChange('dining', 'removed', e)),
      ...diningDiff.changed.map(e => describeChange('dining', 'changed', e)),
    ];

    const report = {
      ok: true, ts: new Date().toISOString(), baseline: firstRun,
      materialChanges, tripsScanned: 0, tripsAffected: [],
    };

    if (!firstRun && materialChanges.length) {
      const stable = await readFirstJson(STABLE_PREFIX);
      const catSections = ((stable && stable.data) || stable || {}).sections || {};
      const catList = Object.values(buildCatalogIndex(catSections.CATALOG));
      const venues = parseCatalogVenues(catSections.CATALOG);

      let registry = await readFirstJson(registryKey());
      if (!registry && SALT) registry = await readFirstJson('twize/trip_registry.json');
      const ids = Object.keys(registry || {});
      for (const id of ids) {
        let trip;
        try { trip = await readTripBlob(id); } catch (e) { continue; }
        if (!trip) continue;
        report.tripsScanned++;
        const cfg = trip.tripConfig || {};
        const sched = cfg.schedule || trip.schedule || {};
        const days = Array.isArray(sched.days) ? sched.days : [];
        const cfgDays = Array.isArray(cfg.days) ? cfg.days : [];
        if (!days.length) continue;
        const existing = Array.isArray(trip.closureAlerts) ? trip.closureAlerts : [];
        const seen = new Set(existing.map(a => a && a.id).filter(Boolean));
        const fresh = [];
        days.forEach((day, di) => {
          const cfgDay = cfgDays[di] || {};
          const date = cfgDay.date || day.date || '';
          if (!date) return;
          const items = Array.isArray(day.items) ? day.items : [];
          const dayPark = cfgDay.park || 'Disneyland';
          for (const it of items) {
            const h = String(it.h || '');
            if (!h) continue;
            const type = String(it.type || '');
            let entry = null, kind = null;
            if (type === 'ride') { entry = coveringEntry(closures, date, h); kind = 'ride'; }
            else if (type === 'dining' || type === 'quickservice' || type === 'snack') {
              entry = coveringEntry(diningClosures, date, h); kind = 'dining';
            }
            if (!entry) continue;
            const aid = alertIdFor(kind, entry);
            if (seen.has(aid)) continue;
            seen.add(aid);
            fresh.push({
              id: aid, kind, dayIndex: di, date, item: h,
              closure: {
                name: entry.name, park: entry.park || '', land: entry.land || '',
                closeDate: entry.closeDate || null, reopenDate: entry.reopenDate || null,
                reopenConfidence: entry.reopenConfidence || 'unknown', note: entry.note || '',
              },
              suggestion: suggestSwap(kind, dayPark, date, items, catList, venues, closures, diningClosures),
              createdAt: report.ts,
            });
          }
        });
        if (fresh.length) {
          trip.closureAlerts = existing.concat(fresh);
          await writeJson(tripKey(id), trip);
          report.tripsAffected.push({ tripId: id, newAlerts: fresh.length });
        }
      }
    }

    await writeJson(STATE_KEY, {
      snapshot: { closures, diningClosures },
      lastScan: report.ts,
      lastMaterial: materialChanges.length ? report.ts : (prevState.lastMaterial || null),
    });
    await writeJson(REPORT_KEY, report);
    return res.status(200).json(report);
  } catch (e) {
    console.error('[trip-closure-scan]', e.message);
    return res.status(500).json({ ok: false, error: 'scan failed' });
  }
}
