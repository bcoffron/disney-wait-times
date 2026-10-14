// api/lib/blob.js - shared Vercel Blob helpers for the blog endpoints.
//
// Single home for the suffix-tolerant key matcher and the safe read pattern,
// extracted from api/blog-post.js (Step 1 of the blob exact-match audit,
// GitHub #5) so the predicate exists in exactly one place. Behavior is
// unchanged from the per-file copies this replaces; the only additions are
// the shared location and a caller label in the empty-match log, so a drift
// event names the endpoint that fired it.
import { list, put } from '@vercel/blob';
import { createHash } from 'node:crypto';

export function matchesKey(pathname, key) {
  // INVARIANT (OBSERVED, NOT guaranteed by @vercel/blob):
  // With addRandomSuffix, the server appends '-' + an alphanumeric-only suffix
  // (no '-' or '_'). Verified across 654 live blobs (all 30-char [A-Za-z0-9]).
  // The client lib only sends a boolean flag; the suffix is minted server-side,
  // so this format is NOT a documented contract. The regex below DEPENDS on it to
  // tell "key + random-suffix" apart from "key + '-' + a longer sibling slug".
  // If this invariant ever breaks, the empty-match guard in readBlobJson /
  // readBlobText (selectBlob, below) in this module will log it.
  if (pathname === key) return true;
  if (!pathname.startsWith(key + '-')) return false;
  return /^[A-Za-z0-9]+$/.test(pathname.slice(key.length + 1));
}

