// api/trip.js - Trip code registry handler
import { put, list, del } from '@vercel/blob';
// validateSchedule is intentionally NOT imported here: saves must not rewrite schedules (see note in the POST handler).
// scaffold.js IS imported, but only for the read-only trip-level surfacing
// computation (computeTripSurfacing) in the POST handler: it reads the final
// stored schedule and reports; it never mutates anything.
import { buildCatalogIndex, computeTripSurfacing, parseCatalogVenues, correctVenueServices, scanTripProseForwardFlags } from './scaffold.js';

// Secret path-prefix hardening. When BLOB_PATH_SALT is set, the registry and
// per-trip blobs live behind an unguessable path segment so their fixed public
// URLs are no longer guessable. When unset, keys fall back to the bare paths
// (current behavior -- no lockout). Never log the salted key or full pathname.
const SALT = (process.env.BLOB_PATH_SALT || '').trim();

// Bare keys (also used as the transition-fallback for reads).
const REGISTRY_KEY = 'twize/trip_registry.json';
const tripBareKey = (tripId) => 'twize/trip_' + tripId + '.json';

// Salted keys -- salted when SALT is set, bare otherwise.
const registrySaltedKey = () => SALT ? ('twize/' + SALT + '/trip_registry.json') : 'twize/trip_registry.json';
const tripSaltedKey = (tripId) => SALT ? ('twize/' + SALT + '/trip_' + tripId + '.json') : ('twize/trip_' + tripId + '.json');

async function readRegistry() {
  try {
    // salted-first, bare-fallback (transition-safe)
    let { blobs } = await list({ prefix: registrySaltedKey() });
    if (!blobs || blobs.length === 0) {
      ({ blobs } = await list({ prefix: REGISTRY_KEY }));
    }
    if (!blobs || blobs.length === 0) return {};
    const resp = await fetch(blobs[0].url);
    if (!resp.ok) return {};
    return await resp.json();
  } catch (e) {
    console.error('trip registry read error', e.message);
    return {};
  }
}

async function writeRegistry(data) {
  await put(registrySaltedKey(), JSON.stringify(data), {
    access: 'public',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: 'application/json'
  });
}

function sanitizeJson(text) {
  const lastBrace = text.lastIndexOf('}}');
  if (lastBrace > -1) return text.substring(0, lastBrace + 2);
  return text;
}

async function readTripBlob(tripId) {
  try {
    // salted-first, bare-fallback (transition-safe)
    let { blobs } = await list({ prefix: tripSaltedKey(tripId) });
    if (!blobs || blobs.length === 0) {
      ({ blobs } = await list({ prefix: tripBareKey(tripId) }));
    }
    if (!blobs || blobs.length === 0) return null;
    const resp = await fetch(blobs[0].url + '?t=' + Date.now());
    if (!resp.ok) return null;
    const rawText = await resp.text();
    return JSON.parse(sanitizeJson(rawText));
  } catch (e) { return null; }
}

async function writeTripBlob(tripId, tripData) {
  await put(tripSaltedKey(tripId), JSON.stringify(tripData), {
    access: 'public',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: 'application/json'
  });
}

// Onboarding drafts (Oct 7, 2026 -- Claude's guardrails, load-bearing after
// the BCDIS2026-A incident): autosave drafts from the onboarding flow live
// in a SEPARATE blob namespace keyed by trip CODE. A draft write can never
// touch the live trip blob (twize/trip_<id>.json); a draft becomes a real
// trip only when the client promotes it through the normal POST save path
// above. Draft keys are intentionally NOT salted (same as the booking-cron
// and device-state keys); the trip-code registry is the access control.
const DRAFT_PREFIX = 'twize/onboarding-drafts/';
const draftKey = (code) => DRAFT_PREFIX + code + '.json';

// Log-safe rendering of a trip code for [trip-draft] lines: the code
// alphabet only, length-capped -- a hostile code string must never
// inject extra lines into the log. Codes themselves are not secrets
// (they are the lookup key every endpoint already logs around); draft
// payload contents are NEVER logged.
function safeCodeForLog(c) {
  const s = String(c == null ? '' : c).replace(/[^A-Za-z0-9_-]/g, '?').slice(0, 64);
  return s || '(none)';
}

async function writeDraftBlob(code, payload) {
  await put(draftKey(code), JSON.stringify(payload), {
    access: 'public',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: 'application/json'
  });
}

