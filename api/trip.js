// api/trip.js - Trip code registry handler
import { put, list, del } from '@vercel/blob';
// validateSchedule is intentionally NOT imported here: saves must not rewrite schedules (see note in the POST handler).
// scaffold.js IS imported, but only for the read-only trip-level surfacing
// computation (computeTripSurfacing) in the POST handler: it reads the final
// stored schedule and reports; it never mutates anything.
import { buildCatalogIndex, computeTripSurfacing, parseCatalogVenues, correctVenueServices, scanTripProseForwardFlags } from './scaffold.js';
// Plan-changed notifications (restoration step iv): this POST is the single
// persistence seam for schedules, so the material-change diff, the schedule
// version stamp, and the notify call all live here (see api/plan-changed.js).
import { notePlanChange, diffScheduleDays, safeDeviceToken } from './plan-changed.js';
// Poll-backstop episodes (Claude msg 94 (i)): the GET response carries the
// trip's recorded push episodes so the client's ~10s foreground poll can
// render any the native shell never handed to its push listener.
import { readEpisodesForPoll, readBookingDone } from './push-episodes.js';

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

// --- Code-pair issuance (restoration step i, Oct 8, 2026) -------------------
// Every trip is a PAIR of codes from birth: a leader code (registry role
// 'admin') and a guest code (role 'guest', view-only). The registry is the
// source of role: the guest code exists as its own registry entry, written
// here at issuance -- role is NEVER derived by parsing a code's suffix at
// request time. deriveGuestCode is an ISSUANCE-time naming rule only (the
// -G form, following the code-pair convention from the May 2026 design:
// 'TPCPTEST01-A' -> 'TPCPTEST01-G'; a bare leader code gains '-G').
// A leader code that itself ends in -G cannot be paired safely by rule and
// is left unpaired (deriveGuestCode returns null).
function deriveGuestCode(leaderCode) {
  if (typeof leaderCode !== 'string' || !leaderCode) return null;
  if (/-g$/i.test(leaderCode)) return null;
  if (/-a$/i.test(leaderCode)) return leaderCode.slice(0, -1) + 'G';
  return leaderCode + '-G';
}

// Mint (or re-sync) the guest half of a leader entry's pair, IN PLACE on the
// registry object. Returns the guest code when the pair exists after the
// call, null when this entry cannot be paired. Mutates the registry only
// when something actually changed, and reports that via the return of
// ensureGuestPair below -- callers persist with writeRegistry.
function mintGuestPair(registry, leaderCode) {
  const entry = registry && registry[leaderCode];
  if (!entry || entry.role !== 'admin') return null;
  let g = (typeof entry.guestCode === 'string' && entry.guestCode) ? entry.guestCode : deriveGuestCode(leaderCode);
  if (!g) return null;
  const existing = registry[g];
  if (existing && existing.tripId !== entry.tripId) return null; // code owned by another trip -- never steal it
  let changed = false;
  if (entry.guestCode !== g) { entry.guestCode = g; changed = true; }
  if (!existing) {
    registry[g] = {
      tripId: entry.tripId,
      role: 'guest',
      status: entry.status || 'active',
      expires: entry.expires,
      leaderCode: leaderCode,
      pairedAt: new Date().toISOString()
    };
    changed = true;
  } else {
    // Re-sync the guest entry's lifecycle fields from the leader entry so a
    // pair can never drift apart on status/expiry.
    if (existing.role !== 'guest') { existing.role = 'guest'; changed = true; }
    if (existing.leaderCode !== leaderCode) { existing.leaderCode = leaderCode; changed = true; }
    if ((existing.status || '') !== (entry.status || '')) { existing.status = entry.status; changed = true; }
    if ((existing.expires || '') !== (entry.expires || '')) { existing.expires = entry.expires; changed = true; }
  }
  return changed ? g : (existing || entry.guestCode ? g : null);
}

