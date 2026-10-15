#!/usr/bin/env node
// ---------------------------------------------------------------------------
// youtube-embeds.mjs -- reviewed YouTube embed pass for the TPCP blog.
//
// This is the first bulk job run under the agent-token process (PR #64
// reads, PR #65-era editor work, and this PR's blog-save change): a
// committed, reviewed file instead of a console snippet. The console
// snippet it replaces carried a latent bug worth recording -- it sent
// the credential in an Authorization header the endpoints never read;
// this script transports through the tpcp-api connector helper, which
// places the BLOG_AGENT_TOKEN in the x-admin-key header.
//
// What it does, per job (scripts/youtube-embeds.jobs.json):
//   - reads the post through the agent-token API,
//   - inserts (or replaces) one responsive YouTube embed by Beau's
//     placement rules: at/after the halfway point by visible text,
//     both neighbors non-photo and non-embed, preferring the boundary
//     immediately before an <h2> inside the 50-80% window,
//   - proves the visible text and the image set are unchanged,
//   - saves through blog-save, and verifies the result in storage.
//
// Safety shape (same guards as the proven spacer cleanup):
//   - dry-run first: --stage fetches and plans, writes a state file
//     holding each post's updatedAt and body, and writes NOTHING.
//   - --commit refuses to save a post whose updatedAt moved since
//     staging (SKIP, never overwrite someone else's edit).
//   - 409 INDEX_CONFLICT counts as landed (the body write succeeded;
//     the index lags), exactly as blog-save's contract defines it.
//   - on 429 the commit waits out the window, re-reads the post, and
//     retries at most once, only if the post is untouched.
//   - every save is verified by re-reading storage (lag-aware polls).
//   - resumable: the state file records done/skipped/problems and a
//     re-run skips finished jobs. Saves pace at 10s+ (30/hour per IP).
//
// Transport: the tpcp-api helper from the custom.tpcp-blog-agent
// connector (override with --api <path> or $TPCP_API). The script
// itself never sees the credential.
//
// Usage:
//   node scripts/youtube-embeds.mjs --stage [--state f] [--only a,b]
//   node scripts/youtube-embeds.mjs --commit --start 0 --count 30 [--state f]
//   node scripts/youtube-embeds.mjs --report [--state f]
// ---------------------------------------------------------------------------
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Pure placement engine (no dependencies). The block splitter below is a
// small tag tokenizer for the well-formed HTML the Quill editor stores;
// splitBlocks + applyJob were differentially tested against the jsdom
// implementation used in the offline placement study across all 50 real
// post bodies, with identical results on every job (Oct 15, 2026).
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const TOKEN_RE = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+/g;

export function splitBlocks(body) {
  const blocks = [];
  let loose = false;
  let depth = 0;
  let current = null;
  for (const m of (body || '').matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (tok.startsWith('<!--') || tok.startsWith('<!')) {
      if (depth === 0) { if (current === null) blocks.push(tok); else current += tok; }
      else current += tok;
      continue;
    }
    if (tok.startsWith('<')) {
      const close = tok.startsWith('</');
      const name = (tok.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/) || [])[1]?.toLowerCase() || '';
      const selfClose = /\/>$/.test(tok) || VOID_TAGS.has(name);
      if (depth === 0 && current === null && !close) {
        if (selfClose) { blocks.push(tok); continue; }
        current = tok; depth = 1; continue;
      }
      if (current !== null) {
        current += tok;
        if (close) depth--;
        else if (!selfClose) depth++;
        if (depth === 0) { blocks.push(current); current = null; }
      }
      continue;
    }
    // text token
    if (depth === 0) { if (tok.trim() !== '') loose = true; }
    else current += tok;
  }
  if (current !== null) blocks.push(current); // unterminated tail: kept whole; applyJob invariants still gate the save
  return { blocks, loose };
}

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function textOf(html) {
  let out = '';
  for (const m of (html || '').matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (tok.startsWith('<')) continue;
    out += tok.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (w, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : w;
      }
      return ENTITY[e] ?? w;
    });
  }
  return out;
}
const textLen = html => textOf(html).replace(/\s+/g, '').length;
const hasImg = html => /<img[\s>]/i.test(html);
const hasEmbed = html => /youtube\.com\/embed|ql-video-wrapper/i.test(html);
const isH2 = html => /^<h2[\s>]/i.test(html.trim());

export function embedHtml(id) {
  return `<div class="ql-video-wrapper" contenteditable="false" style="position: relative; padding-bottom: 56.25%; height: 0px; overflow: hidden; margin: 24px 0px; border-radius: 8px;"><iframe src="https://www.youtube.com/embed/${id}" frameborder="0" allowfullscreen="true" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" style="position: absolute; top: 0px; left: 0px; width: 100%; height: 100%; border-radius: 8px;"></iframe></div>`;
}

