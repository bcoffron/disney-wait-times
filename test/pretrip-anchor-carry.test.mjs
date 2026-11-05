// Pretrip anchor carry suite (anchor fix lane part 5, Nov 4, 2026).
//
// The defect (trace: ~/workspace/tpcp-cost-fixes/anchor-fix/
// pretrip-trace.md, at main f517d0b9): part 1 taught the server to seat
// held LL returns, but only when the client SENDS them -- and pretrip,
// the Settings -> Regenerate path Beau's device acceptance uses, never
// did, in two places:
//
//   1. GENERATION: ptGenerateDaySchedule's scaffold body is an explicit
//      field pick that carried reservations twice and heldReturns zero
//      times, so no held anchor was ever seated on this path.
//   2. SAVES: ptFinish builds tripConfig as a fresh literal from form
//      fields. It had no heldReturns key and no vipWindow key, and BOTH
//      pretrip saves POST that literal (the early write in
//      ptFinishAfterHours, before generation starts, and the terminal
//      save in _saveDays), so a rebuild ERASED the stored records --
//      permanently, and before the first day generated.
//
// The in-app path (app.html generateFromSetup) forwards the stored
// config whole and was never broken; it is untouched by this part.
//
// Part 5's fix is preservation, because pretrip has no UI to view or
// edit either field: ptRestoreFromConfig captures the loaded config's
// heldReturns / vipWindow (ptCaptureLoadedAnchors), ptFinish writes
// them into its literal verbatim (keys added only when the loaded trip
// actually has them), and the generation pick forwards
// tripConfig.heldReturns whole -- per-day filtering stays the server's
// job (planHeldReturnAnchors skips records whose day is not the day
// being generated), exactly as generateFromSetup's pass-through relies
// on. _genDaySeq's Object.assign already forwards every other key of
// the finish config into each day's generation config, so the literal
// is the only save-side change needed.
//
// The suite extracts pretrip's REAL code (the capture block,
// ptGenerateDaySchedule, and the whole finish range) and drives it in
// a vm with browser stubs -- the part-3 pattern -- then feeds the
// captured generation payload to the REAL /api/generateschedule
// handler (part 1's stubFill harness) and checks the anchor seats.
// On pre-part-5 main, (a) fails because the payload carries no
// heldReturns at all and (b) fails because both saves carry a config
// the records were erased from -- the negative controls, run and
// recorded in the lane's build log.
//
//   node --test test/pretrip-anchor-carry.test.mjs
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ------------------------------------------------------------ generator harness (part 1's)
const blobStubSrc = [
  'export async function list({ prefix } = {}) {',
  '  const table = globalThis.__anchorBlobTable || {};',
  '  if (prefix && Object.prototype.hasOwnProperty.call(table, prefix)) {',
  "    return { blobs: [{ url: 'https://blob.test/' + prefix, downloadUrl: 'https://blob.test/' + prefix, pathname: prefix, uploadedAt: '2026-11-01T00:00:00.000Z' }] };",
  '  }',
  '  return { blobs: [] };',
  '}',
  'export async function put() { throw new Error("put not stubbed"); }',
  'export async function del() {}',
].join('\n');

const hooksSrc = [
  'let stubUrl = "";',
  'export async function initialize(data) { stubUrl = data.blob; }',
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === '@vercel/blob') return { url: stubUrl, shortCircuit: true };",
  '  return nextResolve(specifier, context);',
  '}',
].join('\n');

register('data:text/javascript;base64,' + Buffer.from(hooksSrc).toString('base64'), {
  data: { blob: 'data:text/javascript;base64,' + Buffer.from(blobStubSrc).toString('base64') },
});

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.ADMIN_KEY = 'suite-admin-key-never-sent';