// ensureGuestPair(registry, code): pair a validated leader entry if it is
// not paired yet, persisting the registry when (and only when) the mint
// changed something. Used by (a) init_registry at trip creation -- the pair
// is born with the trip -- and (b) the validated read/save paths as the
// BACKFILL for pre-pair legacy trips (Claude msg 70: backfill approved;
// this writes the REGISTRY only -- a trip's schedule blob is never touched
// by pairing, and the tripConfig.guestCode stamp below happens only inside
// a leader save the leader themselves initiated).
async function ensureGuestPair(registry, leaderCode) {
  const before = JSON.stringify(registry);
  const g = mintGuestPair(registry, leaderCode);
  if (!g) return null;
  if (JSON.stringify(registry) !== before) {
    try { await writeRegistry(registry); } catch (e) { console.warn('[trip] guest-pair registry write failed (pairing deferred):', e.message); }
  }
  return g;
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

    // Poll-backstop episodes recorded for THIS code (msg 94 (i) + (iv)):
    // retention-pruned, today-Pacific only. Older clients ignore the
    // field; the current client's blob poll renders the unpresented
    // ones through the foreground push handler.
    const episodes = await readEpisodesForPoll(code);

    // Booking done flags (Claude msg 118): "I made my reservation" is
    // a fact about the TRIP, stored per tripId (api/push-episodes.js),
    // so it merges here -- keyed by the resolved trip, it reaches both
    // the leader's and the guest's poll on this existing read, and a
    // device that has never seen the episode learns it is done before
    // ever presenting it.
    if (episodes.length) {
      const bookingDone = await readBookingDone(entry.tripId);
      for (const ep of episodes) { if (bookingDone[ep.episodeId]) ep.done = true; }
    }

    return res.status(200).json({
      valid: true,
      role: entry.role,
      tripId: entry.tripId,
      status: entry.status,
      expires: entry.expires,
      // The leader's own response carries the pair's guest code (the Share
      // card reads it from here / from TRIP_CONFIG.guestCode). A guest
      // code's response never names the leader code.
      guestCode: entry.role === 'admin' ? (entry.guestCode || null) : null,
      hasTrip,
      tripData: hasTrip ? tripData : null,
      episodes: episodes
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

      // Code-pair issuance (restoration step i): new trips are paired at
      // registration (init_registry); a pre-pair legacy trip is BACKFILLED
      // here, on the leader's own save -- the one product write path that
      // already rewrites this trip's blob, so pairing rides a write the
      // leader owns (registry write + the guestCode stamp below, atomically
      // with the save). Pairing is deliberately NOT done on reads or draft
      // writes: reads stay pure, and draft writes must touch ONLY the
      // draft namespace (the seam discipline the draft/guard suites lock).
      if (entry.role === 'admin') {
        await ensureGuestPair(registry, code);
      }
      // Plan-changed (step iv): capture the pre-save stored blob and the
      // originating device's push token (the client sends its stashed
      // token with the write; older clients send none, which at notify
      // time means no exclusion). The stored snapshot is what the
      // material-change diff below compares the final, post-merge-guard
      // schedule against. The scheduleVersion stamp itself moved below
      // the merge guard: the version now moves ONLY on a material
      // schedule change (see the stamp block there).
      const _pcOriginToken = safeDeviceToken(body && body.deviceToken);
      let _pcStored = null;
      try { _pcStored = await readTripBlob(entry.tripId); } catch (e) { _pcStored = null; }
      if (tripData && tripData.tripConfig) {
        if (entry.guestCode && !tripData.tripConfig.guestCode) {
          tripData.tripConfig.guestCode = entry.guestCode;
        }
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
      // Plan-changed version stamp (step iv): computed against the FINAL
      // schedule (post merge-guard -- exactly what is about to be
      // stored). The version moves ONLY when a day's card sequence
      // materially changed (membership, order, or times --
      // diffScheduleDays in api/plan-changed.js), and it is monotonic:
      // max(now, stored + 1). A save that leaves the schedule untouched
      // (settings-only edits, an identical regeneration, a
      // non-reflowing write, Optimize-then-Keep-current) keeps the
      // stored version: no bump, and below, no push. The stamped value
      // is the version the plan-changed payload carries and the one
      // clients record as applied through the blob poll -- the client's
      // foreground suppression compares the two.
      let _pcNotify = null;
      try {
        const _pcStoredTc = (_pcStored && _pcStored.tripConfig) || null;
        const _pcStoredVersion = _pcStoredTc ? (parseInt(_pcStoredTc.scheduleVersion, 10) || 0) : 0;
        const _pcStoredDays = _pcStoredTc && _pcStoredTc.schedule && _pcStoredTc.schedule.days;
        const _pcFinalDays = tripData && tripData.tripConfig && tripData.tripConfig.schedule && tripData.tripConfig.schedule.days;
        const _pcDiff = diffScheduleDays(_pcStoredDays, _pcFinalDays);
        let _pcVersion;
        if (_pcDiff.changed) _pcVersion = Math.max(Date.now(), _pcStoredVersion + 1);
        else _pcVersion = _pcStoredVersion > 0 ? _pcStoredVersion : Date.now();
        if (tripData && tripData.tripConfig) tripData.tripConfig.scheduleVersion = String(_pcVersion);
        // Notify only when a schedule someone could already be looking
        // at changed: a first schedule landing on a stored trip (or a
        // brand-new trip) stamps its version but sends nothing.
        const _pcStoredHadSchedule = Array.isArray(_pcStoredDays) && _pcStoredDays.some(d => d && Array.isArray(d.items) && d.items.length);
        if (_pcDiff.changed && _pcStoredHadSchedule) {
          _pcNotify = { version: _pcVersion, changedDays: _pcDiff.changedDays };
        }
      } catch (e) { /* best-effort: versioning must never block a save */ }
      // Save to shared trip blob
      await writeTripBlob(entry.tripId, tripData);
      const _blobBodyLen = JSON.stringify(tripData).length;
      console.log('[ptFinish] trip blob write status: 200, bytes written: ' + _blobBodyLen + ', tripId: ' + entry.tripId);

      // Plan-changed notify (step iv): after the write lands, record the
      // material change -- notePlanChange sends immediately or queues
      // behind the per-trip debounce window (api/plan-changed.js).
      // Failure-isolated: a notify failure never affects the save.
      if (_pcNotify) {
        try {
          const _pcRes = await notePlanChange({ tripId: entry.tripId, presentedCode: code, version: _pcNotify.version, changedDays: _pcNotify.changedDays, originToken: _pcOriginToken });
          console.log('[plan-changed] trip ' + entry.tripId + ' v' + _pcNotify.version + ' days ' + _pcNotify.changedDays.join(',') + ' -> ' + JSON.stringify(_pcRes));
        } catch (e) { console.warn('[plan-changed] notify failed (save unaffected)', e && e.message); }
      }

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
        // Initialize or merge registry entries. Code-pair issuance
        // (restoration step i): every leader entry merged here is paired
        // in the SAME write -- a trip is a pair of codes from birth, so a
        // guest can resolve read-only to the trip before onboarding even
        // starts. (Re-merging a leader entry re-syncs its guest entry.)
        const registry = await readRegistry();
        const entries = body.entries || {};
        Object.assign(registry, entries);
        const pairs = {};
        for (const c of Object.keys(entries)) {
          if (registry[c] && registry[c].role === 'admin') {
            const g = mintGuestPair(registry, c);
            if (g) pairs[c] = g;
          }
        }
        await writeRegistry(registry);
        return res.status(200).json({ ok: true, codes: Object.keys(registry), pairs });
      }

      if (body.action === 'seed_trip') {
        // Seed a trip's data blob directly. If a leader entry owns this
        // tripId, the blob is born carrying the pair's guest code (same
        // issuance stamp as the POST save path).
        const { tripId, tripData } = body;
        if (!tripId || tripData === undefined) return res.status(400).json({ error: 'Missing tripId or tripData' });
        try {
          const registry = await readRegistry();
          const leaderCode = Object.keys(registry).find(c => registry[c] && registry[c].tripId === tripId && registry[c].role === 'admin');
          if (leaderCode) {
            const g = await ensureGuestPair(registry, leaderCode);
            if (g && tripData && tripData.tripConfig && !tripData.tripConfig.guestCode) {
              tripData.tripConfig.guestCode = g;
            }
          }
        } catch (e) { /* best-effort: seeding must not fail on pairing */ }
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
