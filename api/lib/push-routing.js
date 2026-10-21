// api/lib/push-routing.js
// Per-role push routing policy (Claude routing ruling, Oct 16, 2026, as
// amended the same day). ONE home for the category -> audience/variant
// table, the fail-closed send decision, and the role map built from a
// single trip-registry read. Senders (cron-push-monitor.js,
// cron-booking-alerts.js, plan-changed.js, and step (v)'s live sender
// later) consult this module instead of open-coding role conditionals,
// so a new category is a one-row table change and a forgotten row fails
// the exhaustiveness test -- not a guest's lock screen.
//
// Vocabulary:
//   role     'leader' | 'guest'. The registry stores the leader role as
//            'admin'; normalizeRole maps it at this boundary. Role is
//            read from each code's OWN registry entry -- never derived
//            from a code's suffix and never resolved through a pair
//            back-pointer (a dangling back-pointer can't break routing).
//   variant  'actionable' -- the copy asks for a decision or an action
//            (soft prompts included); leaders only.
//            'fact' -- awareness only: the factual core of the alert
//            with the action prompt stripped.
//            null -- this role receives nothing for this category.
// Classification is by what the push ASKS, not what triggered it
// (ruling section 2). Actionable is the safe default: an unknown
// category fails closed to leader-only.
//
// Fail-closed semantics (ruling section 3):
//   - Role map unavailable (registry read failed): NO actionable
//     variant is selected for anyone, on either channel; awareness
//     (fact) variants still flow.
//   - Orphan code (a recipient file exists but the code has no registry
//     entry, or its entry carries no role): actionable suppressed,
//     awareness still sends; callers log the code (detect-divergence).

import { readBlobJson } from './blob.js';

// Registry path-prefix hardening -- identical discipline to
// cron-push-monitor / cron-booking-alerts / plan-changed: when
// BLOB_PATH_SALT is set, the registry lives behind an unguessable path
// segment; reads are salted-first with a bare-key fallback. Never log
// the salted key.
const SALT = (process.env.BLOB_PATH_SALT || '').trim();
const registryKeys = () => SALT
  ? ['twize/' + SALT + '/trip_registry.json', 'twize/trip_registry.json']
  : ['twize/trip_registry.json'];

// ---------------------------------------------------------------------------
// Category table. audience: who may receive the category at all.
// variants: the copy variant each role receives (null = nothing).
// A row with audience 'all' MUST carry a guest variant -- the
// exhaustiveness test treats that combination as a configuration error.
// ---------------------------------------------------------------------------
export const AUDIENCE = {
  // Monitor categories (cron-push-monitor): the copy is SPLIT (Beau's
  // decision, Oct 16, 2026). Leaders keep the full actionable copy;
  // guests receive the fact-only variant of the same event.
  'wait-spike':       { audience: 'all',    variants: { leader: 'actionable', guest: 'fact' } },
  'wait-drop':        { audience: 'all',    variants: { leader: 'actionable', guest: 'fact' } },
  'high-wait':        { audience: 'all',    variants: { leader: 'actionable', guest: 'fact' } },
  'ride-down':        { audience: 'all',    variants: { leader: 'actionable', guest: 'fact' } },
  'ride-back-up':     { audience: 'all',    variants: { leader: 'actionable', guest: 'fact' } },
  // Booking alerts (cron-booking-alerts): LEADER ONLY (Claude's ruling,
  // adopted by Beau, Oct 16, 2026). A deadline a guest cannot act on is
  // a powerless countdown; coordination lives in-app. 'booking-window'
  // is the opens-today alert; 'booking-morning-of' is the catch-up
  // ('already open') alert fired on a later morning.
  'booking-window':     { audience: 'leader', variants: { leader: 'actionable', guest: null } },
  // LL game plan (cron-push-monitor, Item 5, Claude msg 574): the
  // morning booking-order push. LEADER ONLY -- a booking order is an
  // instruction to one person; guests see the game plan in-app.
  'll-order':           { audience: 'leader', variants: { leader: 'actionable', guest: null } },
  'booking-morning-of': { audience: 'leader', variants: { leader: 'actionable', guest: null } },
  // Plan-changed (plan-changed.js): awareness for every role -- its
  // whole purpose is keeping guests in sync. The originating actor is
  // excluded by the caller's excludeToken mechanism, not by role.
  'plan-changed':     { audience: 'all',    variants: { leader: 'fact', guest: 'fact' } }
};
export const CATEGORIES = Object.keys(AUDIENCE);

