// Tests for the item34 cron-cache rework: the legacy builders
// (buildLegacy / buildDiningDL) now route through the shared callClaude,
// which carries the per-key web_search cap and the pause_turn continuation,
// and buildDiningDL validates BEFORE its put (a truncated or shrunken
// rebuild must never replace the last good blob).
//
// The stub is at the FETCH layer, per the ruling: the real request builder
// runs, so the asserted request bodies are the shipped ones. The handler's
// @vercel/blob import is redirected to the in-memory stub via
// test/stub-hooks.mjs, and blob read-backs (verdict record) are served by
// the same stubbed fetch from the stub's retained bodies.
//
//   node --test test/cache-legacy-builders.test.mjs
import { register } from 'node:module';
register('./stub-hooks.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CRON_SECRET = 'test-secret';
process.env.ADMIN_KEY = 'test-admin';
process.env.ANTHROPIC_API_KEY = 'test-key';

const handler = (await import('../api/cron-cache.js')).default;
const SRC = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'api', 'cron-cache.js'), 'utf8');

// ---- fetch stub -----------------------------------------------------------
let anthropicScript = [];
let anthropicRequests = [];

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
    const entry = globalThis.__blobState && globalThis.__blobState.blobs.get(p);
    const body = entry && entry.body != null ? entry.body : (entry && entry.json != null ? JSON.stringify(entry.json) : '{}');
    return { status: 200, json: async () => JSON.parse(body), text: async () => body };
  }
  throw new Error('unexpected fetch: ' + u);
};

function reset(script) {
  globalThis.__blobState = { blobs: new Map(), delCalls: [] };
  anthropicScript = script.slice();
  anthropicRequests = [];
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

async function runKey(key) {
  const res = mockRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer test-secret' }, query: { key, force: '1' } }, res);
  return res;
}

function stored(pathname) {
  const e = globalThis.__blobState.blobs.get(pathname);
  return e ? JSON.parse(e.body) : null;
}

function verdictsFor(key) {
  const v = stored('twize/cache_verdicts.json');
  return Array.isArray(v) ? v.filter((e) => e.key === key) : [];
}

function searchBlocks(n, withCapError) {
  const blocks = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ type: 'server_tool_use', id: 's' + i, name: 'web_search', input: { query: 'q' + i } });
    if (withCapError && i === n - 1) {
      blocks.push({ type: 'web_search_tool_result', tool_use_id: 's' + i, content: [{ type: 'web_search_tool_error', error_code: 'max_uses_exceeded' }] });
    } else {
      blocks.push({ type: 'web_search_tool_result', tool_use_id: 's' + i, content: [{ type: 'web_search_result', title: 't' + i, url: 'https://example.com/' + i }] });
    }
  }
  return blocks;
}

function resp(content, stopReason, searches) {
  return { content, stop_reason: stopReason, usage: { input_tokens: 500, output_tokens: 700, server_tool_use: { web_search_requests: searches } } };
}

// ---- fixtures ---------------------------------------------------------------
const VENUE_NAMES = [
  'Blue Bayou Restaurant', 'Cafe Orleans', 'Carnation Cafe', 'River Belle Terrace', 'Plaza Inn',
  'Alien Pizza Planet', 'Bengal Barbecue', 'The Golden Horseshoe', 'Hungry Bear Restaurant', "Tiana's Palace",
  'Docking Bay 7 Food and Cargo', 'Ronto Roasters', "Oga's Cantina", 'French Market Restaurant', 'Harbour Galley',
  'Jolly Holiday Bakery Cafe', 'Refreshment Corner', 'Rancho del Zocalo Restaurante', 'Troubadour Tavern', 'Edelweiss Snacks',
  'Carthay Circle Restaurant', 'Wine Country Trattoria', 'Lamplight Lounge', "Flo's V8 Cafe", 'Award Wieners',
  'Corn Dog Castle', 'Paradise Garden Grill', 'Boardwalk Pizza and Pasta', 'Smokejumpers Grill', 'Aunt Cass Cafe',
  'Cocina Cucamonga Mexican Grill', 'Lucky Fortune Cookery', 'Sonoma Terrace', 'Schmoozies', 'Fairfax Market',
  'Cozy Cone Motel', "Rita's Baja Blenders", 'Mendocino Terrace', 'Ghirardelli Soda Fountain', 'Kat Saka\'s Kettle',
];
function venues(n) {
  return VENUE_NAMES.slice(0, n).map((name, i) => ({
    name, park: i % 2 ? 'DCA' : 'DL', land: 'Some Land', resv: 'walkup',
    topPick: 'Signature item', kids: 'Kid option', veg: null, vegan: null, gf: null,
  }));
}
function diningText(n) {
  return '```json\n' + JSON.stringify({ venues: venues(n) }) + '\n```';
}
const EVENTS_PROSE = 'Oogie Boogie Bash runs on select nights this month at Disney California Adventure, with tickets required and the park closing early to day guests on party nights. Fantasmic! plays on the Rivers of America most weekends, weather permitting, and the fireworks show runs nightly when winds allow. Specific dated listings follow in the guide.';

