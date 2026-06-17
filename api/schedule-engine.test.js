// api/schedule-engine.test.js
// Unit tests for schedule-engine.js — run with: node --test api/schedule-engine.test.js
// Uses Node built-in test runner (node:test + node:assert). No external deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHourMin,
  parseParkHoursForDate,
  deriveBlocks,
  whichParkAt,
  buildCatalogFilter
} from './schedule-engine.js';

// ---------------------------------------------------------------------------
// parseHourMin
// ---------------------------------------------------------------------------
test('parseHourMin: 8:00 AM -> 480', () => {
  assert.equal(parseHourMin('8:00 AM'), 480);
});

test('parseHourMin: 11:00 PM -> 1380', () => {
  assert.equal(parseHourMin('11:00 PM'), 1380);
});

test('parseHourMin: 12:00 AM midnight close -> 1440', () => {
  assert.equal(parseHourMin('12:00 AM'), 1440);
});

test('parseHourMin: 12:00 PM noon -> 720', () => {
  assert.equal(parseHourMin('12:00 PM'), 720);
});

test('parseHourMin: 9:30 AM -> 570', () => {
  assert.equal(parseHourMin('9:30 AM'), 570);
});

test('parseHourMin: null/invalid -> 0', () => {
  assert.equal(parseHourMin(null), 0);
  assert.equal(parseHourMin(''), 0);
  assert.equal(parseHourMin('garbage'), 0);
});

// ---------------------------------------------------------------------------
// parseParkHoursForDate
// ---------------------------------------------------------------------------
test('parseParkHoursForDate: real multi-space format -> openMin 480, closeMin 1440', () => {
  // Real cache format: multiple spaces between open and close times
  const parkHoursArray = [
    { dl: '8:00 AM   12:00 AM', dca: '8:00 AM   10:00 PM', note: 'Day 0' }
  ];
  const result = parseParkHoursForDate(parkHoursArray, 0);
  assert.ok(result, 'result should not be null');
  assert.equal(result.DL.openMin,   480,  'DL open should be 480 (8:00 AM)');
  assert.equal(result.DL.closeMin,  1440, 'DL close should be 1440 (12:00 AM midnight)');
  assert.equal(result.DCA.openMin,  480,  'DCA open should be 480 (8:00 AM)');
  assert.equal(result.DCA.closeMin, 1320, 'DCA close should be 1320 (10:00 PM)');
});

test('parseParkHoursForDate: dash separator format also works', () => {
  const parkHoursArray = [
    { dl: '9:00 AM - 11:00 PM', dca: '10:00 AM - 10:00 PM' }
  ];
  const result = parseParkHoursForDate(parkHoursArray, 0);
  assert.equal(result.DL.openMin,   540);
  assert.equal(result.DL.closeMin,  1380);
  assert.equal(result.DCA.openMin,  600);
  assert.equal(result.DCA.closeMin, 1320);
});

test('parseParkHoursForDate: out-of-range dayIndex -> null', () => {
  const arr = [{ dl: '8:00 AM   12:00 AM', dca: '8:00 AM   10:00 PM' }];
  assert.equal(parseParkHoursForDate(arr, 5), null);
  assert.equal(parseParkHoursForDate(arr, -1), null);
  assert.equal(parseParkHoursForDate(null, 0), null);
});

// ---------------------------------------------------------------------------
// deriveBlocks — no-hop
// ---------------------------------------------------------------------------
test('deriveBlocks no-hop: returns 1 block with correct park and open/close times', () => {
  const parkHours = { DL: { openMin: 480, closeMin: 1320 }, DCA: { openMin: 480, closeMin: 1260 } };
  const dayIntent = { startPark: 'DL', hop: null, vip: null };
  const blocks = deriveBlocks(dayIntent, parkHours);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].park,     'DL');
  assert.equal(blocks[0].startMin, 480);
  assert.equal(blocks[0].endMin,   1320);
});

