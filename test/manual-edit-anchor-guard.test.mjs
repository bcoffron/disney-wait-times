// Tests for the manual-edit anchor guard (anchor fix lane part 3,
// Nov 4, 2026; Claude msg 205: "anchors should change only through
// their record"). The audit (anchor-audit/matrix.md) found the manual
// edit cells ABSENT for every anchor class: in admin edit mode an
// anchor card was an ordinary entry -- deleteEntry spliced it,
// startInlineEdit retimed or renamed it, onDrop reordered it -- while
// its booking record sat untouched in tripConfig, leaving record and
// day in disagreement (and, since part 2, a save the seam refuses).
//
// Part 3 guards the three edit sites in app.html. The predicate keys
// on the flags the writers actually stamp, never on the entry name:
//   generation (api/scaffold.js applyFills): reservations carry
//     anchor:true + reservation:true; held returns carry anchor:true
//     + heldReturn:true (isConfirmed:true is the trio member the
//     client's own heldReturnConflict already tests);
//   the client's record path: a booked return's timeline face carries
//     _preBook (converted plan item) or _recordedInsert (inserted
//     item), set only when a held-return record is written and
//     cleared only when the record is removed;
//   VIP tour cards: since part 7 (Claude anchor-lane ruling, flag 6)
//     generation stamps them anchor:true + vip:true like every other
//     anchor class, and the predicate keys on the stamp; the type key
//     remains as the fallback for tour cards saved before the stamp
//     existed (this suite's fixture card is exactly that legacy shape:
//     {type:'vip'} bare).
// The record controls themselves (llRemoveHeld for held returns,
// removeDiningRes for reservations) are NOT guarded and must keep
// working end to end: removing a booking goes through its record.
//
// The part-3 build log's known gap -- entries returned by
// /api/reoptimize losing every stamp (normalizeEntry rebuilt each
// entry from {t,h,type,n,land}) -- was closed in part 4 by the
// normalizeEntry passthrough, and part 7 added the vip stamp to both
// generation and that passthrough; a reoptimized day's booking cards
// now stay visible to this guard. The save seam (part 2) also refuses
// any save that drops or moves them -- it keys on the records.
//
// The suite extracts the REAL code from app.html (held-return record
// layer, the record Remove handlers, the dining-reservation record
// layer, and the whole edit-mode region) and drives it in a vm with
// browser stubs, so the code under test is the code that ships --
// the single-pass-manual / startup-day-state pattern. On pre-part-3
// main the anchor cases fail behaviorally (the splice / retime /
// reorder simply happens); the normal-entry and record-path cases
// pass on both trees by design -- they pin the no-over-refusal
// posture and the unblocked record controls.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/manual-edit-anchor-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appHtml = readFileSync(new URL('../app.html', import.meta.url), 'utf8');

function sliceRange(startMarker, endMarker) {
  const s = appHtml.indexOf(startMarker);
  assert.ok(s !== -1, 'range start not found: ' + startMarker);
  const e = appHtml.indexOf(endMarker, s + startMarker.length);
  assert.ok(e > s, 'range end not found: ' + endMarker);
  return appHtml.slice(s, e);
}
const SRC = [
  sliceRange('function llNormKey', '// Anchor-collision check for a candidate held return'),
  sliceRange('function llEditHeld', '// ===== SINGLE PASS ROWS'),
  sliceRange('function loadDiningReservations', '//    Crowd Prediction'),
  sliceRange('function saveCustom(d){', 'function openModal'),
].join('\n');

function memStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

// One Disneyland day in the editing model, one section, carrying every
// anchor shape the writers produce, plus two ordinary entries:
//   0 Indy          -- normal ride
//   1 VIP Tour      -- VIP anchor (type only; no flag exists)
//   2 Blue Bayou    -- reservation anchor (anchor:true, reservation:true)
//   3 Space Mountain-- held return, server-stamped (anchor:true, heldReturn:true)
//   4 small world   -- held return, client-stamped insert (_recordedInsert)
//   5 Haunted Mansion -- normal ride
function dayEntries() {
  return [
    { t: '8:05 AM', h: 'Indiana Jones Adventure', type: 'ride', n: '' },
    { t: '10:00 AM', h: 'VIP Tour', type: 'vip', n: 'Your private guide handles all skip-the-line access from 10:00 AM to 2:00 PM.' },
    { t: '11:30 AM', h: 'Blue Bayou', type: 'dining', anchor: true, reservation: true, n: 'Your confirmed reservation -- the rest of the day is built around it.' },
    { t: '2:00 PM', h: 'Space Mountain', type: 'ride', anchor: true, heldReturn: true, returnStart: '2:00 PM', returnEnd: '3:00 PM', ll: { t: 'multi', a: 'Lightning Lane Multi Pass' } },
    { t: '4:30 PM', h: "it's a small world", type: 'ride', _recordedInsert: true, ll: { t: 'multi', a: 'Lightning Lane Multi Pass' } },
    { t: '6:00 PM', h: 'Haunted Mansion', type: 'ride', n: '' },
  ];
}

