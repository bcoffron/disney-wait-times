// api/lib/publish-date.js
// The publish-date rule (Beau, Oct 16, 2026): a post's publishedAt is
// when it GOES LIVE, never when it was created. Enforced here, in one
// shared helper, so every publish path (blog-save, blog-batch-save,
// cron-publish, and anything added later) applies the same semantics
// instead of depending on which button or cron flipped the post live.
//
// resolvePublishedAt(preImage, incoming, nowIso) -> { publishedAt, transition }
//   preImage: the stored post blob before this save (null = no blob =
//             a creation, not a transition), read by the caller via
//             readBlobJson(..., { expected: false }). The BLOB is the
//             authoritative pre-image — never the index entry (the
//             index has said draft while the blob said live before;
//             an index-based test would re-date live posts).
//   incoming: the post object being saved.
//   nowIso:   the save moment (callers pass new Date().toISOString()).
//
// Semantics:
//   - Drafts are never stamped: published !== true returns the
//     incoming date untouched, transition = false.
//   - Creation (no pre-image): not a transition; the caller keeps the
//     incoming date, and blog-save's long-standing invariant stamps
//     now when a published creation carries no date at all.
//   - Already live (preImage.published === true): never re-dated. The
//     stored date wins over whatever the client sent, so an edit can
//     never move a live post's date.
//   - TRANSITION (pre-image exists and was not published, incoming is
//     published): the post is going live now.
//       * If the incoming date DIFFERS from the pre-image's, the
//         caller set it deliberately (a stamping client, or an
//         intentional backdate on import) — honor it. This equality
//         guard is also what makes a double-save inside the blob
//         visibility-lag window safe: the second save's pre-image is
//         the stale draft, but its incoming date (the first save's
//         stamp) differs from the stale date, so it is preserved
//         instead of being re-stamped.
//       * If the incoming date EQUALS the pre-image's (or is absent),
//         nobody stamped it: stamp now.
//     transition = true tells the caller the index entry must take
//     this value too — the index upsert's usual preference for the
//     existing entry's date would otherwise keep the stale draft
//     date in the feed while the blob carries the stamp, silently
//     defeating the fix (the reconciler treats date drift as routine
//     and would not surface it).
export function resolvePublishedAt(preImage, incoming, nowIso) {
  const inc = incoming || {};
  if (inc.published !== true) {
    return { publishedAt: inc.publishedAt || null, transition: false };
  }
  if (!preImage) {
    // Creation: not a transition. Keep the caller's date (possibly
    // null — blog-save's missing-date invariant handles that case).
    return { publishedAt: inc.publishedAt || null, transition: false };
  }
  if (preImage.published === true) {
    // Already live: the stored date is the truth; never re-date.
    return { publishedAt: preImage.publishedAt || inc.publishedAt || null, transition: false };
  }
  // Transition: unpublished -> published.
  if (inc.publishedAt && inc.publishedAt !== preImage.publishedAt) {
    return { publishedAt: inc.publishedAt, transition: true };
  }
  return { publishedAt: nowIso, transition: true };
}