test('deriveBlocks no-hop: DCA start park -> 1 block with DCA hours', () => {
  const parkHours = { DL: { openMin: 480, closeMin: 1320 }, DCA: { openMin: 480, closeMin: 1260 } };
  const dayIntent = { startPark: 'DCA', hop: null, vip: null };
  const blocks = deriveBlocks(dayIntent, parkHours);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].park,     'DCA');
  assert.equal(blocks[0].startMin, 480);
  assert.equal(blocks[0].endMin,   1260);
});

// ---------------------------------------------------------------------------
// deriveBlocks — with hop
// ---------------------------------------------------------------------------
test('deriveBlocks with hop: returns 2 blocks, boundary at atMin', () => {
  const parkHours = { DL: { openMin: 480, closeMin: 1320 }, DCA: { openMin: 480, closeMin: 1260 } };
  const dayIntent = { startPark: 'DL', hop: { toPark: 'DCA', atMin: 840 }, vip: null };
  const blocks = deriveBlocks(dayIntent, parkHours);
  assert.equal(blocks.length, 2);
  // Block 1: DL from open to hop time
  assert.equal(blocks[0].park,     'DL');
  assert.equal(blocks[0].startMin, 480);
  assert.equal(blocks[0].endMin,   840);
  // Block 2: DCA from hop time to DCA close
  assert.equal(blocks[1].park,     'DCA');
  assert.equal(blocks[1].startMin, 840);
  assert.equal(blocks[1].endMin,   1260);
});

test('deriveBlocks with hop: DCA->DL direction', () => {
  const parkHours = { DL: { openMin: 480, closeMin: 1320 }, DCA: { openMin: 480, closeMin: 1260 } };
  const dayIntent = { startPark: 'DCA', hop: { toPark: 'DL', atMin: 900 }, vip: null };
  const blocks = deriveBlocks(dayIntent, parkHours);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].park,     'DCA');
  assert.equal(blocks[0].endMin,   900);
  assert.equal(blocks[1].park,     'DL');
  assert.equal(blocks[1].startMin, 900);
  assert.equal(blocks[1].endMin,   1320);
});

// ---------------------------------------------------------------------------
// deriveBlocks — hop:null fail-safe (must never throw, single park)
// ---------------------------------------------------------------------------
test('deriveBlocks hop:null explicit -> single park, never throws', () => {
  const parkHours = { DL: { openMin: 480, closeMin: 1320 }, DCA: { openMin: 480, closeMin: 1260 } };
  // hop explicitly null
  assert.doesNotThrow(() => {
    const blocks = deriveBlocks({ startPark: 'DL', hop: null }, parkHours);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].park, 'DL');
  });
});

test('deriveBlocks hop:undefined -> single park, never throws', () => {
  const parkHours = { DL: { openMin: 480, closeMin: 1320 }, DCA: { openMin: 480, closeMin: 1260 } };
  assert.doesNotThrow(() => {
    const blocks = deriveBlocks({ startPark: 'DCA' }, parkHours);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].park, 'DCA');
  });
});

test('deriveBlocks with VIP: VIP does NOT change blocks (still 1 block)', () => {
  const parkHours = { DL: { openMin: 480, closeMin: 1320 }, DCA: { openMin: 480, closeMin: 1260 } };
  const dayIntent = { startPark: 'DL', hop: null, vip: { startMin: 600, endMin: 840 } };
  const blocks = deriveBlocks(dayIntent, parkHours);
  // VIP is a time overlay — blocks should be unchanged (1 block, DL, full day)
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].park,     'DL');
  assert.equal(blocks[0].startMin, 480);
  assert.equal(blocks[0].endMin,   1320);
});

// ---------------------------------------------------------------------------
// whichParkAt
// ---------------------------------------------------------------------------
test('whichParkAt: at exactly atMin (hop boundary) -> second park', () => {
  // atMin=840: blocks[0].endMin=840, so min=840 is NOT < 840, falls to blocks[1]
  const blocks = [
    { park: 'DL',  startMin: 480, endMin: 840  },
    { park: 'DCA', startMin: 840, endMin: 1260 }
  ];
  assert.equal(whichParkAt(blocks, 840), 'DCA');
});

