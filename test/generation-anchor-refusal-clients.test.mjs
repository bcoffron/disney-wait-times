// Tests for the client behavior on a generation ANCHOR_VIOLATION
// refusal (anchor fix lane part 8, Nov 4, 2026 -- Claude anchor-lane
// ruling, hardening point 3).
//
// THE TRACE (at pre-part-8 main 13429785; the build log carries the
// full version). The server refusal is HTTP 502 from
// api/generateschedule.js -- { ok:false, code:'ANCHOR_VIOLATION',
// anchorConflicts:[...], error:'The rebuilt day would drop or move a
// locked booking (<names>) -- your saved day was kept.' } -- the
// names ARE in the payload. Neither client read them:
//
//   app.html -- generateFromSetup (fetch at :7621) passed the error
//   string to its callback as 'AI error: ...', and BOTH callers threw
//   it away for generic copy: generateAllDays (:7939) toasted 'Day N
//   hit a snag -- tap AI Optimize to retry', and tpcpToggleLLMP
//   (:6473) toasted 'Day N could not be rebuilt -- nothing changed.'
//   No automatic retry loop exists in app.html (failures halt the
//   driver for a manual re-tap) -- compliant on (b), short on (a).
//   (Settings -> Regenerate, app.html:6775, leaves for pretrip.html
//   entirely -- the pretrip path below is Beau's acceptance path.)
//
//   pretrip.html -- ptGenerateDaySchedule (:1979) treated the refusal
//   like any failure: its !d.ok branch retried up to 3 times, FOUR
//   full generations against a deterministic refusal, then called
//   back 'Failed after 3 retries: ...'. The driver (_genDaySeq
//   ._attempt, :2679) only console.error'd that string and parked the
//   day via _parkFailed -> ptSetGenLine (:1846) as 'Day N -- couldn't
//   build' + retry/skip buttons. Short on BOTH (a) and (b).
//
// THE FIX (smallest changes, existing channels only):
//   pretrip: ptGenerateDaySchedule short-circuits d.code ===
//   'ANCHOR_VIOLATION' BEFORE the retry branch -- no retry, immediate
//   callback('ANCHOR_VIOLATION: ' + server message). The driver
//   unwraps the marker and hands the message to _parkFailed, which
//   passes it to ptSetGenLine as a detail line rendered (as text)
//   under the failed day line; the retry/skip buttons stay (a manual
//   re-tap is the guest's choice, and Continue is the productive
//   path -- the carry-forward guard protects the stored day).
//   app.html: generateFromSetup marker-prefixes the refusal into its
//   callback error the same way; both callers surface it via
//   tpcpAnchorRefusalMsg in their existing toast instead of the
//   generic copy.
//
// CASES: pretrip generation is driven BEHAVIORALLY in a vm (the real
// extracted function): (a) the refusal costs exactly ONE fetch and
// the callback carries the named message; (b) a generic failure
// still retries (4 fetches, 'Failed after 3 retries') -- the pin
// that only the refusal was excluded. ptSetGenLine is driven in a vm
// for the detail line (c). app.html's generateFromSetup is driven in
// a vm (d): marker-prefixed refusal, generic error unchanged, one
// fetch either way (no retry loop exists to exclude). The two app
// callers' branches are pinned statically (e), as is the pretrip
// wiring order (the ANCHOR_VIOLATION check precedes the retry
// branch) (f).
//
// Negative controls (against 13429785): (a) FAILS (4 fetches, the
// 'Failed after 3 retries' callback), (c) FAILS (no detail line),
// (d)'s refusal case FAILS (the callback is the unmarked 'AI error:
// ...'), (e) and (f) FAIL (no marker wiring exists). (b) and (d)'s
// generic case pass on both trees by design.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/generation-anchor-refusal-clients.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const pretripSrc = readFileSync(new URL('../pretrip.html', import.meta.url), 'utf8');
const appSrc = readFileSync(new URL('../app.html', import.meta.url), 'utf8');

