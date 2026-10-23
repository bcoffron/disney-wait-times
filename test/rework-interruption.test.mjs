// Rework fresh-run + interruption suite (Claude ruling, Oct 22, 2026;
// defects 2 and 3 of the build-48 device test).
//
// Defect 2: an alert-driven rework must be a FRESH run per alert. The
// leader's in-memory day snapshot is rebuilt only on trip load (the
// 10s poll ingests schedule updates for guests only), so at 9:27 PM
// on Oct 22 a second rework re-ran on the pre-Accept snapshot and
// re-proposed the just-accepted plan byte-for-byte, diffed against
// times that no longer existed in storage. tpcpReworkRun now fetches
// the trip fresh and re-ingests it before resolving the day.
//
// Defect 3: interruption is its own classified state. Backgrounding
// the app mid-rework (iOS suspends the webview; the fetch dies
// on-device) surfaced as "I could not reach the optimizer" -- a false
// cause. Client-side interruption (visibility loss during the run, or
// an abort that is not the run's own 65s timeout) now restores the
// alert's Rework prompt with "Rework interrupted -- tap to try
// again", while genuine network failure and the own-timeout keep
// their existing, truthful copy.
//
// The suite extracts the REAL code from app.html (tpcpParseDayDate,
// tpcpAlertKicker, and the whole REWORK block) and drives it in a vm
// with DOM / fetch / timer / visibility stubs, so the code under test
// is the code that ships.
//
// Run: node --test test/rework-interruption.test.mjs
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
const PARSE_SRC = sliceRange('function tpcpParseDayDate', 'function tpcpRealDays');
const KICKER_SRC = sliceRange('function tpcpAlertKicker', '\nfunction ');
const REWORK_SRC = sliceRange('function tpcpReworkTimeToMin', '// Booking tap-through');
assert.ok(REWORK_SRC.includes('function tpcpReworkRun'), 'rework run missing');
assert.ok(REWORK_SRC.includes('function tpcpReworkShowInterrupted'), 'interrupted presenter missing (defect 3)');
assert.ok(REWORK_SRC.includes('Fresh run per alert'), 'fresh-fetch block missing (defect 2)');
assert.ok(REWORK_SRC.includes('_run.interrupted'), 'interruption tracking missing');

const DAYS_CFG = [{ date: 'Oct 22, 2026' }, { date: 'Oct 23, 2026' }];
const STALE_ITEMS = [
  { t: '8:05 AM', h: 'Space Mountain', type: 'ride', n: '' },
  { t: '11:55 PM', h: 'Nighttime Spectacular', type: 'show', n: 'STALE-SNAPSHOT' },
];
const FRESH_ITEMS = [
  { t: '8:05 AM', h: 'Space Mountain', type: 'ride', n: '' },
  { t: '11:55 PM', h: 'Nighttime Spectacular', type: 'show', n: 'FRESH-FETCH' },
];
const PLAN_ENTRIES = [{ t: '11:55 PM', h: 'Nighttime Spectacular', type: 'show', n: 'FRESH-FETCH' }];

function makeWorld() {
  const world = {
    calls: [],          // fetch urls in order
    post: null,         // { body, resolve, reject } for the reoptimize POST
    saveCustomCalls: 0,
    timers: new Map(),
    nextTimer: 1,
  };
  const els = {};
  const document = {
    hidden: false,
    _listeners: {},
    getElementById: (id) => els[id] || (els[id] = { textContent: '', style: {}, disabled: false }),
    addEventListener: (ev, fn) => { (document._listeners[ev] = document._listeners[ev] || []).push(fn); },
    removeEventListener: (ev, fn) => { const a = document._listeners[ev] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    _fire: (ev) => { (document._listeners[ev] || []).slice().forEach((fn) => fn()); },
  };
  world.els = els;
  world.document = document;

  const staleSched = { days: [{ items: JSON.parse(JSON.stringify(STALE_ITEMS)) }, { items: [] }] };
  const freshTripData = {
    tripConfig: {
      days: DAYS_CFG,
      schedule: { days: [{ items: JSON.parse(JSON.stringify(FRESH_ITEMS)) }, { items: [] }] },
    },
  };

  const sandbox = {
    console,
    AbortController,
    setTimeout: (fn, ms) => { const id = world.nextTimer++; world.timers.set(id, { fn, ms, cleared: false }); return id; },
    clearTimeout: (id) => { const t = world.timers.get(id); if (t) t.cleared = true; },
    document,
    localStorage: { getItem: () => 'TESTDL', setItem: () => {}, removeItem: () => {} },
    window: {
      _schedData: staleSched,
      _loadedTripData: { tripConfig: { days: DAYS_CFG, schedule: staleSched } },
    },
    SYNC_BASE: 'https://example.test',
    ensureApiKey: async () => {},
    buildWaitContext: () => '',
    buildRidePrefsContext: () => '',
    getHeldReturnsForDay: () => [],
    tpcpDeviceToken: () => 'tok',
    tpcpTodayYmdPT: () => '2026-10-22',
    saveCustom: () => { world.saveCustomCalls++; },
    renderSched: () => {},
    customSched: [{}],
    curDay: 0,
    _tpcpAlertCurrent: null,
    fetch: (url, init) => {
      world.calls.push(String(url));
      if (String(url).includes('/api/trip?code=')) {
        return Promise.resolve({ json: async () => JSON.parse(JSON.stringify({ tripData: freshTripData })) });
      }
      if (String(url).includes('/api/reoptimize')) {
        return new Promise((resolve, reject) => {
          world.post = { body: JSON.parse(init.body), resolve, reject };
          if (init && init.signal && typeof init.signal.addEventListener === 'function') {
            init.signal.addEventListener('abort', () => {
              const e = new Error('The operation was aborted.');
              e.name = 'AbortError';
              reject(e);
            });
          }
        });
      }
      return Promise.reject(new Error('unexpected fetch: ' + url));
    },
  };
  world.sandbox = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PARSE_SRC + '\n' + KICKER_SRC + '\n' + REWORK_SRC, sandbox);
  return world;
}