const DL = 'Disneyland', DCA = 'Disney California Adventure';
const RIDE = (name, park, land, peak, rope, ll) => ({ name, park, land, typicalPeakWait: peak, ropeDropValue: rope || '', llKind: ll || '' });
const CATALOG = {
  attractions: [
    RIDE('Space Mountain', DL, 'Tomorrowland', 75, 'high', 'multi'),
    RIDE('Indiana Jones Adventure', DL, 'Adventureland', 70, 'high', 'multi'),
    RIDE('Star Wars: Rise of the Resistance', DL, "Star Wars: Galaxy's Edge", 100, 'high', 'single'),
    RIDE('Big Thunder Mountain Railroad', DL, 'Frontierland', 55, '', 'multi'),
    RIDE('Pirates of the Caribbean', DL, 'New Orleans Square', 40, '', 'none'),
    RIDE('Haunted Mansion', DL, 'New Orleans Square', 45, '', 'multi'),
    RIDE('Jungle Cruise', DL, 'Adventureland', 35, '', 'none'),
    RIDE('Matterhorn Bobsleds', DL, 'Fantasyland', 50, '', 'multi'),
    RIDE('Millennium Falcon: Smugglers Run', DL, "Star Wars: Galaxy's Edge", 60, '', 'multi'),
    RIDE("Mickey & Minnie's Runaway Railway", DL, "Mickey's Toontown", 55, '', 'multi'),
    RIDE('Buzz Lightyear Astro Blasters', DL, 'Tomorrowland', 30, '', 'multi'),
    RIDE('Star Tours', DL, 'Tomorrowland', 35, '', 'multi'),
    RIDE("Peter Pan's Flight", DL, 'Fantasyland', 45, '', 'none'),
    RIDE('Mad Tea Party', DL, 'Fantasyland', 25, '', 'none'),
    RIDE('Autopia', DL, 'Tomorrowland', 30, '', 'none'),
    RIDE('Finding Nemo Submarine Voyage', DL, 'Tomorrowland', 40, '', 'none'),
    RIDE("Mr. Toad's Wild Ride", DL, 'Fantasyland', 25, '', 'none'),
    RIDE("Snow White's Enchanted Wish", DL, 'Fantasyland', 20, '', 'none'),
    RIDE("Roger Rabbit's Car Toon Spin", DL, "Mickey's Toontown", 30, '', 'multi'),
    RIDE('The Many Adventures of Winnie the Pooh', DL, 'Critter Country', 20, '', 'none'),
    RIDE('Radiator Springs Racers', DCA, 'Cars Land', 95, 'high', 'single'),
    RIDE('Incredicoaster', DCA, 'Pixar Pier', 50, '', 'multi'),
    RIDE("Soarin' Around the World", DCA, 'Grizzly Peak', 45, '', 'multi'),
    RIDE('Guardians of the Galaxy - Mission: BREAKOUT!', DCA, 'Avengers Campus', 70, 'high', 'multi'),
  ],
  venues: [
    { name: 'Blue Bayou Restaurant', park: DL, land: 'New Orleans Square', service: 'table', reservationPolicy: 'required' },
    { name: 'Bengal Barbecue', park: DL, land: 'Adventureland', service: 'quickservice', reservationPolicy: 'walkup' },
    { name: 'Jolly Holiday Bakery Cafe', park: DL, land: 'Main Street, U.S.A.', service: 'quickservice', reservationPolicy: 'walkup' },
    { name: 'Galactic Grill', park: DL, land: 'Tomorrowland', service: 'quickservice', reservationPolicy: 'walkup' },
    { name: 'Red Rose Taverne', park: DL, land: 'Fantasyland', service: 'quickservice', reservationPolicy: 'walkup' },
    { name: 'Hungry Bear Restaurant', park: DL, land: 'Critter Country', service: 'quickservice', reservationPolicy: 'walkup' },
    { name: 'Harbour Galley', park: DL, land: 'New Orleans Square', service: 'quickservice', reservationPolicy: 'walkup' },
  ],
};

