// Push-tap presenter suite (Claude ruling, Oct 22, 2026).
//
// The ruling's invariant -- a tap presents THAT episode, identified by
// id, exactly once, and nothing else -- is a test, not a convention.
// This suite extracts the REAL presenter source from app.html (the
// contiguous range from the shown-set through the presenter, the
// TAP-PRESENT block, the alert route and tpcpAlertOpen) and drives it
// in a vm with storage / fetch / DOM stubs, so the code under test is
// the code that ships. Only the final render inch (tpcpAlertShowModal
// / tpcpAlertShowBooking) and the dismiss path are stubbed; the
// dismiss is modelled by clearing the current slot directly.
//
// Run: node --test test/push-tap-presenter.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appHtml = readFileSync(new URL('../app.html', import.meta.url), 'utf8');

const RANGE_START = 'var _tpcpPresentedEpisodes = {};';
const RANGE_END = '// Morning-modal singles section';
const startIdx = appHtml.indexOf(RANGE_START);
const endIdx = appHtml.indexOf(RANGE_END);
assert.ok(startIdx !== -1, 'presenter range start not found in app.html');
assert.ok(endIdx > startIdx, 'presenter range end not found after start');
const PRESENTER_SRC = appHtml.slice(startIdx, endIdx);
assert.ok(PRESENTER_SRC.includes('BEGIN TAP-PRESENT'), 'TAP-PRESENT block missing from presenter range');
assert.ok(PRESENTER_SRC.includes('function tpcpTapConsume'), 'tpcpTapConsume missing');
assert.ok(PRESENTER_SRC.includes('function tpcpPresentPolledEpisodes'), 'poll presenter missing');
assert.ok(PRESENTER_SRC.includes('function tpcpAlertOpen'), 'alert open missing');

const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());
const FRESH = 10 * 60 * 1000;

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }
  };
}

function ep(episodeId, cls, firedAgoMs, extra) {
  return Object.assign({
    episodeId, 'class': cls, tag: '', title: 'Alert', body: 'Body',
    url: '/app.html', ymd: TODAY, firedAt: Date.now() - firedAgoMs
  }, extra || {});
}

function makeWorld(opts) {
  opts = opts || {};
  const world = {
    presented: [],   // episodeIds whose presentation OPENED, in order
    fetchUrls: [],
    episodes: opts.episodes || []
  };
  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    localStorage: opts.localStorage || makeStorage(),
    sessionStorage: opts.sessionStorage || makeStorage(),
    window: {},
    document: { addEventListener: () => {}, hidden: false },
    SYNC_BASE: 'https://example.test',
    isAdmin: () => opts.leader !== false,
    fetch: (url) => {
      world.fetchUrls.push(url);
      if (opts.fetchImpl) return opts.fetchImpl(url);
      return Promise.resolve({ json: () => Promise.resolve({ episodes: world.episodes }) });
    },
    // The render inch: record the open (mark-on-present has already
    // happened in the real tpcpAlertOpen before this is called).
    tpcpAlertShowModal: (item) => { world.presented.push(item.episodeId); },
    tpcpAlertShowBooking: (item) => { world.presented.push(item.episodeId); }
  };
  if (opts.code !== null) sandbox.localStorage.setItem('tpcp_code', opts.code || 'TEST02');
  vm.createContext(sandbox);
  vm.runInContext(PRESENTER_SRC, sandbox);
  world.ctx = sandbox;
  return world;
}

async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

const HM = 'ep:test-trip-2:haunted mansion holiday:spike:2026-10-22:f1';
const RISE = 'ep:test-trip-2:star wars rise of the resistance:spike:2026-10-22:f2';