function sliceRange(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  assert.ok(s !== -1, 'range start not found: ' + startMarker);
  const e = src.indexOf(endMarker, s + startMarker.length);
  assert.ok(e !== -1, 'range end not found: ' + endMarker);
  return src.slice(s, e);
}

const REFUSAL_MSG = 'The rebuilt day would drop or move a locked booking (Space Mountain) -- your saved day was kept.';
const REFUSAL_BODY = { ok: false, code: 'ANCHOR_VIOLATION', error: REFUSAL_MSG, anchorConflicts: [{ kind: 'held-return-missing', name: 'Space Mountain' }] };

const quietConsole = { log() {}, warn() {}, error() {} };
function memStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const flush = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };

// ------------------------------------------------------- pretrip driver
const GEN_SRC = sliceRange(pretripSrc, 'function ptGenerateDaySchedule', '// -- Finish / final step CTA');
const PT_CFG = {
  tripName: 'Refusal fixture',
  days: [{ date: 'Dec 8, 2026', park: 'Disneyland', hasLL: true, hasLLMP: true, hasILL: false, illRides: '' }],
  ridePreferences: { mustDo: [], skip: [] },
  reservations: [], heldReturns: [], characters: [],
  dining: { reservations: [] },
  groupProfile: { size: 2, dietary: [] },
};

async function drivePretrip(respBody, status) {
  let fetches = 0;
  const timers = [];
  const ctx = {
    console: quietConsole, JSON, Math, Promise, Error,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    AbortController,
    window: {},
    localStorage: memStorage({ tpcp_code: 'TESTP8' }),
    SYNC_BASE: 'https://app.themeparkcopilot.com',
    tpcpDeviceToken: () => 'tok',
    fetch: () => { fetches++; return Promise.resolve({ status, json: async () => JSON.parse(JSON.stringify(respBody)) }); },
  };
  vm.createContext(ctx);
  vm.runInContext(GEN_SRC, ctx);
  let cbErr = '__unset__';
  ctx.ptGenerateDaySchedule(JSON.parse(JSON.stringify(PT_CFG)), 0, 0, (err) => { cbErr = err; });
  for (let round = 0; round < 16 && cbErr === '__unset__'; round++) {
    await flush();
    // Fire only the retry timers (2-3s); the 240s abort timer stays.
    for (let i = timers.length - 1; i >= 0; i--) {
      if (timers[i].ms <= 10000) { const t = timers.splice(i, 1)[0]; t.fn(); }
    }
    await flush();
  }
  return { fetches, cbErr };
}

test('(a) pretrip: an ANCHOR_VIOLATION refusal is NOT retried and the callback carries the named message', async () => {
  const { fetches, cbErr } = await drivePretrip(REFUSAL_BODY, 502);
  assert.equal(fetches, 1, 'exactly one generation attempt: the deterministic refusal is excluded from the retry loop');
  assert.equal(cbErr, 'ANCHOR_VIOLATION: ' + REFUSAL_MSG, 'the callback carries the marker + the server message naming the booking');
});

test('(b) pretrip: a generic generation failure still retries (pin -- only the refusal was excluded)', async () => {
  const { fetches, cbErr } = await drivePretrip({ ok: false, code: 'GENERATION_FAILED', error: 'boom' }, 502);
  assert.equal(fetches, 4, 'a generic failure still gets its 3 retries');
  assert.equal(cbErr, 'Failed after 3 retries: boom');
});

