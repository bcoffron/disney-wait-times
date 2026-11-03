// Tests for the item35 section-build rework (Claude msg 202):
//  - uniform 12000 ceilings on prose sections (stable + dynamic), the
//    closures JSON class stays at 6000, per-section maxUses (stable
//    default 3; SHOW/FAMILY 6; TRIP_CONTEXT its own 6)
//  - the falsified Oct 22 budget comment replaced
//  - fanout failure back-off: sections whose last verdict was 'fail'
//    build behind sections that did not fail
//  - staggered expiries: every rebuild stamps section_meta.expires_at
//    within +/-20% of the key's window
//  - CATALOG writes a verdict carrying attraction/venue counts, and its
//    meta records the counts instead of a text length of 0
//  - verdict appends chain on this invocation's own last write, so the
//    store's read-after-write lag cannot drop a verdict (the Nov 2
//    fanout lost CATALOG's verdict exactly that way)
//  - output_tokens recorded on ok verdicts
//  - vercel.json: stable fanout daily, dynamic still weekly
//
//   node --test test/section-builds.test.mjs
import { register } from 'node:module';
register('./stub-hooks.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CRON_SECRET = 'test-secret-x';
process.env.ADMIN_KEY = 'test-admin';
process.env.ANTHROPIC_API_KEY = 'test-key';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const handler = (await import('../api/cron-cache.js')).default;
const SRC = fs.readFileSync(path.resolve(HERE, '..', 'api', 'cron-cache.js'), 'utf8');
const VERCEL = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'vercel.json'), 'utf8'));

// ---- fetch stub -----------------------------------------------------------
let anthropicScript = [];
let anthropicRequests = [];
let frozenVerdictsBody = null; // lag simulation: verdict reads serve this

globalThis.fetch = async function (url, opts) {
  const u = String(url);
  if (u.includes('api.anthropic.com')) {
    anthropicRequests.push(JSON.parse(opts.body));
    const r = anthropicScript.shift();
    if (!r) throw new Error('no scripted Anthropic response left');
    return { status: 200, json: async () => r };
  }
  if (u.startsWith('https://blob.test/')) {
    const p = u.slice('https://blob.test/'.length);
    if (p === 'twize/cache_verdicts.json' && frozenVerdictsBody != null) {
      return { status: 200, json: async () => JSON.parse(frozenVerdictsBody), text: async () => frozenVerdictsBody };
    }
    const entry = globalThis.__blobState && globalThis.__blobState.blobs.get(p);
    const body = entry && entry.body != null ? entry.body : (entry && entry.json != null ? JSON.stringify(entry.json) : '{}');
    return { status: 200, json: async () => JSON.parse(body), text: async () => body };
  }
  throw new Error('unexpected fetch: ' + u);
};