test('(i) a tap presents exactly the tapped episode, even when a newer episode exists', async () => {
  const tapped = ep(HM, 'ride-update', 120000);          // fired 2 min ago
  const newer = ep(RISE, 'ride-update', 30000);          // fired 30 s ago
  const world = makeWorld({ episodes: [newer, tapped] }); // newest first, as served
  const tap = world.ctx.tpcpTapRecord({ episodeId: HM, url: '/app.html', 'class': 'ride-update' });
  assert.ok(tap && tap.episodeId === HM, 'tap recorded');
  world.ctx.tpcpTapConsume();
  await flush();
  assert.deepEqual(world.presented, [HM], 'exactly the tapped episode presented');
  assert.equal(world.fetchUrls.length, 1, 'one consume fetch');
  assert.ok(world.fetchUrls[0].includes('code=TEST02'), 'fetch carries the trip code');
  assert.ok(!world.fetchUrls[0].includes('dt='), 'tap fetch is tokenless (no dt)');
  assert.equal(world.ctx._tpcpPresentedEpisodes[HM], 1, 'mark-on-present re-marked the tapped episode');
});

test('(ii) one tap produces at most one presentation, and the tap is spent', async () => {
  const tapped = ep(HM, 'ride-update', 60000);
  const world = makeWorld({ episodes: [tapped] });
  world.ctx.tpcpTapRecord({ episodeId: HM, url: '/app.html', 'class': 'ride-update' });
  world.ctx.tpcpTapConsume();
  await flush();
  assert.deepEqual(world.presented, [HM]);
  // A later consume attempt and a later poll tick (dt-shaped list: the
  // pushed episode is excluded server-side, so it is absent here) must
  // not re-present it.
  world.ctx.tpcpTapConsume();
  world.ctx.tpcpPresentPolledEpisodes([]);
  await flush();
  assert.deepEqual(world.presented, [HM], 'still exactly one presentation');
  assert.equal(world.ctx.tpcpTapRead(), null, 'pending tap is spent');
  assert.equal(world.ctx.sessionStorage.getItem('tpcp_pending_tap'), null, 'stored tap cleared');
});

test('(iii) a tap on an episode older than the freshness cap presents nothing', async () => {
  const stale = ep(HM, 'ride-update', FRESH + 60000);
  const world = makeWorld({ episodes: [stale] });
  world.ctx.tpcpTapRecord({ episodeId: HM, url: '/app.html', 'class': 'ride-update' });
  world.ctx.tpcpTapConsume();
  await flush();
  assert.deepEqual(world.presented, [], 'stale episode not presented');
  assert.equal(world.ctx.tpcpTapRead(), null, 'stale tap is spent, not retried forever');
});

test('(iv) a booking tap (absolute https url) records nothing and consumes nothing', async () => {
  const world = makeWorld({ episodes: [] });
  const bookingData = {
    episodeId: 'ep:test-trip-2:booking:2026-10-23', 'class': 'booking',
    url: 'https://disneyland.disney.go.com/dining/disneyland/blue-bayou-restaurant/'
  };
  assert.equal(world.ctx.tpcpTapFromData(bookingData, Date.now()), null, 'booking payload classifies to no tap');
  assert.equal(world.ctx.tpcpTapRecord(bookingData), null, 'booking tap not recorded');
  assert.equal(world.ctx.sessionStorage.getItem('tpcp_pending_tap'), null, 'nothing stored');
  world.ctx.tpcpTapConsume();
  await flush();
  assert.equal(world.fetchUrls.length, 0, 'no consume fetch without a pending tap');
  assert.deepEqual(world.presented, [], 'nothing presented -- the external open is the handler\u2019s unchanged path');
  // Legacy payloads with no episode identity also record nothing.
  assert.equal(world.ctx.tpcpTapRecord({ url: '/app.html', tag: 'tpcp-test' }), null);
  // A booking-class episode can never be picked even if a tap somehow names it.
  const bk = ep('ep:test-trip-2:booking:2026-10-23', 'booking', 30000);
  assert.equal(world.ctx.tpcpTapPickEpisode([bk], { episodeId: bk.episodeId, tappedAt: Date.now() }, TODAY, Date.now()), null);
});

