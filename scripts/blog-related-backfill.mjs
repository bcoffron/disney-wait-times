#!/usr/bin/env node
// ---------------------------------------------------------------------------
// blog-related-backfill.mjs -- one-time relatedSource backfill for the
// related-auto lane (Nov 9, 2026).
//
// Every post that predates api/lib/related.js has a `related` list but
// NO `relatedSource`. The save/sweep paths treat those as manual
// (preserved verbatim) so deploying the resolver is a no-op for the
// existing corpus - this script is the reviewed step that migrates
// them: by default every legacy list becomes 'auto' (they were made
// at creation, the only way that existed then); slugs named in the
// keeps list become 'manual' with their existing list; lists already
// marked 'manual' by real editor edits after the deploy stay manual.
//
// SAFETY SHAPE:
// - DRY RUN IS THE DEFAULT. It writes nothing - no blob writes, no
//   restore file - and prints the full review report (current vs
//   computed per post, with score explanations, inbound counts
//   before/after, and zero-inbound flags).
// - --write requires --keeps <file> (the reviewed keeps list; the
//   file may be empty). Before the first write it saves a restore
//   file (every post's slug + related + relatedSource) and prints
//   its path. Only posts whose stored (related, relatedSource)
//   would change are written; `updatedAt` is never touched.
// - --restore <file> writes a restore file's lists back (same
//   changed-only rule), for undoing a bad write run.
//
// Usage:
//   node scripts/blog-related-backfill.mjs [--report out.md]
//   node scripts/blog-related-backfill.mjs --write --keeps keeps.txt [--report out.md]
//   node scripts/blog-related-backfill.mjs --restore blog-related-restore-<ts>.json
//
// Reads/writes go through @vercel/blob like the rest of the blog
// tooling: run with BLOB_READ_WRITE_TOKEN in the environment (e.g.
// via `vercel env pull`). Corpus assembly (which blob copy wins per
// slug) reuses buildCandidate - the same code reconcile/reindex run.
// ---------------------------------------------------------------------------
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { put } from '@vercel/blob';
import { buildCandidate } from '../api/lib/reindex-candidate.js';
import { computeRelated, explainRelated, relatedListsEqual } from '../api/lib/related.js';

export function corpusOf(posts) {
  return posts.map(p => ({
    slug: p.slug, title: p.title, park: p.park, category: p.category,
    heroImage: p.heroImage, published: p.published,
    publishedAt: p.publishedAt, tags: p.tags || []
  }));
}

// The migration plan for a corpus of full post objects. Pure: the
// caller decides what (if anything) to write.
export function planBackfill(posts, keepsSlugs = []) {
  const keeps = new Set(keepsSlugs);
  const corpus = corpusOf(posts);
  const entries = posts.map(post => {
    const oldSource = post.relatedSource || null;
    const oldList = post.related || [];
    let newSource, newList, reason;
    if (oldSource === 'manual') {
      newSource = 'manual'; newList = oldList; reason = 'already manual (real editor edit) - untouched';
    } else if (keeps.has(post.slug)) {
      newSource = 'manual'; newList = oldList; reason = 'kept manual by review';
    } else {
      newSource = 'auto'; newList = computeRelated(post, corpus); reason = oldSource === 'auto' ? 'already auto - recomputed' : 'legacy - becomes auto';
    }
    const changed = newSource !== oldSource || !relatedListsEqual(newList, oldList);
    return { slug: post.slug, oldSource, oldList, newSource, newList, changed, reason };
  });
  return { entries, corpus };
}

export function buildRestoreFile(posts, nowIso) {
  return {
    kind: 'blog-related-restore',
    version: 1,
    createdAt: nowIso,
    entries: posts.map(p => ({
      slug: p.slug,
      related: p.related || [],
      relatedSource: p.relatedSource || null
    }))
  };
}

// Apply a restore file to post objects (pure): returns new post
// objects with related/relatedSource exactly as recorded.
export function applyRestore(posts, restoreFile) {
  const bySlug = new Map((restoreFile.entries || []).map(e => [e.slug, e]));
  return posts.map(p => {
    const entry = bySlug.get(p.slug);
    if (!entry) return p;
    const next = { ...p, related: entry.related || [] };
    if (entry.relatedSource) next.relatedSource = entry.relatedSource;
    else delete next.relatedSource;
    return next;
  });
}

// Inbound counts from PUBLISHED sources only (a draft's stored list
// renders nowhere). listOf: post -> its related list.
export function countInbound(posts, listOf) {
  const counts = new Map();
  for (const p of posts) {
    if (p.published !== true) continue;
    for (const r of listOf(p) || []) {
      if (r && r.slug) counts.set(r.slug, (counts.get(r.slug) || 0) + 1);
    }
  }
  return counts;
}

