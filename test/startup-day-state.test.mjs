// Startup / day-state suite (item 20, Oct 23, 2026).
//
// Beau's build-50 screen recording showed three defects, diagnosed in
// item19/findings.md and ruled on by Claude:
//  A. Cold start painted the baked-in default trip ("Disneyland Trip",
//     3 empty days, "No schedule yet") for up to a minute: leaders got
//     no cache-first paint, "not loaded" rendered as "empty", and a
//     transient validation failure reloaded the whole app.
//  B. The app opened on Day 1 mid-trip: the initial-day pick ran once
//     at parse time against the dateless default config (device-local
//     date math) and nothing re-ran it when the real config landed.
//  C. Day view flickered Day 2 -> Day 1 -> Day 2: every curDay writer
//     is now logged in a persisted ring buffer, the fit-clamp routes
//     through setDay, and tab taps are guarded against moved touches.
//
// Item 26 (Oct 23, 2026) supersedes parts of the above, per Claude's
// round-2 ruling on the flashing (item24/findings.md):
//  - The first paint takes a computable day pick as a PRECONDITION
//    ("no day paint until a pick is possible"): cache payloads carry
//    the config dates (cfgDays), a cache that cannot pick does not
//    paint at all, the DOMContentLoaded init setDay no longer paints,
//    and every load path applies the pick as state before its first
//    render. The repick remains for genuine later config changes, and
//    its one-time gate is consumed only by a decision against a real
//    dated config (a no-op call no longer burns it).
//  - The ring buffer is boot-stamped: each page instance mints a boot
//    id, stamps every entry, and writes one 'boot' entry; the Info
//    readout shows the WHOLE buffer (not last-8) with boot ids, which
//    settles whether the impossible 1->2, 1->2 pair straddled a page
//    recreation. Tests (a) and (e) changed for exactly these reasons;
//    tests (f)-(i) pin the newly ruled behavior.
//
// Item 31 (Oct 24, 2026) finishes item 26 per Claude's ruling on the
// build-52 readout:
//  - The pick is now ONE implementation: tpcpPickFromDays takes today
//    from the single park-time authority (tpcpParkTodayIso over the
//    PR #118 map) and getInitialActiveDay delegates to it. The
//    post-paint re-pick is GONE (function, gate flag, all five load-
//    path call sites): build 52 still logged a 'repick' on every
//    ended-trip cold open because two pick authorities could disagree
//    and a corrector existed to paper over the difference. Tests (a),
//    (b), (e), (h) updated for exactly this; test (b) now drives the
//    cold-open load sequence for an ENDED trip (sync -> pick -> paint
//    order): the first pick IS the clamped last day and nothing is
//    logged.
//  - Cheap switches (fork B): setDay early-returns on the active day
//    (at most a scroll-to-now), and a single scroll owner
//    (tpcpDaySwitchScroll) issues a switch's one scroll directive --
//    switchNav and setTab stand down for marked switches. Test (j)
//    pins both halves, including a rapid-burst supersede.
//  - The harness now also extracts the real setTab, switchNav and
//    tpcpSyncTripConfig, and can record timers / queue rAF / count
//    scroll directives (opt-in per world).
//
// The suite extracts the REAL code from app.html (the startup/daystate
// block, the day helpers, setDay/ensureDayTabs, the fit function) and
// drives it in a vm with browser stubs -- the code under test is the
// code that ships.
//
// Run: node --test test/startup-day-state.test.mjs
import { test } from 'node:test';
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
  sliceRange('function tpcpParseDayDate', 'function tpcpTripRangeLabel'),
  sliceRange('function tpcpParkTzForDay', 'function tpcpSinglePassRidesForDay'),
  sliceRange('var _tripLoaded = false;', '/* TPCP-STARTUP-DAYSTATE-END */'),
  sliceRange('function _isDateToday', 'function _schedStickyTop'),
  sliceRange('function getInitialActiveDay()', '/* --- Splash screen --- */'),
  sliceRange('function tpcpTripDayCount', 'function loadCustom'),
  sliceRange('function ensureDayTabs', 'function setTab('),
  sliceRange('function setTab(t){', 'function sendSuggested'),
  sliceRange('function tpcpSyncTripConfig', 'function checkLock(){'),
  sliceRange('function switchNav(tabKey)', '/* --- Alt sheet --- */'),
].join('\n');

assert.ok(SRC.includes('function tpcpPaintCachedTrip'), 'cache paint missing');
assert.ok(!SRC.includes('tpcpMaybeRepickDay'), 'the post-paint repick must stay gone (item 31)');
assert.ok(SRC.includes('function tpcpDaySwitchScroll'), 'single scroll owner missing');
assert.ok(SRC.includes('function switchNav'), 'switchNav missing');
assert.ok(SRC.includes('function tpcpSyncTripConfig'), 'config sync missing');
assert.ok(SRC.includes('function tpcpDayTabTap'), 'tab tap guard missing');
assert.ok(SRC.includes('function setDay'), 'setDay missing');
assert.ok(SRC.includes('function tpcpFitCustomSched'), 'fit missing');