test('(v) passive poll presentation is unchanged by the tap path', async () => {
  const unpushed = ep('ep:test-trip-2:space mountain:down:2026-10-22', 'ride-update', 45000);
  const unpushed2 = ep('ep:test-trip-2:indiana jones adventure:drop:2026-10-22:f1', 'ride-update', 20000);
  const tapped = ep(HM, 'ride-update', 90000);
  const world = makeWorld({ episodes: [tapped, unpushed, unpushed2] });
  // The shipped poll sends dt, so episodes pushed to this device are
  // excluded server-side and never reach the presenter; the unpushed
  // ones present under the ordinary rules.
  world.ctx.tpcpPresentPolledEpisodes([unpushed]);
  assert.deepEqual(world.presented, [unpushed.episodeId], 'poll presents the unpushed episode');
  world.ctx._tpcpAlertCurrent = null; // user acknowledged it (dismiss path is outside this range)
  world.ctx.tpcpPresentPolledEpisodes([unpushed]);
  assert.deepEqual(world.presented, [unpushed.episodeId], 'shown-set still dedupes the poll');
  world.ctx.tpcpPresentPolledEpisodes([unpushed, unpushed2]);
  assert.deepEqual(world.presented, [unpushed.episodeId, unpushed2.episodeId], 'poll still presents new unpushed episodes');
  world.ctx._tpcpAlertCurrent = null;
  // The pushed episode was never presented by any poll call above --
  // only the tap path may present it, and it does, exactly once.
  world.ctx.tpcpTapRecord({ episodeId: HM, url: '/app.html', 'class': 'ride-update' });
  world.ctx.tpcpTapConsume();
  await flush();
  assert.deepEqual(world.presented, [unpushed.episodeId, unpushed2.episodeId, HM], 'tap adds exactly its own episode');
});

test('(vi) a tap does not stack a second modal when the foreground slot is taken', async () => {
  const occupant = ep('ep:test-trip-2:space mountain:down:2026-10-22', 'ride-update', 30000);
  const tapped = ep(HM, 'ride-update', 60000);
  const world = makeWorld({ episodes: [tapped] });
  world.ctx.tpcpPresentPolledEpisodes([occupant]);
  assert.deepEqual(world.presented, [occupant.episodeId], 'occupant holds the slot');
  world.ctx.tpcpTapRecord({ episodeId: HM, url: '/app.html', 'class': 'ride-update' });
  world.ctx.tpcpTapConsume();
  await flush();
  assert.deepEqual(world.presented, [occupant.episodeId], 'tap presented nothing alongside');
  assert.equal(world.ctx.tpcpTapRead(), null, 'the tap is spent even when the slot was taken');
});

test('(vii) a tap recorded before a cold start still presents (sessionStorage survives)', async () => {
  const sharedSession = makeStorage();
  const tapped = ep(HM, 'ride-update', 60000);
  const w1 = makeWorld({ episodes: [tapped], sessionStorage: sharedSession });
  w1.ctx.tpcpTapRecord({ episodeId: HM, url: '/app.html', 'class': 'ride-update' });
  // New world = new JS session (module state gone), same sessionStorage.
  const w2 = makeWorld({ episodes: [tapped], sessionStorage: sharedSession });
  assert.equal(w2.ctx._tpcpPendingTap, null, 'no in-memory tap in the new session');
  w2.ctx.tpcpTapConsume();
  await flush();
  assert.deepEqual(w2.presented, [HM], 'stored tap presented after cold start');
});

test('static: the poll still sends dt and the tap handler still captures before the external open', () => {
  assert.ok(
    appHtml.includes("(_pollDt ? '&dt=' + encodeURIComponent(_pollDt) : '')"),
    'poll dt construction intact'
  );
  const handlerIdx = appHtml.indexOf("addListener('pushNotificationActionPerformed'");
  assert.ok(handlerIdx !== -1, 'tap handler present');
  const captureIdx = appHtml.indexOf('tpcpTapRecord(action && action.notification', handlerIdx);
  const externalIdx = appHtml.indexOf('tpcpNoteExternalCover();', handlerIdx);
  assert.ok(captureIdx !== -1 && externalIdx !== -1 && captureIdx < externalIdx,
    'tap capture runs in the handler ahead of the external-open branch');
});
