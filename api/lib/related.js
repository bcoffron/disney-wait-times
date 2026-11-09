// api/lib/related.js - related-posts resolution for the blog: ONE
// scorer, ONE provenance adjudicator, shared by every path that writes
// a post blob (Claude's related-auto design, Nov 9, 2026).
//
// Why this exists: related lists used to be whatever the admin
// editor's hand-picked rows happened to store - nothing recomputed
// them, ever, so a post nobody remembered to cross-link stayed an
// internal orphan (the DCA guide sat at zero inbound links for five
// months). Beau's ruling: lists build themselves BY DEFAULT; a human
// edit in the editor freezes a list as manual, and manual sticks until
// a human explicitly returns the post to automatic.
//
// Provenance: each post carries `related` (list of
// {slug, park, title, heroImage}) plus `relatedSource`: 'auto' |
// 'manual'. A post with NO relatedSource is LEGACY - the whole corpus
// at deploy time - and is treated as manual (preserved verbatim, no
// relatedSource written) until the reviewed backfill sets it. Only a
// session (editor) save can set or clear 'manual'; the agent and the
// batch importer can never change provenance.
//
// Scorer (deterministic, explainable - no stemming, no fuzzy match):
//   candidates: published corpus entries, source excluded.
//   score = sum of idf(t) over shared tags (summed in sorted tag
//     order) + park term + category term.
//   idf(t) = ln(P / df(t)), P = published corpus size, df(t) =
//     published corpus entries carrying t. A tag on every post scores
//     0; a tag on 2 of ~50 scores ~3.2 - rarity is the point, so one
//     shared rare tag outweighs park + category combined.
//   park: +1.0 when same park or either side is 'both', else -1.0
//     (the dl-vs-wdw case).
//   category: +0.5 when the source's category is non-empty and the
//     candidate's string is identical.
//   Scores are rounded to 6dp before comparison. Ties: shared-tag
//     count, then newer publishedAt, then slug ascending.
//   List length is RELATED_LIST_LENGTH (2) - a constant, matching the
//     house rule every existing list and the render grid follow.
//
// Tags are compared as normalized exact phrases: lowercase, trimmed,
// internal whitespace collapsed, curly apostrophes straightened,
// deduped within a post. Source tags come from the caller (the
// incoming payload on a save - the index still holds the old ones);
// candidate tags/park/category come from the corpus (the blog index,
// read once by the caller).
//
// This module is pure (no imports, no IO) so the backfill script and
// the gate suite exercise the exact code the handlers run.

export const RELATED_LIST_LENGTH = 2;
export const RELATED_MANUAL_MAX = 6;

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

export function normalizeTag(tag) {
  return String(tag == null ? '' : tag)
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeTags(tags) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const n = normalizeTag(t);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

function parkTerm(sourcePark, candidatePark) {
  const a = sourcePark || 'both';
  const b = candidatePark || 'both';
  return (a === b || a === 'both' || b === 'both') ? 1.0 : -1.0;
}

function publishedCorpus(corpus) {
  return (Array.isArray(corpus) ? corpus : []).filter(p => p && p.slug && p.published === true);
}

// Rank every published candidate for `source` with full score parts.
// Shared by computeRelated (top-N) and explainRelated (the dry run /
// suite view of the same ranking - one ordering, two consumers).
function rankCandidates(source, corpus) {
  const published = publishedCorpus(corpus);
  const P = published.length;
  if (!source || !source.slug || P === 0) return [];
  const sourceTags = normalizeTags(source.tags);
  const df = new Map();
  for (const p of published) {
    for (const t of normalizeTags(p.tags)) df.set(t, (df.get(t) || 0) + 1);
  }
  const idfOf = (t) => {
    const d = df.get(t) || 0;
    return d > 0 ? round6(Math.log(P / d)) : 0;
  };
  const ranked = [];
  for (const cand of published) {
    if (cand.slug === source.slug) continue;
    const candTags = new Set(normalizeTags(cand.tags));
    const shared = sourceTags.filter(t => candTags.has(t)).sort();
    const tagParts = shared.map(t => ({ tag: t, idf: idfOf(t) }));
    const tagScore = round6(tagParts.reduce((sum, p) => sum + p.idf, 0));
    const park = parkTerm(source.park, cand.park);
    const category = (source.category && cand.category === source.category) ? 0.5 : 0;
    ranked.push({
      slug: cand.slug,
      title: cand.title || cand.slug,
      park: cand.park || 'both',
      heroImage: cand.heroImage || '',
      publishedAt: cand.publishedAt || null,
      sharedTagCount: shared.length,
      parts: { tags: tagParts, tagScore, park, category },
      score: round6(tagScore + park + category)
    });
  }
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.sharedTagCount !== a.sharedTagCount) return b.sharedTagCount - a.sharedTagCount;
    const ta = new Date(a.publishedAt || 0).getTime() || 0;
    const tb = new Date(b.publishedAt || 0).getTime() || 0;
    if (tb !== ta) return tb - ta;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  return ranked;
}

// The computed list: the top RELATED_LIST_LENGTH ranked candidates,
// in the stored entry shape.
export function computeRelated(source, corpus) {
  return rankCandidates(source, corpus)
    .slice(0, RELATED_LIST_LENGTH)
    .map(r => ({ slug: r.slug, park: r.park, title: r.title, heroImage: r.heroImage }));
}

// Every ranked candidate with its score parts - the explanation the
// backfill dry run prints and the suite asserts against.
export function explainRelated(source, corpus) {
  return rankCandidates(source, corpus).map(r => ({
    slug: r.slug,
    title: r.title,
    score: r.score,
    sharedTagCount: r.sharedTagCount,
    parts: r.parts
  }));
}