test('whichParkAt: just before atMin -> first park', () => {
  const blocks = [
    { park: 'DL',  startMin: 480, endMin: 840  },
    { park: 'DCA', startMin: 840, endMin: 1260 }
  ];
  assert.equal(whichParkAt(blocks, 839), 'DL');
});

test('whichParkAt: just after atMin -> second park', () => {
  const blocks = [
    { park: 'DL',  startMin: 480, endMin: 840  },
    { park: 'DCA', startMin: 840, endMin: 1260 }
  ];
  assert.equal(whichParkAt(blocks, 841), 'DCA');
});

test('whichParkAt: past close -> clamps to last block park', () => {
  const blocks = [
    { park: 'DL',  startMin: 480, endMin: 840  },
    { park: 'DCA', startMin: 840, endMin: 1260 }
  ];
  assert.equal(whichParkAt(blocks, 1440), 'DCA');
});

test('whichParkAt: single block, past close -> clamps to that block', () => {
  const blocks = [{ park: 'DL', startMin: 480, endMin: 1320 }];
  assert.equal(whichParkAt(blocks, 1400), 'DL');
});

test('whichParkAt: empty blocks -> default DL', () => {
  assert.equal(whichParkAt([], 600), 'DL');
});

// ---------------------------------------------------------------------------
// buildCatalogFilter
// ---------------------------------------------------------------------------
const MOCK_CATALOG = {
  attractions: [
    { id: 'rise', name: 'Rise of the Resistance', park: 'DL' },
    { id: 'rsr',  name: 'Radiator Springs Racers', park: 'DCA' },
    { id: 'ij',   name: 'Indiana Jones', park: 'DL' }
  ],
  venues: [
    { id: 'blue_bayou',       name: 'Blue Bayou Restaurant',  park: 'DL',  service: 'table',        exclude: false },
    { id: 'lamplight_lounge', name: 'Lamplight Lounge',        park: 'DCA', service: 'lounge',       exclude: false },
    { id: 'magic_key_terrace', name: 'Magic Key Terrace',      park: 'DCA', service: 'quickservice', exclude: true  },
    { id: 'carthay',          name: 'Carthay Circle Restaurant', park: 'DCA', service: 'table',      exclude: false }
  ]
};

test('buildCatalogFilter DL: returns only DL attractions, drops DCA', () => {
  const result = buildCatalogFilter(MOCK_CATALOG, 'DL');
  assert.equal(result.attractions.length, 2);
  assert.ok(result.attractions.every(a => a.park === 'DL'));
});

test('buildCatalogFilter DL: returns only DL venues', () => {
  const result = buildCatalogFilter(MOCK_CATALOG, 'DL');
  assert.equal(result.venues.length, 1);
  assert.equal(result.venues[0].name, 'Blue Bayou Restaurant');
});

test('buildCatalogFilter DCA: drops exclude:true venues (Magic Key Terrace)', () => {
  const result = buildCatalogFilter(MOCK_CATALOG, 'DCA');
  assert.equal(result.venues.length, 2, 'Should have Lamplight + Carthay, not Magic Key Terrace');
  assert.ok(result.venues.every(v => v.exclude !== true), 'No excluded venues should appear');
  assert.ok(!result.venues.some(v => v.name === 'Magic Key Terrace'), 'Magic Key Terrace must be absent');
});

test('buildCatalogFilter DCA: correct attraction count', () => {
  const result = buildCatalogFilter(MOCK_CATALOG, 'DCA');
  assert.equal(result.attractions.length, 1);
  assert.equal(result.attractions[0].id, 'rsr');
});

test('buildCatalogFilter: null catalog -> empty arrays, no throw', () => {
  assert.doesNotThrow(() => {
    const result = buildCatalogFilter(null, 'DL');
    assert.equal(result.attractions.length, 0);
    assert.equal(result.venues.length, 0);
  });
});

test('buildCatalogFilter: case-insensitive park match', () => {
  const result = buildCatalogFilter(MOCK_CATALOG, 'dl');
  assert.equal(result.attractions.length, 2);
});
