// Completeness read-sites suite (item 30, Oct 24, 2026).
//
// Claude's ruling on the Oct 20 completeness rule (item28 root cause):
// the shared validator tpcpDayIsComplete keeps its full force where a
// day is GENERATED or SAVED, but at READ sites it may only annotate a
// stored plan, never erase one.
//  - renderSched: a stored day that HAS items but does not run to the
//    park's live closing time renders its items under a plain
//    "ends before park closing" notice -- never the "No schedule yet"
//    empty state. The empty state is only for genuinely item-less
//    days. (TEST03 Day 1, Oct 24, 2026: 26 items ending 10:25 PM
//    against a midnight live close rendered as "No schedule yet".)
//  - tpcpMaybeAutoBuild: "has a schedule" is presence, not
//    completeness. A stored day with items never counts as invalid
//    for the AUTOMATIC rebuild trigger; the heal fires only for a
//    genuinely item-less (stranded onboarding) trip.
// The generation/save gates are pinned UNCHANGED below.
//
// The suite extracts the REAL code from app.html (the shared
// validator, the close-time helper, renderSched, tpcpMaybeAutoBuild)
// and drives it in a vm with browser stubs -- the code under test is
// the code that ships.
//
// Run: node --test test/completeness-read-sites.test.mjs
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
  sliceRange('/* ==== BEGIN SHARED: tpcpDayIsComplete', '/* ==== END SHARED: tpcpDayIsComplete ==== */'),
  sliceRange('function _tpcpCloseMinutesForDay(dayIdx) {', '// Self-heal for a stranded onboarding'),
  sliceRange('function getCurDay()', '//    VIP notes'),
  sliceRange('function renderSched(){', 'function renderWaitTab(){'),
  sliceRange('function tpcpMaybeAutoBuild(){', 'function generateAllDays()'),
].join('\n');

assert.ok(SRC.includes('function tpcpDayIsComplete'), 'validator missing');
assert.ok(SRC.includes('function renderSched'), 'renderSched missing');
assert.ok(SRC.includes('_rsEndsEarly'), 'ends-early verdict missing');
assert.ok(SRC.includes('ends-early-note'), 'ends-early treatment missing');
assert.ok(SRC.includes('function tpcpMaybeAutoBuild'), 'auto-build missing');

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
  return { style: {}, innerHTML: '', textContent: '', remove: () => {} };
}

function fmtTime(mins) {
  let h = Math.floor(mins / 60), m = mins % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
}

// A stored day of n items whose latest start is lastMin (minutes from
// midnight) -- the TEST03 Day 1 shape: items from 7:00 AM, the last
// one at 10:25 PM (1345).
function storedDay(n, lastMin, park) {
  const items = [];
  for (let i = 0; i < n - 1; i++) {
    items.push({ t: fmtTime(420 + i * 30), h: 'Stop ' + (i + 1), type: i % 3 === 0 ? 'ride' : 'tip', n: '' });
  }
  items.push({ t: fmtTime(lastMin), h: 'Finale Ride', type: 'ride', n: '' });
  return { park: park || 'Disneyland Park', items };
}

const INTEL = {
  '2026-10-24': { dl: { open: '08:00', close: '00:00' }, dca: { open: '08:00', close: '22:00' } },
  '2026-10-25': { dl: { open: '08:00', close: '23:00' }, dca: { open: '08:00', close: '22:00' } },
};
const CFG_DAYS = [
  { date: 'Oct 24, 2026', park: 'Disneyland' },
  { date: 'Oct 25, 2026', park: 'Disneyland' },
];

