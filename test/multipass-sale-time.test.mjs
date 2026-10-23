// Tests for the "Multi Pass goes on sale at 7 AM" copy fix (Oct 23,
// 2026; item 17). Research verdict (dl-multipass-sale-time-20261023):
// the claim is FALSE for Disneyland -- there is no daily sale-opening
// time. Day-of in-app purchase unlocks only once the guest has scanned
// into their first park (first selection unlocks at the same moment);
// the only advance path is an add-on covering every day of the ticket.
//
// Two user-visible setup lines in pretrip.html carried the claim
// verbatim ("Lightning Lane Multi Pass goes on sale at 7 AM each day --
// earlier picks are better picks."): the Step 6 "Important to-dos"
// card and the generating screen's "While we work" to-dos. Both now
// carry the accurate sentence. This suite pins the corrected copy and
// sweeps the other LL-copy surfaces (app.html + the api/ files that
// carry user-facing Lightning Lane text) for the same claim.
//
// NOT claims, deliberately untouched and not flagged here:
//   - api/cron-push-monitor.js's 7:00 AM park-local ALERT gate
//     (LL_ORDER_EARLIEST_MIN) -- Beau's deliberate alert-delivery
//     decision (PR #121), not purchase copy.
//   - app.html's PR #126 Single Pass line ("goes on sale once you've
//     scanned into the park") -- the corrected Single Pass rule.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/multipass-sale-time.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const pretripHtml = read('../pretrip.html');
const appHtml = read('../app.html');
const apiFiles = {
  'api/generateschedule.js': read('../api/generateschedule.js'),
  'api/reoptimize.js': read('../api/reoptimize.js'),
  'api/ai.js': read('../api/ai.js'),
  'api/cron-push-monitor.js': read('../api/cron-push-monitor.js'),
  'api/cron-booking-alerts.js': read('../api/cron-booking-alerts.js'),
  'api/scaffold.js': read('../api/scaffold.js'),
  'api/validate-schedule.js': read('../api/validate-schedule.js'),
  'api/trip.js': read('../api/trip.js'),
};

// Single-line claim shapes: a daily 7 AM sale/purchase moment for
// Multi Pass. Phrased narrowly so historical comments (PR #126's
// "said \"at 7\"" note) and the alert-gate comments never match.
const CLAIM_PATTERNS = [
  /goes on sale at 7/i,
  /on sale at 7/i,
  /multi pass[^.\n]{0,40}on sale/i,
  /buy[^.\n]{0,40}multi pass[^.\n]{0,30}at 7/i,
  /multi pass[^.\n]{0,30}at 7 (am|a\.m\.)/i,
];

function assertNoClaim(name, src) {
  for (const pat of CLAIM_PATTERNS) {
    assert.ok(!pat.test(src), name + ' still carries a Multi Pass sale-time claim: ' + pat);
  }
}

const CORRECTED =
  "Lightning Lane Multi Pass isn't sold at a set time — buy it ahead as an add-on for every day of your ticket, or in the app once you've scanned into the park. Your first pick opens at entry too.";

test('pretrip: the 7 AM sale claim is gone', () => {
  assertNoClaim('pretrip.html', pretripHtml);
  assert.ok(!pretripHtml.includes('goes on sale at 7 AM each day'));
  assert.ok(!pretripHtml.includes('earlier picks are better picks'));
});

test('pretrip: the corrected sentence appears in both to-do lists', () => {
  const count = pretripHtml.split(CORRECTED).length - 1;
  assert.equal(count, 2, 'expected the corrected sentence twice (Step 6 card + generating screen), found ' + count);
});

test('app.html carries no Multi Pass sale-time claim', () => {
  assertNoClaim('app.html', appHtml);
});

test('app.html still teaches the post-entry purchase rule', () => {
  assert.ok(appHtml.includes('You buy Multi Pass after scanning in at the gate.'));
});

test('api/ LL-copy surfaces carry no Multi Pass sale-time claim', () => {
  for (const [name, src] of Object.entries(apiFiles)) assertNoClaim(name, src);
});

test('the deliberate 7 AM alert-delivery gate is untouched', () => {
  const monitor = apiFiles['api/cron-push-monitor.js'];
  assert.ok(monitor.includes('LL_ORDER_EARLIEST_MIN'), 'alert gate constant missing -- the delivery gate is not copy and must not be removed by a copy fix');
});

test('the PR #126 Single Pass post-entry line is not regressed', () => {
  // (the line is stored in app.html source with a \u2019 escape)
  assert.ok(appHtml.includes('Single Pass goes on sale once you\\u2019ve scanned into the park.'));
});
