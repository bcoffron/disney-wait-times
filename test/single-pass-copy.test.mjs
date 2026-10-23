// Tests for the "buy at 7" copy audit fixes (Claude ruling, Oct 23,
// 2026; item 16 step 0). The research found there is NO 7:00 AM Single
// Pass drop at Disneyland: Single Pass is bought day-of, after the
// guest scans into a park, for the next available window (the 7 AM
// figure is Walt Disney World's advance-booking system). Four shipped
// surfaces stated or implied the wrong rule; this suite pins the
// corrected copy:
//   1. api/cron-push-monitor.js llOrderBody -- the game-plan push's
//      Single Pass clause said "Buy <ride> at 7." (the exact text the
//      leader received the morning of Oct 23).
//   2. app.html guide card "Lightning Lane Strategy" -- "Buy as soon
//      as the park opens at 7 AM."
//   3. app.html Ask-AI LL strategy prompt -- "(or 7AM on-site)".
//   4. pretrip.html generation prompt -- "tip card at 7:00 AM telling
//      them to purchase ILL immediately at park open."
// The monitor's 7:00 AM ALERT gate is a separate, deliberate decision
// (Beau, Oct 23; PR #121) and is untouched by these fixes.
//
// Run with Node's built-in runner (no new dependencies):
//   node --test test/single-pass-copy.test.mjs
// @vercel/blob and web-push are redirected to inline stubs via
// module.register hooks (the ll-order-gate suite's pattern); the
// monitor module is otherwise the real shipped file.
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const blobStubSrc = [
  'export async function list() { return { blobs: [] }; }',
  'export async function put() { throw new Error("put not stubbed"); }',
  'export async function del() {}',
  'export async function get() { return null; }',
].join('\n');
const webpushStubSrc = [
  'export default {',
  '  setVapidDetails() {},',
  '  async sendNotification() { return {}; }',
  '};',
].join('\n');

const hooksSrc = [
  'let blobUrl = "", wpUrl = "";',
  'export async function initialize(data) { blobUrl = data.blob; wpUrl = data.wp; }',
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === '@vercel/blob') return { url: blobUrl, shortCircuit: true };",
  "  if (specifier === 'web-push') return { url: wpUrl, shortCircuit: true };",
  '  return nextResolve(specifier, context);',
  '}',
].join('\n');

register('data:text/javascript;base64,' + Buffer.from(hooksSrc).toString('base64'), {
  data: {
    blob: 'data:text/javascript;base64,' + Buffer.from(blobStubSrc).toString('base64'),
    wp: 'data:text/javascript;base64,' + Buffer.from(webpushStubSrc).toString('base64'),
  },
});

const { llOrderBody } = await import('../api/cron-push-monitor.js');

// ------------------------------------------------------------- push body
test('zero singles: the Option A Multi Pass body is byte-identical', () => {
  const body = llOrderBody({ bookFirst: 'Space Mountain', order: ['Space Mountain', 'Indiana Jones Adventure'], singleSeparate: [] });
  assert.equal(body, 'Book Space Mountain first, then Indiana Jones Adventure.');
});

test('one single: clause names the post-entry rule, never a 7 AM purchase', () => {
  const body = llOrderBody({ bookFirst: 'Space Mountain', order: ['Space Mountain'], singleSeparate: ['Radiator Springs Racers'] });
  assert.equal(body, 'Buy Radiator Springs Racers once you’re in the park. Book Space Mountain first.');
  assert.ok(!/at 7/.test(body));
  assert.ok(body.length <= 100, 'lock-screen budget: ' + body.length);
});

test('two singles: counted, post-entry clause first, within budget', () => {
  const body = llOrderBody({
    bookFirst: 'Space Mountain',
    order: ['Space Mountain', 'Indiana Jones Adventure', 'Matterhorn Bobsleds'],
    singleSeparate: ['Star Wars: Rise of the Resistance', 'Radiator Springs Racers'],
  });
  assert.equal(body, 'Buy your 2 Single Passes once you’re in the park. Book Space Mountain first, and 2 more.');
  assert.ok(!/at 7/.test(body));
  assert.ok(body.length <= 100, 'lock-screen budget: ' + body.length);
});

test('long single name + long order: cascade keeps clause and stays in budget', () => {
  const body = llOrderBody({
    bookFirst: 'Space Mountain',
    order: ['Space Mountain', 'Indiana Jones Adventure', 'Matterhorn Bobsleds', 'Big Thunder Mountain Railroad'],
    singleSeparate: ['Star Wars: Rise of the Resistance'],
  });
  assert.ok(body.startsWith('Buy Star Wars: Rise of the Resistance once you’re in the park. '), body);
  assert.ok(!/at 7/.test(body));
  assert.ok(body.length <= 100, 'lock-screen budget: ' + body.length);
});

// ------------------------------------------------------- static copy pins
const appHtml = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const pretripHtml = readFileSync(new URL('../pretrip.html', import.meta.url), 'utf8');
const monitorSrc = readFileSync(new URL('../api/cron-push-monitor.js', import.meta.url), 'utf8');

test('app guide card teaches the post-entry rule', () => {
  assert.ok(!appHtml.includes('Buy as soon as the park opens at 7 AM'));
  assert.ok(appHtml.includes('Single Pass (Rise of the Resistance): You can only buy it after you scan into the park, and you get the next open return time.'));
});

test('app Ask-AI prompt no longer implies a 7 AM booking', () => {
  assert.ok(!appHtml.includes('7AM on-site'));
  assert.ok(appHtml.includes('First ride to book right after you scan into the park'));
});

test('pretrip generation prompt no longer instructs a 7 AM purchase tip', () => {
  assert.ok(!pretripHtml.includes('tip card at 7:00 AM'));
  assert.ok(!pretripHtml.includes('purchase ILL immediately at park open'));
  assert.ok(pretripHtml.includes('buy ILL right after they scan into the park'));
});

test('monitor source carries no buy-at-7 clause text', () => {
  assert.ok(!monitorSrc.includes('at 7. '), 'stale singles clause remains');
});