async function selectBlob(key, caller, opts) {
  const { blobs } = await list({ prefix: key, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
  const matches = (blobs || []).filter(b => matchesKey(b.pathname, key)).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) {
    // Empty-match split (GitHub #6): the guard used to tag every zero-match
    // [SECURITY], but most zero-matches are prefix probes - requests for a
    // key that is a string-prefix of real keys without being one itself
    // (e.g. slug "disney-world" listing the disney-world-* posts). Those are
    // benign and attacker-shaped, so they log WITHOUT the [SECURITY] tag at
    // warn level. Callers reading a key that must exist (the posts index,
    // settings, featured, or a post slug taken from the index) pass
    // { expected: true }; for those, a zero-match is genuine drift - the
    // suffix-format tripwire - and keeps the [SECURITY] tag, including when
    // the prefix listing itself came back empty.
    if (opts && opts.expected) {
      console.error('[SECURITY] ' + (caller || 'readBlob') + ' matched 0 of ' + (blobs || []).length + ' listed blobs for expected key "' + key + '" - possible suffix-format drift.');
    } else if ((blobs || []).length > 0) {
      console.warn('[blob] ' + (caller || 'readBlob') + ' matched 0 of ' + blobs.length + ' listed blobs for key "' + key + '" - no exact or suffixed form; treating as prefix probe.');
    }
    return null;
  }
  return matches[0];
}

// Featured-post sentinel: the blob SDK rejects empty content, so "nothing
// featured" is stored as an explicit sentinel rather than ''. The sentinel
// can never be a real slug (slugs are [a-z0-9-]; this contains underscores).
// normalizeFeaturedSlug maps the sentinel, empty, and whitespace-only raw
// values - any of which may exist in older copies - to null, so every reader
// of the featured key agrees on what "unfeatured" means.
export const UNFEATURED_SENTINEL = '__unfeatured__';
export function normalizeFeaturedSlug(raw) {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim();
  if (v === '' || v === UNFEATURED_SENTINEL) return null;
  return v;
}

export async function readBlobJson(key, caller, opts) {
  const chosen = await selectBlob(key, caller, opts);
  if (!chosen) return null;
  const r = await fetch(chosen.downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  const text = await r.text();
  return JSON.parse(text);
}

export async function readBlobText(key, caller, opts) {
  const chosen = await selectBlob(key, caller, opts);
  if (!chosen) return null;
  const r = await fetch(chosen.downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.text();
}

// The index entry's bodySnippet, computed exactly as blog-save computes
// it. Extracted (reindex Deliverable 2) so the save path and the rebuild
// produce the identical field from the identical code - the rebuild's
// output shape must match the save path's field for field.
export function computeBodySnippet(body) {
  return (body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 2000);
}

// --- Race-safe read-modify-write for shared JSON blobs (write-path fix) ---
//
// The posts index is written by several endpoints as read-modify-write:
// read the whole array, change one entry, put the whole array back. The
// blob store's reads lag writes by tens of seconds, so a writer can read
// state that predates a competitor's write and silently discard that
// write when it puts its stale-based array (observed live Oct 13, 2026:
// two saves seconds apart lost the first post's index entry while its
// post blob stayed live and public).
//
// updateBlobJson narrows that window. It fingerprints the exact state it
// read (source pathname + uploadedAt + SHA-256 of the raw text), then
// re-reads immediately before writing; if the fingerprint moved, the
// mutator is re-applied to the FRESH state instead of overwriting it.
// After maxAttempts (or budgetMs — interactive callers must not hang)
// it throws an INDEX_CONFLICT error rather than writing stale state.
//
// This is advisory, NOT atomic: @vercel/blob offers no compare-and-swap.
// A competing write that is still invisible to the verification re-read
// (inside the store's visibility lag) cannot be detected at all, and the
// gap between the final verification and the put is one round trip. The
// guarantee is narrower and honest: any competing change VISIBLE by
// write time is merged, never discarded, and persistent visible
// contention fails loudly instead of losing data silently. The complete
// fix (append-only index format) is scoped to the reindex lane.
// --- Last-write memo (batch/memo track) ---
//
// updateBlobJson's fingerprint check compares two reads of the store,
// but the store can report a fresh uploadedAt in list() while fetch
// still serves pre-write bytes (observed in PR #40's verification), so
// both reads can agree on state that predates a write this process
// itself just made - the guard is structurally blind to that case, and
// two saves seconds apart dropped an index entry silently because of
// it (fixture-proven, Oct 14, 2026).
//
// The writer knows one thing the store can't be trusted to show it:
// what it just wrote. This memo records, per blob key, the SHA-256 of
// the exact bytes the last successful updateBlobJson put wrote, in
// module scope. On the next update of that key, if the freshly read
// bytes do NOT hash to the memo while the memo is recent, the read is
// provably stale (or a write from elsewhere has landed over ours) -
// either way, mutating from that base could discard a write, so the
// update refuses with INDEX_CONFLICT instead of writing.
//
// One refinement: if the read state's own uploadedAt POSTDATES our
// memo write, a later write is visible in the base we read - mutating
// on top of it discards nothing of ours that isn't already superseded,
// so the update proceeds (that later writer's own staleness, if any,
// is the reconciliation check's to catch). Without this, any visible
// foreign write within the memo window would false-refuse a perfectly
// fresh read. The postdate test demands a margin (1s) rather than any
// positive gap: the store's clock and this instance's clock are
// independent, and our own write's stamp can sit a few ms either side
// of the moment we record the memo - only a gap beyond plausible clock
// skew proves the base genuinely postdates our write.
//
// Recency bound: 5 minutes - long enough to cover the measured
// 30-120s visibility window with margin, short enough that an
// unrelated write hours later is never refused over an ancient memo.
// When in doubt this prefers refusing: a loud failure on a save is
// recoverable (retry once the store settles), a silent drop is not.
//
// LIMITATION, stated plainly: the memo is per-instance (module scope).
// It catches successive writes that land on the same warm instance -
// which is the pattern that actually bites (a sequential batch, a
// human saving twice in a minute) - and it is blind across cold starts
// and separate instances. It is a partial guard, not a lock; the daily
// reconciliation check remains the detector for everything it misses.
//
// --- Self-collision recovery (Claude msg #442) ---
//
// The refusal above protected the batch case, but production showed
// the "successive writes on one instance" pattern is not an edge -
// it is the core admin loop (save a draft, then publish it; delete
// several posts in a row), and a guard that fires on the main path
// is a defect in the operation it guards. So the memo now RECOVERS
// the provable self-collision instead of refusing it.
//
// The memo retains, alongside the hash of the bytes written, the
// parsed value of those bytes (the post-image) and the hash of the
// base they were computed from (the pre-image). If the next update's
// read hashes exactly to the pre-image, the store is serving the
// very state this instance's own last write superseded: the
// staleness is ours to correct from memory, the true current state
// is the memoized post-image, and the mutator is applied to that
// instead of to the stale read. No unknown writer's work is
// discarded - the write is based on the true latest state, and the
// fingerprint re-read still guards the put (a foreign write that
// becomes visible mid-update fails the fingerprint comparison and
// the update retries on the fresh state, as before). A read that
// matches NEITHER image and does not postdate the memo is still
// unexplained state and still refuses loudly; a read visibly
// postdating the memo still proceeds on the read base.
//
// The memo keeps exactly one generation: its pre-image advances on
// every successful write, so a lagging read that catches up one
// write at a time keeps classifying as self-collision, but a read
// two writes behind matches neither image and refuses. Visibility
// lag that deep with two same-instance writes inside it is outside
// the measured window, and the reconciliation check remains the
// detector for it. The classification runs on every attempt of the
// update loop, not just the first: a verification re-read can trip
// the fingerprint guard on a list()-only change while fetch still
// serves the pre-image, and the retried read must not then mutate
// from that stale state (see updateBlobJson).
const LAST_WRITE_MEMO_MS = 5 * 60 * 1000;
// 1s, not 0: a bare > comparison lets sub-second clock/stamp drift
// bypass the memo in exactly the stale case it exists to catch
// (fixture-proven) - do not simplify this back to a bare comparison.
const MEMO_POSTDATE_MARGIN_MS = 1000;
const lastWriteMemo = new Map();

async function readRawWithFingerprint(key, caller) {
  const chosen = await selectBlob(key, caller, { expected: true });
  if (!chosen) return { value: null, fingerprint: null, textSha: null, uploadedAt: null };
  const r = await fetch(chosen.downloadUrl, { cache: 'no-store' });
  if (!r.ok) {
    const err = new Error('fetch failed (' + r.status + ') reading "' + key + '" for update');
    err.code = 'UPDATE_READ_FAILED';
    throw err;
  }
  const text = await r.text();
  const textSha = createHash('sha256').update(text).digest('hex');
  const fingerprint = chosen.pathname + '|' + chosen.uploadedAt + '|' + textSha;
  return { value: JSON.parse(text), fingerprint, textSha, uploadedAt: chosen.uploadedAt };
}

export async function updateBlobJson(key, caller, mutator, opts = {}) {
  const maxAttempts = opts.maxAttempts || 3;
  const budgetMs = opts.budgetMs || 5000;
  const started = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { value, fingerprint, textSha, uploadedAt } = await readRawWithFingerprint(key, caller);
    // Last-write memo classification (see the memo comments above).
    // baseValue/baseSha name the state the mutator is applied to: the
    // read state on the normal path, the memoized post-image on the
    // self-collision path. baseSha is what the next write's memo
    // records as its pre-image, so chained self-collisions classify.
    //
    // The self-collision recovery is evaluated on EVERY attempt, not
    // just the first: if attempt 1's verification re-read trips the
    // fingerprint guard (e.g. list() catches up to our write while
    // fetch still serves the pre-image), attempt 2's starting read
    // can present the same provably-ours stale state, and mutating
    // from it there would silently discard our own write - the exact
    // drop the memo exists to prevent. A hash-exact match against
    // the memo's pre-image cannot misfire on a foreign state, so
    // recovering wherever it appears weakens no refusal. The
    // unexplained-mismatch refusal, by contrast, stays first-attempt
    // only: later attempts are the designed recovery from a VISIBLE
    // change, and their mismatches resolve through the fingerprint
    // guard and the retry loop (which still throws after maxAttempts
    // if the contention persists).
    let baseValue = value;
    let baseSha = textSha;
    let selfCollision = false;
    if (fingerprint !== null) {
      const memo = lastWriteMemo.get(key);
      if (memo && Date.now() - memo.at <= LAST_WRITE_MEMO_MS && memo.textSha !== textSha) {
        const postdatesMemo = uploadedAt && new Date(uploadedAt).getTime() > memo.at + MEMO_POSTDATE_MARGIN_MS;
        if (typeof memo.baseSha === 'string' && memo.baseSha === textSha && memo.value !== undefined) {
          // SELF-COLLISION: the read is serving exactly the state
          // this instance's last write superseded (hash-equal to the
          // memo's pre-image), so the store's staleness is this
          // instance's OWN write not yet visible - correctable from
          // memory, not an unknown writer's state. Apply the update
          // to the memoized post-image instead of the stale read.
          selfCollision = true;
          baseValue = memo.value;
          baseSha = memo.textSha;
          console.warn('[blob] ' + (caller || 'updateBlobJson') + ': read of "' + key + '" is serving the pre-write state of this instance\'s own write ' + Math.round((Date.now() - memo.at) / 1000) + 's ago - applying the update to the memoized post-write state (self-collision recovery).');
        } else if (!postdatesMemo && attempt === 1) {
          console.error('[SECURITY] ' + (caller || 'updateBlobJson') + ': stale read of "' + key + '" detected by last-write memo (this instance wrote different bytes ' + Math.round((Date.now() - memo.at) / 1000) + 's ago; the store is not showing them) - refusing to update from stale state.');
          const err = new Error('Stale read of "' + key + '": the store is not showing this process\'s most recent write; refusing to overwrite from stale state.');
          err.code = 'INDEX_CONFLICT';
          throw err;
        }
        // postdatesMemo: the read state's uploadedAt proves a later
        // write is visible in the base - fall through and mutate on
        // top of the read state, discarding nothing of ours.
      }
    }
    const draft = baseValue === null ? null : JSON.parse(JSON.stringify(baseValue));
    const next = await mutator(draft);
    if (JSON.stringify(next) === JSON.stringify(baseValue)) {
      return { changed: false, conflicted: attempt > 1, attempts: attempt, recovered: selfCollision };
    }
    const check = await readRawWithFingerprint(key, caller);
    if (check.fingerprint === fingerprint) {
      const outText = JSON.stringify(next);
      await put(key, outText, {
        access: 'public',
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/json',
        token: process.env.BLOB_READ_WRITE_TOKEN
      });
      lastWriteMemo.set(key, {
        textSha: createHash('sha256').update(outText).digest('hex'),
        baseSha,
        value: JSON.parse(outText),
        at: Date.now()
      });
      return { changed: true, conflicted: attempt > 1, attempts: attempt, recovered: selfCollision };
    }
    console.error('[SECURITY] ' + (caller || 'updateBlobJson') + ': "' + key + '" changed during update (attempt ' + attempt + ' of ' + maxAttempts + ') - re-applying on fresh state.');
    if (Date.now() - started > budgetMs) break;
  }
  console.error('[SECURITY] ' + (caller || 'updateBlobJson') + ': giving up on "' + key + '" after ' + maxAttempts + ' attempts / ' + (Date.now() - started) + 'ms - refusing to overwrite from stale state.');
  const err = new Error('Index changed repeatedly during update of "' + key + '"; refusing to overwrite from stale state.');
  err.code = 'INDEX_CONFLICT';
  throw err;
}
