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
// Item 32 (Oct 24, 2026) adds the loaded-apply teardown, per Claude's
// build-53 ruling (stage 1 only): the provisional cache paint's render
// was composited OVER by the loaded render instead of replaced --
// doubled sections in every tab from the first frame on device.
// tpcpTeardownProvisional empties the provisional containers at each
// loaded-apply seam, immediately before the loaded paint. Test (k)
// drives the seam in both flag-flip orderings against write-logging
// containers and pins the five call sites; test (l) sweeps the
// item-31 scroll marker down after every render path the harness
// drives (the marker audit's ordered assertion).
//
// Item 33 (Oct 24, 2026) kills the last switch flash, per Claude's
// build-54 ruling: the ghosting was closed by item 32 (Beau: scrolling
// fine now), but every day switch still painted ONE intermediate
// frame -- incoming day at the inherited scroll offset, day-tab strip
// blank, header countdown missing -- because setDay's one scroll was
// deferred to a double-rAF and the header text landed at the end of
// the task. The fix is ordering, not layers: (1) the switch scroll
// issues SYNCHRONOUSLY inside setDay's task (double-rAF retired,
// switch path only; a forced layout read precedes scroll-to-now), and
// (2) header-first ordering -- tab toggles + renderDayInfoBar (which
// drives renderCountdown) precede renderSched in setDay, so the
// switch paints complete-or-nothing. Test (m) pins both orderings
// statically and the in-task landing behaviorally. Two (j) tests are
// re-pinned to the new semantics: a switch's scroll now lands DURING
// setDay (nothing waits for a rAF flush), and a rapid burst issues one
// synchronous scroll per switch -- there is no pending scroll left
// for a later switch to supersede, and each switch task is atomic,
// so only the last switch's position can ever paint.
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
assert.ok(SRC.includes('function tpcpTeardownProvisional'), 'loaded-apply teardown missing');
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

// An element whose innerHTML setter logs every write, so a test can
// observe the exact write sequence a container goes through (the
// compositing defect itself is device-only; the seam's write order is
// the logical half the harness CAN see).
function makeTrackedEl(id, log) {
  const el = makeEl();
  let v = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => v,
    set: (nv) => { v = String(nv); log.push({ id, value: v }); },
  });
  return el;
}

function makeWorld(opts = {}) {
  const world = { loadCustomCalls: 0, renderSchedCalls: 0, scrollCalls: 0, scrollArgs: [], nowScrollCalls: 0, docScrollTopSets: 0, timers: [], rafQueue: [], contentWrites: [], phase: null };
  world._loadCustomImpl = opts.loadCustomImpl || null;
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
  if (opts.trackContainers) {
    world.els = {
      schedContent: makeTrackedEl('schedContent', world.contentWrites),
      dayInfoBar: makeTrackedEl('dayInfoBar', world.contentWrites),
    };
    byId.schedContent = world.els.schedContent;
    byId.dayInfoBar = world.els.dayInfoBar;
  }
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
    loadCustom: () => { world.loadCustomCalls++; if (world._loadCustomImpl) world._loadCustomImpl(world); },
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
  // Item 33: no flush needed -- the owner's scroll lands synchronously
  // inside the switch task (switchNav issued none of its own, or this
  // count would be higher / the args wrong).
  assert.equal(w.scrollCalls, 1, 'the owner issued the switch\'s one scroll, in-task');
  assert.deepEqual(w.scrollArgs[0], [0, 0], 'non-today switch scrolls to top');
  assert.equal(w.window._tpcpDayScrollSeq, 0, 'the switch marker is released in the same task');
  w.flushRaf();
  assert.equal(w.scrollCalls, 1, 'no deferred second scroll was hiding in the rAF queue');
  w.flushTimers();
  assert.equal(w.scrollDirectives(), 1, 'setTab\'s timed scroll stood down -- exactly one directive total');

  // To the TODAY day:
  const w2 = makeWorld({ curDay: 0, recordTimers: true, queueRaf: true });
  w2.ctx.setDay(1, { caller: 'tab-tap', user: true });
  assert.equal(w2.renderSchedCalls, 1, 'one render for the today switch');
  assert.equal(w2.nowScrollCalls, 1, 'today switch scrolls to now, synchronously, once');
  assert.equal(w2.scrollCalls, 0, 'no competing scroll-to-top');
  w2.flushRaf();
  w2.flushTimers();
  assert.equal(w2.scrollDirectives(), 1, 'exactly one directive for the today switch too');
});