globalThis.__anchorBlobTable = {
  'twize/trip_registry.json': {
    BEAU01: { tripId: 'beau01-anchor-suite', role: 'admin', status: 'active' },
  },
  'twize/park_intel_dl_stable.json': {
    data: {
      sections: {
        LAND_MAP: 'Tomorrowland in Disneyland; Cars Land in Disney California Adventure.',
        WAIT_PATTERNS: '{}',
        ROPE_DROP_STRATEGY: 'rope drop strategy',
        LIGHTNING_LANE_STRATEGY: 'lightning lane strategy',
        DINING_TIMING: 'dining timing',
        CROWD_FLOW: 'crowd flow',
        PARK_HOP_STRATEGY: 'park hop strategy',
        SHOW_AND_ENTERTAINMENT: 'shows and entertainment',
        CATALOG,
      },
    },
  },
  'twize/park_intel_dl_dynamic.json': {
    data: {
      sections: {
        CURRENT_CLOSURES: 'All attractions operating today.',
        CLOSURES: [],
        DINING_CLOSURES: [],
        SHOWS: { shows: [] },
      },
    },
  },
  'twize/dining_intel_dl.json': { data: 'Verified dining list.' },
  'twize/park_hours_intel.json': {
    data: { '2026-12-07': { dl: { open: '08:00', close: '24:00' }, dca: { open: '08:00', close: '22:00' } } },
  },
};

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://blob.test/')) {
    const key = decodeURIComponent(u.slice('https://blob.test/'.length));
    const payload = globalThis.__anchorBlobTable[key];
    return { ok: !!payload, json: async () => payload };
  }
  throw new Error('unexpected fetch (stubFill must never call out): ' + u);
};
console.log = () => {};
console.warn = () => {};
// console.error stays live, as in part 1's suite.

const genMod = await import('../api/generateschedule.js');
const handler = genMod.default;
const scaffold = await import('../api/scaffold.js');

// ------------------------------------------------------------ pretrip extraction
const pretripHtml = readFileSync(new URL('../pretrip.html', import.meta.url), 'utf8');

function sliceRange(startMarker, endMarker) {
  const s = pretripHtml.indexOf(startMarker);
  assert.ok(s !== -1, 'range start not found: ' + startMarker);
  const e = pretripHtml.indexOf(endMarker, s + startMarker.length);
  assert.ok(e > s, 'range end not found: ' + endMarker);
  return pretripHtml.slice(s, e);
}
function trySlice(startMarker, endMarker) {
  const s = pretripHtml.indexOf(startMarker);
  if (s === -1) return '';
  const e = pretripHtml.indexOf(endMarker, s + startMarker.length);
  return e > s ? pretripHtml.slice(s, e) : '';
}
// The capture block exists only on the fixed tree. On the pre-fix tree
// its absence IS the defect, so it is sliced tolerantly and the worlds
// below call it only when it exists -- the (a)/(b) failures on the old
// tree are then behavioral (records absent / erased), not load errors.
const CAPTURE_SRC = trySlice('// -- Anchor carry-forward state', '// -- Load from storage');
const GEN_SRC = sliceRange('function ptGenerateDaySchedule', '// -- Finish / final step CTA');
const FINISH_SRC = sliceRange('function ptFinish() {', '</script>');

// ------------------------------------------------------------ fixtures
const SM = 'Space Mountain';
// The record layer's shape (app.html): 0-based day, rideKey, ride,
// returnStart/returnEnd clock strings. The server planner reads exactly
// day / ride / returnStart / returnEnd.
const HELD_REC = {
  day: 0, rideKey: 'space mountain', ride: SM,
  returnStart: '2:00 PM', returnEnd: '3:00 PM',
  bookedAt: '2026-11-01T00:00:00.000Z', standbyAtConfirm: 60, conflict: '',
};
// No current writer emits a top-level vipWindow (VIP lives in days[]
// isVip/vipStart/vipEnd); the carry is shape-agnostic preservation of
// whatever a stored config holds, so the fixture value is arbitrary.
const VIP_WINDOW = { start: '10:00 AM', end: '2:00 PM' };
const LOADED_WITH = { tripName: 'Anchor Carry Trip', heldReturns: [HELD_REC], vipWindow: VIP_WINDOW };
const LOADED_BARE = { tripName: 'Anchor Carry Trip' };