const RealDate = Date;
function fixedDateClass(ms) {
  return class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [ms])); }
    static now() { return ms; }
    static parse(s) { return RealDate.parse(s); }
    static UTC(...a) { return RealDate.UTC(...a); }
  };
}

function memStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

function makeEl() {
  const el = {
    style: {}, innerHTML: '', textContent: '', className: '', id: '',
    _classes: {}, _listeners: {},
    classList: {
      toggle: (c, on) => { el._classes[c] = !!on; },
      add: (c) => { el._classes[c] = true; },
      remove: (c) => { el._classes[c] = false; },
      contains: (c) => !!el._classes[c],
    },
    setAttribute: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    appendChild: () => {},
    parentNode: null,
  };
  return el;
}

const TEST02_DAYS = [
  { num: 1, label: 'Day 1', date: 'Oct 22, 2026', park: 'Disneyland', isVip: false },
  { num: 2, label: 'Day 2', date: 'Oct 23, 2026', park: 'Disneyland', isVip: false },
];

function makeWorld(opts = {}) {
  const world = { loadCustomCalls: 0, renderSchedCalls: 0, scrollCalls: 0, scrollArgs: [], nowScrollCalls: 0, docScrollTopSets: 0, timers: [], rafQueue: [] };
  world.flushTimers = () => { const q = world.timers.splice(0); q.forEach((t) => t.fn()); };
  world.flushRaf = () => { while (world.rafQueue.length) { const fn = world.rafQueue.shift(); fn(); } };
  world.scrollDirectives = () => world.scrollCalls + world.nowScrollCalls + world.docScrollTopSets;
  const FixedDate = fixedDateClass(opts.nowMs ?? RealDate.UTC(2026, 9, 23, 17, 0, 0)); // Oct 23, 10:00 AM PDT
  const tc = {
    tripName: opts.tripName ?? '',
    location: 'Disneyland',
    days: opts.days ?? JSON.parse(JSON.stringify(TEST02_DAYS)),
    guestCode: '',
  };
  world.tc = tc;
  const tabs = [makeEl(), makeEl(), makeEl()];
  world.tabs = tabs;
  const container = makeEl();
  container.querySelectorAll = () => tabs;
  world.container = container;
  const titleEl = makeEl(); titleEl.textContent = 'Disneyland Trip';
  world.titleEl = titleEl;
  const banner = makeEl(); banner.style.display = 'none';
  world.banner = banner;
  const editToggle = makeEl();
  const byId = {
    dayTabsContainer: container,
    cachedSchedBanner: banner,
    editToggle,
    reoptBox: null,
    reoptLoading: null,
  };
  const docElStub = {};
  Object.defineProperty(docElStub, 'scrollTop', { get: () => 0, set: () => { world.docScrollTopSets++; } });
  const documentStub = {
    documentElement: docElStub,
    getElementById: (id) => (id in byId ? byId[id] : null),
    querySelectorAll: (sel) => (sel === '.day-tab' ? tabs : []),
    querySelector: (sel) => (sel === '.header-title' ? titleEl : null),
    createElement: () => makeEl(),
    addEventListener: () => {},
    hidden: false,
  };
  const localStorage = memStorage(opts.storage);
  world.localStorage = localStorage;
  const windowObj = {
    TRIP_CONFIG: tc,
    _schedData: opts.schedData ?? { days: [{ park: 'Disneyland' }, { park: 'Disneyland' }] },
    _appInitialized: opts.appInitialized ?? true,
    scrollTo: (...a) => { world.scrollCalls++; world.scrollArgs.push(a); },
  };
  world.window = windowObj;
  const ctx = {
    console, Intl, Date: FixedDate,
    window: windowObj,
    document: documentStub,
    localStorage,
    sessionStorage: memStorage(),
    TRIP_CONFIG: tc,
    curDay: opts.curDay ?? 0,
    customSched: opts.customSched ?? [null, null],
    DAYS: [],
    editMode: false,
    usingCachedSchedule: false,
    SYNC_BASE: 'https://example.test',
    requestAnimationFrame: (fn) => { if (opts.queueRaf) { world.rafQueue.push(fn); return world.rafQueue.length; } fn(); return 0; },
    setTimeout: (fn, ms) => { if (opts.recordTimers) { world.timers.push({ fn, ms }); return world.timers.length; } return 0; },
    clearTimeout: () => {},
    renderClosed: () => {},
    renderSched: () => { world.renderSchedCalls++; },
    renderDayInfoBar: () => {},
    renderVipBanner: () => {},
    renderWaitTab: null,
    renderShows: null,
    renderInfoTab: null,
    renderClosuresFromWaits: null,
    scrollScheduleToNow: () => { world.nowScrollCalls++; },
    loadCustom: () => { world.loadCustomCalls++; },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  world.ctx = ctx;
  return world;
}

function fire(el, type, ev) {
  (el._listeners[type] || []).forEach((fn) => fn(ev));
}

// ------------------------------------------------------------ (a) cold start
test('(a) same-code cache paints provisionally for a leader, then reconciles on load', () => {
  const cache = JSON.stringify({
    code: 'TEST02', tripName: 'BB test trip',
    cfgDays: [{ date: 'Oct 22, 2026', park: 'Disneyland' }, { date: 'Oct 23, 2026', park: 'Disneyland' }],
    customSched: [{ sections: [{ title: 'Disneyland', entries: [{ t: '8:05 AM', h: 'Space Mountain' }] }] }, null],
    savedAt: 1,
  });
  const w = makeWorld({ storage: { tpcp_code: 'TEST02', tpcp_role: 'admin', tpcp_lastSched_TEST02: cache } });
  assert.equal(w.ctx._tripLoaded, false);
  const painted = w.ctx.tpcpPaintCachedTrip('TEST02');
  assert.equal(painted, true, 'same-code cache must paint');
  assert.equal(w.loadCustomCalls, 1, 'paint renders through loadCustom');
  assert.equal(w.ctx._tripProvisional, true, 'paint is provisional until the server copy applies');
  assert.equal(w.titleEl.textContent, 'BB test trip', 'cached trip name replaces the shell title');
  assert.equal(w.banner.style.display, '', 'provisional banner ("Last saved plan — updating…") shows');
  assert.equal(w.ctx.tpcpSchedPlaceholderHTML(), null, 'no loading placeholder over a provisional paint');
  // Item 26: the paint landed ON the picked day (Oct 23 = Day 2) --
  // state set before the first render, never a Day-1 paint to flip
  // from, and no day-change entries beyond this instance's boot.
  assert.equal(w.ctx.curDay, 1, 'cache paint is the picked day, not Day 1');
  assert.equal(w.tabs[1]._classes.active, true, 'picked day tab lit at first paint');
  assert.equal(w.tabs[0]._classes.active, false, 'Day 1 tab not lit');
  assert.equal(w.ctx._tpcpDayLog.filter((e) => e.caller !== 'boot').length, 0, 'no init/repick flip entries for the cold open');
  // Reconcile: the server copy applies.
  w.ctx.tpcpMarkTripLoaded();
  assert.equal(w.ctx._tripLoaded, true);
  assert.equal(w.ctx._tripProvisional, false);
  assert.equal(w.banner.style.display, 'none', 'banner clears when the server copy applies');
  // Item 31: there is no post-load corrector left to reconcile
  // anything -- the mechanism itself is removed, so no cold open can
  // ever produce a correction entry after the paint.
  assert.equal(typeof w.ctx.tpcpMaybeRepickDay, 'undefined', 'the post-paint repick mechanism is removed');
  assert.equal(w.ctx._tpcpDayLog.filter((e) => e.caller !== 'boot').length, 0, 'the whole cold open logged nothing but the boot entry');
});

test('(a) legacy cache without dates cannot pick -> does not paint; loading covers the gap', () => {
  // Anything written before item 26 has no cfgDays: the dates the pick
  // needs are not in the payload, so painting it would be painting an
  // unpicked day. It must not paint; the loading state covers the gap
  // until checkLock delivers a pickable config and paints picked.
  const legacy = JSON.stringify({
    code: 'TEST02', tripName: 'BB test trip',
    customSched: [{ sections: [{ title: 'Disneyland', entries: [{ t: '8:05 AM', h: 'Space Mountain' }] }] }, null],
    savedAt: 1,
  });
  const w = makeWorld({ storage: { tpcp_code: 'TEST02', tpcp_role: 'admin', tpcp_lastSched_TEST02: legacy } });
  assert.equal(w.ctx.tpcpPaintCachedTrip('TEST02'), false, 'dateless cache must not paint a day');
  assert.equal(w.loadCustomCalls, 0, 'no render happened');
  assert.equal(w.ctx._tripProvisional, false, 'no provisional paint state');
  assert.ok(w.ctx.tpcpSchedPlaceholderHTML().includes('Loading your trip'), 'loading state covers the gap');
});

test('(a) a different trip\'s cache is never painted; no cache -> loading view, never the empty state', () => {
  const foreign = JSON.stringify({ code: 'OTHER99', tripName: 'Someone else', customSched: [{ sections: [] }], savedAt: 1 });
  const w = makeWorld({ storage: { tpcp_code: 'TEST02', tpcp_lastSched_TEST02: foreign } });
  assert.equal(w.ctx.tpcpCacheForCode('TEST02'), null, 'payload code mismatch must not paint');
  assert.equal(w.ctx.tpcpPaintCachedTrip('TEST02'), false);
  const ph = w.ctx.tpcpSchedPlaceholderHTML();
  assert.ok(ph && ph.includes('Loading your trip'), 'no usable cache -> neutral loading view');
  assert.ok(!ph.includes('No schedule yet'), 'loading must not render as empty');

  const w2 = makeWorld({ storage: { tpcp_code: 'TEST02' } });
  assert.equal(w2.ctx.tpcpPaintCachedTrip('TEST02'), false, 'no cache -> no paint');
  assert.ok(w2.ctx.tpcpSchedPlaceholderHTML().includes('Loading your trip'));
  // The genuine empty state stays reachable once a load has succeeded:
  w2.ctx.tpcpMarkTripLoaded();
  assert.equal(w2.ctx.tpcpSchedPlaceholderHTML(), null);
});

test('(a) static pins: gate precedes the empty state; hydrate is role-free; transient path has no reload', () => {
  const rsStart = appHtml.indexOf('function renderSched(){');
  const gateIdx = appHtml.indexOf('tpcpSchedPlaceholderHTML()', rsStart);
  const emptyIdx = appHtml.indexOf('No schedule yet', rsStart);
  assert.ok(gateIdx > rsStart && gateIdx < emptyIdx, 'renderSched must consult the loading gate before the empty state');

  const initSrc = sliceRange('function _initApp()', 'if (skipAnim) {');
  assert.ok(initSrc.includes('tpcpPaintCachedTrip(_openCode)'), '_initApp paints the cache');
  assert.ok(!initSrc.includes("=== 'guest'"), 'hydrate must not be guest-gated');

  const lockSrc = sliceRange('function checkLock(){', 'function tryUnlock()');
  const lockCode = lockSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!lockCode.includes('location.reload'), 'checkLock transient path must not reload');
  assert.ok(lockSrc.includes('_tpcpRevalRetried') && lockSrc.includes('checkLock();'), 'transient path retries in place, bounded');
});