function makeWorld(opts = {}) {
  const world = { alerts: [], posts: [], pushes: 0, renders: 0, inputs: [] };
  const tc = {
    location: 'Disneyland',
    heldReturns: opts.heldReturns || [],
    days: [{ date: 'Oct 23, 2026', park: 'Disneyland', startPark: 'Disneyland' }],
  };
  world.tc = tc;
  const entries = dayEntries();
  const localStorage = memStorage(Object.assign({ tpcp_code: 'TEST01' }, opts.storage || {}));
  world.localStorage = localStorage;
  const documentStub = {
    getElementById: () => null,
    createElement: () => {
      const inp = {
        className: '', value: '', _listeners: {},
        focus() {}, select() {},
        addEventListener: (t, f) => { (inp._listeners[t] = inp._listeners[t] || []).push(f); },
        replaceWith: () => {},
      };
      world.inputs.push(inp);
      return inp;
    },
    addEventListener: () => {},
    querySelectorAll: () => [],
  };
  const windowObj = {
    _loadedTripData: { tripConfig: tc },
    _schedData: { days: [{ park: 'Disneyland', items: entries }] },
  };
  const ctx = {
    console,
    Date,
    Intl,
    window: windowObj,
    document: documentStub,
    localStorage,
    TRIP_CONFIG: tc,
    curDay: 0,
    editMode: true,
    customSched: [{ sections: [{ title: 'Disneyland', entries }] }],
    DAYS: [],
    dragSrc: null,
    alert: (m) => { world.alerts.push(String(m)); },
    isAdmin: () => true,
    renderSched: () => { world.renders++; },
    pushSchedule: () => { world.pushes++; },
    ensureAdminKey: () => '',
    tpcpDeviceToken: () => 'tok',
    SYNC_BASE: '',
    fetch: async (url, fetchOpts) => {
      world.posts.push({ url: String(url), body: JSON.parse(fetchOpts.body) });
      return { ok: true };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  world.ctx = ctx;
  world.entries = () => ctx.customSched[0].sections[0].entries;
  world.headings = () => world.entries().map((e) => e.h);
  return world;
}
const flush = async () => { await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); };
function dropEvent() {
  return { preventDefault() {}, currentTarget: { classList: { remove() {}, add() {} } } };
}
function spanStub() {
  const el = { _replaced: false, replaceWith() { el._replaced = true; } };
  return el;
}
const HELD_REC = { day: 0, rideKey: 'space mountain', ride: 'Space Mountain', returnStart: '2:00 PM', returnEnd: '3:00 PM', bookedAt: 1 };

// ------------------------------------------------------------ delete
test('(a) delete on a reservation anchor card is refused; the item survives and nothing is saved', () => {
  const w = makeWorld();
  w.ctx.deleteEntry(0, 0, 2);
  assert.equal(w.entries().length, 6, 'the reservation card survives');
  assert.equal(w.entries()[2].h, 'Blue Bayou');
  assert.equal(w.pushes, 0, 'no save attempted');
  assert.equal(w.alerts.length, 1, 'the refusal is surfaced, not silent');
  assert.ok(w.alerts[0].includes('Blue Bayou') && w.alerts[0].includes('confirmed'), 'message names the booking: ' + w.alerts[0]);
});

test('(b) delete on a server-stamped held-return card is refused and points at the return controls', () => {
  const w = makeWorld();
  w.ctx.deleteEntry(0, 0, 3);
  assert.equal(w.entries().length, 6);
  assert.equal(w.entries()[3].h, 'Space Mountain');
  assert.equal(w.pushes, 0);
  assert.equal(w.alerts.length, 1);
  assert.ok(w.alerts[0].includes('Space Mountain') && w.alerts[0].includes('Lightning Lane return') && w.alerts[0].includes('Remove'), 'message: ' + w.alerts[0]);
});

test('(c) delete on a client-stamped held-return card (recorded insert) is refused', () => {
  const w = makeWorld();
  w.ctx.deleteEntry(0, 0, 4);
  assert.equal(w.entries().length, 6, 'the inserted return card survives');
  assert.equal(w.pushes, 0);
  assert.equal(w.alerts.length, 1);
  assert.ok(w.alerts[0].includes("it's a small world"), 'message names the ride: ' + w.alerts[0]);
});

test('(d) delete on a legacy (pre-stamp) VIP tour card is refused via the type fallback', () => {
  const w = makeWorld();
  w.ctx.deleteEntry(0, 0, 1);
  assert.equal(w.entries().length, 6);
  assert.equal(w.entries()[1].h, 'VIP Tour');
  assert.equal(w.pushes, 0);
  assert.equal(w.alerts.length, 1);
  assert.ok(w.alerts[0].includes('VIP Tour') && w.alerts[0].includes('trip setup'), 'message: ' + w.alerts[0]);
});

test('(e) delete on a normal card still works', () => {
  const w = makeWorld();
  w.ctx.deleteEntry(0, 0, 5);
  assert.equal(w.entries().length, 5);
  assert.ok(!w.headings().includes('Haunted Mansion'), 'the normal card is gone');
  assert.equal(w.pushes, 1, 'the edit saved');
  assert.equal(w.alerts.length, 0, 'no refusal for an ordinary entry');
});

// ------------------------------------------------------------ inline edit
test('(f) inline time edit on a held-return card is refused before any input opens', () => {
  const w = makeWorld();
  const span = spanStub();
  w.ctx.startInlineEdit(span, 0, 0, 3, 't');
  assert.equal(w.inputs.length, 0, 'no editor input was created');
  assert.equal(span._replaced, false, 'the card was not swapped for an input');
  assert.equal(w.entries()[3].t, '2:00 PM', 'the return time is unchanged');
  assert.equal(w.pushes, 0);
  assert.equal(w.alerts.length, 1);
});

test('(g) inline rename on a reservation anchor card is refused', () => {
  const w = makeWorld();
  const span = spanStub();
  w.ctx.startInlineEdit(span, 0, 0, 2, 'h');
  assert.equal(w.inputs.length, 0, 'no editor input was created');
  assert.equal(w.entries()[2].h, 'Blue Bayou', 'the reservation name is unchanged');
  assert.equal(w.pushes, 0);
  assert.equal(w.alerts.length, 1);
});

test('(h) inline time edit on a normal card still works end to end', () => {
  const w = makeWorld();
  const span = spanStub();
  w.ctx.startInlineEdit(span, 0, 0, 0, 't');
  assert.equal(w.inputs.length, 1, 'the editor opened');
  const inp = w.inputs[0];
  assert.equal(inp.value, '8:05 AM', 'the editor starts from the current time');
  assert.equal(span._replaced, true);
  inp.value = '8:20 AM';
  (inp._listeners.blur || []).forEach((f) => f());
  assert.equal(w.entries()[0].t, '8:20 AM', 'the retime landed');
  assert.equal(w.pushes, 1, 'the edit saved');
  assert.equal(w.alerts.length, 0);
});

// ------------------------------------------------------------ drag & drop
test('(i) dropping a normal card onto an anchor position is refused; order and save untouched', () => {
  const w = makeWorld();
  w.ctx.dragSrc = '0_0_0'; // Indiana Jones
  w.ctx.onDrop(dropEvent(), 0, 0, 3); // onto the Space Mountain anchor
  assert.deepEqual(w.headings(), dayEntries().map((e) => e.h), 'the order is unchanged');
  assert.equal(w.pushes, 0, 'no save attempted');
  assert.equal(w.alerts.length, 1, 'the refusal is surfaced');
  assert.equal(w.ctx.dragSrc, null, 'the drag state is cleared');
});

test('(j) dragging an anchor card away is refused', () => {
  const w = makeWorld();
  w.ctx.dragSrc = '0_0_3'; // the held return itself
  w.ctx.onDrop(dropEvent(), 0, 0, 0);
  assert.deepEqual(w.headings(), dayEntries().map((e) => e.h), 'the order is unchanged');
  assert.equal(w.entries()[3].h, 'Space Mountain', 'the anchor stayed at its position');
  assert.equal(w.pushes, 0);
  assert.equal(w.alerts.length, 1);
});

test('(k) dragging the VIP card is refused', () => {
  const w = makeWorld();
  w.ctx.dragSrc = '0_0_1'; // VIP Tour
  w.ctx.onDrop(dropEvent(), 0, 0, 5);
  assert.deepEqual(w.headings(), dayEntries().map((e) => e.h), 'the order is unchanged');
  assert.equal(w.pushes, 0);
  assert.equal(w.alerts.length, 1);
});

test('(l) dragging a normal card onto a normal position still works', () => {
  const w = makeWorld();
  w.ctx.dragSrc = '0_0_5'; // Haunted Mansion
  w.ctx.onDrop(dropEvent(), 0, 0, 0);
  assert.equal(w.entries().length, 6, 'nothing lost in the move');
  assert.equal(w.entries()[0].h, 'Haunted Mansion', 'the card moved to the drop position');
  assert.equal(w.pushes, 1, 'the reorder saved');
  assert.equal(w.alerts.length, 0);
});

// ------------------------------------------------------------ record paths stay open
test('(m) the held-return RECORD controls are not blocked: Remove clears the record and persists it', async () => {
  const w = makeWorld({ heldReturns: [Object.assign({}, HELD_REC)] });
  // The card-level delete is refused in this same world...
  w.ctx.deleteEntry(0, 0, 3);
  assert.equal(w.alerts.length, 1, 'card delete refused');
  assert.equal(w.ctx.getHeldReturnsForDay(0).length, 1, 'record untouched by the refused delete');
  // ...while the record's own Remove handler runs end to end.
  await w.ctx.llRemoveHeld('space_mountain', 'Space Mountain');
  await flush();
  assert.equal(w.ctx.getHeldReturnsForDay(0).length, 0, 'the record is removed');
  const post = w.posts.find((p) => p.url.endsWith('/api/trip'));
  assert.ok(post, 'the removal persisted through the trip save');
  assert.equal(post.body.tripData.tripConfig.heldReturns.length, 0, 'the saved config carries no held return');
});

test('(n) the reservation RECORD control is not blocked: removeDiningRes removes the record', () => {
  const w = makeWorld({
    storage: { dining_reservations: JSON.stringify([{ name: 'Blue Bayou', time: '6:30 PM' }, { name: 'Cafe Orleans', time: '12:00 PM' }]) },
  });
  w.ctx.removeDiningRes(0);
  const left = JSON.parse(w.localStorage.getItem('dining_reservations'));
  assert.equal(left.length, 1, 'one record removed');
  assert.equal(left[0].name, 'Cafe Orleans', 'the other record is untouched');
});

// ------------------------------------------------------------ static pins
test('(o) static pins: all three edit sites consult the guard; the record handlers never do; the predicate keys on the documented flags', () => {
  assert.equal(typeof makeWorld().ctx.tpcpIsAnchorEntry, 'function', 'the guard predicate exists');
  assert.ok(sliceRange('function startInlineEdit', 'function toggleEdit').includes('tpcpIsAnchorEntry('), 'inline edit is guarded');
  assert.ok(sliceRange('function deleteEntry', 'function onDragStart').includes('tpcpIsAnchorEntry('), 'delete is guarded');
  assert.ok(sliceRange('function onDrop', 'function openModal').includes('tpcpIsAnchorEntry('), 'drop is guarded');
  const rec = sliceRange('function llEditHeld', '// ===== SINGLE PASS ROWS');
  assert.ok(!rec.includes('tpcpIsAnchorEntry') && !rec.includes('tpcpAnchorBlockMsg'), 'held-return record controls carry no guard');
  const dres = sliceRange('function removeDiningRes', '//    Crowd Prediction');
  assert.ok(!dres.includes('tpcpIsAnchorEntry') && !dres.includes('tpcpAnchorBlockMsg'), 'reservation record control carries no guard');
  assert.ok(SRC.includes("entry.type==='vip'"), 'the VIP type fallback is retained for pre-stamp tour cards');
  assert.ok(SRC.includes('entry.vip===true'), 'the part-7 VIP stamp is keyed');
  assert.ok(SRC.includes('entry._recordedInsert') && SRC.includes('entry._preBook'), 'the client-stamped held-return flags are keyed');
  assert.ok(SRC.includes('entry.heldReturn===true') && SRC.includes('entry.reservation===true'), 'the server-stamped flags are keyed');
});

// ------------------------------------------------------------ part 7: the VIP stamp
test('(p) part 7 (flag 6): the predicate fires on the VIP stamp itself; the legacy type fallback still fires', () => {
  const w = makeWorld();
  assert.equal(typeof w.ctx.tpcpIsAnchorEntry, 'function');
  // The real post-part-7 shape generation emits.
  assert.equal(w.ctx.tpcpIsAnchorEntry({ t: '10:00 AM', h: 'VIP Tour', type: 'vip', anchor: true, vip: true }), true, 'the fully stamped tour card is an anchor (pin: fires via anchor on both trees)');
  // The stamp ALONE trips the guard, whatever the type says: the stamp
  // is the rule now, the type is only the legacy fallback. (On
  // pre-part-7 main this entry is invisible to the predicate.)
  const stampOnly = { t: '10:00 AM', h: 'VIP Tour', type: 'ride', vip: true };
  assert.equal(w.ctx.tpcpIsAnchorEntry(stampOnly), true, 'the vip stamp alone marks the entry as an anchor');
  assert.ok(w.ctx.tpcpAnchorBlockMsg(stampOnly).includes('trip setup'), 'the stamp earns the VIP wording, not the generic booking wording');
  // A tour card saved before the stamp existed still fires via type.
  assert.equal(w.ctx.tpcpIsAnchorEntry({ t: '10:00 AM', h: 'VIP Tour', type: 'vip' }), true, 'a legacy pre-stamp card still fires via the type fallback (pin: passes on both trees)');
});