// ---- static acceptance (the ruling's grep) ----------------------------------
test('static: exactly one Anthropic call site, every web_search def carries max_uses', () => {
  assert.equal(SRC.split('api.anthropic.com/v1/messages').length - 1, 1);
  const defs = SRC.split('\n').filter((l) => l.includes('web_search_20250305'));
  assert.ok(defs.length >= 1);
  for (const line of defs) assert.ok(line.includes('max_uses'), 'web_search def without max_uses: ' + line);
});

test('static: budgets -- events 4000, dining 16000', () => {
  assert.match(SRC, /events_intel:\{[^}]*maxTokens:4000\}/);
  assert.match(SRC, /dining_intel_dl:\{[\s\S]*?maxTokens:16000\}/);
});

// ---- events -----------------------------------------------------------------
test('events: a normal response stores, and the shipped request is capped at the new budget', async () => {
  reset([resp([...searchBlocks(3), { type: 'text', text: EVENTS_PROSE }], 'end_turn', 3)]);
  const res = await runKey('events_intel');
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(anthropicRequests.length, 1);
  assert.equal(anthropicRequests[0].max_tokens, 4000);
  assert.equal(anthropicRequests[0].tools[0].max_uses, 6);
  const blob = stored('twize/events_intel.json');
  assert.ok(blob && typeof blob.data === 'string' && blob.data.includes('Oogie Boogie Bash'));
});

test('events: the Nov 1 shape (max_tokens, searches, no text) fails loud and stores nothing', async () => {
  const blocks = [...searchBlocks(7, true)];
  for (let i = 0; i < 4; i++) blocks.push({ type: 'thinking', thinking: '...' });
  reset([resp(blocks, 'max_tokens', 7)]);
  const res = await runKey('events_intel');
  assert.equal(res.statusCode, 500, JSON.stringify(res.body));
  assert.equal(globalThis.__blobState.blobs.has('twize/events_intel.json'), false);
  // Even fed an over-cap history, the shipped request body is the capped one.
  assert.equal(anthropicRequests[0].tools[0].max_uses, 6);
  const v = verdictsFor('events_intel');
  assert.ok(v.length >= 1);
  const fail = v[v.length - 1];
  assert.equal(fail.outcome, 'fail');
  assert.equal(fail.stopReason, 'max_tokens');
  assert.equal(fail.maxUsesExceeded, 1);
});

// ---- dining -------------------------------------------------------------------
test('events: a LONG truncated answer is rejected before the put (truncation extension)', async () => {
  // At the raised 4000 budget a max_tokens answer easily clears the length
  // floor -- without the guard it would store silently as a good build.
  reset([resp([...searchBlocks(5), { type: 'text', text: EVENTS_PROSE }], 'max_tokens', 5)]);
  const res = await runKey('events_intel');
  assert.equal(res.statusCode, 500, JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /events_intel rebuild rejected: truncated/);
  assert.equal(globalThis.__blobState.blobs.has('twize/events_intel.json'), false);
});

test('dining: truncated response salvaging to a partial list is rejected before the put', async () => {
  reset([resp([...searchBlocks(6), { type: 'text', text: diningText(12) }], 'max_tokens', 6)]);
  const res = await runKey('dining_intel_dl');
  assert.equal(res.statusCode, 500, JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /rejected: truncated/);
  assert.equal(globalThis.__blobState.blobs.has('twize/dining_intel_dl.json'), false);
});

test('dining: the exact Nov 1 shape (max_tokens, zero venues) stores nothing', async () => {
  const truncated = '```json\n{"venues":[{"name":"Blue Bayou Restaurant","park":"DL","land":"New Orleans Square","resv":"required","topPick":"Monte Cristo","kids":"Kids meal","veg":null,"vegan":null,"gf":null},{"name":"Carthay Cir';
  reset([resp([...searchBlocks(7), { type: 'text', text: truncated }], 'max_tokens', 7)]);
  const res = await runKey('dining_intel_dl');
  assert.equal(res.statusCode, 500, JSON.stringify(res.body));
  assert.equal(globalThis.__blobState.blobs.has('twize/dining_intel_dl.json'), false);
});