// ------------------------------------------------------------ (b) day pick
test('(b) initial day: mid-trip -> today, pre-trip -> first, post-trip -> last, bad dates -> first', () => {
  const mid = makeWorld({ nowMs: RealDate.UTC(2026, 9, 23, 17, 0, 0) }); // Oct 23 10:00 PDT
  assert.equal(mid.ctx.getInitialActiveDay(), 1, 'Oct 23 is Day 2');
  const lateNight = makeWorld({ nowMs: RealDate.UTC(2026, 9, 24, 5, 30, 0) }); // Oct 23 22:30 PDT (Oct 24 on an ET device)
  assert.equal(lateNight.ctx.getInitialActiveDay(), 1, 'park-local: still Day 2 at 10:30 PM PT');
  const pre = makeWorld({ nowMs: RealDate.UTC(2026, 9, 20, 15, 0, 0) });
  assert.equal(pre.ctx.getInitialActiveDay(), 0, 'pre-trip -> Day 1');
  const post = makeWorld({ nowMs: RealDate.UTC(2026, 9, 25, 15, 0, 0) });
  assert.equal(post.ctx.getInitialActiveDay(), 1, 'post-trip -> last day');
  const blank = makeWorld({ days: [{ num: 1, label: 'Day 1', date: '', park: 'Disneyland' }, { num: 2, label: 'Day 2', date: '', park: 'Disneyland' }] });
  assert.equal(blank.ctx.getInitialActiveDay(), 0, 'dateless config -> safe fallback');
  const garbage = makeWorld({ days: [{ num: 1, label: 'Day 1', date: 'not-a-date', park: 'Disneyland' }, { num: 2, label: 'Day 2', date: 'also-not-a-date', park: 'Disneyland' }] });
  assert.equal(garbage.ctx.getInitialActiveDay(), 0, 'no parseable dates -> safe fallback');
  const mixed = makeWorld({ days: [{ num: 1, label: 'Day 1', date: 'not-a-date', park: 'Disneyland' }, { num: 2, label: 'Day 2', date: 'Oct 23, 2026', park: 'Disneyland' }] });
  assert.equal(mixed.ctx.getInitialActiveDay(), 1, 'one parseable day that IS today still matches');
});