function makeWorld(opts = {}) {
  const world = { fetchCalls: 0, genCalls: 0, toasts: [] };
  const schedDays = opts.schedDays;
  const schedContent = makeEl();
  world.schedContent = schedContent;
  const banner = makeEl();
  const byId = { schedContent, cachedSchedBanner: banner };
  const tripConfig = {
    onboardingComplete: true,
    days: JSON.parse(JSON.stringify(CFG_DAYS)),
    schedule: { days: schedDays },
  };
  world.tripConfig = tripConfig;
  const windowObj = {
    _schedData: { days: schedDays },
    _loadedTripData: { tripConfig },
    _tpcpAutoBuildChecking: false,
    _tpcpAutoBuildFired: false,
  };
  world.window = windowObj;
  const ctx = {
    console,
    window: windowObj,
    document: {
      getElementById: (id) => (id in byId ? byId[id] : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => makeEl(),
    },
    localStorage: memStorage(opts.storage ?? { tpcp_code: 'TEST03', tpcp_onboardingComplete: 'true' }),
    sessionStorage: memStorage(),
    fetch: (url) => {
      world.fetchCalls++;
      const payload = opts.fetchPayload ?? { tripData: { tripConfig } };
      return Promise.resolve({ json: () => Promise.resolve(payload) });
    },
    SYNC_BASE: 'https://example.test',
    curDay: opts.curDay ?? 0,
    // Mirror of loadCustom's model build (sections from stored items).
    customSched: schedDays.map((d) => (d && d.items && d.items.length)
      ? { sections: [{ title: d.park || '', entries: d.items }] }
      : null),
    DAYS: [],
    // app.html reads the runtime config under BOTH spellings
    // (TRIP_CONFIG.day and TRIP_CONFIG.days are both populated live).
    TRIP_CONFIG: {
      day: CFG_DAYS.map(() => ({ isVip: false })),
      days: CFG_DAYS.map(() => ({ isVip: false })),
    },
    editMode: opts.editMode ?? false,
    usingCachedSchedule: false,
    llState: null,
    setTimeout: () => 0,
    clearTimeout: () => {},
    getParkHoursIntel: () => opts.intel ?? INTEL,
    tpcpSchedPlaceholderHTML: () => null,
    renderDayTipsCard: () => '',
    renderLLSequenceBlock: () => '',
    fixEncoding: (s) => (s == null ? '' : String(s)),
    diningDetailsHtml: () => '',
    tpcpPhotoNoteForCard: () => '',
    attachDiningListeners: () => {},
    updateWaitPillVisibility: () => {},
    isAdmin: () => opts.admin ?? true,
    lookupWait: () => null,
    showToast: (msg) => { world.toasts.push(String(msg)); },
    generateAllDays: () => { world.genCalls++; },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  world.ctx = ctx;
  return world;
}

async function flush() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ------------------------------------------------------------- renderSched
test('(R1) TEST03 Oct 24: 26 items ending 10:25 PM vs a midnight live close render WITH the ends-before-closing notice, never the empty state', () => {
  const w = makeWorld({ schedDays: [storedDay(26, 1345), storedDay(24, 1345)] });
  w.ctx.renderSched();
  const html = w.schedContent.innerHTML;
  assert.ok(!html.includes('No schedule yet'), 'a stored day with items must not render as empty');
  assert.ok(html.includes('This plan ends before the park closes.'), 'the ends-before-closing notice shows');
  assert.ok(html.includes('ends-early-note'), 'the notice carries its treatment class');
  assert.ok(html.includes('Finale Ride'), 'the day items render');
  assert.ok(html.includes('Stop 1'), 'the day items render from the top');
});

test('(R2) a day with zero items still renders "No schedule yet" (and no notice)', () => {
  const w = makeWorld({ schedDays: [{ park: 'Disneyland Park', items: [] }, storedDay(24, 1345)] });
  w.ctx.renderSched();
  const html = w.schedContent.innerHTML;
  assert.ok(html.includes('No schedule yet'), 'a genuinely empty day keeps the empty state');
  assert.ok(!html.includes('ends-early-note'), 'no ends-early notice on an empty day');
});

test('(R3) a complete day (ends 10:25 PM vs an 11 PM close) renders with NO notice', () => {
  const w = makeWorld({ schedDays: [storedDay(24, 1345), storedDay(26, 1345)], curDay: 1 });
  w.ctx.renderSched();
  const html = w.schedContent.innerHTML;
  assert.ok(!html.includes('No schedule yet'));
  assert.ok(!html.includes('ends-early-note'), 'a day that runs to closing gets no notice');
  assert.ok(html.includes('Finale Ride'), 'items render');
});

test('(R4) an unjudgeable day (no live hours for its date) renders with NO notice', () => {
  const w = makeWorld({ schedDays: [storedDay(26, 1345), storedDay(24, 1345)], intel: {} });
  w.ctx.renderSched();
  const html = w.schedContent.innerHTML;
  assert.ok(!html.includes('No schedule yet'));
  assert.ok(!html.includes('ends-early-note'), 'unknown close -> cannot judge -> no notice');
  assert.ok(html.includes('Finale Ride'), 'items render');
});

test('(R5) the notice extend affordance is admin-only and yields to edit mode', () => {
  const admin = makeWorld({ schedDays: [storedDay(26, 1345), storedDay(24, 1345)], admin: true });
  admin.ctx.renderSched();
  assert.ok(admin.schedContent.innerHTML.includes('Add to this day'), 'admin sees the extend affordance');
  assert.ok(admin.schedContent.innerHTML.includes('onclick="toggleEdit()"'), 'the affordance is the existing Edit Schedule toggle');

  const guest = makeWorld({ schedDays: [storedDay(26, 1345), storedDay(24, 1345)], admin: false });
  guest.ctx.renderSched();
  assert.ok(guest.schedContent.innerHTML.includes('This plan ends before the park closes.'), 'guest still sees the notice');
  assert.ok(!guest.schedContent.innerHTML.includes('Add to this day'), 'guest (view-only) gets no edit affordance');

  const editing = makeWorld({ schedDays: [storedDay(26, 1345), storedDay(24, 1345)], admin: true, editMode: true });
  editing.ctx.renderSched();
  assert.ok(editing.schedContent.innerHTML.includes('This plan ends before the park closes.'), 'notice still shows while editing');
  assert.ok(!editing.schedContent.innerHTML.includes('Add to this day'), 'no toggle button while already editing');
});

// ------------------------------------------------------------- auto-build
test('(A1) a trip whose days ALL have items but ALL fail live-close completeness does NOT auto-build (not even a fetch)', async () => {
  const w = makeWorld({ schedDays: [storedDay(26, 1345), storedDay(24, 1345)] });
  w.ctx.tpcpMaybeAutoBuild();
  await flush();
  assert.equal(w.fetchCalls, 0, 'presence is decided locally: items = has schedule');
  assert.equal(w.genCalls, 0, 'no automatic regeneration of a stored plan');
  assert.equal(w.window._tpcpAutoBuildFired, false);
});

test('(A3) mixed trip: one ends-early day with items + one item-less day still counts as scheduled', async () => {
  const w = makeWorld({ schedDays: [storedDay(26, 1345), { park: 'Disneyland', items: [] }] });
  w.ctx.tpcpMaybeAutoBuild();
  await flush();
  assert.equal(w.fetchCalls, 0, 'the day with items settles it -- no fetch, no heal');
  assert.equal(w.genCalls, 0);
});

test('(A2) a genuinely item-less trip still auto-builds (the stranded-onboarding heal keeps its purpose)', async () => {
  const empty = [{ park: 'Disneyland Park', items: [] }, { park: 'Disneyland', items: [] }];
  const fresh = {
    onboardingComplete: true,
    days: JSON.parse(JSON.stringify(CFG_DAYS)),
    schedule: { days: JSON.parse(JSON.stringify(empty)) },
  };
  const w = makeWorld({ schedDays: empty, fetchPayload: { tripData: { tripConfig: fresh } } });
  w.ctx.tpcpMaybeAutoBuild();
  await flush();
  assert.equal(w.fetchCalls, 1, 'item-less -> confirm with a fresh read');
  assert.equal(w.genCalls, 1, 'still item-less on the fresh read -> the heal fires');
  assert.ok(w.toasts.some((t) => t.includes('Finishing your schedule')), 'the heal announces itself');
});

test('(A2b) item-less locally but the fresh read HAS a schedule -> no auto-build (just-landed terminal write is safe)', async () => {
  const empty = [{ park: 'Disneyland Park', items: [] }, { park: 'Disneyland', items: [] }];
  const fresh = {
    onboardingComplete: true,
    days: JSON.parse(JSON.stringify(CFG_DAYS)),
    schedule: { days: [storedDay(26, 1345), storedDay(24, 1345)] },
  };
  const w = makeWorld({ schedDays: empty, fetchPayload: { tripData: { tripConfig: fresh } } });
  w.ctx.tpcpMaybeAutoBuild();
  await flush();
  assert.equal(w.fetchCalls, 1);
  assert.equal(w.genCalls, 0, 'a schedule that just landed must not be rebuilt over');
});

// ------------------------------------------------------------- save gate
test('(S1) the shared validator is unchanged, and both generation/save gates still refuse incomplete new days', () => {
  const w = makeWorld({ schedDays: [storedDay(26, 1345), storedDay(24, 1345)] });
  const isComplete = w.ctx.tpcpDayIsComplete;
  assert.equal(isComplete({ items: [{ t: '10:25 PM' }] }, 1440), false, '10:25 PM does not run to a midnight close');
  assert.equal(isComplete({ items: [{ t: '10:25 PM' }] }, 1380), true, '10:25 PM runs to an 11 PM close');
  assert.equal(isComplete({ items: [] }, 1380), false, 'an item-less day is never complete');
  assert.equal(isComplete({ items: [{ t: '10:25 PM' }] }, null), false, 'unvalidated is not complete');

  // The save-time refusals stay verbatim in the shipped file:
  assert.ok(appHtml.includes('!tpcpDayIsComplete({ items: sections }, _tpcpCloseMinutesForDay(_vDayIdx))'),
    'generateFromSetup still gates its save on the validator');
  assert.ok(appHtml.includes('!tpcpDayIsComplete({ park: park, items: sections }, _tpcpCloseMinutesForDay(idx))'),
    'the generateAllDays orchestrator still gates each day on the validator');
  assert.ok(appHtml.includes('did not run to park closing, so nothing was saved'),
    'the save refusal still tells the user nothing was saved');

  // Read-site structure: neither ruled read site judges stored days
  // with the validator any more.
  const rsSrc = sliceRange('function renderSched(){', 'function renderWaitTab(){');
  assert.ok(rsSrc.includes('if(!day||!day.sections||!day.sections.length){'),
    'renderSched empty state keys on missing content only');
  assert.ok(!rsSrc.includes('_rsInvalid'), 'the old erase verdict is gone from renderSched');
  const abSrc = sliceRange('function tpcpMaybeAutoBuild(){', 'function generateAllDays()');
  assert.ok(!abSrc.includes('tpcpDayIsComplete'),
    'the auto-build trigger no longer consults the completeness validator');
});