// What ptCollectData returns for the same trip (form state only -- by
// construction it can never contain the records; that is the defect).
const COLLECTED = {
  tripName: 'Anchor Carry Trip',
  dates: { start: '2026-12-07', end: '2026-12-07' },
  location: 'Disneyland',
  thrillLevel: 'Mix of everything',
  mustDo: [], neverSchedule: [], avoidWater: false,
  activeCats: [], accessibility: [], dietaryNeeds: [],
  showPreferences: { want: [], skip: [] },
  diningRecs: '', wantedRestaurants: '',
  days: [{ park: 'Disneyland', date: '2026-12-07', hopTo: null, hasLL: true, hasLLMP: true, hasILL: true, illRides: '', isVip: false, intent: '' }],
  reservations: ['Blue Bayou, 6:00 PM, Day 1'],
  diningReservations: [{ name: 'Blue Bayou', time: '6:00 PM', day: 1 }],
  minHeight: 'over48',
  characters: { categories: [], priority: 'niceToHave' },
  party: { size: 2, adults: 2, children: 0 },
};

// ------------------------------------------------------------ client worlds
function memStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

function clientFetch(world, url, opts) {
  const u = String(url);
  if (u.includes('/api/generateschedule')) {
    world.genBodies.push(JSON.parse(opts.body));
    return Promise.resolve({ status: 200, json: async () => ({ ok: true, text: '[]', parsed: [{ t: '8:00 AM', h: 'Park Entry', type: 'tip', n: '' }] }) });
  }
  if (u.includes('/api/cache')) {
    return Promise.resolve({ status: 200, json: async () => ({ data: {} }) });
  }
  if (u.includes('/api/trip')) {
    if (opts && opts.method === 'POST') {
      world.tripPosts.push(JSON.parse(opts.body));
      return Promise.resolve({ status: 200, json: async () => ({ ok: true }) });
    }
    return Promise.resolve({ status: 200, json: async () => ({ tripData: { tripConfig: { schedule: { days: [] } } } }) });
  }
  return Promise.reject(new Error('unexpected client fetch: ' + u));
}

// A pretrip page world. With `realGenerator`, the shipped
// ptGenerateDaySchedule is in scope (its fetch is the stub router, so
// the request BODY it builds is what gets judged); without it, the
// generator is a stub that records the day config _genDaySeq hands it.
function makeWorld({ realGenerator }) {
  const world = { genBodies: [], tripPosts: [], genCfgs: [], alerts: [], exited: false };
  const ctx = {
    console, Date, Intl, JSON, Math, Object, Array, Promise, Error, RegExp, String, Number, Boolean,
    setTimeout, clearTimeout, AbortController, URLSearchParams,
    window: {},
    document: { getElementById: () => null, querySelectorAll: () => [] },
    localStorage: memStorage({ tpcp_code: 'TESTP5' }),
    SYNC_BASE: 'https://app.themeparkcopilot.com',
    fetch: (url, opts) => clientFetch(world, url, opts),
    alert: (m) => { world.alerts.push(String(m)); },
    ptSaveCurrentStep: () => {},
    ptCollectData: () => JSON.parse(JSON.stringify(COLLECTED)),
    ptShowGenerating: () => {},
    ptSetGenLine: () => {},
    ptUpdateGenBar: () => {},
    ptFinishExit: () => { world.exited = true; },
    ptHomeUrl: () => '/',
    // The completeness validator is a separate shipped component with
    // its own coverage; it is not this suite's subject.
    tpcpDayIsComplete: () => true,
  };
  if (!realGenerator) {
    ctx.ptGenerateDaySchedule = (cfg, idx, rc, cb) => {
      world.genCfgs.push(cfg);
      cb(null, [{ t: '8:00 AM', h: 'Park Entry', type: 'tip', n: '' }], null);
    };
  }
  vm.createContext(ctx);
  const src = [CAPTURE_SRC, realGenerator ? GEN_SRC : '', FINISH_SRC].filter(Boolean).join('\n');
  vm.runInContext(src, ctx);
  world.ctx = ctx;
  // The restore seam: on the fixed tree this is ptCaptureLoadedAnchors;
  // on the pre-fix tree there is nowhere for the records to land, which
  // is precisely what the negative control demonstrates.
  world.capture = (cfg) => {
    if (typeof ctx.ptCaptureLoadedAnchors === 'function') ctx.ptCaptureLoadedAnchors(cfg);
  };
  return world;
}

