// api/blob-diag.js — TEMP READ-ONLY DIAGNOSTIC. REMOVE BEFORE PROMOTION.
// Purpose: compare which blog/posts/index blob is selected + its content, per @vercel/blob version.
// READ-ONLY: uses list() and fetch() of downloadUrl only. NO put(), NO del(), NO writes of any kind.
import { list } from '@vercel/blob';

const TARGET_SLUGS = [
  'disney-world-stroller-guide',
  'disney-world-resort-hotels-guide',
  'disney-world-dining-reservations-guide',
  'disney-pin-trading-guide',
  'disney-world-transportation-guide'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Gate: same token guard as blog-debug. Not anonymously hittable.
  if (req.query.token !== 'tpcp-diag-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    // READ-ONLY list of all blobs under the index prefix
    const { blobs } = await list({ prefix: 'blog/posts/index', limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });

    // Replicate readBlob's exact selection: exact-pathname match, uploadedAt desc, take [0]
    const exactMatches = (blobs || [])
      .filter(function (b) { return b.pathname === 'blog/posts/index'; })
      .sort(function (a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
    const selected = exactMatches[0] || null;

    // Fingerprint EVERY matched blob under the prefix (read-only fetch of each)
    const perBlob = [];
    for (var i = 0; i < (blobs || []).length; i++) {
      var b = blobs[i];
      var rec = {
        pathname: b.pathname,
        uploadedAt: b.uploadedAt,
        size: b.size,
        exactPathnameMatch: (b.pathname === 'blog/posts/index'),
        isSelected: selected && b.uploadedAt === selected.uploadedAt && b.pathname === selected.pathname
      };
      try {
        var r = await fetch((b.downloadUrl || b.url), { cache: 'no-store' });
        if (r.ok) {
          var arr = await r.json();
          rec.entryCount = Array.isArray(arr) ? arr.length : null;
          rec.slugFingerprint = {};
          for (var k = 0; k < TARGET_SLUGS.length; k++) {
            var slug = TARGET_SLUGS[k];
            var e = Array.isArray(arr) ? arr.find(function (p) { return p && p.slug === slug; }) : null;
            rec.slugFingerprint[slug] = e ? { present: true, published: e.published } : { present: false };
          }
        } else {
          rec.fetchStatus = r.status;
        }
      } catch (e) {
        rec.fetchError = e.message;
      }
      perBlob.push(rec);
    }

    return res.status(200).json({
      readonly: true,
      note: 'temporary diagnostic; no writes performed',
      totalBlobsUnderPrefix: (blobs || []).length,
      exactPathnameMatchCount: exactMatches.length,
      selectedBlob: selected ? { pathname: selected.pathname, uploadedAt: selected.uploadedAt, size: selected.size } : null,
      perBlob: perBlob
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