// Reads are suffix-tolerant (a stray suffixed variant never hides the
// draft): list the code's prefix, match the exact-or-suffixed pathname,
// and take the newest by upload time.
async function readDraftBlob(code) {
  try {
    const { blobs } = await list({ prefix: DRAFT_PREFIX + code });
    if (!blobs || !blobs.length) return null;
    const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + DRAFT_PREFIX + esc + '(-[^/]*)?\\.json$');
    const matches = blobs.filter(b => b && re.test(b.pathname || ''));
    if (!matches.length) return null;
    matches.sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0));
    const resp = await fetch((matches[0].downloadUrl || matches[0].url) + '?t=' + Date.now());
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    // Fail-soft for the reader (a draft read failure reads as "no
    // draft" and must never break onboarding resume) -- but LOUD: a
    // silent null here is how infra failures masquerade as "the guest
    // never had a draft".
    console.warn('[trip-draft] read failed code=' + safeCodeForLog(code) + ' (reporting no draft)');
    return null;
  }
}

// Cache sections for the trip-level surfacing computation: the SAME blobs and
// sections the generator reads (stable CATALOG; dynamic CLOSURES +
// CURRENT_CLOSURES), read the same way generateschedule's buildCacheContext
// reads them. Best-effort: any failure yields an empty context and the
// surfacing computation simply finds no closures.
async function readSurfacingCache() {
  const out = {};
  const readBlob = async (key) => {
    const { blobs } = await list({ prefix: key });
    if (!blobs || !blobs.length) return null;
    const resp = await fetch(blobs[0].downloadUrl || blobs[0].url);
    if (!resp.ok) return null;
    return await resp.json();
  };
  const section = (data, name) => {
    const sections = (data && data.data && data.data.sections) || {};
    const v = sections[name];
    if (v === undefined || v === null) return undefined;
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  await Promise.all([
    (async () => {
      try {
        const d = await readBlob('twize/park_intel_dl_stable.json');
        const v = d && section(d, 'CATALOG');
        if (v !== undefined) out.CATALOG = v;
      } catch (e) { console.warn('[trip] surfacing stable cache read failed:', e.message); }
    })(),
    (async () => {
      try {
        const d = await readBlob('twize/park_intel_dl_dynamic.json');
        if (d) {
          const cl = section(d, 'CLOSURES');
          if (cl !== undefined) out.CLOSURES = cl;
          const cc = section(d, 'CURRENT_CLOSURES');
          if (cc !== undefined) out.CURRENT_CLOSURES = cc;
        }
      } catch (e) { console.warn('[trip] surfacing dynamic cache read failed:', e.message); }
    })()
  ]);
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_KEY = (process.env.ADMIN_KEY || '').toLowerCase();

  // GET: look up a code
  if (req.method === 'GET') {
    // Per-user schedule data must never be cached by the browser or Vercel edge --
    // stale reads after a rebuild were showing old schedules. Force a fresh read every time.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const code = (req.query.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const registry = await readRegistry();
    const entry = registry[code];
    if (!entry) return res.status(404).json({ error: 'Code not found', valid: false });

    if (entry.status !== 'active') return res.status(403).json({ error: 'Code inactive', valid: false });

    if (entry.expires) {
      const expDate = new Date(entry.expires + 'T23:59:59Z');
      if (expDate < new Date()) return res.status(403).json({ error: 'Code expired', expires: entry.expires, valid: false });
    }

    // Onboarding draft read (Oct 7, 2026): GET ?code=X&draft=1 returns the
    // autosave draft for the code (registry auth above applies unchanged).
    // A tombstone payload ({ draft: null }) reads as "no draft".
    if (req.query.draft === '1') {
      const stored = await readDraftBlob(code);
      const hasDraft = !!(stored && stored.draft != null);
      console.log('[trip-draft] read code=' + safeCodeForLog(code) + ' hasDraft=' + hasDraft);
      return res.status(200).json({
        valid: true,
        tripId: entry.tripId,
        hasDraft,
        draft: hasDraft ? stored.draft : null,
        updatedAt: stored ? (stored.updatedAt || null) : null
      });
    }

    // Check if trip data exists
    let tripData = await readTripBlob(entry.tripId);
    const hasTrip = !!tripData;

    return res.status(200).json({
      valid: true,
      role: entry.role,
      tripId: entry.tripId,
      status: entry.status,
      expires: entry.expires,
      hasTrip,
      tripData: hasTrip ? tripData : null
    });
  }

  // POST: save trip data for a code (requires admin key OR an active owner code)
  if (req.method === 'POST') {
    const sentKey = (req.headers['x-admin-key'] || '').toLowerCase();
    const isAdmin = sentKey === ADMIN_KEY && ADMIN_KEY !== '';

    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      // Onboarding draft write (Oct 7, 2026): POST { action: 'save_draft',
      // code, draft }. Writes ONLY the draft namespace -- never the live
      // trip blob, never the registry. Auth mirrors the trip save exactly
      // (admin key, or an active unexpired role-admin code). A null draft
      // is a tombstone: it clears the draft without deleting the blob.
      // Routing accepts BOTH signals (integration fix, Oct 7, 2026): the
      // body action above, AND the shipped onboarding client's mirror
      // shape -- POST /api/trip?draft=1 with { code, tripCode, draft } and
      // no tripData (pretrip.html ptMirrorDraft). The client's POST fell
      // through to the trip-save path and 400'd before this adapter, so
      // the server mirror never landed. Auth, validation, storage and
      // response below are identical for either signal.
      // HARDENED (Oct 7, 2026, Claude follow-up on the seam fix): the
      // !tripData precondition now guards the WHOLE branch, on BOTH
      // signals. It started on the query arm only, which left the
      // action arm able to consume a body carrying a full trip
      // payload: the save was silently dropped -- and with no draft
      // field present, the same request silently TOMBSTONED the
      // guest's existing server draft. A body carrying tripData is a
      // trip save, full stop; the save path below (with its merge
      // guard) is the only code that may consume one. Structural note:
      // this branch's ONLY write is writeDraftBlob -> draftKey(), a
      // key confined to twize/onboarding-drafts/ by construction (the
      // code is regex-validated to a single path segment, so it can
      // never address twize/trip_<id>.json), meaning no draft write
      // can land on a trip blob even before this guard is consulted.
      // Loud logging (same follow-up): every exit from this branch
      // logs exactly one [trip-draft] line -- a mirror failure masked
      // by the client's local autosave must never be silent again.
      const _isDraftWrite = body && !body.tripData && (body.action === 'save_draft' ||
        (req.query && req.query.draft === '1' && body.draft !== undefined));
      if (_isDraftWrite) {
        const _rawCode = typeof body.code === 'string' ? body.code : (typeof body.tripCode === 'string' ? body.tripCode : '');
        const dcode = _rawCode.trim();
        if (!dcode || !/^[A-Za-z0-9_-]{3,64}$/.test(dcode)) {
          console.log('[trip-draft] rejected code=' + safeCodeForLog(_rawCode) + ' reason=invalid-code');
          return res.status(400).json({ error: 'Invalid code' });
        }
        const registry = await readRegistry();
        const entry = registry[dcode];
        if (!entry) {
          console.log('[trip-draft] rejected code=' + dcode + ' reason=code-not-found');
          return res.status(404).json({ error: 'Code not found' });
        }
        if (!isAdmin) {
          if (entry.status !== 'active') {
            console.log('[trip-draft] rejected code=' + dcode + ' reason=code-inactive');
            return res.status(403).json({ error: 'Code inactive' });
          }
          if (entry.expires) {
            const expDate = new Date(entry.expires + 'T23:59:59Z');
            if (expDate < new Date()) {
              console.log('[trip-draft] rejected code=' + dcode + ' reason=code-expired');
              return res.status(403).json({ error: 'Code expired' });
            }
          }
          if (entry.role !== 'admin') {
            console.log('[trip-draft] rejected code=' + dcode + ' reason=role-not-admin');
            return res.status(403).json({ error: 'Not authorized to write drafts for this trip' });
          }
        }
        const payload = { code: dcode, draft: (body.draft === undefined ? null : body.draft), updatedAt: new Date().toISOString() };
        const _payloadBytes = JSON.stringify(payload).length;
        if (_payloadBytes > 262144) {
          console.log('[trip-draft] rejected code=' + dcode + ' reason=draft-too-large bytes=' + _payloadBytes);
          return res.status(413).json({ error: 'Draft too large' });
        }
        try {
          await writeDraftBlob(dcode, payload);
        } catch (e) {
          console.error('[trip-draft] failed code=' + dcode + ' reason=write-error');
          throw e; // the outer catch responds, exactly as it did before
        }
        console.log('[trip-draft] saved code=' + dcode + ' bytes=' + _payloadBytes);
        return res.status(200).json({ ok: true, draft: true, updatedAt: payload.updatedAt });
      }

      const { code, tripData } = body;
      if (!code || !tripData) return res.status(400).json({ error: 'Missing code or tripData' });

      const registry = await readRegistry();
      const entry = registry[code];
      if (!entry) return res.status(404).json({ error: 'Code not found' });
      if (!isAdmin) {
        if (entry.status !== 'active') {
          return res.status(403).json({ error: 'Code inactive' });
        }
        if (entry.expires) {
          const expDate = new Date(entry.expires + 'T23:59:59Z');
          if (expDate < new Date()) {
            return res.status(403).json({ error: 'Code expired' });
          }
        }
        if (entry.role !== 'admin') {
          return res.status(403).json({ error: 'Not authorized to write this trip' });
        }
      }

      // Auto-stamp scheduleVersion so client caches are invalidated on every save
      if (tripData && tripData.tripConfig) {
        tripData.tripConfig.scheduleVersion = Date.now().toString();
      }
      // NO save-time schedule rewriting. Generation validates its own output
      // (the scaffold path has its verify layer; the legacy path validates inside
      // /api/generateschedule). The legacy validateSchedule pass that used to run
      // here silently mangled scaffold schedules on every save -- it deleted the
      // return-hop rides (its park model has no hop-back segment), inserted
      // 'Explore + Recharge'/'Restroom Break' filler cards, and degraded
      // late-trip ride cards into generic tips. A save must store exactly what
      // the client generated. (Removed Oct 4, 2026.)
      // Merge guard (Oct 6, 2026): a client save that carries no schedule
      // (settings edits, older app builds, a load race) must never erase a
      // schedule already stored for this trip. If the incoming tripConfig
      // has no schedule days but the stored blob does, carry the stored
      // schedule forward. An incoming schedule always wins.
      try {
        const _inDays = tripData && tripData.tripConfig && tripData.tripConfig.schedule && tripData.tripConfig.schedule.days;
        const _needsGuard = !Array.isArray(_inDays) || !_inDays.length || _inDays.some(d => !d || !d.items || !d.items.length);
        if (_needsGuard) {
          const _stored = await readTripBlob(entry.tripId);
          const _stDays = _stored && _stored.tripConfig && _stored.tripConfig.schedule && _stored.tripConfig.schedule.days;
          if (Array.isArray(_stDays) && _stDays.some(d => d && d.items && d.items.length)) {
            if (!Array.isArray(_inDays) || !_inDays.some(d => d && d.items && d.items.length)) {
              // No usable schedule incoming at all: keep the stored one wholesale.
              tripData.tripConfig.schedule = _stored.tripConfig.schedule;
              console.log('[trip-guard] schedule-less save for trip ' + entry.tripId + ': kept stored schedule (' + _stDays.length + ' days)');
            } else {
              // Per-day guard (Oct 6, 2026, build-7 incident): an incoming day
              // with zero items must never erase a stored day that has items.
              // A client save once serialized an empty Day 1 over a freshly
              // generated plan while Days 2-3 were fine, and the old
              // all-or-nothing guard let it through because SOME day had items.
              const _rescued = [];
              for (let _di = 0; _di < _inDays.length; _di++) {
                const _id = _inDays[_di], _sd = _stDays[_di];
                if ((!_id || !_id.items || !_id.items.length) && _sd && _sd.items && _sd.items.length) {
                  _inDays[_di] = _sd;
                  _rescued.push(_di + 1);
                }
              }
              if (_rescued.length) console.log('[trip-guard] trip ' + entry.tripId + ': carried forward stored day(s) ' + _rescued.join(', ') + ' (incoming day was empty)');
            }
          }
        }
      } catch (e) { /* best-effort: never block a save */ }
      // Save to shared trip blob
      await writeTripBlob(entry.tripId, tripData);
      const _blobBodyLen = JSON.stringify(tripData).length;
      console.log('[ptFinish] trip blob write status: 200, bytes written: ' + _blobBodyLen + ', tripId: ' + entry.tripId);

      // Trip-level must-do surfacing (Oct 7, 2026): computed ONCE, here at
      // the save seam, against the schedule exactly as stored (post
      // merge-guard) -- the one place the complete trip is visible.
      // tripUnplacedMustDos = must-dos placed on no day of the saved
      // schedule (minus closed-all-dates and banned); closedMustDos =
      // must-dos closed on every date of the trip. Clients render these
      // response fields as the end-of-build summary and must NOT union the
      // per-day unplacedMustDos diagnostic (it over-reports by design).
      // Best-effort: a surfacing failure never affects the save.
      let _surfFields = null;
      try {
        const _stc = tripData && tripData.tripConfig;
        const _sdays = _stc && _stc.schedule && _stc.schedule.days;
        if (Array.isArray(_sdays) && _sdays.some(d => d && Array.isArray(d.items) && d.items.length)) {
          const _scache = await readSurfacingCache();
          const _surf = computeTripSurfacing(_stc, {
            catalog: buildCatalogIndex(_scache.CATALOG),
            closures: _scache.CLOSURES,
            currentClosures: _scache.CURRENT_CLOSURES
          });
          if (_surf) {
            // tripInsights (Items 3+4, Oct 7, 2026): the per-trip insights
            // channel -- hop-window starvation and reservation-not-seated
            // explanations, computed by computeTripSurfacing from the stored
            // trip. Data only this pass; client rendering is a follow-up.
            _surfFields = { tripUnplacedMustDos: _surf.tripUnplacedMustDos, closedMustDos: _surf.closedMustDos, tripInsights: Array.isArray(_surf.insights) ? _surf.insights : [] };
            if (_surf.tripUnplacedMustDos.length || _surf.closedMustDos.length) {
              console.log('[trip] surfacing trip ' + entry.tripId + ': couldnt-fit=[' + _surf.tripUnplacedMustDos.join(', ') + '] closed-all-dates=[' + _surf.closedMustDos.join(', ') + ']');
            }
            if (_surfFields.tripInsights.length) {
              console.log('[trip] insights trip ' + entry.tripId + ': ' + JSON.stringify(_surfFields.tripInsights.map(i => i.type + ':' + (i.park || i.name || ''))));
            }
          }
          // Prose forward-reference reconciliation (Oct 7, 2026 -- Claude's
          // package-2 ruling): the per-day prose tripwire in generation
          // cannot see a note that names a venue seated on a LATER day
          // (Day 1 prose previewing Day 2's venue). This save seam is the
          // one place the complete trip exists exactly as stored, so the
          // whole-trip reconciliation runs here, beside the surfacing
          // above: scanTripProseForwardFlags re-runs the shipped per-day
          // scanner against the complete trip venue set and reports only
          // the forward references the per-day pass could not flag.
          // Response-only surface (proseVenueFlagsForward); the stored
          // blob is never modified by it. FLAGS ONLY -- never rewrites a
          // note, never blocks the save. Failure-isolated like the rest of
          // this block: its own try/catch, and the scanner itself is
          // fail-open.
          try {
            const _fwd = scanTripProseForwardFlags(_sdays, { venues: correctVenueServices(parseCatalogVenues(_scache.CATALOG)) });
            _surfFields = Object.assign({}, _surfFields || {}, { proseVenueFlagsForward: _fwd });
            if (_fwd.length) {
              console.log('[trip] prose-forward trip ' + entry.tripId + ': ' + JSON.stringify(_fwd.map(f => 'day' + f.day + ':' + f.venue + '->day' + f.seatedDay)));
            }
          } catch (e) { console.warn('[trip] prose-forward scan failed (save unaffected):', e.message); }
        }
      } catch (e) { console.warn('[trip] surfacing computation failed (save unaffected):', e.message); }

      return res.status(200).json(Object.assign({ ok: true, tripId: entry.tripId }, _surfFields || {}));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  // PUT: admin registry management (seed codes, update registry, delete blobs)
  if (req.method === 'PUT') {
    const sentKey = (req.headers['x-admin-key'] || '').toLowerCase();
    if (sentKey !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });

    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      if (body.action === 'init_registry') {
        // Initialize or merge registry entries
        const registry = await readRegistry();
        const entries = body.entries || {};
        Object.assign(registry, entries);
        await writeRegistry(registry);
        return res.status(200).json({ ok: true, codes: Object.keys(registry) });
      }

      if (body.action === 'seed_trip') {
        // Seed a trip's data blob directly
        const { tripId, tripData } = body;
        if (!tripId || tripData === undefined) return res.status(400).json({ error: 'Missing tripId or tripData' });
        await writeTripBlob(tripId, tripData);
        return res.status(200).json({ ok: true, tripId });
      }

      if (body.action === 'delete_blob') {
        const { blobKey } = body;
        if (!blobKey || typeof blobKey !== 'string') return res.status(400).json({ error: 'Missing blobKey' });
        // Safety: only allow deleting trip_ blobs to prevent accidents
        if (!blobKey.startsWith('twize/trip_') && !blobKey.startsWith('twize/current_schedule')) {
          return res.status(400).json({ error: 'Only trip_ and current_schedule blobs may be deleted' });
        }
        try {
          const { blobs } = await list({ prefix: blobKey });
          if (!blobs || blobs.length === 0) return res.status(200).json({ ok: true, deleted: 0 });
          await del(blobs.map(b => b.url));
          console.log('[trip] deleted blob(s):', blobKey, 'count:', blobs.length);
          return res.status(200).json({ ok: true, deleted: blobs.length, key: blobKey });
        } catch(e) {
          return res.status(500).json({ error: e.message });
        }
      }

      return res.status(400).json({ error: 'Unknown action' });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

handler.config = { maxDuration: 15 };