function seed(pathname, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  globalThis.__blobState.blobs.set(pathname, {
    pathname, url: 'https://blob.test/' + pathname, downloadUrl: 'https://blob.test/' + pathname,
    size: body.length, body, uploadedAt: new Date().toISOString(),
  });
}
function stored(pathname) {
  const e = globalThis.__blobState.blobs.get(pathname);
  return e ? JSON.parse(e.body) : null;
}
function mockRes() {
  return {
    headers: {}, statusCode: null, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
}
function textResp() {
  return {
    content: [{ type: 'text', text: 'Stubbed section body: specific, current, guest-ready guidance for this section of the Disneyland intel cache.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 120, output_tokens: 321, server_tool_use: { web_search_requests: 2 } },
  };
}

const STABLE_SECTIONS = ['LAND_MAP','WAIT_PATTERNS','CROWD_FLOW','ROPE_DROP_STRATEGY','LIGHTNING_LANE_STRATEGY','WALKING_ROUTES','DINING_TIMING','SHOW_AND_ENTERTAINMENT','FAMILY_AND_ACCESSIBILITY','PHOTO_AND_EXPERIENCE','PARK_HOP_STRATEGY','WEATHER_AND_COMFORT','PARK_SERVICES','CATALOG'];
const FAILED_LAST = ['FAMILY_AND_ACCESSIBILITY','SHOW_AND_ENTERTAINMENT','WEATHER_AND_COMFORT'];

function sectionDef(name) {
  const i = SRC.indexOf('\n  ' + name + ':{');
  assert.ok(i >= 0, 'section def present: ' + name);
  const seg = SRC.slice(i, i + 200000);
  const mt = seg.match(/maxTokens:(\d+)(?:,maxUses:(\d+))?/);
  assert.ok(mt, 'budget found for ' + name);
  return { maxTokens: Number(mt[1]), maxUses: mt[2] ? Number(mt[2]) : null };
}

test('budgets: uniform 12000 prose ceilings, closures class at 6000, per-section maxUses', () => {
  for (const n of ['LAND_MAP','WAIT_PATTERNS','CROWD_FLOW','ROPE_DROP_STRATEGY','LIGHTNING_LANE_STRATEGY','WALKING_ROUTES','DINING_TIMING','SHOW_AND_ENTERTAINMENT','FAMILY_AND_ACCESSIBILITY','PHOTO_AND_EXPERIENCE','PARK_HOP_STRATEGY','WEATHER_AND_COMFORT']) {
    assert.equal(sectionDef(n).maxTokens, 12000, n + ' ceiling');
  }
  for (const n of ['CURRENT_CLOSURES','CURRENT_CLOSURES_WDW','SPECIAL_EVENTS','CURRENT_LL_PRICING','TRIP_CONTEXT']) {
    assert.equal(sectionDef(n).maxTokens, 12000, n + ' ceiling');
  }
  for (const n of ['CLOSURES','DINING_CLOSURES']) assert.equal(sectionDef(n).maxTokens, 6000, n + ' stays 6000');
  for (const n of STABLE_SECTIONS) {
    if (n === 'PARK_SERVICES' || n === 'CATALOG') continue;
    assert.equal(sectionDef(n).maxUses, (n === 'SHOW_AND_ENTERTAINMENT' || n === 'FAMILY_AND_ACCESSIBILITY') ? 6 : 3, n + ' maxUses');
  }
  assert.equal(sectionDef('TRIP_CONTEXT').maxUses, 6, 'TRIP_CONTEXT own cap');
  assert.equal(sectionDef('SPECIAL_EVENTS').maxUses, 6);
  assert.equal(sectionDef('CURRENT_LL_PRICING').maxUses, 3);
  assert.ok(!SRC.includes('the global search cap bounds their runaway'), 'falsified Oct 22 rationale removed');
  assert.ok(SRC.includes('Budget note (Nov 3, 2026'), 'corrected budget note present');
  assert.ok(SRC.includes('const TIME_BUDGET_MS = 240000;'), 'time budget NOT raised');
});

test('vercel.json: stable fanout every other day, dynamic unchanged', () => {
  const byPath = Object.fromEntries(VERCEL.crons.map((c) => [c.path, c.schedule]));
  assert.equal(byPath['/api/cron-cache?key=park_intel_dl_stable'], '0 3 */2 * *');
  assert.equal(byPath['/api/cron-cache?key=park_intel_dl_dynamic'], '0 4 * * 1');
});

test('fanout: back-off order, staggered expiry, CATALOG verdict+counts, lag-chained verdicts, output_tokens', async () => {
  globalThis.__blobState = { blobs: new Map(), delCalls: [] };
  anthropicRequests = [];
  anthropicScript = Array.from({ length: 13 }, textResp);

  const meta = {}, sections = {};
  const builtAts = {
    LAND_MAP: '2026-10-01T10:00:00.000Z', CROWD_FLOW: '2026-10-01T14:26:55.324Z',
    FAMILY_AND_ACCESSIBILITY: '2026-10-01T14:38:39.782Z', DINING_TIMING: '2026-10-01T14:42:23.326Z',
    SHOW_AND_ENTERTAINMENT: '2026-10-01T14:56:02.305Z', PHOTO_AND_EXPERIENCE: '2026-10-01T17:27:48.806Z',
    WEATHER_AND_COMFORT: '2026-10-01T17:28:43.353Z', ROPE_DROP_STRATEGY: '2026-10-01T17:29:44.850Z',
    LIGHTNING_LANE_STRATEGY: '2026-10-01T17:30:42.226Z', PARK_SERVICES: '2026-10-02T01:37:21.554Z',
    WAIT_PATTERNS: '2026-10-02T01:38:15.336Z', WALKING_ROUTES: '2026-10-01T14:35:29.993Z',
    PARK_HOP_STRATEGY: '2026-10-01T14:45:45.253Z', CATALOG: '2026-10-01T15:00:00.000Z',
  };
  for (const n of STABLE_SECTIONS) { meta[n] = { built: true, length: 100, built_at: builtAts[n] }; sections[n] = 'old ' + n; }
  seed('twize/park_intel_dl_stable.json', { sections, section_meta: meta, last_updated: '2026-10-02T00:00:00.000Z' });

  const venues = ['Blue Bayou Restaurant','Cafe Orleans','Carnation Cafe','River Belle Terrace','Carthay Circle Restaurant','Wine Country Trattoria','Lamplight Lounge',"Oga's Cantina",'Plaza Inn','Bengal Barbecue',"Flo's V8 Cafe",'Mint Julep Bar']
    .map((name) => ({ name, park: 'DL', land: 'x', resv: 'walkup', topPick: 'y', kids: 'z', veg: null, vegan: null, gf: null }));
  // buildCatalogVenues parses the dining blob's .data LINE STRING
  // ("Name [PARK, Land] RESV=policy"), not the venues array.
  const lines = venues.map((v) => v.name + ' [DL, Some Land] RESV=walkup').join('\n');
  seed('twize/dining_intel_dl.json', { venues, data: lines, storedAt: '2026-11-01T17:03:44.000Z' });

  const seedVerdicts = [
    { ts: '2026-11-02T03:01:12.011Z', key: 'park_intel_dl_stable', section: 'LAND_MAP', via: 'fanout', outcome: 'ok' },
    ...FAILED_LAST.map((s, i) => ({ ts: '2026-11-02T03:0' + (2 + i) + ':00.000Z', key: 'park_intel_dl_stable', section: s, via: 'fanout', outcome: 'fail', error: 'Response too short: 0 chars (stop_reason=max_tokens)' })),
  ];
  seed('twize/cache_verdicts.json', seedVerdicts);
  frozenVerdictsBody = JSON.stringify(seedVerdicts); // reads lag a full run behind

  const res = mockRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer test-secret-x' }, query: { key: 'park_intel_dl_stable' } }, res);
  frozenVerdictsBody = null;

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.fanout.failed, 0, JSON.stringify(res.body.fanout.errors));
  assert.equal(res.body.fanout.built, 14, 'all 14 sections build in one run when calls are fast');

  // Back-off: every failed-last section's model call comes after both
  // younger non-failed sections (pure stalest-first would run WEATHER
  // before ROPE_DROP and LIGHTNING_LANE).
  const order = anthropicRequests.map((r) => {
    const m = JSON.stringify(r.messages).match(/Now build the ([A-Z_]+) section/);
    return m && m[1];
  });
  assert.equal(order.length, 13, 'CATALOG makes no model call');
  for (const f of FAILED_LAST) {
    assert.ok(order.indexOf(f) > order.indexOf('ROPE_DROP_STRATEGY'), f + ' behind ROPE_DROP_STRATEGY');
    assert.ok(order.indexOf(f) > order.indexOf('LIGHTNING_LANE_STRATEGY'), f + ' behind LIGHTNING_LANE_STRATEGY');
  }
  // The section calls themselves carry the per-section caps.
  const famReq = anthropicRequests[order.indexOf('FAMILY_AND_ACCESSIBILITY')];
  assert.equal(famReq.max_tokens, 12000);
  assert.equal(famReq.tools[0].max_uses, 6);
  const crowdReq = anthropicRequests[order.indexOf('CROWD_FLOW')];
  assert.equal(crowdReq.tools[0].max_uses, 3);

  // Staggered expiry + CATALOG counts in meta.
  const rawBlob = stored('twize/park_intel_dl_stable.json');
  const blob = (rawBlob && rawBlob.data && rawBlob.data.sections) ? rawBlob.data : rawBlob;
  const DAY = 86400000;
  for (const n of STABLE_SECTIONS) {
    const m = blob.section_meta[n];
    assert.ok(m.expires_at, n + ' expires_at stamped');
    const span = new Date(m.expires_at).getTime() - new Date(m.built_at).getTime();
    assert.ok(span >= 24 * DAY && span <= 36 * DAY, n + ' expiry within +/-20% of 30d (got ' + Math.round(span / DAY) + 'd)');
  }
  assert.ok(blob.section_meta.CATALOG.attractions > 0, 'CATALOG attractions counted');
  assert.ok(blob.section_meta.CATALOG.venues > 0, 'CATALOG venues counted');
  assert.ok(blob.section_meta.CATALOG.length > 0, 'CATALOG meta length is a real size, not 0');

  // Verdicts: despite lagged reads, EVERY section's verdict survived
  // (chaining), CATALOG's carries counts, ok verdicts carry outputTokens.
  const v = stored('twize/cache_verdicts.json');
  const runEntries = v.filter((e) => e.key === 'park_intel_dl_stable' && e.ts > '2026-11-02T04:00:00.000Z');
  assert.equal(runEntries.length, 14, 'all 14 verdicts landed: ' + runEntries.map((e) => e.section).join(','));
  const cat = runEntries.find((e) => e.section === 'CATALOG');
  assert.ok(cat && cat.counts && cat.counts.attractions > 0 && cat.counts.venues > 0, 'CATALOG verdict carries counts');
  const land = runEntries.find((e) => e.section === 'LAND_MAP');
  assert.equal(land.outputTokens, 321, 'ok verdict records output_tokens');
});