test('(j) rapid burst: many switches, one render and one in-task scroll each -- nothing deferred survives', () => {
  // Item 33 re-pin: the old deferred owner held each switch's scroll
  // for a double-rAF, so a burst collapsed to ONE scroll (the last
  // switch's). The synchronous owner scrolls inside each switch task
  // instead -- a paint can only land between tasks, so intermediate
  // positions are never painted, and the burst still SETTLES on the
  // last switch's position. What must not come back: any scroll
  // waiting in a queue after the burst.
  const w = makeWorld({ curDay: 0, recordTimers: true, queueRaf: true });
  w.ctx.setDay(1, { caller: 'tab-tap', user: true });
  w.ctx.setDay(0, { caller: 'tab-tap', user: true });
  w.ctx.setDay(1, { caller: 'tab-tap', user: true });
  assert.equal(w.renderSchedCalls, 3, 'each real switch renders once (one innerHTML owner per switch)');
  assert.equal(w.scrollDirectives(), 3, 'one synchronous scroll per switch -- no pending scroll exists to supersede');
  assert.equal(w.nowScrollCalls, 2, 'both today switches scrolled to now');
  assert.equal(w.scrollCalls, 1, 'the non-today switch scrolled to top');
  w.flushRaf();
  w.flushTimers();
  assert.equal(w.scrollDirectives(), 3, 'flushing the queues adds nothing -- no deferred scroll survives the burst');
  assert.equal(w.ctx.curDay, 1, 'the burst settles on the last switch\'s day');
  assert.equal(w.window._tpcpDayScrollSeq, 0, 'marker down after the burst');
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

// ------------------------------------------------------------ (k) loaded-apply teardown
// A world whose two provisional containers log every innerHTML write.
// The loadCustom implementation models the real loadCustom ->
// renderSched + renderDayInfoBar pair: both containers are filled by
// wholesale assignment, tagged by the phase the test sets (the paint
// phase writes PROVISIONAL, the apply phase writes LOADED).
function trackedCacheWorld() {
  const cache = JSON.stringify({
    code: 'TEST02', tripName: 'BB test trip',
    cfgDays: [{ date: 'Oct 22, 2026', park: 'Disneyland' }, { date: 'Oct 23, 2026', park: 'Disneyland' }],
    customSched: [{ sections: [{ title: 'Disneyland', entries: [{ t: '8:05 AM', h: 'Space Mountain' }] }] }, null],
    savedAt: 1,
  });
  const w = makeWorld({
    storage: { tpcp_code: 'TEST02', tpcp_role: 'admin', tpcp_lastSched_TEST02: cache },
    trackContainers: true,
    loadCustomImpl: (ww) => {
      const tag = ww.phase || 'PROVISIONAL';
      ww.els.schedContent.innerHTML = tag + '-SCHED';
      ww.els.dayInfoBar.innerHTML = tag + '-INFOBAR';
    },
  });
  w.phase = 'PROVISIONAL';
  return w;
}

// Drive one loaded apply over a provisional paint, in the order the
// real path uses. 'flag-first' is the checkLock / tryUnlock main
// order (tpcpMarkTripLoaded runs before the paint); 'flag-last' is
// the retry-ladder / poll-ingest order (it runs after).
function driveLoadedApply(w, order) {
  w.phase = 'LOADED';
  if (order === 'flag-first') w.ctx.tpcpMarkTripLoaded();
  w.ctx.tpcpSyncTripConfig({ tripName: 'BB test trip', days: JSON.parse(JSON.stringify(TEST02_DAYS)) });
  w.ctx.tpcpApplyFirstPaintPick();
  w.ctx.tpcpTeardownProvisional();
  w.ctx.loadCustom();
  if (order === 'flag-last') w.ctx.tpcpMarkTripLoaded();
}

test('(k) loaded apply tears the provisional down before painting: the clear lands between the two paints, in both flag orderings', () => {
  for (const order of ['flag-first', 'flag-last']) {
    const w = trackedCacheWorld();
    assert.equal(w.ctx.tpcpPaintCachedTrip('TEST02'), true, 'provisional paint lands (' + order + ')');
    assert.equal(w.ctx._tripProvisional, true);
    assert.deepEqual(w.contentWrites.map((x) => x.id + '=' + x.value),
      ['schedContent=PROVISIONAL-SCHED', 'dayInfoBar=PROVISIONAL-INFOBAR'],
      'the provisional paint filled both containers (' + order + ')');
    driveLoadedApply(w, order);
    assert.deepEqual(w.contentWrites.map((x) => x.id + '=' + x.value), [
      'schedContent=PROVISIONAL-SCHED', 'dayInfoBar=PROVISIONAL-INFOBAR',
      'schedContent=', 'dayInfoBar=',
      'schedContent=LOADED-SCHED', 'dayInfoBar=LOADED-INFOBAR',
    ], 'each container is emptied AFTER the provisional paint and BEFORE the loaded paint (' + order + ')');
    assert.equal(w.els.schedContent.innerHTML, 'LOADED-SCHED', 'final content is the loaded render alone -- nothing provisional remains under it');
    assert.equal(w.els.dayInfoBar.innerHTML, 'LOADED-INFOBAR');
    assert.equal(w.ctx._tripLoaded, true);
    assert.equal(w.ctx._tripProvisional, false);
    assert.equal(w.banner.style.display, 'none', 'the banner transition lands with the apply');
    assert.ok(!w.window._tpcpDayScrollSeq, 'scroll marker is down after the loaded apply (' + order + ')');
  }
});

test('(k) static pins (item 32): the teardown is called at exactly the five loaded-apply seams, each time immediately before the loaded paint', () => {
  assert.ok(appHtml.includes('function tpcpTeardownProvisional(){'), 'teardown helper exists');
  assert.equal(appHtml.split('tpcpTeardownProvisional();').length - 1, 5, 'exactly five teardown call sites (checkLock main + retry, tryUnlock main + retry, guest poll ingest)');
  const seam = /tpcpTeardownProvisional\(\);\s*(loadCustom\(\);|if \(typeof loadCustom === 'function'\) loadCustom\(\);)/g;
  assert.equal((appHtml.match(seam) || []).length, 5, 'every call site sits immediately before a loaded-apply loadCustom');
  const flip = sliceRange('function tpcpMarkTripLoaded(){', 'function tpcpTeardownProvisional');
  assert.ok(!flip.includes('innerHTML'), 'the clear does NOT live inside tpcpMarkTripLoaded -- on the retry/poll paths the flip runs after the paint and would erase it');
});

// ------------------------------------------------------------ (l) marker-down sweep
test('(l) the scroll marker is down after every render path the harness drives (item 32)', () => {
  const down = (w, label) => assert.ok(!w.window._tpcpDayScrollSeq, 'marker down after ' + label);
  for (const order of ['flag-first', 'flag-last']) {
    const w = trackedCacheWorld();
    w.ctx.tpcpPaintCachedTrip('TEST02');
    down(w, 'provisional paint (' + order + ')');
    driveLoadedApply(w, order);
    down(w, 'loaded apply (' + order + ')');
  }
  const w = makeWorld({ curDay: 0, recordTimers: true, queueRaf: true });
  w.ctx.switchNav('schedule');
  down(w, 'plain switchNav');
  w.ctx.setTab('waits');
  w.flushTimers();
  down(w, 'setTab');
  w.ctx.setDay(1, { caller: 'tab-tap', user: true });
  w.flushRaf();
  down(w, 'cross-day switch');
  w.ctx.setDay(0, { caller: 'tab-tap', user: true });
  w.ctx.setDay(1, { caller: 'tab-tap', user: true });
  w.flushRaf();
  w.flushTimers();
  down(w, 'rapid switch burst');
  w.ctx.setDay(1, { caller: 'tab-tap', user: true });
  down(w, 'same-day tap');
});

// ------------------------------------------------------------ (m) switch flash (item 33)
test('(m) static pins (item 33): in setDay the header lands before the schedule render, and the switch scroll path carries no deferral', () => {
  const setDaySrc = sliceRange('function setDay(d, opts){', 'function setTab(t){');
  // Header-first ordering (a): the day-tab toggles precede every render.
  const toggleIdx = setDaySrc.indexOf("classList.toggle('active',i===d)");
  assert.ok(toggleIdx !== -1, 'setDay toggles the day tabs');
  assert.ok(toggleIdx < setDaySrc.indexOf('renderSched();'), 'day-tab toggles precede renderSched in setDay');
  // ...and on the render line itself, the header render precedes
  // renderSched. renderDayInfoBar is what writes #dayInfoBar AND
  // drives the header countdown (pinned just below), so its position
  // is the header's position.
  const renderLine = setDaySrc.split('\n').find((l) => l.includes('renderSched();') && l.includes('tpcpDaySwitchScroll'));
  assert.ok(renderLine, 'setDay render + switch-scroll line exists');
  assert.ok(renderLine.indexOf('renderDayInfoBar();') !== -1 && renderLine.indexOf('renderDayInfoBar();') < renderLine.indexOf('renderSched();'),
    'renderDayInfoBar precedes renderSched on the switch render line');
  const dibSrc = sliceRange('function renderDayInfoBar(){', 'var PROXY=');
  assert.ok(dibSrc.includes('renderCountdown();'), 'renderDayInfoBar drives the header countdown -- header-first covers the countdown');
  // No deferral (b): the switch-scroll function contains no rAF and
  // no timer, forces a layout read before scroll-to-now, and still
  // issues both directives itself; its call site sits after the
  // renders on the same line (same task).
  const swSrc = sliceRange('function tpcpDaySwitchScroll(d){', 'function setDay(d, opts){');
  assert.ok(!swSrc.includes('requestAnimationFrame'), 'switch scroll: the double-rAF deferral is retired');
  assert.ok(!swSrc.includes('setTimeout'), 'switch scroll: no timer deferral');
  assert.ok(swSrc.includes('offsetHeight'), 'switch scroll forces a synchronous layout read before scroll-to-now');
  assert.ok(swSrc.includes('scrollScheduleToNow()') && swSrc.includes('window.scrollTo(0, 0)'), 'both scroll directives still issue from the single owner');
  assert.ok(renderLine.indexOf('tpcpDaySwitchScroll(d);') > renderLine.indexOf('renderSched();'), 'the switch scroll issues after the renders, in the same task');
});

test('(m) behavioral: in a queued-rAF world the switch scroll has already landed when setDay returns -- the rAF queue stays empty (item 33)', () => {
  const w = makeWorld({ curDay: 1, recordTimers: true, queueRaf: true });
  w.ctx.setDay(0, { caller: 'tab-tap', user: true });
  assert.equal(w.rafQueue.length, 0, 'the switch queued no animation frames');
  assert.equal(w.scrollDirectives(), 1, 'the one scroll directive already landed, inside the task');
  assert.equal(w.window._tpcpDayScrollSeq, 0, 'marker consumed synchronously at the scroll');
  // Same for a today switch (the forced-layout + scroll-to-now arm):
  const w2 = makeWorld({ curDay: 0, recordTimers: true, queueRaf: true });
  w2.ctx.setDay(1, { caller: 'tab-tap', user: true });
  assert.equal(w2.rafQueue.length, 0, 'today switch also queues no animation frames');
  assert.equal(w2.nowScrollCalls, 1, 'scroll-to-now landed in-task');
  assert.equal(w2.window._nowScrollPending, false, 'the pending flag is consumed in-task');
});

// ------------------------------------------------------------ park time helpers
test('park time epoch: 7 AM park-local, including the DST fall-back morning', () => {
  const w = makeWorld({});
  assert.equal(w.ctx.tpcpParkTimeEpoch(0, '2026-10-23', 7, 0), RealDate.UTC(2026, 9, 23, 14, 0, 0), '7 AM PDT = 14:00 UTC');
  assert.equal(w.ctx.tpcpParkTimeEpoch(0, '2026-11-01', 7, 0), RealDate.UTC(2026, 10, 1, 15, 0, 0), '7 AM PST on fall-back day = 15:00 UTC');
});