export function formatReport(posts, plan) {
  const bySlug = new Map(posts.map(p => [p.slug, p]));
  const planBySlug = new Map(plan.entries.map(e => [e.slug, e]));
  const inboundBefore = countInbound(posts, p => p.related || []);
  const inboundAfter = countInbound(posts, p => (planBySlug.get(p.slug) || {}).newList || []);
  const lines = [];
  lines.push('# Related backfill - dry-run report');
  lines.push('');
  lines.push('Posts: ' + posts.length + ' - changed by the plan: ' + plan.entries.filter(e => e.changed).length);
  lines.push('');
  lines.push('## Zero inbound after the plan');
  lines.push('');
  const zeroAfter = posts.filter(p => p.published === true && !inboundAfter.get(p.slug)).map(p => p.slug).sort();
  if (zeroAfter.length) for (const s of zeroAfter) lines.push('- ' + s);
  else lines.push('- (none)');
  lines.push('');
  lines.push('## Per post');
  for (const e of plan.entries) {
    const post = bySlug.get(e.slug);
    lines.push('');
    lines.push('### ' + e.slug);
    lines.push('- source: ' + (e.oldSource || 'legacy') + ' -> ' + e.newSource + ' (' + e.reason + ')' + (e.changed ? '' : ' - unchanged, not written'));
    lines.push('- current: [' + e.oldList.map(r => r.slug).join(', ') + ']');
    lines.push('- planned: [' + e.newList.map(r => r.slug).join(', ') + ']');
    lines.push('- inbound: ' + (inboundBefore.get(e.slug) || 0) + ' -> ' + (inboundAfter.get(e.slug) || 0));
    if (e.newSource === 'auto') {
      const explained = explainRelated(post, plan.corpus);
      const top = explained.slice(0, 2);
      for (const c of top) {
        const tagBits = c.parts.tags.map(t => t.tag + ' ' + t.idf).join(', ') || 'no shared tags';
        lines.push('  - pick ' + c.slug + ' (score ' + c.score + '): ' + tagBits + '; park ' + c.parts.park + '; category ' + c.parts.category);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

// Injectable run: readPosts/writePost/saveRestoreFile are the IO
// seams the gate suite fakes. mode 'dry' performs ZERO writes of any
// kind (no post writes, no restore file).
export async function runBackfill({ posts, keeps = [], mode = 'dry', writePost, saveRestoreFile, nowIso }) {
  const plan = planBackfill(posts, keeps);
  const report = formatReport(posts, plan);
  const result = { plan, report, wrote: [], restoreSaved: false };
  if (mode !== 'write') return result;
  await saveRestoreFile(buildRestoreFile(posts, nowIso));
  result.restoreSaved = true;
  const bySlug = new Map(posts.map(p => [p.slug, p]));
  for (const e of plan.entries) {
    if (!e.changed) continue;
    const post = bySlug.get(e.slug);
    // updatedAt is carried over untouched - a provenance migration
    // is not a content edit.
    await writePost(e.slug, { ...post, related: e.newList, relatedSource: e.newSource });
    result.wrote.push(e.slug);
  }
  return result;
}

async function readKeeps(path) {
  if (!path) return [];
  const text = await readFile(path, 'utf8');
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed).map(String);
  return trimmed.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const { posts, errors } = await buildCandidate();
  if (errors.length) {
    console.error('Corpus build incomplete - refusing to plan from a partial corpus: ' + errors.join('; '));
    process.exit(1);
  }
  const writePost = async (slug, post) => {
    await put('blog/posts/' + slug, JSON.stringify(post), { access: 'public', allowOverwrite: true });
  };
  const restorePath = opt('--restore');
  if (restorePath) {
    const restoreFile = JSON.parse(await readFile(restorePath, 'utf8'));
    if (restoreFile.kind !== 'blog-related-restore') {
      console.error('Not a blog-related restore file: ' + restorePath);
      process.exit(1);
    }
    const restored = applyRestore(posts, restoreFile);
    let wrote = 0;
    for (const p of restored) {
      const before = posts.find(q => q.slug === p.slug);
      const changed = (p.relatedSource || null) !== (before.relatedSource || null) || !relatedListsEqual(p.related || [], before.related || []);
      if (changed) { await writePost(p.slug, p); wrote++; }
    }
    console.log('Restore applied from ' + restorePath + ': ' + wrote + ' post(s) written.');
    return;
  }
  const mode = flag('--write') ? 'write' : 'dry';
  if (mode === 'write' && !opt('--keeps')) {
    console.error('--write requires --keeps <file> (the reviewed keeps list; it may be empty). Nothing was written.');
    process.exit(1);
  }
  const keeps = await readKeeps(opt('--keeps'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const restoreOut = 'blog-related-restore-' + stamp + '.json';
  const result = await runBackfill({
    posts,
    keeps,
    mode,
    nowIso: new Date().toISOString(),
    writePost,
    saveRestoreFile: async (data) => {
      await writeFile(restoreOut, JSON.stringify(data, null, 2));
      console.log('Restore file saved: ' + restoreOut);
    }
  });
  if (opt('--report')) await writeFile(opt('--report'), result.report);
  console.log(result.report);
  if (mode === 'write') console.log('Wrote ' + result.wrote.length + ' post(s): ' + result.wrote.join(', '));
  else console.log('DRY RUN - nothing was written.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