export function chooseInsertion(blocks) {
  const lens = blocks.map(textLen);
  const total = lens.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const cum = [0];
  for (const l of lens) cum.push(cum[cum.length - 1] + l);
  const valid = i => i > 0 && i < blocks.length && !hasImg(blocks[i - 1]) && !hasEmbed(blocks[i - 1]) && !hasImg(blocks[i]) && !hasEmbed(blocks[i]);
  let firstValid = -1;
  for (let i = 1; i < blocks.length; i++) {
    const frac = cum[i] / total;
    if (frac < 0.5) continue;
    if (!valid(i)) continue;
    if (firstValid === -1) firstValid = i;
    if (frac <= 0.8 && isH2(blocks[i])) return { index: i, frac, via: 'before-h2' };
    if (frac > 0.8 && firstValid !== -1) break;
  }
  if (firstValid !== -1) return { index: firstValid, frac: cum[firstValid] / total, via: 'first-valid' };
  for (let i = 1; i < blocks.length; i++) {
    if (cum[i] / total >= 0.5 && !hasImg(blocks[i])) return { index: i, frac: cum[i] / total, via: 'RELAXED' };
  }
  return null;
}

export function applyJob(body, job) {
  const { blocks, loose } = splitBlocks(body);
  if (loose) return { error: 'loose-top-level-text' };
  let work = blocks.slice();
  if (job.mode === 'replace') {
    const n = work.length;
    work = work.filter(b => !hasEmbed(b));
    if (work.length === n) return { error: 'replace-mode-but-no-existing-embed' };
  } else if (work.some(hasEmbed)) {
    return { error: 'new-mode-but-embed-already-present' };
  }
  const pick = chooseInsertion(work);
  if (!pick) return { error: 'no-valid-insertion-point' };
  work.splice(pick.index, 0, embedHtml(job.videoId));
  return { body: work.join(''), pick };
}

export function checkInvariants(oldBody, newBody) {
  const imgs = h => [...(h || '').matchAll(/<img[^>]+src="([^"]+)"/gi)].map(m => m[1]).sort();
  return {
    textSame: textOf(oldBody).replace(/\s+/g, '') === textOf(newBody).replace(/\s+/g, ''),
    imgsSame: JSON.stringify(imgs(oldBody)) === JSON.stringify(imgs(newBody)),
  };
}

// ---------------------------------------------------------------------------
// CLI: transport through the tpcp-api connector helper.
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));
const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { state: '.youtube-embeds-state.json', jobs: join(HERE, 'youtube-embeds.jobs.json'), api: process.env.TPCP_API || join(process.env.HOME, 'workspace/custom-connectors/custom.tpcp-blog-agent/bin/tpcp-api'), start: 0, count: Infinity, only: null, mode: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stage') args.mode = 'stage';
    else if (a === '--commit') args.mode = 'commit';
    else if (a === '--report') args.mode = 'report';
    else if (a === '--state') args.state = argv[++i];
    else if (a === '--jobs') args.jobs = argv[++i];
    else if (a === '--api') args.api = argv[++i];
    else if (a === '--start') args.start = parseInt(argv[++i], 10);
    else if (a === '--count') args.count = parseInt(argv[++i], 10);
    else if (a === '--only') args.only = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
  }
  return args;
}

let lastCallAt = 0;

async function callApi(apiPath, method, path, bodyObj) {
  const wait = 3500 - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  const argv = [method, path];
  if (bodyObj !== undefined) {
    const bodyFile = join(process.env.TMPDIR || '/tmp', `yte-body-${process.pid}-${Date.now()}.json`);
    writeFileSync(bodyFile, JSON.stringify(bodyObj));
    argv.push(bodyFile);
  }
  return new Promise(resolve => {
    execFile(apiPath, argv, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const http = (stderr.match(/HTTP (\d+)/) || [])[1];
      const status = err ? (http ? parseInt(http, 10) : -1) : 200;
      let json = null;
      if (status === 200) { try { json = JSON.parse(stdout); } catch { /* leave null */ } }
      else { try { json = JSON.parse(stderr.split('\n').slice(1).join('\n')); } catch { /* error payload not JSON */ } }
      resolve({ status, json, stderr });
    });
  });
}

async function getPost(apiPath, slug) {
  for (let a = 0; a < 4; a++) {
    const r = await callApi(apiPath, 'GET', '/api/blog-admin-post?slug=' + encodeURIComponent(slug));
    if (r.status === 200) return r.json;
    if (r.status !== 429 && r.status < 500) return null;
    await sleep(a === 0 ? 5000 : 15000);
  }
  return null;
}

function loadState(path) {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  return { kind: 'tpcp-youtube-embeds-state', stagedAt: null, staged: {}, done: {}, results: [] };
}
function saveState(path, state) { writeFileSync(path, JSON.stringify(state, null, 1)); }

async function stage(args, jobs) {
  const state = loadState(args.state);
  const list = args.only ? jobs.filter(j => args.only.includes(j.slug)) : jobs;
  let problems = 0;
  for (const job of list) {
    const post = await getPost(args.api, job.slug);
    if (!post) { console.log('PROBLEM(stage-fetch):', job.slug); problems++; continue; }
    const r = applyJob(post.body, job);
    if (r.error) { console.log('PROBLEM(stage-apply):', job.slug, r.error); problems++; continue; }
    state.staged[job.slug] = { updatedAt: post.updatedAt, body: post.body };
    console.log(`STAGED ${job.slug} -> ${job.videoId} @ ${(r.pick.frac * 100).toFixed(0)}% (${r.pick.via})`);
  }
  state.stagedAt = new Date().toISOString();
  saveState(args.state, state);
  console.log(`\nSTAGE COMPLETE — staged: ${Object.keys(state.staged).length}/${jobs.length}, problems: ${problems}. State: ${args.state}`);
  return problems ? 1 : 0;
}