test('dining: a clean but empty venue list is rejected as empty', async () => {
  const emptyJson = '```json\n' + JSON.stringify({ venues: [], note: 'No venues could be verified for this window in the sources consulted for this build.' }) + '\n```';
  reset([resp([{ type: 'text', text: emptyJson }], 'end_turn', 1)]);
  const res = await runKey('dining_intel_dl');
  assert.equal(res.statusCode, 500, JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /rejected: empty/);
  assert.equal(globalThis.__blobState.blobs.has('twize/dining_intel_dl.json'), false);
});

test('dining: a materially shrunken list is rejected as shrank', async () => {
  reset([resp([{ type: 'text', text: diningText(20) }], 'end_turn', 2)]);
  const res = await runKey('dining_intel_dl');
  assert.equal(res.statusCode, 500, JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /rejected: shrank \(20 venues < floor 30\)/);
  assert.equal(globalThis.__blobState.blobs.has('twize/dining_intel_dl.json'), false);
});

test('dining: a complete response stores at the raised ceiling', async () => {
  reset([resp([...searchBlocks(4), { type: 'text', text: diningText(40) }], 'end_turn', 4)]);
  const res = await runKey('dining_intel_dl');
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(anthropicRequests[0].max_tokens, 16000);
  assert.equal(anthropicRequests[0].tools[0].max_uses, 6);
  const blob = stored('twize/dining_intel_dl.json');
  assert.ok(blob && Array.isArray(blob.venues) && blob.venues.length === 40);
  const v = verdictsFor('dining_intel_dl');
  const ok = v[v.length - 1];
  assert.equal(ok.outcome, 'ok');
  assert.equal(ok.note, 'venues=40');
});

test('dining: an empty stored payload reads as NOT fresh, so a plain (non-force) run rebuilds it', async () => {
  reset([resp([...searchBlocks(4), { type: 'text', text: diningText(40) }], 'end_turn', 4)]);
  // Seed the exact Nov 1 empty overwrite at the blob layer: top-level
  // venues: [] with an empty data string and a fresh ts. Before the fix,
  // isFresh's shape-blind checks read this as fresh and the run skipped
  // (Beau's Nov 1 manual Run recorded skipped-fresh against it).
  const emptyPayload = JSON.stringify({ data: '', venues: [], _retired: [], _meta: { built_at: '2026-11-01T04:01:44.320Z', count: 0 }, ts: Date.now() });
  globalThis.__blobState.blobs.set('twize/dining_intel_dl.json', { pathname: 'twize/dining_intel_dl.json', url: 'https://blob.test/twize/dining_intel_dl.json', downloadUrl: 'https://blob.test/twize/dining_intel_dl.json', size: emptyPayload.length, body: emptyPayload, uploadedAt: new Date().toISOString() });
  const res = mockRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer test-secret' }, query: { key: 'dining_intel_dl' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(anthropicRequests.length, 1, 'the run must actually build, not skip as fresh');
  const blob = stored('twize/dining_intel_dl.json');
  assert.ok(blob && Array.isArray(blob.venues) && blob.venues.length === 40);
});

test('dining: a JSON answer split across a pause_turn boundary parses and stores', async () => {
  const full = JSON.stringify({ venues: venues(40) });
  const cut = Math.floor(full.length / 2);
  const first = {
    content: [
      { type: 'text', text: 'I will pull the current venue menus first.' },
      ...searchBlocks(2),
      { type: 'text', text: '```json\n' + full.slice(0, cut) },
    ],
    stop_reason: 'pause_turn',
    usage: { input_tokens: 400, output_tokens: 300, server_tool_use: { web_search_requests: 2 } },
  };
  const second = resp([{ type: 'text', text: full.slice(cut) + '\n```' }], 'end_turn', 0);
  reset([first, second]);
  const res = await runKey('dining_intel_dl');
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(anthropicRequests.length, 2);
  // The resume sends the paused assistant message back unchanged.
  assert.equal(anthropicRequests[1].messages[1].role, 'assistant');
  const blob = stored('twize/dining_intel_dl.json');
  assert.ok(blob && Array.isArray(blob.venues) && blob.venues.length === 40);
});