test('(b) load sequence for an ENDED trip: first pick is the clamped last day, applied as state before paint, nothing logged', () => {
  // Oct 25: TEST02 (Oct 22-23) has ended. This is the build-52 failure
  // shape (boots b2-b8: App start, then a 'repick' entry ~1s later).
  // The load paths run: sync the real config -> apply the pick as
  // state -> paint. The first pick must BE the clamp -- there is no
  // corrector left to fix it afterwards -- and the log must stay
  // empty.
  const w = makeWorld({ nowMs: RealDate.UTC(2026, 9, 25, 17, 0, 0), days: [{ num: 1, label: 'Day 1', date: '', park: '' }, { num: 2, label: 'Day 2', date: '', park: '' }], curDay: 0 });
  w.ctx.tpcpSyncTripConfig({ tripName: 'BB test trip', days: JSON.parse(JSON.stringify(TEST02_DAYS)) });
  assert.equal(w.ctx.tpcpApplyFirstPaintPick(), true, 'the synced config makes a pick computable');
  assert.equal(w.ctx.curDay, 1, 'ended trip clamps to the last day as the FIRST pick');
  assert.equal(w.loadCustomCalls, 0, 'the pick itself paints nothing -- the load path paints next, on the picked day');
  assert.equal(w.ctx._tpcpDayLog.filter((e) => e.caller !== 'boot').length, 0, 'no repick (or any) entry for the cold open');
  assert.equal(w.tabs[1]._classes.active, true, 'the picked tab is lit before the first paint');
  // A deliberate selection is never overridden by the pick:
  const w2 = makeWorld({ nowMs: RealDate.UTC(2026, 9, 25, 17, 0, 0), curDay: 0 });
  w2.window._dayUserPicked = true; // user tapped a tab before load completed
  assert.equal(w2.ctx.tpcpApplyFirstPaintPick(), true);
  assert.equal(w2.ctx.curDay, 0, 'a deliberate selection is never stolen');
});