// ------------------------------------------------------- pretrip line
test('(c) pretrip: ptSetGenLine renders the refusal detail under the failed line', () => {
  const LINE_SRC = sliceRange(pretripSrc, 'function ptSetGenLine', 'function gpLabelText');
  const lineEl = {
    className: '', innerHTML: '', children: [],
    appendChild(c) { this.children.push(c); },
  };
  const ctx = {
    console: quietConsole, JSON,
    document: {
      getElementById: (id) => (id === 'ptGenDay0' ? lineEl : null),
      createElement: () => ({ className: '', textContent: '', children: [], appendChild(c) { this.children.push(c); } }),
    },
    ptSyncGenProgress: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(LINE_SRC, ctx);
  ctx.ptSetGenLine(0, 'failed', true, REFUSAL_MSG);
  assert.ok(lineEl.innerHTML.includes("couldn't build"), 'the failed line still renders its standard copy');
  assert.ok(lineEl.innerHTML.includes('Tap to retry'), 'the manual retry affordance stays');
  assert.equal(lineEl.children.length, 1, 'exactly one detail element is appended');
  assert.equal(lineEl.children[0].className, 'pt-gen-detail');
  assert.equal(lineEl.children[0].textContent, REFUSAL_MSG, 'the detail is the server message verbatim, as text');
});

// ------------------------------------------------------- app generator
const GFS_SRC = sliceRange(appSrc, 'function generateFromSetup(params, callback)', '// -- Generation progress');

async function driveApp(respBody) {
  let fetches = 0;
  const ctx = {
    console: quietConsole, JSON, Math, Promise, Error,
    window: {},
    localStorage: memStorage({ tpcp_code: 'TESTP8' }),
    parkIntelCache: null, eventsIntelCache: null, parkHoursCache: null,
    TRIP_CONFIG: {}, _loadedTripData: null,
    tpcpDeviceToken: () => 'tok',
    SYNC_BASE: 'https://app.themeparkcopilot.com',
    showToast: () => {},
    fetch: () => { fetches++; return Promise.resolve({ json: async () => JSON.parse(JSON.stringify(respBody)) }); },
  };
  vm.createContext(ctx);
  vm.runInContext(GFS_SRC, ctx);
  let cbErr = '__unset__';
  ctx.generateFromSetup(0, (err) => { cbErr = err; });
  for (let round = 0; round < 8 && cbErr === '__unset__'; round++) await flush();
  return { fetches, cbErr };
}

test('(d) app: generateFromSetup marker-prefixes the refusal (and only the refusal)', async () => {
  const refusal = await driveApp(REFUSAL_BODY);
  assert.equal(refusal.fetches, 1, 'one fetch: no retry loop exists on this path');
  assert.equal(refusal.cbErr, 'ANCHOR_VIOLATION: ' + REFUSAL_MSG, 'the callback error carries the marker + named message for the callers to surface');
  const generic = await driveApp({ ok: false, error: 'boom' });
  assert.equal(generic.cbErr, 'AI error: boom', 'a generic failure keeps its existing error shape (pin: passes on both trees)');
});

// ------------------------------------------------------- static wiring
test('(e) app: both generateFromSetup callers surface the refusal message via tpcpAnchorRefusalMsg', () => {
  assert.ok(appSrc.includes('function tpcpAnchorRefusalMsg(err)'), 'the unwrap helper exists');
  const allDays = sliceRange(appSrc, 'function generateAllDays()', 'function aiChooseRides');
  assert.ok(allDays.includes('tpcpAnchorRefusalMsg(err)'), 'generateAllDays surfaces the named refusal in its toast instead of the generic snag copy');
  const toggle = sliceRange(appSrc, 'function tpcpToggleLLMP', 'function renderLLReceiptBlock');
  assert.ok(toggle.includes('tpcpAnchorRefusalMsg(err)'), 'tpcpToggleLLMP surfaces the named refusal in its toast instead of the generic rebuild copy');
});

test('(f) pretrip: the refusal check precedes the retry branch, and the driver unwraps the marker', () => {
  const iAnchor = GEN_SRC.indexOf("d.code === 'ANCHOR_VIOLATION'");
  const iRetry = GEN_SRC.indexOf('if (retries < 3)');
  assert.ok(iAnchor !== -1, 'ptGenerateDaySchedule tests the refusal code');
  assert.ok(iRetry !== -1 && iAnchor < iRetry, 'the refusal short-circuits BEFORE the retry branch');
  assert.ok(pretripSrc.includes("err.indexOf('ANCHOR_VIOLATION: ') === 0") && pretripSrc.includes('_parkFailed((typeof err'), 'the _genDaySeq driver unwraps the marker into _parkFailed');
  assert.ok(pretripSrc.includes('function ptSetGenLine(idx, state, canRetry, detail)'), 'ptSetGenLine takes the detail parameter');
});
