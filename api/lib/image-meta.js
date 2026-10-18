// api/lib/image-meta.js
// Per-image metadata registry (Claude ruling, Oct 16, 2026): one JSON blob,
// blog/image-meta, keyed by image PATHNAME (a CDN host change must not
// orphan records). A record carries the image's alt text, its credit line,
// where the photo came from, and whether a credit is legally required --
// the flag is derived from the license at WRITE time and stored, never
// inferred at render.
//
// Alt text and credit are different problems and are handled differently
// (the ruling's core distinction): alt is a quality problem -- attached at
// insert in the editor, warned about at save, repaired in bulk; credit is
// a compliance problem -- a Commons CC BY / BY-SA image published without
// its credit line is out of license compliance for every day it is live,
// so the editor blocks that insert, and the credit itself renders from
// this registry (presentation, not stored content: one registry edit
// corrects the credit on every post using the image).
import { readBlobJson, updateBlobJson } from './blob.js';

export const IMAGE_META_KEY = 'blog/image-meta';
export const IMAGE_SOURCES = ['own', 'commons', 'pexels', 'unsplash', 'pixabay', 'unknown'];

const ALT_MAX = 500;
const CREDIT_MAX = 300;
const URL_MAX = 1000;
const PATH_MAX = 400;

// The registry key for an image URL: its pathname, no leading slash.
// Works for any host (Vercel blob store, raw.githubusercontent.com, a
// future CDN) because the path is the stable part.
export function pathnameFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const p = new URL(url).pathname;
    let decoded = p;
    try { decoded = decodeURIComponent(p); } catch (e) { /* keep raw */ }
    return decoded.replace(/^\/+/, '');
  } catch (e) {
    return '';
  }
}

function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  // Strip control characters and collapse whitespace runs; a credit line
  // is one line of small print, an alt is one sentence.
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Validate + normalize an incoming record. Returns null when the record
// is not an object at all; otherwise a record with exactly the registry
// fields, coerced to safe values (an unknown source becomes 'unknown';
// creditRequired defaults from the source when not explicitly boolean).
export function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = IMAGE_SOURCES.includes(raw.source) ? raw.source : 'unknown';
  const creditRequired = (typeof raw.creditRequired === 'boolean')
    ? raw.creditRequired
    : (source === 'commons');
  let creditUrl = cleanStr(raw.creditUrl, URL_MAX);
  if (creditUrl && !/^https:\/\/[^\s]+$/i.test(creditUrl)) creditUrl = '';
  return {
    alt: cleanStr(raw.alt, ALT_MAX),
    credit: cleanStr(raw.credit, CREDIT_MAX),
    creditUrl,
    source,
    creditRequired
  };
}

export function validPathname(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= PATH_MAX
    && !p.startsWith('/') && !p.includes('..') && !/[\u0000-\u001f\u007f]/.test(p);
}

// Read the whole registry. Never throws: a registry hiccup must not take
// a public page (or a save) down with it -- callers get {} and render /
// proceed without credits, and the drift checks surface the gap.
export async function readImageMeta(caller) {
  try {
    const meta = await readBlobJson(IMAGE_META_KEY, caller || 'image-meta', { expected: false });
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) return meta;
    return {};
  } catch (e) {
    return {};
  }
}

// Merge records into the registry through the race-safe helper.
// records: { pathname: record } (already normalized by the caller via
// normalizeRecord, or normalized here defensively). Returns the number
// of records written.
export async function upsertImageMeta(records, caller) {
  const entries = Object.entries(records || {});
  if (!entries.length) return 0;
  await updateBlobJson(IMAGE_META_KEY, caller || 'image-meta', (current) => {
    const base = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
    for (const [path, rec] of entries) {
      const clean = normalizeRecord(rec);
      if (clean && validPathname(path)) base[path] = clean;
    }
    return base;
  });
  return entries.length;
}

export function recordFor(meta, url) {
  if (!meta) return null;
  const p = pathnameFromUrl(url);
  if (!p) return null;
  return meta[p] || null;
}

// The visible credit line for a record, or '' when there is none.
// Beau's rule (Oct 16, 2026): every third-party photo carries its credit
// in small print under the image; his own photos carry none here (the
// site footer's standing line covers them).
export function creditHtml(rec, esc) {
  if (!rec || !rec.credit) return '';
  const text = esc(rec.credit);
  const inner = rec.creditUrl
    ? '<a href="' + esc(rec.creditUrl) + '" target="_blank" rel="noopener">' + text + '</a>'
    : text;
  return '<p class="img-credit">' + inner + '</p>';
}

function imgCreditFor(imgTag, meta, esc) {
  const m = /src\s*=\s*"([^"]+)"/i.exec(imgTag) || /src\s*=\s*'([^']+)'/i.exec(imgTag);
  if (!m) return '';
  return creditHtml(recordFor(meta, m[1]), esc);
}

// Insert credit lines into body HTML at RENDER time (stored bodies are
// never touched): a credit paragraph lands immediately after the image's
// paragraph when the image sits alone in one (the Quill shape), or
// immediately after a bare image otherwise.
export function applyBodyCredits(body, meta, esc) {
  if (!body || !meta || !Object.keys(meta).length) return body;
  let out = body.replace(/<p(?:\s[^>]*)?>\s*(<img[^>]*>)\s*<\/p>/gi, (whole, img, offset, full) => {
    if (full.slice(offset + whole.length).replace(/^\s+/, '').startsWith('<p class="img-credit">')) return whole;
    const c = imgCreditFor(img, meta, esc);
    return c ? whole + c : whole;
  });
  out = out.replace(/<img[^>]*>/gi, (img, offset, full) => {
    // Skip leading whitespace before the already-credited checks: editor-
    // serialized bodies put newlines between the img and </p>, and a
    // whitespace-blind guard here inserted a SECOND credit inside the
    // paragraph after the paragraph pass had already added one.
    const after = full.slice(offset + img.length, offset + img.length + 48).replace(/^\s+/, '');
    if (after.startsWith('</p><p class="img-credit">') || after.startsWith('<p class="img-credit">')) return img;
    const c = imgCreditFor(img, meta, esc);
    return c ? img + c : img;
  });
  return out;
}

// Insert a fallback link into each YouTube embed wrapper at RENDER time
// (stored bodies are never touched — the same boundary as applyBodyCredits).
// The anchor becomes the wrapper's first child; the iframe follows it in DOM
// order and paints over it when the player loads. When a reader's browser
// blocks the player, the iframe renders transparent/absent and the label
// shows, with the whole box linking out to the video on YouTube.
// Beau's decision (Oct 17, 2026): label with a link out. The video ID is
// derived defensively: a src that is not a youtube.com/embed/<id> shape
// produces NO anchor and the body passes through untouched. Stored iframes
// carry no title attribute, so the anchor text is the video's only
// accessible name — it is deliberately not aria-hidden.
export function applyVideoFallbacks(body) {
  if (!body || body.indexOf('ql-video-wrapper') === -1) return body;
  return body.replace(/(<div class="ql-video-wrapper"[^>]*>)(\s*)(<iframe[^>]*\bsrc="([^"]+)"[^>]*>)/gi, (whole, open, ws, iframe, src) => {
    const m = /^https:\/\/(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_-]{6,})(?:[?#].*)?$/.exec(src.trim());
    if (!m) return whole;
    const anchor = '<a class="video-fallback" href="https://www.youtube.com/watch?v=' + m[1] + '" target="_blank" rel="noopener">\u25B6 YouTube video \u2014 Watch on YouTube</a>';
    return open + anchor + ws + iframe;
  });
}