async function runFinish(world, loadedCfg) {
  world.capture(JSON.parse(JSON.stringify(loadedCfg)));
  world.ctx.ptFinish();
  for (let i = 0; i < 100 && !world.exited; i++) await new Promise(r => setTimeout(r, 0));
  assert.ok(world.exited, 'ptFinish ran to its exit (both saves settled)');
}

// ------------------------------------------------------------ (a) generation carries the records
test('(a) the generation request built by pretrip\'s real pick carries the loaded held returns', async () => {
  const w = makeWorld({ realGenerator: true });
  await runFinish(w, LOADED_WITH);
  assert.equal(w.genBodies.length, 1, 'exactly one day was generated');
  const sent = w.genBodies[0].tripConfig;
  assert.ok(sent, 'the request carries a tripConfig');
  assert.deepEqual(sent.heldReturns, [HELD_REC],
    'the whole trip record set rides the payload, unfiltered (per-day filtering is the server\'s job)');
  // The pick's pre-existing reservation carriage is undisturbed.
  assert.deepEqual(sent.dining.reservations, [{ name: 'Blue Bayou', time: '6:00 PM', day: 1, isConfirmed: true }],
    'the day\'s structured reservation rows still ride the pick');
});

test('(a2) that payload, fed to the real generator, seats the anchor at its window', async () => {
  const w = makeWorld({ realGenerator: true });
  await runFinish(w, LOADED_WITH);
  const sent = w.genBodies[0];
  const req = {
    method: 'POST', url: '/api/generateschedule',
    headers: { 'x-forwarded-for': '10.5.0.1', 'content-length': '0' },
    body: {
      prompt: sent.prompt, scaffold: true, stubFill: true,
      dayIndex: 0, mode: 'setup', maxTokens: 8000, tripCode: 'BEAU01',
      tripConfig: sent.tripConfig,
    },
  };
  const res = {
    code: null, payload: null,
    setHeader() {},
    status(c) { this.code = c; return this; },
    json(o) { this.payload = o; return this; },
    end() {},
  };
  await handler(req, res);
  assert.equal(res.code, 200, 'generation succeeds on the pretrip-built payload');
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.scaffold, true);
  const cards = (res.payload.parsed || []).filter(c => c && c.type === 'ride' && scaffold.normName(c.ride || c.h) === scaffold.normName(SM));
  assert.equal(cards.length, 1, 'the held ride appears exactly once');
  assert.equal(cards[0].t, '2:00 PM', 'it sits at the held window start');
  assert.equal(cards[0].anchor, true, 'the seated card is an anchor');
  assert.equal(cards[0].heldReturn, true, 'the seated card is the held return');
  assert.deepEqual((res.payload.heldAnchors || []).map(a => a.name), [SM], 'the response names the seated held anchor');
});

