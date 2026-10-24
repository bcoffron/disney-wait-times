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
].join('\n');

assert.ok(SRC.includes('function tpcpPaintCachedTrip'), 'cache paint missing');
assert.ok(SRC.includes('function tpcpMaybeRepickDay'), 'repick missing');
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
  const world = { loadCustomCalls: 0, renderSchedCalls: 0 };
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
  const documentStub = {
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
    scrollTo: () => {},
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
    requestAnimationFrame: (fn) => { fn(); return 0; },
    setTimeout: () => 0,
    clearTimeout: () => {},
    switchNav: () => {},
    renderClosed: () => {},
    renderSched: () => { world.renderSchedCalls++; },
    renderDayInfoBar: () => {},
    renderVipBanner: () => {},
    scrollScheduleToNow: () => {},
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
  // The post-load repick is now a reconciler, not a corrector: the
  // pick already matches, so it must not flip or log anything.
  w.ctx.tpcpMaybeRepickDay();
  assert.equal(w.ctx.curDay, 1, 'repick after a picked paint is a no-op');
  assert.equal(w.ctx._tpcpDayLog.filter((e) => e.caller === 'repick').length, 0, 'no repick entry for an already-right day');
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

test('(b) re-pick fires once on first real config, and never steals a user tap', () => {
  const w = makeWorld({ curDay: 0 });
  w.ctx.tpcpMaybeRepickDay();
  assert.equal(w.ctx.curDay, 1, 'repick moves to today (Day 2)');
  assert.equal(w.tabs[1]._classes.active, true, 'tab strip agrees');
  const logAfter = w.ctx._tpcpDayLog.filter((e) => e.caller === 'repick');
  assert.equal(logAfter.length, 1, 'exactly one repick entry');
  w.ctx.tpcpMaybeRepickDay();
  assert.equal(w.ctx._tpcpDayLog.filter((e) => e.caller === 'repick').length, 1, 'repick is one-time');

  const w2 = makeWorld({ curDay: 0 });
  w2.window._dayUserPicked = true; // user tapped a tab before load completed
  w2.ctx.tpcpMaybeRepickDay();
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
  w.ctx.setDay(0, { caller: 'repick' });
  assert.equal(w.ctx._tpcpDayLog.length, 3);
  const [, e1, e2] = w.ctx._tpcpDayLog;
  assert.deepEqual([e1.from, e1.to, e1.caller], [0, 1, 'init']);
  assert.deepEqual([e2.from, e2.to, e2.caller], [1, 0, 'repick']);
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
  assert.ok(html.includes('repick'), 'readout names callers');
  assert.ok(html.includes('App start'), 'readout renders boot entries as app starts');
  assert.ok(html.includes(w.ctx.tpcpBootId()) && html.includes(w2.ctx.tpcpBootId()), 'readout shows both boot ids');
});

test('(e) readout shows the WHOLE buffer and marks pre-instrumentation entries', () => {
  const legacyLog = JSON.stringify([{ ts: 1792700000000, from: 0, to: 1, caller: 'tab-tap', touch: true }]);
  const w = makeWorld({ storage: { tpcp_day_log: legacyLog } });
  const html0 = w.ctx.tpcpDayChangesHtml();
  assert.ok(html0.includes('pre-instrumentation'), 'entries without a boot stamp are marked as such');
  // More entries than the old last-8 window: every one must render.
  for (let i = 0; i < 12; i++) w.ctx.setDay(i % 2, { caller: 'sw' + i });
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

// ------------------------------------------------------------ (h) repick gate
test('(h) repick gate: a no-op call against a dateless config does NOT consume the one-time repick', () => {
  const w = makeWorld({ days: [{ num: 1, label: 'Day 1', date: '', park: 'Disneyland' }, { num: 2, label: 'Day 2', date: '', park: 'Disneyland' }], curDay: 0 });
  w.ctx.tpcpMaybeRepickDay();
  assert.equal(w.ctx._dayRepicked, false, 'no dates -> no decision made -> gate NOT consumed');
  assert.equal(w.ctx.curDay, 0);
  // The real config lands on a later load path: the repick must still fire.
  w.tc.days = JSON.parse(JSON.stringify(TEST02_DAYS));
  w.ctx.tpcpMaybeRepickDay();
  assert.equal(w.ctx._dayRepicked, true, 'the dated call consumes the gate');
  assert.equal(w.ctx.curDay, 1, 'and the repick still happens');
  assert.equal(w.ctx._tpcpDayLog.filter((e) => e.caller === 'repick').length, 1);
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