// Validate a hand-picked list against the index. Known slugs only
// (drafts included - a manual row may target an unpublished post; the
// renderer hides it until it publishes), no self, no duplicates, at
// most RELATED_MANUAL_MAX. Any problem is a hard error NAMING it: a
// silent drop would hide an editor mistake. park/title/heroImage are
// filled from the index entry, never trusted from the payload.
export function validateManualRelated(incoming, sourceSlug, corpus) {
  if (!Array.isArray(incoming)) {
    return { ok: false, error: 'Related posts must be a list.' };
  }
  if (incoming.length > RELATED_MANUAL_MAX) {
    return { ok: false, error: 'Related list has ' + incoming.length + ' posts; the maximum is ' + RELATED_MANUAL_MAX + '.' };
  }
  const bySlug = new Map((Array.isArray(corpus) ? corpus : []).filter(p => p && p.slug).map(p => [p.slug, p]));
  const seen = new Set();
  const list = [];
  for (let i = 0; i < incoming.length; i++) {
    const entry = incoming[i];
    const slug = typeof entry === 'string' ? entry : (entry && entry.slug);
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'Related entry ' + (i + 1) + ' has no slug.' };
    }
    if (slug === sourceSlug) {
      return { ok: false, error: 'A post cannot list itself as related ("' + slug + '").' };
    }
    if (seen.has(slug)) {
      return { ok: false, error: 'Duplicate related post: "' + slug + '".' };
    }
    const known = bySlug.get(slug);
    if (!known) {
      return { ok: false, error: 'Unknown related post: "' + slug + '".' };
    }
    seen.add(slug);
    list.push({ slug, park: known.park || 'both', title: known.title || slug, heroImage: known.heroImage || '' });
  }
  return { ok: true, list };
}

function copyList(list) {
  return (Array.isArray(list) ? list : []).map(r => ({ ...r }));
}

// resolveRelated(incoming, stored, authKind, corpus)
//   incoming: the post object being saved (slug/tags/park/category
//     plus whatever related/relatedSource the caller sent).
//   stored:   the stored post blob before this save (null = creation).
//   authKind: 'session' for the admin editor; anything else ('agent',
//     'batch', ...) takes the non-editor branch.
//   corpus:   the blog index entries (one read by the caller).
// Returns { related, relatedSource } - relatedSource null means
// LEGACY PRESERVATION: keep the stored list and write no relatedSource
// field - or { error } for an invalid manual list (the caller refuses
// the save with a 400 before writing anything).
//
// Precedence (the design's core - provenance is sticky and only a
// human editor action changes it):
//   session + 'manual' -> validate the incoming list, store as manual.
//   session + 'auto'   -> compute, store as auto ("return to
//     automatic" rides this same value; no special endpoint).
//   anything else (agent, batch, or an editor payload carrying no
//     relatedSource - an untouched legacy editor, or a pre-deploy
//     cached one) -> the incoming list is IGNORED:
//       stored manual -> keep the stored list verbatim;
//       stored legacy (no relatedSource) -> keep the stored list,
//         write no relatedSource (the backfill owns that migration);
//       otherwise (stored auto, or no stored post) -> compute.
export function resolveRelated(incoming, stored, authKind, corpus) {
  if (authKind === 'session' && incoming && incoming.relatedSource === 'manual') {
    const v = validateManualRelated(incoming.related, incoming.slug, corpus);
    if (!v.ok) return { error: v.error };
    return { related: v.list, relatedSource: 'manual' };
  }
  if (authKind === 'session' && incoming && incoming.relatedSource === 'auto') {
    return { related: computeRelated(incoming, corpus), relatedSource: 'auto' };
  }
  if (stored && stored.relatedSource === 'manual') {
    return { related: copyList(stored.related), relatedSource: 'manual' };
  }
  if (stored && (stored.relatedSource === undefined || stored.relatedSource === null)) {
    return { related: copyList(stored.related), relatedSource: null };
  }
  return { related: computeRelated(incoming, corpus), relatedSource: 'auto' };
}

// Apply a resolution to the post object about to be written. A null
// relatedSource REMOVES the field: a legacy post must not gain one
// from an ordinary save.
export function applyRelated(post, resolved) {
  post.related = resolved.related;
  if (resolved.relatedSource) post.relatedSource = resolved.relatedSource;
  else delete post.relatedSource;
  return post;
}

// For the stored-post mutators (blog-schedule, blog-update-meta,
// cron-publish): they write a post blob that started as the stored
// blob and receive no post payload, so there is no incoming list to
// adjudicate - their whole obligation is that related + relatedSource
// ride through untouched. They call this with a snapshot taken at
// read time, immediately before the write, so a future refactor that
// rebuilds the object cannot silently drop the fields.
export function carryRelatedFields(target, snapshot) {
  if (snapshot && Array.isArray(snapshot.related)) target.related = snapshot.related;
  else delete target.related;
  if (snapshot && snapshot.relatedSource) target.relatedSource = snapshot.relatedSource;
  else delete target.relatedSource;
  return target;
}

// Structural equality of two related lists (entry fields, in order) -
// the sweep's write-only-what-changed test.
export function relatedListsEqual(a, b) {
  const norm = (list) => (Array.isArray(list) ? list : []).map(r => ({
    slug: r && r.slug, park: (r && r.park) || 'both', title: (r && r.title) || '', heroImage: (r && r.heroImage) || ''
  }));
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