// ------------------------------------------------------------ (c) fit-clamp via setDay
test('(c) fit-clamp routes through setDay: tabs and content can never desync', () => {
  const w = makeWorld({
    curDay: 1,
    customSched: [{ sections: [] }, { sections: [] }],
    schedData: { days: [{ park: 'Disneyland' }] },
    days: [TEST02_DAYS[0]],
  });
  w.ctx.tpcpFitCustomSched();
  assert.equal(w.ctx.customSched.length, 1, 'model fitted to one day');
  assert.equal(w.ctx.curDay, 0, 'clamped to the last existing day');
  assert.equal(w.tabs[0]._classes.active, true, 'Day 1 tab lit');
  assert.equal(w.tabs[1]._classes.active, false, 'Day 2 tab NOT lit over Day 1 content');
  const last = w.ctx._tpcpDayLog[w.ctx._tpcpDayLog.length - 1];
  assert.equal(last.caller, 'fit-clamp');
  assert.equal(last.from, 1); assert.equal(last.to, 0);
});

// ------------------------------------------------------------ (d) tap guard
test('(d) a moved touch does not switch days; a clean tap does', () => {
  const w = makeWorld({ curDay: 0 });
  w.ctx.tpcpInitDayTabGuards();
  // Scroll gesture that starts on the strip and travels 65px:
  fire(w.container, 'touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
  fire(w.container, 'touchmove', { touches: [{ clientX: 100, clientY: 165 }] });
  fire(w.container, 'touchend', { changedTouches: [{ clientX: 100, clientY: 165 }] });
  w.ctx.tpcpDayTabTap(1); // the click the browser fires anyway
  assert.equal(w.ctx.curDay, 0, 'moved touch must not switch the day');
  assert.ok(!w.ctx._tpcpDayLog.some((e) => e.caller === 'tab-tap'), 'no tab-tap logged for the moved touch');
  // Clean tap:
  fire(w.container, 'touchstart', { touches: [{ clientX: 50, clientY: 50 }] });
  fire(w.container, 'touchend', { changedTouches: [{ clientX: 50, clientY: 50 }] });
  w.ctx.tpcpDayTabTap(1);
  assert.equal(w.ctx.curDay, 1, 'clean tap switches');
  assert.equal(w.window._dayUserPicked, true, 'clean tap marks the day user-picked');
  const last = w.ctx._tpcpDayLog[w.ctx._tpcpDayLog.length - 1];
  assert.equal(last.caller, 'tab-tap');
  assert.equal(last.touch, true, 'touch sequence recorded as preceding the change');
});

// ------------------------------------------------------------ (e) ring buffer
test('(e) ring buffer records caller-labelled, boot-stamped entries and persists across a reload', () => {
  const w = makeWorld({ curDay: 0 });
  // Item 26: this instance's boot entry is already in the buffer.
  assert.equal(w.ctx._tpcpDayLog.length, 1, 'exactly one boot entry per instance');
  assert.equal(w.ctx._tpcpDayLog[0].caller, 'boot');
  assert.equal(w.ctx._tpcpDayLog[0].boot, w.ctx.tpcpBootId());
  w.ctx.setDay(1, { caller: 'init' });
  w.ctx.setDay(0, { caller: 'tab-tap' });
  assert.equal(w.ctx._tpcpDayLog.length, 3);
  const [, e1, e2] = w.ctx._tpcpDayLog;
  assert.deepEqual([e1.from, e1.to, e1.caller], [0, 1, 'init']);
  assert.deepEqual([e2.from, e2.to, e2.caller], [1, 0, 'tab-tap']);
  assert.equal(typeof e1.ts, 'number');
  assert.equal(typeof e1.touch, 'boolean');
  assert.equal(e1.boot, w.ctx.tpcpBootId(), 'every entry is stamped with its instance boot id');
  assert.equal(e2.boot, w.ctx.tpcpBootId());
  const persisted = JSON.parse(w.localStorage.getItem('tpcp_day_log'));
  assert.equal(persisted.length, 3, 'buffer persisted to localStorage');
  // A fresh world (the "reload") reading the same storage sees the log
  // and appends its OWN boot entry under a NEW boot id:
  const w2 = makeWorld({ storage: Object.fromEntries(w.localStorage._map) });
  assert.equal(w2.ctx._tpcpDayLog.length, 4, 'buffer survives reload, plus the new instance boot entry');
  assert.notEqual(w2.ctx.tpcpBootId(), w.ctx.tpcpBootId(), 'each instance mints a distinct boot id');
  const html = w2.ctx.tpcpDayChangesHtml();
  assert.ok(html.includes('Day changes'), 'diagnostics readout is labelled plainly');
  assert.ok(html.includes('tab-tap'), 'readout names callers');
  assert.ok(html.includes('App start'), 'readout renders boot entries as app starts');
  assert.ok(html.includes(w.ctx.tpcpBootId()) && html.includes(w2.ctx.tpcpBootId()), 'readout shows both boot ids');
});

test('(e) readout shows the WHOLE buffer and marks pre-instrumentation entries', () => {
  const legacyLog = JSON.stringify([{ ts: 1792700000000, from: 0, to: 1, caller: 'tab-tap', touch: true }]);
  const w = makeWorld({ storage: { tpcp_day_log: legacyLog } });
  const html0 = w.ctx.tpcpDayChangesHtml();
  assert.ok(html0.includes('pre-instrumentation'), 'entries without a boot stamp are marked as such');
  // More entries than the old last-8 window: every one must render.
  // Item 31: alternate REAL switches -- a same-day setDay is now a
  // no-op by design and logs nothing, so the old i%2 pattern (which
  // started with a same-day call) would not produce 12 entries.
  for (let i = 0; i < 12; i++) w.ctx.setDay(i % 2 === 0 ? 1 : 0, { caller: 'sw' + i });
  const html = w.ctx.tpcpDayChangesHtml();
  assert.ok(html.includes('sw0'), 'earliest entry still shown (no last-8 window)');
  assert.ok(html.includes('sw11'), 'latest entry shown');
});

// ------------------------------------------------------------ (f) the churn fork
test('(f) boot ids settle the churn fork: the same 0->1 tap in two instances carries two boot ids', () => {
  const w1 = makeWorld({ curDay: 0 });
  w1.ctx.setDay(1, { caller: 'tab-tap' });
  // A recreated page over the same storage: its in-memory day starts
  // back at Day 1, so the user's next Day-2 tap honestly logs 0->1
  // again -- indistinguishable from a single-instance reset UNLESS the
  // entries carry boot ids. This is Beau's 21:28:27/:28 pair.
  const w2 = makeWorld({ storage: Object.fromEntries(w1.localStorage._map), curDay: 0 });
  w2.ctx.setDay(1, { caller: 'tab-tap' });
  const taps = w2.ctx._tpcpDayLog.filter((e) => e.caller === 'tab-tap' && e.from === 0 && e.to === 1);
  assert.equal(taps.length, 2, 'the impossible pair, reproduced');
  assert.notEqual(taps[0].boot, taps[1].boot, 'the pair straddles two boots = the page was recreated');
  const bootsBetween = w2.ctx._tpcpDayLog.slice(w2.ctx._tpcpDayLog.indexOf(taps[0]) + 1, w2.ctx._tpcpDayLog.indexOf(taps[1])).filter((e) => e.caller === 'boot');
  assert.equal(bootsBetween.length, 1, 'a boot entry sits between the pair');
  assert.equal(bootsBetween[0].boot, taps[1].boot);
});

// ------------------------------------------------------------ (g) first-paint pick
test('(g) first-paint pick: applies from a dated config, refuses a dateless one, never overrides the user', () => {
  const w = makeWorld({ curDay: 0 });
  assert.equal(w.ctx.tpcpApplyFirstPaintPick(), true);
  assert.equal(w.ctx.curDay, 1, 'pick = today (Day 2), applied as state before any paint');
  assert.equal(w.tabs[1]._classes.active, true, 'tabs reflect the pick');
  assert.equal(w.ctx._tpcpDayLog.filter((e) => e.caller !== 'boot').length, 0, 'the pick is state, not a logged change');
  assert.equal(w.ctx.tpcpApplyFirstPaintPick(), true, 'one-time: a second call is a no-op success');
  assert.equal(w.ctx.curDay, 1);

  const blank = makeWorld({ days: [{ num: 1, label: 'Day 1', date: '', park: 'Disneyland' }, { num: 2, label: 'Day 2', date: '', park: 'Disneyland' }], curDay: 0 });
  assert.equal(blank.ctx.tpcpApplyFirstPaintPick(), false, 'no dates -> no pick possible -> the caller must not paint');
  assert.equal(blank.ctx.curDay, 0);
  assert.equal(blank.ctx._dayPickApplied, false, 'a failed pick does not consume the one-time application');

  const user = makeWorld({ curDay: 0 });
  user.window._dayUserPicked = true;
  assert.equal(user.ctx.tpcpApplyFirstPaintPick(), true);
  assert.equal(user.ctx.curDay, 0, 'a deliberate user selection is never overridden');
});

// ------------------------------------------------------------ (h) one pick
test('(h) one pick implementation: tpcpPickFromDays and getInitialActiveDay can never disagree', () => {
  const cases = [
    { nowMs: RealDate.UTC(2026, 9, 20, 15, 0, 0), want: 0, label: 'before the trip -> first day' },
    { nowMs: RealDate.UTC(2026, 9, 22, 17, 0, 0), want: 0, label: 'Day 1 -> Day 1' },
    { nowMs: RealDate.UTC(2026, 9, 23, 17, 0, 0), want: 1, label: 'Day 2 -> Day 2' },
    { nowMs: RealDate.UTC(2026, 9, 24, 5, 30, 0), want: 1, label: 'park-local: still Day 2 late at night' },
    { nowMs: RealDate.UTC(2026, 9, 25, 15, 0, 0), want: 1, label: 'after the trip -> clamped last day' },
  ];
  for (const c of cases) {
    const w = makeWorld({ nowMs: c.nowMs });
    assert.equal(w.ctx.tpcpPickFromDays(w.tc.days), c.want, 'pick: ' + c.label);
    assert.equal(w.ctx.getInitialActiveDay(), c.want, 'initial day agrees: ' + c.label);
  }
  const blank = makeWorld({ days: [{ num: 1, label: 'Day 1', date: '', park: 'Disneyland' }, { num: 2, label: 'Day 2', date: '', park: 'Disneyland' }] });
  assert.equal(blank.ctx.tpcpPickFromDays(blank.tc.days), -1, 'dateless config -> no pick possible');
  assert.equal(blank.ctx.getInitialActiveDay(), 0, 'and the initial day falls back to Day 1');
});

test('(h) static pins (item 31): the post-paint repick is gone from every load path; the timed render cannot beat the pick', () => {
  assert.ok(!appHtml.includes('tpcpMaybeRepickDay'), 'no repick function or call sites remain');
  assert.ok(!appHtml.includes('_dayRepicked'), 'no repick gate flag remains');
  assert.ok(!appHtml.includes("caller:'repick'"), 'no repick log entries can be written');
  const initSrc = sliceRange('function _initApp()', 'if (skipAnim) {');
  assert.ok(initSrc.includes('(_tripLoaded || _tripProvisional)'), '_initApp timed render only paints over an already-picked paint');
});

// ------------------------------------------------------------ (j) cheap switches
test('(j) same-day tap is a no-op: no re-render, no log, at most scroll-to-now', () => {
  const w = makeWorld({ curDay: 1, recordTimers: true, queueRaf: true }); // Day 2 is today at the default clock
  w.ctx.setDay(1, { caller: 'tab-tap', user: true });
  assert.equal(w.ctx.curDay, 1);
  assert.equal(w.renderSchedCalls, 0, 'same-day tap must not rebuild the schedule');
  assert.equal(w.scrollCalls, 0, 'no scroll-to-top for a same-day tap');
  assert.equal(w.nowScrollCalls, 1, 'today + same-day tap may scroll to now, once');
  assert.equal(w.ctx._tpcpDayLog.filter((e) => e.caller !== 'boot').length, 0, 'no day-change entry for a non-switch');
  assert.equal(w.window._dayUserPicked, true, 'the tap still counts as a deliberate selection');

  const w2 = makeWorld({ curDay: 0, recordTimers: true, queueRaf: true }); // Day 1 is not today
  w2.ctx.setDay(0, { caller: 'tab-tap', user: true });
  assert.equal(w2.renderSchedCalls, 0, 'same-day tap on a non-today day also renders nothing');
  assert.equal(w2.scrollDirectives(), 0, 'non-today same-day tap: no scroll at all');
});

test('(j) cross-day switch: one render, exactly one scroll directive from the single owner', () => {
  // To a NON-today day:
  const w = makeWorld({ curDay: 1, recordTimers: true, queueRaf: true });
  w.ctx.setDay(0, { caller: 'tab-tap', user: true });
  assert.equal(w.renderSchedCalls, 1, 'one innerHTML owner renders the switch once');
  assert.equal(w.scrollCalls, 0, 'switchNav issued no scroll of its own for the switch');
  w.flushRaf();
  assert.equal(w.scrollCalls, 1, 'the owner issued the switch\'s one scroll');
  assert.deepEqual(w.scrollArgs[0], [0, 0], 'non-today switch scrolls to top');
  w.flushTimers();
  assert.equal(w.scrollDirectives(), 1, 'setTab\'s timed scroll stood down -- exactly one directive total');
  assert.equal(w.window._tpcpDayScrollSeq, 0, 'the switch marker is released after the scroll');

  // To the TODAY day:
  const w2 = makeWorld({ curDay: 0, recordTimers: true, queueRaf: true });
  w2.ctx.setDay(1, { caller: 'tab-tap', user: true });
  assert.equal(w2.renderSchedCalls, 1, 'one render for the today switch');
  w2.flushRaf();
  assert.equal(w2.nowScrollCalls, 1, 'today switch scrolls to now, once');
  assert.equal(w2.scrollCalls, 0, 'no competing scroll-to-top');
  w2.flushTimers();
  assert.equal(w2.scrollDirectives(), 1, 'exactly one directive for the today switch too');
});

test('(j) rapid burst: many switches, one render each, exactly one scroll -- the last switch\'s', () => {
  const w = makeWorld({ curDay: 0, recordTimers: true, queueRaf: true });
  w.ctx.setDay(1, { caller: 'tab-tap', user: true });
  w.ctx.setDay(0, { caller: 'tab-tap', user: true });
  w.ctx.setDay(1, { caller: 'tab-tap', user: true });
  assert.equal(w.renderSchedCalls, 3, 'each real switch renders once (one innerHTML owner per switch)');
  w.flushRaf();
  w.flushTimers();
  assert.equal(w.scrollDirectives(), 1, 'superseded switches never scroll');
  assert.equal(w.nowScrollCalls, 1, 'the surviving directive is the last switch\'s (to today: scroll-to-now)');
  assert.equal(w.ctx.curDay, 1);
});

test('(j) plain navigation keeps its own scroll: switchNav outside a day switch still scrolls to top', () => {
  const w = makeWorld({ curDay: 0, recordTimers: true, queueRaf: true });
  w.ctx.switchNav('schedule');
  assert.equal(w.scrollCalls, 1, 'plain nav scrolls as before');
  assert.equal(w.scrollArgs[0][0].behavior, 'smooth', 'with its smooth scroll-to-top');
});

// ------------------------------------------------------------ (i) static pins
test('(i) static pins (item 26): init does not paint; cache writers carry dates; load paths pick before painting', () => {
  const initSrc = sliceRange('// Update day tabs with VIP markers', '</script>');
  assert.ok(!initSrc.includes("caller: 'init'"), 'the DOMContentLoaded init setDay paint is gone');
  assert.ok(initSrc.includes('curDay = getInitialActiveDay()'), 'init initializes day STATE only');
  assert.equal(appHtml.split('cfgDays: tpcpCacheCfgDays()').length - 1, 5, 'all five cache writers stamp cfgDays');
  const paintSrc = sliceRange('function tpcpPaintCachedTrip', 'function tpcpMarkTripLoaded');
  assert.ok(paintSrc.includes('tpcpPickFromDays(c.cfgDays)'), 'cache paint picks from the payload dates');
  assert.ok(paintSrc.includes('if(_picked<0) return false;'), 'an unpickable cache does not paint');
  const lockSrc = sliceRange('function checkLock(){', 'function tryUnlock()');
  assert.ok(lockSrc.indexOf('tpcpSyncTripConfig(d.tripData.tripConfig)') < lockSrc.indexOf('tpcpApplyFirstPaintPick()'), 'checkLock: config sync precedes the pick');
  assert.ok(lockSrc.indexOf('tpcpApplyFirstPaintPick()') < lockSrc.indexOf('loadCustom();'), 'checkLock: the pick precedes the first paint');
  assert.ok(lockSrc.includes('tpcpSyncTripConfig(dr.data.tripData.tripConfig)'), 'checkLock retry path syncs the config (it never did)');
  const unlockSrc = sliceRange('function tryUnlock()', 'function enterMagic()');
  assert.ok(unlockSrc.includes('tpcpApplyFirstPaintPick();'), 'tryUnlock applies the pick before its first paint');
  assert.ok(unlockSrc.includes('tpcpSyncTripConfig(dr2.data.tripData.tripConfig)'), 'tryUnlock retry path syncs the config (it never did)');
});

// ------------------------------------------------------------ park time helpers
test('park time epoch: 7 AM park-local, including the DST fall-back morning', () => {
  const w = makeWorld({});
  assert.equal(w.ctx.tpcpParkTimeEpoch(0, '2026-10-23', 7, 0), RealDate.UTC(2026, 9, 23, 14, 0, 0), '7 AM PDT = 14:00 UTC');
  assert.equal(w.ctx.tpcpParkTimeEpoch(0, '2026-11-01', 7, 0), RealDate.UTC(2026, 10, 1, 15, 0, 0), '7 AM PST on fall-back day = 15:00 UTC');
});