async function trySave(apiPath, post, newBody) {
  const outgoing = { ...post, body: newBody, updatedAt: new Date().toISOString() };
  const r = await callApi(apiPath, 'POST', '/api/blog-save', outgoing);
  if (r.status === 200 && r.json && r.json.success) return 'saved';
  if (r.status === 409 && r.json && r.json.code === 'INDEX_CONFLICT') return 'saved-409';
  if (r.status === 429) return 'throttled';
  return 'error:' + r.status;
}

async function verifySaved(apiPath, job, preBody) {
  for (let a = 0; a < 6; a++) {
    await sleep(a === 0 ? 3000 : 5000);
    const check = await getPost(apiPath, job.slug);
    if (!check) continue;
    const body = check.body || '';
    const hasNew = body.includes('youtube.com/embed/' + job.videoId);
    const embedCount = (body.match(/youtube\.com\/embed\//g) || []).length;
    const inv = checkInvariants(preBody, body);
    if (hasNew && embedCount === 1 && inv.textSame && inv.imgsSame) return true;
  }
  return false;
}

async function commitOne(args, state, job) {
  const snap = state.staged[job.slug];
  if (!snap) return { slug: job.slug, status: 'PROBLEM-not-staged' };
  const post = await getPost(args.api, job.slug);
  if (!post) return { slug: job.slug, status: 'PROBLEM-fetch' };
  if (post.updatedAt !== snap.updatedAt || (post.body || '') !== snap.body) {
    return { slug: job.slug, status: 'SKIPPED-changed-since-stage' };
  }
  const r = applyJob(post.body, job);
  if (r.error) return { slug: job.slug, status: 'PROBLEM-apply:' + r.error };
  const inv = checkInvariants(post.body, r.body);
  if (!inv.textSame || !inv.imgsSame) return { slug: job.slug, status: 'PROBLEM-invariants' };
  let note = await trySave(args.api, post, r.body);
  if (note === 'throttled') {
    console.log('throttled on', job.slug, '— cooling down 60s, re-checking, one retry');
    await sleep(60000);
    const p2 = await getPost(args.api, job.slug);
    if (p2 && (p2.body || '').includes('youtube.com/embed/' + job.videoId)) note = 'saved';
    else if (p2 && p2.updatedAt === snap.updatedAt && (p2.body || '') === snap.body) note = await trySave(args.api, p2, r.body);
    else note = 'state-changed-during-cooldown';
  }
  if (note === 'saved' || note === 'saved-409') {
    const ok = await verifySaved(args.api, job, post.body);
    return { slug: job.slug, status: ok ? note + '-verified' : 'PROBLEM-unverified-after-save', insertPct: Math.round(r.pick.frac * 100) };
  }
  return { slug: job.slug, status: 'PROBLEM-save:' + note };
}

async function commit(args, jobs) {
  const state = loadState(args.state);
  if (!state.stagedAt) { console.log('NO STAGED STATE — run --stage first.'); return 1; }
  const slice = jobs.slice(args.start, args.start + args.count);
  let problems = 0;
  for (const job of slice) {
    if (state.done[job.slug]) { console.log('already done, skipping:', job.slug); continue; }
    const res = await commitOne(args, state, job);
    state.results.push({ ...res, at: new Date().toISOString() });
    if (res.status.startsWith('saved')) state.done[job.slug] = res.status;
    else if (!res.status.startsWith('SKIPPED')) problems++;
    saveState(args.state, state);
    console.log(res.status.toUpperCase(), job.slug, res.insertPct ? '@ ' + res.insertPct + '%' : '');
    await sleep(10000); // save pacing: the 30/hour/IP budget is the binding limit
  }
  const tally = {};
  for (const r of state.results) tally[r.status] = (tally[r.status] || 0) + 1;
  console.log('\nCOMMIT COMPLETE — tally so far:', JSON.stringify(tally));
  return problems ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jobsDoc = JSON.parse(readFileSync(args.jobs, 'utf8'));
  const jobs = jobsDoc.jobs;
  if (args.mode === 'stage') process.exit(await stage(args, jobs));
  if (args.mode === 'commit') process.exit(await commit(args, jobs));
  if (args.mode === 'report') {
    const state = loadState(args.state);
    console.log('staged:', Object.keys(state.staged).length, '| done:', Object.keys(state.done).length, '| results:', state.results.length);
    for (const r of state.results) console.log(r.status, r.slug);
    return;
  }
  console.log('Usage: youtube-embeds.mjs --stage | --commit --start N --count M | --report  [--state f] [--jobs f] [--api path] [--only a,b]');
}

if (import.meta.url === 'file://' + process.argv[1]) await main();