function spikeItem() {
  return {
    cls: 'ride-update', type: 'spike', tag: 'tpcp-wait-spike',
    title: 'Wait spike on your plan', body: 'Matterhorn Bobsleds just jumped to ~45 min.',
    ymd: '2026-10-22', rework: true, state: undefined,
  };
}
async function startRun(world, item) {
  world.sandbox._tpcpAlertCurrent = item;
  world.post = null;
  const p = world.sandbox.tpcpReworkRun(item);
  // The run awaits the fresh trip fetch (plus its json()) and
  // ensureApiKey before it POSTs; wait on macrotasks, which drain the
  // whole microtask queue each round, until the POST is in flight.
  for (let i = 0; i < 100 && !world.post; i++) await new Promise((r) => setImmediate(r));
  assert.ok(world.post, 'reoptimize POST was issued');
  // Wrap the run promise: returning it bare from this async function
  // would make callers' await adopt it -- and the run can only settle
  // after the caller resolves the POST. Deadlock by promise adoption.
  return { runPromise: p };
}
function resolvePost(world) {
  world.post.resolve({
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => ({ sections: [{ title: 'Disneyland', entries: JSON.parse(JSON.stringify(PLAN_ENTRIES)) }], explanation: 'Reworked around the spike.', changed: true, changeCount: 1 }),
  });
}

test('fresh run: the rework payload is built from a fresh trip fetch, not the stale snapshot', async () => {
  const world = makeWorld();
  const item = spikeItem();
  const { runPromise: p } = await startRun(world, item);
  // the trip GET must precede the reoptimize POST
  const getIdx = world.calls.findIndex((u) => u.includes('/api/trip?code='));
  const postIdx = world.calls.findIndex((u) => u.includes('/api/reoptimize'));
  assert.ok(getIdx !== -1 && postIdx !== -1 && getIdx < postIdx, 'fresh fetch precedes the POST');
  const sent = JSON.stringify(world.post.body.scheduleItems);
  assert.ok(sent.includes('FRESH-FETCH'), 'payload carries the freshly fetched day');
  assert.ok(!sent.includes('STALE-SNAPSHOT'), 'payload must not carry the stale snapshot');
  resolvePost(world);
  await p;
  assert.equal(item.state, 'rework-result');
  assert.equal(world.els.tpcpAlertPrimary.textContent, 'Accept');
  assert.equal(world.saveCustomCalls, 0, 'nothing is written before Accept');
});

test('interruption: backgrounding mid-flight restores the alert prompt with honest copy', async () => {
  const world = makeWorld();
  const item = spikeItem();
  const { runPromise: p } = await startRun(world, item);
  world.document.hidden = true;
  world.document._fire('visibilitychange');
  world.post.reject(new TypeError('Load failed'));
  await p;
  assert.equal(item.state, 'rework-interrupted');
  assert.equal(world.els.tpcpAlertTitle.textContent, 'Wait spike on your plan');
  assert.ok(world.els.tpcpAlertBody.textContent.includes('Rework interrupted \u2014 tap to try again'), 'interrupted copy shown');
  assert.ok(!world.els.tpcpAlertBody.textContent.includes('could not reach'), 'no false reachability claim');
  assert.equal(world.els.tpcpAlertPrimary.textContent, 'Rework my morning');
  assert.equal(world.els.tpcpAlertPrimary.disabled, false);
  // the affordance is live: tapping again re-runs and can complete
  world.document.hidden = false;
  const { runPromise: p2 } = await startRun(world, item);
  resolvePost(world);
  await p2;
  assert.equal(item.state, 'rework-result');
});

test('interruption: a client-side abort (not the run timeout) is classified as interrupted', async () => {
  const world = makeWorld();
  const item = spikeItem();
  const { runPromise: p } = await startRun(world, item);
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  world.post.reject(e);
  await p;
  assert.equal(item.state, 'rework-interrupted');
  assert.ok(world.els.tpcpAlertBody.textContent.includes('Rework interrupted \u2014 tap to try again'));
  assert.ok(!world.els.tpcpAlertBody.textContent.includes('could not reach'));
});

test('genuine network failure keeps the reachability copy (no interruption signal)', async () => {
  const world = makeWorld();
  const item = spikeItem();
  const { runPromise: p } = await startRun(world, item);
  world.post.reject(new TypeError('Load failed'));
  await p;
  assert.equal(item.state, 'rework-error');
  assert.equal(world.els.tpcpAlertTitle.textContent, 'Could not rework just now');
  assert.ok(world.els.tpcpAlertBody.textContent.includes('I could not reach the optimizer'));
});

test("the run's own 65s timeout keeps the took-longer copy (not classified as interruption)", async () => {
  const world = makeWorld();
  const item = spikeItem();
  const { runPromise: p } = await startRun(world, item);
  const t65 = [...world.timers.values()].find((t) => t.ms === 65000);
  assert.ok(t65, 'run timeout was armed');
  t65.fn(); // fires _run.timedOut = true; controller.abort() -> the stub rejects with AbortError
  await p;
  assert.equal(item.state, 'rework-error');
  assert.ok(world.els.tpcpAlertBody.textContent.includes('took longer than expected'));
  assert.ok(!world.els.tpcpAlertBody.textContent.includes('interrupted'));
});