// Registry role -> routing role. 'admin' is the registry's name for the
// trip leader. Anything unrecognized normalizes to null (unresolved),
// which the policy treats as awareness-only.
export function normalizeRole(raw) {
  if (raw === 'admin' || raw === 'leader') return 'leader';
  if (raw === 'guest') return 'guest';
  return null;
}

// The copy variant a code with this role receives for this category,
// or null when it receives nothing. mapOk === false (the role map could
// not be built) suppresses every actionable variant: a split category
// falls back to its fact variant for BOTH roles, a leader-only
// actionable category sends to nobody, awareness still flows. An
// unresolved role (null) is treated as a guest for variant selection:
// awareness if the category has a fact variant, nothing if it does not.
export function variantFor(category, role, mapOk) {
  const row = AUDIENCE[category];
  if (!row) {
    // Unknown / new category: fail closed, leader only, and only when
    // the role map is good.
    return (mapOk !== false && normalizeRole(role) === 'leader') ? 'actionable' : null;
  }
  const r = normalizeRole(role);
  let v = (r === 'leader') ? row.variants.leader : row.variants.guest;
  if (mapOk === false && v === 'actionable') v = row.variants.guest;
  return v == null ? null : v;
}

// The send decision: true when this code should receive this category
// (in the variant variantFor selects). Fail-closed by construction.
export function shouldSend(category, role, mapOk) {
  return variantFor(category, role, mapOk) !== null;
}

// Pure: build the role map from a registry object (code -> entry).
// Returns { byCode, byTrip, ok }. ok is false ONLY when the registry
// itself could not be read (null / not an object) -- a successfully
// read empty registry is a good map with no codes in it. byCode[code]
// carries the code's OWN normalized role (null when its entry has no
// recognizable role), its tripId, and its lifecycle status. byTrip
// groups every code that names the trip, sorted for determinism.
export function buildRoleMap(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    return { byCode: {}, byTrip: {}, ok: false };
  }
  const byCode = {};
  const byTrip = {};
  for (const code of Object.keys(registry)) {
    const e = registry[code];
    if (!e || typeof e !== 'object') continue;
    const tripId = (typeof e.tripId === 'string') ? e.tripId : '';
    byCode[code] = {
      role: normalizeRole(e.role),
      tripId: tripId,
      status: (typeof e.status === 'string') ? e.status : ''
    };
    if (tripId) {
      if (!byTrip[tripId]) byTrip[tripId] = [];
      byTrip[tripId].push(code);
    }
  }
  for (const t of Object.keys(byTrip)) byTrip[t].sort();
  return { byCode: byCode, byTrip: byTrip, ok: true };
}

// The registry read behind loadRoleMap: salted-first, bare fallback,
// via the shared suffix-tolerant reader (same discipline as
// plan-changed's readRegistry). Returns null when nothing could be
// read -- the caller-visible difference between "no registry" and
// "empty registry" is exactly the fail-closed signal.
async function readRegistryBlob() {
  for (const key of registryKeys()) {
    try {
      const data = await readBlobJson(key, 'push-routing');
      if (data && typeof data === 'object') return data;
    } catch (e) { /* fall through to the next key / null */ }
  }
  return null;
}

// Load the role map with ONE registry read. Callers invoke this once
// per run (never per send) and thread the result through their send
// decisions -- the crons that already read the registry for trip
// grouping build the map from that same read via buildRoleMap instead
// of reading twice. Never throws: a failed read is { ok: false }.
export async function loadRoleMap() {
  let registry = null;
  try {
    registry = await readRegistryBlob();
  } catch (e) {
    console.error('[push-routing] registry read failed', e && e.message);
    registry = null;
  }
  const map = buildRoleMap(registry);
  if (!map.ok) console.error('[push-routing] ROLE MAP UNAVAILABLE (registry read failed) -- actionable pushes suppressed');
  return map;
}
