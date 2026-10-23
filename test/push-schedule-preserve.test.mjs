// Tests for the client half of the LL stamp strip fix (Claude ruling,
// Oct 23, 2026): app.html's pushSchedule must carry day-level
// generation state forward from the stored day when it rebuilds days
// as {park, items}, and it must exist exactly ONCE -- the file carried
// duplicate definitions (the later one silently winning by hoisting),
// which is how a fix applied to the wrong copy would have shipped as
// a no-op. The durable guard is server-side (test/trip-save-preserve);
// this suite pins the client behavior and the dedupe.
//
// The real function is extracted from app.html and run in a vm with
// the browser surface stubbed, so the shipped bytes are what execute.
// Run with Node's built-in runner (no new dependencies):
//   node --test test/push-schedule-preserve.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../app.html', import.meta.url), 'utf8');

function extractPushSchedule() {
  const matches = [...html.matchAll(/async function pushSchedule/g)];
  assert.equal(matches.length, 1, 'app.html must define pushSchedule exactly once (found ' + matches.length + ')');
  const start = matches[0].index;
  const nl = html.indexOf('\n', start);
  return html.slice(start, nl);
}

const SEQ = { bookFirst: 'Space Mountain', order: ['Space Mountain'], singleSeparate: [] };
const STAMP = { hasLLMP: true, hasILL: false, illRides: [] };

async function runPushSchedule({ customSched, loadedDays, schedDays }) {
  const src = extractPushSchedule();
  assert.match(src, /llSequence/, 'surviving pushSchedule must carry fields forward');
  let posted = null;
  const windowObj = {
    _loadedTripData: loadedDays ? { tripConfig: { schedule: { days: loadedDays }, keepMe: 1 } } : null,
    _schedData: schedDays ? { days: schedDays } : null,
  };
  const ctx = {
    window: windowObj,
    isAdmin: () => true,
    localStorage: { getItem: () => 'TESTCODE' },
    customSched,
    tpcpFitCustomSched: () => {},
    ensureAdminKey: () => '',
    tpcpDeviceToken: () => '',
    SYNC_BASE: '',
    console,
    fetch: async (url, opts) => { posted = JSON.parse(opts.body); return { ok: true }; },
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.__run = pushSchedule();', ctx);
  await ctx.__run;
  assert.ok(posted, 'pushSchedule should POST the save');
  return posted.tripData.tripConfig.schedule.days;
}

test('carries llSequence / generatedWith / finalPark forward from the stored day', async () => {
  const stored = [
    { park: 'Disneyland', items: [{ h: 'Old A' }], llSequence: SEQ, generatedWith: STAMP, finalPark: 'Disney California Adventure' },
    { park: 'Disneyland', items: [{ h: 'Old B' }], llSequence: SEQ, generatedWith: STAMP },
  ];
  const days = await runPushSchedule({
    customSched: [
      { sections: [{ title: 'Disneyland', entries: [{ h: 'New A' }] }] },
      { sections: [{ title: 'Disneyland', entries: [{ h: 'New B' }] }] },
    ],
    loadedDays: stored,
    schedDays: null,
  });
  assert.deepEqual(days[0], { park: 'Disneyland', items: [{ h: 'New A' }], llSequence: SEQ, generatedWith: STAMP, finalPark: 'Disney California Adventure' });
  assert.deepEqual(days[1], { park: 'Disneyland', items: [{ h: 'New B' }], llSequence: SEQ, generatedWith: STAMP });
});

test('empty editing day still falls back to stored items AND carries the stamp', async () => {
  const stored = [{ park: 'Disneyland', items: [{ h: 'Stored' }], llSequence: SEQ, generatedWith: STAMP }];
  const days = await runPushSchedule({
    customSched: [{ sections: [{ title: '', entries: [] }] }],
    loadedDays: stored,
    schedDays: null,
  });
  assert.deepEqual(days[0].items, [{ h: 'Stored' }], 'items fallback preserved');
  assert.equal(days[0].park, 'Disneyland', 'park fallback preserved');
  assert.deepEqual(days[0].llSequence, SEQ);
  assert.deepEqual(days[0].generatedWith, STAMP);
});

test('no stored trip loaded: posts plain {park, items} days, no phantom fields', async () => {
  const days = await runPushSchedule({
    customSched: [{ sections: [{ title: 'Disneyland', entries: [{ h: 'A' }] }] }],
    loadedDays: null,
    schedDays: null,
  });
  assert.deepEqual(days[0], { park: 'Disneyland', items: [{ h: 'A' }] });
});