// ------------------------------------------------------------ (b) both saves carry the records
test('(b) ptFinish carries heldReturns and vipWindow into BOTH saves, byte-identical', async () => {
  const w = makeWorld({ realGenerator: false });
  await runFinish(w, LOADED_WITH);
  assert.equal(w.tripPosts.length, 2, 'the early write and the terminal save both POSTed');
  const wantHeld = JSON.stringify(LOADED_WITH.heldReturns);
  const wantVip = JSON.stringify(LOADED_WITH.vipWindow);
  for (const [label, post] of [['early write', w.tripPosts[0]], ['terminal save', w.tripPosts[1]]]) {
    const cfg = post.tripData.tripConfig;
    assert.equal(JSON.stringify(cfg.heldReturns), wantHeld, label + ': heldReturns survive byte-identical');
    assert.equal(JSON.stringify(cfg.vipWindow), wantVip, label + ': vipWindow survives byte-identical');
  }
  const term = w.tripPosts[1].tripData.tripConfig;
  assert.ok(term.schedule && Array.isArray(term.schedule.days), 'the terminal save is the config+schedule write');
  // Reservation handling is untouched by the carry: the Dining slide's
  // structured rows and the flat mirror come out exactly as before.
  assert.deepEqual(term.dining.reservations, [{ name: 'Blue Bayou', time: '6:00 PM', day: 1, isConfirmed: true }],
    'structured reservation rows unchanged');
  assert.deepEqual(term.reservations, ['Blue Bayou, 6:00 PM, Day 1'], 'flat reservation mirror unchanged');
  // The generation chain inherits the records from the same literal:
  // _genDaySeq hands each day's config (an Object.assign of the finish
  // config) to the generator.
  assert.equal(w.genCfgs.length, 1, 'one day generation was attempted');
  assert.equal(JSON.stringify(w.genCfgs[0].heldReturns), wantHeld, 'the day generation config carries the records');
});

// ------------------------------------------------------------ (c) no phantom records
test('(c) a loaded config with no held returns produces no phantom records anywhere', async () => {
  const wb = makeWorld({ realGenerator: false });
  await runFinish(wb, LOADED_BARE);
  assert.equal(wb.tripPosts.length, 2, 'both saves POSTed');
  for (const post of wb.tripPosts) {
    const cfg = post.tripData.tripConfig;
    assert.ok(!('heldReturns' in cfg), 'the saved literal gains no heldReturns key');
    assert.ok(!('vipWindow' in cfg), 'the saved literal gains no vipWindow key');
  }
  const wa = makeWorld({ realGenerator: true });
  await runFinish(wa, LOADED_BARE);
  assert.equal(wa.genBodies.length, 1, 'one day was generated');
  assert.deepEqual(wa.genBodies[0].tripConfig.heldReturns, [],
    'the generation payload carries zero records (the pick\'s empty default, as with reservations)');
});

// ------------------------------------------------------------ (d) static pins
test('(d) static pins: restore captures, the literal carries, the pick forwards', () => {
  assert.ok(CAPTURE_SRC.includes('var ptLoadedAnchors = null;'), 'the carry state exists');
  assert.ok(CAPTURE_SRC.includes('function ptCaptureLoadedAnchors(cfg)'), 'the capture function exists');
  const restore = sliceRange('function ptRestoreFromConfig', 'function ptRestoreParty');
  assert.ok(restore.includes('ptCaptureLoadedAnchors(cfg);'), 'ptRestoreFromConfig captures from the loaded config');
  const literal = sliceRange('function ptFinish() {', '// Populate tripConfig.parkHours');
  assert.ok(literal.includes('tripConfig.heldReturns = ptLoadedAnchors.heldReturns;'), 'ptFinish writes heldReturns into its literal');
  assert.ok(literal.includes('tripConfig.vipWindow = ptLoadedAnchors.vipWindow;'), 'ptFinish writes vipWindow into its literal');
  assert.ok(GEN_SRC.includes('heldReturns: tripConfig.heldReturns || [],'), 'the generation pick forwards heldReturns');
});
