// api/closures-digest.js
// Public, no-auth digest of the current closure state: ride closures (CLOSURES) and
// dining closures (DINING_CLOSURES) from the weekly dynamic cache, plus section meta.
// Consumed by the twice-weekly closure watcher (runs in Muse's runtime, no admin key)
// and by any client that wants closure state without the full cache. Closure data is
// public park information -- nothing sensitive is exposed here.
import { list } from '@vercel/blob';

const DYNAMIC_PREFIX = 'twize/park_intel_dl_dynamic.json';

async function readDynamic() {
  const { blobs } = await list({ prefix: DYNAMIC_PREFIX });
  if (!blobs || !blobs.length) return null;
  const url = blobs[0].downloadUrl || blobs[0].url;
  const r = await fetch(url + (url.indexOf('?') > -1 ? '&' : '?') + 't=' + Date.now());
  if (!r.ok) return null;
  return r.json();
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.closures)) return v.closures;
  return [];
}

export default async function handler(req, res) {
  try {
    const data = await readDynamic();
    if (!data) return res.status(503).json({ ok: false, error: 'dynamic cache unavailable' });
    const payload = data.data || data; // {data:{sections,section_meta}} or bare {sections}
    const sections = payload.sections || {};
    const meta = payload.section_meta || {};
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json({
      ok: true,
      ts: payload.ts || data.ts || null,
      closures: asArray(sections.CLOSURES),
      diningClosures: asArray(sections.DINING_CLOSURES),
      meta: {
        CLOSURES: meta.CLOSURES || null,
        DINING_CLOSURES: meta.DINING_CLOSURES || null,
        CURRENT_CLOSURES: meta.CURRENT_CLOSURES || null,
      },
    });
  } catch (e) {
    console.error('[closures-digest]', e.message);
    return res.status(500).json({ ok: false, error: 'digest failed' });
  }
}
