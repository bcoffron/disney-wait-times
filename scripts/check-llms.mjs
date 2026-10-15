#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-llms.mjs -- llms.txt DRIFT CHECK (Oct 14, 2026).
//
// llms.txt (repo root, served at /llms.txt) carries a hand-maintained index
// of every published guide: title, meta description, URL, grouped by park.
// It silently goes stale on every publish, retitle, or meta-description
// edit. This check asserts the file still mirrors the live blog:
//   1. one llms.txt entry per published post in the public feed, no extras
//   2. each entry's title equals the post's title, and the entry sits in
//      the section matching the post's park (dl / wdw / both)
//   3. each entry's description equals the description the post page
//      actually renders in its <meta name="description">
//   4. static guards from the PR #56 corrections: the file names
//      Lunchbox Dad, LLC and must never again contain "Co-Pilot Labs"
//      or "progressive web app"
//
// Run: node scripts/check-llms.mjs   (exit 1 on any drift)
// Needs network access to themeparkcopilot.com. LLMS_PATH env var can
// point at an alternate llms.txt (used by tests). Post pages are fetched
// sequentially with a short pause — this is a maintainer check, not a
// hot path.
// ---------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LLMS = process.env.LLMS_PATH || path.join(ROOT, 'llms.txt');
const BASE = 'https://themeparkcopilot.com';
const failures = [];
const fail = (m) => failures.push(m);

const SECTION_BY_PARK = {
  dl: 'Disneyland Resort guides',
  wdw: 'Walt Disney World guides',
  both: 'Comparisons and trip planning',
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const text = fs.readFileSync(LLMS, 'utf8');

  // Static guards.
  if (!text.includes('Lunchbox Dad, LLC')) fail('llms.txt does not name Lunchbox Dad, LLC');
  if (/Co-Pilot Labs/i.test(text)) fail('llms.txt contains the retired entity name "Co-Pilot Labs"');
  if (/progressive web app/i.test(text)) fail('llms.txt describes the product as a "progressive web app"');

  // Parse entries with their current ### section.
  const entries = [];
  let section = '';
  for (const line of text.split('\n')) {
    const h = line.match(/^###\s+(.*)$/);
    if (h) { section = h[1].trim(); continue; }
    const m = line.match(/^- \[(.*)\]\((https:\/\/themeparkcopilot\.com\/blog\/([a-z0-9-]+))\): (.*)$/);
    if (m) entries.push({ title: m[1], url: m[2], slug: m[3], desc: m[4].trim(), section });
  }

  // Live published set from the public feed.
  const feedRes = await fetch(BASE + '/api/blog-index');
  if (!feedRes.ok) { fail('blog feed fetch failed: HTTP ' + feedRes.status); return report(entries.length, 0); }
  const feed = await feedRes.json();
  const posts = (Array.isArray(feed) ? feed : []).filter((p) => p && p.published === true && p.slug);
  const bySlug = new Map(posts.map((p) => [p.slug, p]));

  if (entries.length !== posts.length) {
    fail('entry count ' + entries.length + ' != published posts ' + posts.length);
  }

  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.slug)) fail('duplicate llms.txt entry for ' + e.slug);
    seen.add(e.slug);
    const post = bySlug.get(e.slug);
    if (!post) { fail('llms.txt entry has no published post: ' + e.slug); continue; }
    if (e.title !== post.title) fail('title drift for ' + e.slug + ': llms.txt "' + e.title + '" vs post "' + post.title + '"');
    const wantSection = SECTION_BY_PARK[post.park || 'both'];
    if (wantSection && e.section !== wantSection) {
      fail('section drift for ' + e.slug + ': entry is under "' + e.section + '", park ' + (post.park || 'both') + ' belongs under "' + wantSection + '"');
    }
  }
  for (const p of posts) {
    if (!seen.has(p.slug)) fail('published post missing from llms.txt: ' + p.slug);
  }

  // Description truth: the meta description each post page renders.
  let checked = 0;
  for (const e of entries) {
    if (!bySlug.has(e.slug)) continue;
    const res = await fetch(BASE + '/blog/' + e.slug);
    if (!res.ok) { fail('post page fetch failed for ' + e.slug + ': HTTP ' + res.status); continue; }
    const html = await res.text();
    const m = html.match(/<meta name="description" content="([^"]*)"/);
    if (!m) { fail('no meta description rendered for ' + e.slug); continue; }
    const rendered = decodeEntities(m[1]).trim();
    if (rendered !== e.desc) {
      fail('description drift for ' + e.slug + ':\n    llms.txt: ' + e.desc + '\n    rendered: ' + rendered);
    }
    checked++;
    await sleep(150);
  }

  report(entries.length, checked);
}

function report(entryCount, descChecked) {
  if (failures.length) {
    console.error('LLMS.TXT DRIFT (' + failures.length + '):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('llms.txt OK: ' + entryCount + ' entries mirror the live blog (' + descChecked + ' descriptions verified against rendered post pages); entity guards pass.');
}

main().catch((e) => { console.error('check-llms error:', e.message); process.exit(1); });
