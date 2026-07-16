// api/blog-render-index.js
import { list } from '@vercel/blob';
const readRateLimit = new Map();

function matchesKey(pathname, key) {
  // INVARIANT (OBSERVED, NOT guaranteed by @vercel/blob):
  // With addRandomSuffix, the server appends '-' + an alphanumeric-only suffix
  // (no '-' or '_'). Verified across 654 live blobs (all 30-char [A-Za-z0-9]).
  // The client lib only sends a boolean flag; the suffix is minted server-side,
  // so this format is NOT a documented contract. The regex below DEPENDS on it to
  // tell "key + random-suffix" apart from "key + '-' + a longer sibling slug".
  // If this invariant ever breaks, the empty-match guard in readBlob will log it.
  if (pathname === key) return true;
  if (!pathname.startsWith(key + '-')) return false;
  return /^[A-Za-z0-9]+$/.test(pathname.slice(key.length + 1));
}

async function readBlob(pathname) {
const { blobs } = await list({ prefix: pathname, limit: 1000 , token: process.env.BLOB_READ_WRITE_TOKEN});
const matches = (blobs || []).filter(b => matchesKey(b.pathname, pathname)).sort((a,b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
if (!matches.length) {
    if ((blobs || []).length > 0) {
      console.error('[SECURITY] readBlob matched 0 of ' + blobs.length + ' listed blobs for key "' + pathname + '" - possible suffix-format drift.');
    }
    return null;
  }
const r = await fetch(matches[0].downloadUrl, { cache: 'no-store' });
if (!r.ok) return null
return r.json();
}

async function readSettings() {
try {
const s = await readBlob('blog:settings');
return { byline: 'By the Theme Park Co-Pilot Team', readTimeMode: 'auto', postsPerPage: 30, ...(s || {}) };
} catch(e) {
return { byline: 'By the Theme Park Co-Pilot Team', readTimeMode: 'auto', postsPerPage: 30 };
}
}

function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

function sortPosts(posts) {
return posts.slice().sort(function(a, b) {
return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
});
}

function filterAttr(post) {
var cats = [];
if (post.park === 'dl') cats.push('disneyland');
else if (post.park === 'wdw') cats.push('walt-disney-world');
else { cats.push('disneyland'); cats.push('walt-disney-world'); }
var slug = post.slug || '';
if (slug.indexOf('lightning-lane') !== -1) cats.push('lightning-lane');
if (slug.indexOf('restaurant') !== -1 || slug.indexOf('dining') !== -1 || slug.indexOf('snack') !== -1 || slug.indexOf('food') !== -1) cats.push('dining');
if (slug.indexOf('hotel') !== -1 || slug.indexOf('on-site') !== -1 || slug.indexOf('off-site') !== -1) cats.push('hotels');
if (slug.indexOf('plan') !== -1 || slug.indexOf('budget') !== -1 || slug.indexOf('itinerary') !== -1 || slug.indexOf('tips') !== -1 || slug.indexOf('guide') !== -1 || slug.indexOf('strategy') !== -1 || slug.indexOf('best-time') !== -1) cats.push('planning-tips');
var unique = [];
cats.forEach(function(c) { if (unique.indexOf(c) === -1) unique.push(c); });
return unique.join(' ');
}

function renderCard(post, isFeatured) {
var slug = esc(post.slug), title = esc(post.title);
var introRaw = post.intro || post.metaDescription || '';
var intro = esc(introRaw.length > 120 ? introRaw.slice(0, 120).trim() + '\u2026' : introRaw);
var heroImage = esc(post.heroImage || ''), heroAlt = esc(post.heroAlt || title);
var tagLabel = esc((post.tagLabel || (post.park === 'dl' ? 'Disneyland' : post.park === 'wdw' ? 'Walt Disney World' : 'Disney')).toUpperCase());
var readTime = esc(post.readTime || '8');
var cat = filterAttr(post);
var tClass = post.park === 'dl' ? 'tag-abs-dl' : post.park === 'wdw' ? 'tag-abs-wdw' : '';
var tStyle = post.park === 'both' ? ' style="background:rgba(184,134,11,0.92);color:#FFF8E0;"' : '';
var catLabel = (post.category || '').replace(/&middot;/g, '\u00b7').replace(/\u00c3\u00a2\u00c2\u00b7/g, '\u00b7').replace(/\u00c3\u0082\u00c2\u00b7/g, '\u00b7').replace(/&amp;/g, '&')

if (isFeatured) {
return '<a class="post-card post-card--featured" href="/blog/' + slug + '" data-category="' + cat + '" aria-label="' + title + '"><div class="post-card__img-wrap"><img src="' + heroImage + '" alt="' + heroAlt + '" class="post-card__img" loading="eager"><span class="post-card__badge">START HERE</span></div><div class="post-card__body"><p class="post-card__eyebrow">' + catLabel + '</p><h2 class="post-card__title post-card__title--featured">' + title + '</h2><p class="post-card__intro">' + intro + '</p><div class="post-card__footer"><span class="post-card__read">' + readTime + ' min read</span><span class="post-card__cta">Read the guide \u2192</span></div></div></a>';
}
return '<a class="post-card" href="/blog/' + slug + '" data-category="' + cat + '" aria-label="' + title + '"><div class="post-card__img-wrap"><img src="' + heroImage + '" alt="' + heroAlt + '" class="post-card__img" loading="lazy"><span class="post-tag post-tag--card ' + tClass + '"' + tStyle + '>' + tagLabel + '</span></div><div class="post-card__body"><p class="post-card__eyebrow">' + catLabel + '</p><h2 class="post-card__title">' + title + '</h2><p class="post-card__intro">' + intro + '</p><div class="post-card__footer"><span class="post-card__read">' + readTime + ' min read</span><span class="post-card__cta">Read \u2192</span></div></div></a>';
}
var CSS = '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; } html { scroll-behavior: smooth; } body { font-family: Outfit, sans-serif; background: #EEF5F4; color: #071E25; -webkit-font-smoothing: antialiased; overflow-x: hidden; } .nav { background: #071E25; height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 40px; position: sticky; top: 0; z-index: 100; border-bottom: 1px solid rgba(255,255,255,0.07); } .nav-left { display: flex; align-items: center; gap: 10px; text-decoration: none; } .nav-icon { width: 30px; height: 30px; border-radius: 7px; overflow: hidden; border: 1px solid rgba(212,168,48,0.3); flex-shrink: 0; } .nav-icon img { width: 100%; height: 100%; object-fit: cover; display: block; } .nav-wordmark { font-size: 13px; font-weight: 800; color: #fff; letter-spacing: -0.2px; } .nav-wordmark span { color: #F5A623; } .nav-right { display: flex; align-items: center; gap: 20px; } .nav-link { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.55); text-decoration: none; transition: color .15s; letter-spacing: .02em; } .nav-link:hover,.nav-link.active { color: #fff; } .nav-cta { font-size: 11px; font-weight: 700; color: #071E25; background: #F5A623; border-radius: 100px; padding: 7px 14px; text-decoration: none; letter-spacing: .02em; transition: opacity .15s; } .nav-cta:hover { opacity: .85; } .blog-hero { background: #071E25; padding: 64px 40px 56px; } .blog-hero-inner { max-width: 680px; } .blog-hero-eyebrow { font-size: 9px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: #F5A623; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; } .blog-hero-eyebrow::before { content: ""; display: block; width: 28px; height: 1.5px; background: #F5A623; } .blog-hero-h1 { font-family: Fraunces, serif; font-size: 52px; font-weight: 900; color: #fff; line-height: 1.05; letter-spacing: -1px; margin-bottom: 18px; } .blog-hero-h1 em { color: #F5A623; font-style: italic; } .blog-hero-sub { font-size: 15px; color: rgba(255,255,255,0.55); line-height: 1.6; max-width: 480px; } .filter-bar { background: #fff; border-bottom: 0.5px solid rgba(7,30,37,0.08); padding: 0 40px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; overflow-x: auto; scrollbar-width: none; } .filter-bar::-webkit-scrollbar { display: none; } .filter-pill { font-size: 11px; font-weight: 700; color: #4A7A7C; background: none; border: none; cursor: pointer; padding: 14px 14px; border-bottom: 2px solid transparent; white-space: nowrap; transition: color .15s, border-color .15s; letter-spacing: .02em; } .filter-pill:hover { color: #071E25; } .filter-pill.active { color: #071E25; border-bottom-color: #F5A623; } .post-grid { max-width: 1100px; margin: 0 auto; padding: 48px 40px 64px; display: grid; grid-template-columns: 1fr 1fr; gap: 28px; } .post-card { display: flex; flex-direction: column; background: #fff; border-radius: 14px; overflow: hidden; border: 0.5px solid rgba(7,30,37,0.07); text-decoration: none; color: inherit; transition: box-shadow .2s, transform .15s; } .post-card:hover { box-shadow: 0 8px 32px rgba(7,30,37,0.10); transform: translateY(-2px); } .post-card--featured { grid-column: 1 / -1; flex-direction: row; } .post-card__img-wrap { position: relative; overflow: hidden; flex-shrink: 0; } .post-card--featured .post-card__img-wrap { width: 52%; } .post-card__img { width: 100%; height: 100%; object-fit: cover; display: block; aspect-ratio: 16/9; transition: transform .35s; } .post-card--featured .post-card__img { aspect-ratio: auto; height: 100%; min-height: 320px; } .post-card:hover .post-card__img { transform: scale(1.03); } .post-card__badge { position: absolute; bottom: 12px; left: 12px; font-size: 9px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; background: #F5A623; color: #071E25; border-radius: 100px; padding: 5px 11px; } .post-tag { font-size: 9px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; border-radius: 100px; padding: 4px 10px; } .post-tag--card { position: absolute; top: 12px; left: 12px; } .tag-abs-dl { background: rgba(26,104,96,0.92); color: #E0F5EE; } .tag-abs-wdw { background: rgba(184,134,11,0.92); color: #FFF8E0; } .post-card__body { padding: 24px 28px; display: flex; flex-direction: column; flex: 1; } .post-card:not(.post-card--featured) .post-card__body { padding: 14px 16px 16px; } .post-card__meta { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; } .post-card__category { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .10em; color: #8AACAE; } .post-card__title { font-family: Fraunces, serif; font-size: 21px; font-weight: 900; color: #071E25; line-height: 1.2; margin-bottom: 8px; letter-spacing: -0.3px; } .post-card__title--featured { font-size: 28px; } .post-card--featured .post-card__title { font-size: 28px; } .post-card__intro { font-size: 13px; color: #4A7A7C; line-height: 1.6; flex: 1; margin-bottom: 20px; } .post-card__footer { display: flex; justify-content: space-between; align-items: center; padding-top: 10px; border-top: 0.5px solid rgba(7,30,37,0.07); } .post-card__read { font-size: 11px; color: #8AACAE; font-weight: 600; } .post-card__cta { font-size: 11px; font-weight: 700; color: #1A6860; } .newsletter { background: #071E25; padding: 56px 40px; display: flex; justify-content: space-between; align-items: center; gap: 40px; } .newsletter-eyebrow { font-size: 9px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: #F5A623; margin-bottom: 10px; } .newsletter-title { font-family: Fraunces, serif; font-size: 32px; font-weight: 900; color: #fff; line-height: 1.1; } .newsletter-title em { color: #F5A623; font-style: italic; } .newsletter-form { display: flex; gap: 8px; } .newsletter-input { font-family: Outfit, sans-serif; font-size: 13px; padding: 12px 16px; border-radius: 100px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.07); color: #fff; width: 240px; outline: none; } .newsletter-input::placeholder { color: rgba(255,255,255,0.35); } .newsletter-btn { font-family: Outfit, sans-serif; font-size: 12px; font-weight: 700; background: #F5A623; color: #071E25; border: none; border-radius: 100px; padding: 12px 20px; cursor: pointer; white-space: nowrap; } .footer { background: #071E25; padding: 20px 40px; display: flex; align-items: center; justify-content: space-between; border-top: 1px solid rgba(255,255,255,0.07); } .footer-left { font-size: 10px; color: rgba(255,255,255,0.30); } .footer-right { display: flex; gap: 16px; } .footer-link { font-size: 10px; color: rgba(255,255,255,0.30); text-decoration: none; } .footer-link:hover { color: rgba(255,255,255,0.60); } @media (max-width: 768px) { .blog-hero { padding: 40px 20px 36px; } .blog-hero-h1 { font-size: 34px; } .filter-bar { padding: 0 12px; flex-wrap: nowrap !important; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 8px; scrollbar-width: none; } .filter-bar::-webkit-scrollbar { display: none; } .filter-pill { white-space: nowrap; flex-shrink: 0; } .search-bar { display: none; } .post-grid { overflow-x: hidden; width: 100%; grid-template-columns: 1fr; padding: 32px 20px 48px; gap: 20px; } .post-card { max-width: 100%; box-sizing: border-box; } .post-card--featured { flex-direction: column; } .post-card--featured .post-card__img-wrap { width: 100%; } .newsletter { flex-direction: column; padding: 40px 20px; text-align: center; } .newsletter-form { flex-direction: column; width: 100%; } .newsletter-input { width: 100%; } .nav { padding: 0 20px; } .nav-right .nav-link { display: none; } .footer { padding: 16px 20px; flex-direction: column; gap: 10px; text-align: center; } } .search-bar { display: flex; align-items: center; gap: 8px; background: rgba(7,30,37,0.04); border: 1px solid rgba(7,30,37,0.10); border-radius: 20px; padding: 7px 12px; width: 220px; flex-shrink: 0; } .search-icon { color: #8AACAE; flex-shrink: 0; } #blog-search { flex: 1; border: none; outline: none; font-family: Outfit, sans-serif; font-size: 13px; color: #071E25; background: transparent; min-width: 0; } #blog-search::placeholder { color: #8AACAE; } .search-clear { background: none; border: none; cursor: pointer; color: #8AACAE; font-size: 14px; padding: 0; line-height: 1; } .load-more-wrap { text-align: center; padding: 32px 0 48px; } #load-more-btn { display: inline-flex; align-items: center; gap: 8px; background: #1A6860; color: #ffffff; border: none; border-radius: 10px; padding: 12px 24px; font-family: Outfit, sans-serif; font-size: 15px; font-weight: 600; cursor: pointer; } #load-more-btn:hover { background: #155850; } .tpcp-ticker { background: #fff; border-top: 2px solid #1A6860; border-bottom: 2px solid #1A6860; overflow: hidden; } .tpcp-ticker-head { background: #FFFFFF; border-bottom: 0.5px solid rgba(7,30,37,0.08); padding: 11px 15px; display: flex; align-items: center; justify-content: space-between; } .tpcp-ticker-title { font-family: Fraunces, serif; font-size: 16px; font-weight: 600; color: #071E25; } .tpcp-ticker-live { display: flex; align-items: center; gap: 6px; font-family: Outfit, sans-serif; font-size: 10px; font-weight: 700; color: #0F6830; letter-spacing: 0.02em; } .tpcp-ticker-dot { width: 6px; height: 6px; border-radius: 50%; background: #0F6830; display: inline-block; flex-shrink: 0; } .tpcp-ticker-body { overflow: hidden; position: relative; height: 36px; display: flex; align-items: center; } .tpcp-ticker-track { display: flex; align-items: center; gap: 0; white-space: nowrap; animation: tpcpScroll linear infinite; will-change: transform; padding: 0 16px; } .tpcp-ticker-loading { font-family: Outfit, sans-serif; font-size: 12px; font-weight: 600; color: #4A7A7C; padding: 0 16px; } .tpcp-ticker-closed { font-family: Outfit, sans-serif; font-size: 12px; font-weight: 600; color: #4A7A7C; padding: 0 16px; width: 100%; text-align: center; } .tpcp-park-marker { font-family: Fraunces, serif; font-size: 12px; font-weight: 700; margin: 0 14px 0 8px; flex-shrink: 0; } .tpcp-ride { display: inline-flex; align-items: baseline; gap: 5px; margin: 0 6px; flex-shrink: 0; } .tpcp-ride-name { font-family: Outfit, sans-serif; font-size: 12px; font-weight: 600; color: #071E25; } .tpcp-ride-land { font-family: Outfit, sans-serif; font-size: 10px; font-weight: 400; color: #8AACAE; } .tpcp-ride-wait { font-family: Outfit, sans-serif; font-size: 12px; font-weight: 800; } .tpcp-div { color: rgba(7,30,37,0.12); margin: 0 8px; font-size: 14px; font-weight: 400; } @keyframes tpcpScroll { from { transform: translateX(0); } to { transform: translateX(-50%); } } @media (prefers-reduced-motion: reduce) { .tpcp-ticker-track { animation: none !important; } .tpcp-ticker-body { overflow-x: auto; } } @media (max-width: 768px) { .tpcp-ticker { border-radius: 0; border-left: none; border-right: none; margin: 0; } }';

function toPublicIndex(entries) {
  var list = (entries || []).filter(function (p) { return p && p.published === true; });
  var bySlug = {};
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    var slug = p.slug;
    if (!slug) continue;
    var t = new Date(p.updatedAt || p.publishedAt || 0).getTime();
    var cur = bySlug[slug];
    if (!cur || t >= cur._t) { p._t = t; bySlug[slug] = p; }
  }
  var out = Object.keys(bySlug).map(function (k) { var p = bySlug[k]; delete p._t; return p; });
  out.sort(function (a, b) {
    return new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime();
  });
  return out;
}

export default async function handler(req, res) {
const MAX_REQUEST_SIZE = 500 * 1024;
const contentLength = parseInt(req.headers['content-length'] || '0');
if (contentLength > MAX_REQUEST_SIZE) {
return res.status(413).json({ error: 'Request too large' });
}
res.setHeader('X-Content-Type-Options', 'nosniff');
res.setHeader('X-Frame-Options', 'DENY');
res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
const now = Date.now();
const windowMs = 60 * 1000;
const max = 100;
if (!readRateLimit.has(ip)) {
readRateLimit.set(ip, { count: 1, resetAt: now + windowMs });
} else {
const record = readRateLimit.get(ip);
if (now > record.resetAt) {
readRateLimit.set(ip, { count: 1, resetAt: now + windowMs });
} else if (record.count >= max) {
return res.status(429).send('Rate limit exceeded');
} else {
record.count++;
}
}

try {
var posts = [];
try { posts = (await readBlob('blog/posts/index')) || []; } catch(e) { posts = []; }
posts = toPublicIndex(posts);
posts = sortPosts(posts);
var settings = await readSettings();
var postsPerPage = settings.postsPerPage || 30;
posts = posts.slice(0, postsPerPage);
try {
var bodyFetches = posts.map(function(p) {
return readBlob('blog/posts/' + p.slug).then(function(full) {
if (full && full.body) {
p.bodySnippet = (full.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 2000);
} else {
p.bodySnippet = '';
}
}).catch(function() { p.bodySnippet = ''; });
});
await Promise.all(bodyFetches);
} catch(e) { posts.forEach(function(p) { p.bodySnippet = p.bodySnippet || ''; }); }

let pinnedSlugs = [];
try {
const pinsRes = await fetch('https://disney-wait-times-lupt.vercel.app/api/blog-pins', { cache: 'no-store' });
const pinsData = await pinsRes.json();
pinnedSlugs = pinsData.pins || [];
} catch(e) { pinnedSlugs = []; }
var featuredSlug = null;
try {
var _fblobs = (await list({ prefix: 'blog:featured', limit: 10, token: process.env.BLOB_READ_WRITE_TOKEN })).blobs || [];
var _fmatch = _fblobs.filter(function(b){ return b.pathname === 'blog:featured'; }).sort(function(a,b){ return new Date(b.uploadedAt)-new Date(a.uploadedAt); });
if (_fmatch.length) {
var _fr = await fetch(_fmatch[0].downloadUrl, { cache: 'no-store' });
if (_fr.ok) { var _ft = (await _fr.text()).trim(); featuredSlug = _ft || null; }
}
} catch(e) { featuredSlug = null; }
var featuredPost = null;
if (featuredSlug && typeof featuredSlug === 'string') {
featuredPost = posts.find(function(p) { return p.slug === featuredSlug; }) || null;
}
if (!featuredPost) featuredPost = posts[0] || null;
var remainingPosts = posts.filter(function(p) { return p !== featuredPost; });

const pinnedPosts = pinnedSlugs
.map(slug => remainingPosts.find(p => p.slug === slug))
.filter(Boolean);
const pinnedSlugSet = new Set(pinnedSlugs);
const restPosts = remainingPosts.filter(p => !pinnedSlugSet.has(p.slug));

const featuredHtml = featuredPost ? renderCard(featuredPost, true) : '';
const pinnedHtml = pinnedPosts.map(p => renderCard(p, false)).join('');
const restHtml = restPosts.map(p => renderCard(p, false)).join('');
const itemListSchema = JSON.stringify({
"@context": "https://schema.org",
"@type": "ItemList",
"name": "Theme Park Planning Guides",
"description": "Expert guides for Disneyland and Walt Disney World planning",
"url": "https://themeparkcopilot.com/blog",
"numberOfItems": posts.length,
"itemListElement": posts.slice(0, 20).map((post, i) => ({
"@type": "ListItem",
"position": i + 1,
"name": post.title,
"url": `https://themeparkcopilot.com/blog/${post.slug}`
}))
});
var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Theme Park Planning Tips &amp; Guides \u2014 Theme Park Co-Pilot Blog</title><meta name="description" content="Expert tips, strategies, and real insights for Disneyland and Walt Disney World. Plan smarter days and make more magic."><meta property="og:title" content="Theme Park Planning Tips &amp; Guides \u2014 Theme Park Co-Pilot Blog"><meta property="og:description" content="Expert guides for Disneyland and Walt Disney World. Wait time strategies, dining tips, Lightning Lane guides, and more."><meta property="og:type" content="website"><meta property="og:url" content="https://themeparkcopilot.com/blog"><link rel="canonical" href="https://themeparkcopilot.com/blog"><meta property="og:image" content="https://app.themeparkcopilot.com/assets/brand/landing-photo-hero.svg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:image" content="https://app.themeparkcopilot.com/assets/brand/landing-photo-hero.svg"><link rel="sitemap" type="application/xml" href="/sitemap.xml"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,900;1,9..144,900&family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet"><link rel="icon" href="https://app.themeparkcopilot.com/assets/brand/favicon.PNG"><style>' + CSS + '</style><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Theme Park Co-Pilot Blog","url":"https://themeparkcopilot.com/blog","description":"Expert guides for Disneyland and Walt Disney World planning","publisher":{"@type":"Organization","name":"Theme Park Co-Pilot","url":"https://themeparkcopilot.com"}}<\/script><script type=\"application\/ld+json\">' + itemListSchema + '<\/script></head><body>'
+ '<nav class="nav" role="navigation" aria-label="Main navigation"><a href="https://themeparkcopilot.com" class="nav-left"><div class="nav-icon"><img src="https://app.themeparkcopilot.com/assets/brand/favicon.PNG" alt="Theme Park Co-Pilot"></div><div class="nav-wordmark">Theme Park Co<span>\u2726</span>Pilot</div></a><div class="nav-right"><a href="/blog" class="nav-link active">Blog</a><a href="https://themeparkcopilot.com" class="nav-link">Home</a><a href="https://themeparkcopilot.com" class="nav-cta">Try free \u2192</a></div></nav>'
+ '<header class="blog-hero" role="banner"><div class="blog-hero-inner"><div class="blog-hero-eyebrow">Smarter days. More magic.</div><h1 class="blog-hero-h1">Tips, strategies,<br>and <em>real insights.</em></h1><p class="blog-hero-sub">Everything your family needs to spend less time waiting and more time making memories \u2014 at Disneyland, Walt Disney World, Universal Studios, and more of your favorite theme parks!</p></div></header>'
+ '<div class="filter-bar" role="navigation" aria-label="Filter posts"><button class="filter-pill active" data-filter="all">All posts</button><button class="filter-pill" data-filter="disneyland">Disneyland</button><button class="filter-pill" data-filter="walt-disney-world">Walt Disney World</button><button class="filter-pill" data-filter="planning-tips">Planning Tips</button><button class="filter-pill" data-filter="lightning-lane">Lightning Lane</button><button class="filter-pill" data-filter="dining">Dining</button><button class="filter-pill" data-filter="hotels">Hotels</button><div class="search-bar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg><input type="text" id="blog-search" placeholder="Search guides..." autocomplete="off" /><button class="search-clear" id="search-clear" style="display:none">\u2715</button></div></div>'
+ '<main>' + '<div class="tpcp-ticker" aria-label="Live theme park wait times"><div class="tpcp-ticker-head"><span class="tpcp-ticker-title">Today at the Parks</span><span class="tpcp-ticker-live"><span class="tpcp-ticker-dot"></span>Live Wait Times</span></div><div class="tpcp-ticker-body"><div class="tpcp-ticker-track" id="tpcp-ticker-track"><span class="tpcp-ticker-loading">Loading live wait times...</span></div></div></div>' + '<div class="post-grid" id="post-grid">' + featuredHtml + pinnedHtml + restHtml + '</div>' + (posts.length === 0 ? '<div style="text-align:center;padding:80px 40px;color:#4A7A7C;">No posts found.</div>' : '') + '<div class="load-more-wrap"><button id="load-more-btn">Load more guides <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></button></div>' +
'</main>'
+ '<section class="newsletter" aria-label="Newsletter signup"><div><div class="newsletter-eyebrow">Stay in the know</div><div class="newsletter-title">Smarter days.<br><em>More magic.</em></div></div><form class="newsletter-form" action="https://disney-wait-times-lupt.vercel.app/api/subscribe" method="POST"><input class="newsletter-input" type="email" name="email" placeholder="your@email.com" required aria-label="Email address"><button class="newsletter-btn" type="submit">Get park tips \u2192</button></form></section>'
+ '<footer class="footer" role="contentinfo"><div class="footer-left">\u00a9 2026 Lunchbox Dad LLC \u00b7 Theme Park Co-Pilot \u00b7 hello@themeparkcopilot.com</div><div class="footer-right"><a href="https://themeparkcopilot.com" class="footer-link">Home</a><a href="/blog" class="footer-link">Blog</a><a href="https://themeparkcopilot.com/privacy" class="footer-link">Privacy</a><a href="https://themeparkcopilot.com/terms" class="footer-link">Terms</a></div></footer>'
+ '<script>window._postData=' + JSON.stringify(posts.map(function(p){return{slug:p.slug,title:p.title||'',intro:p.intro||p.metaDescription||'',category:p.category||'',park:p.park||'',body:p.bodySnippet||'',tags:(p.tags||[]).join(' ')};})) + ';<\/script>'
+ '<script>' +
'(function(){' +
'var searchInput=document.getElementById("blog-search");' +
'var searchClear=document.getElementById("search-clear");' +
'if(!searchInput)return;' +
'function applyFilters(){' +
'var q=(searchInput.value||"").toLowerCase().trim();' +
'if(searchClear)searchClear.style.display=q?"block":"none";' +
'var activeBtn=document.querySelector(".filter-pill.active");' +
'var activeFilter=activeBtn?(activeBtn.dataset.filter||"all"):"all";' +
'var visibleCount=0;' +
'document.querySelectorAll(".post-card").forEach(function(card){' +
'var href=card.getAttribute("href")||"";' +
'var slug=href.replace("/blog/","");' +
'var postData=(window._postData||[]).find(function(p){return p.slug===slug;});' +
'var text=postData?(postData.title+" "+postData.intro+" "+postData.category+" "+(postData.body||"")+" "+(postData.tags||"")).toLowerCase():card.textContent.toLowerCase();' +
'var category=card.dataset.category||"";' +
'var matchesSearch=!q||text.includes(q);' +
'var matchesFilter=activeFilter==="all"||category.indexOf(activeFilter)!==-1;' +
'card.setAttribute(\'data-lm-hidden\',(matchesSearch&&matchesFilter)?\'0\':\'1\');' +
'if(card.classList.contains(\'post-card--featured\'))card.style.display=(matchesSearch&&matchesFilter)?\'\':' +
'\'none\';if(matchesSearch&&matchesFilter)visibleCount++;' +
'});' +
'var noResults=document.getElementById("search-no-results");' +
'if(!noResults){noResults=document.createElement("p");noResults.id="search-no-results";noResults.style.cssText="text-align:center;color:#8AACAE;padding:40px;font-family:Outfit,sans-serif;font-size:15px;";noResults.textContent="No guides found. Try a different search.";var grid=document.querySelector(".post-grid");if(grid)grid.parentNode.insertBefore(noResults,grid.nextSibling);}' +
'noResults.style.display=visibleCount===0?"block":"none";' +
'if(window._lmReset)window._lmReset();' +
'}' +
'searchInput.addEventListener("input",applyFilters);' +
'searchInput.addEventListener("keyup",applyFilters);' +
'if(searchClear)searchClear.addEventListener("click",function(){searchInput.value="";applyFilters();searchInput.focus();});' +
'window._applyFilters=applyFilters;' +
'})();' +
'(function() {' +
' var PAGE_SIZE = 12;' +
' var shown = PAGE_SIZE;' +
' function refreshLoadMore() {' +
' var cards = document.querySelectorAll(\'.post-card:not(.post-card--featured)\');' +
' var visibleCards = Array.from(cards).filter(function(c) { return c.getAttribute(\'data-lm-hidden\') !== \'1\'; });' +
' var hiddenCards = Array.from(cards).filter(function(c) { return c.getAttribute(\'data-lm-hidden\') === \'1\'; });' +
' hiddenCards.forEach(function(card) { card.style.display = \'none\'; });' +
' visibleCards.forEach(function(card, i) {' +
' card.style.display = i < shown ? \'\' : \'none\';' +
' });' +
' var btn = document.getElementById(\'load-more-btn\');' +
' if (btn) btn.style.display = visibleCards.length > shown ? \'\' : \'none\';' +
' }' +
' refreshLoadMore();' +
' window._lmReset = function() { shown = PAGE_SIZE; refreshLoadMore(); };' +
' var btn = document.getElementById(\'load-more-btn\');' +
' if (btn) btn.addEventListener(\'click\', function() { shown += PAGE_SIZE; refreshLoadMore(); });' +
'})();' +
'document.querySelectorAll(".filter-pill").forEach(function(pill){' +
'pill.addEventListener("click",function(){' +
'document.querySelectorAll(".filter-pill").forEach(function(p){p.classList.remove("active");});' +
'this.classList.add("active");' +
'var si=document.getElementById("blog-search");if(si)si.value="";' +
'var cb=document.getElementById("search-clear");if(cb)cb.style.display="none";' +
'if(window._applyFilters)window._applyFilters();' +
'});' +
'});' +
'(function() {var track = document.getElementById(\'tpcp-ticker-track\');if (!track) return;fetch(\'/api/wait-ticker\').then(function(r) { return r.json(); }).then(function(data) {if (data.allClosed) {track.style.animation = \'none\';track.innerHTML = \'<span class="tpcp-ticker-closed">The parks are closed right now - check back during operating hours.</span>\';return;}var build = function() {var out = \'\';data.parks.forEach(function(park) {if (park.closed || !park.rides.length) return;var markerColor = park.name === \'Disneyland\' ? \'#1A6860\' : \'#ECA050\';out += \'<span class="tpcp-park-marker" style="color:\' + markerColor + \'">&#10022; \' + park.name + \'</span>\';park.rides.forEach(function(ride, i) {var color = ride.level === \'high\' ? \'#A02020\' : (ride.level === \'moderate\' ? \'#9A5800\' : \'#0F6830\');var arrow = ride.trend === \'up\' ? \'&#9650;\' : (ride.trend === \'down\' ? \'&#9660;\' : \'&#9644;\');if (i > 0) out += \'<span class="tpcp-div">|</span>\';out += \'<span class="tpcp-ride"><span class="tpcp-ride-name">\' + ride.name + \'</span> <span class="tpcp-ride-land">\' + ride.land + \'</span> <span class="tpcp-ride-wait" style="color:\' + color + \'">\' + ride.wait + \'m \' + arrow + \'</span></span>\';});});return out;};var single = build();track.innerHTML = single + single;requestAnimationFrame(function() {var trackWidth = track.scrollWidth / 2;var pxPerSec = 40;var duration = Math.round(trackWidth / pxPerSec);if (duration < 20) duration = 20;track.style.animationDuration = duration + \'s\';});}).catch(function() {track.style.animation = \'none\';track.innerHTML = \'<span class="tpcp-ticker-closed">Wait times are unavailable right now.</span>\';});})();' +
'<\/script>'
+ '</body></html>';

res.setHeader('Content-Security-Policy-Report-Only',
"default-src 'self'; " +
"script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; " +
"font-src 'self' https://fonts.gstatic.com; " +
"img-src 'self' data: https: blob:; " +
"connect-src 'self' https://disney-wait-times-lupt.vercel.app; " +
"frame-ancestors 'none';"
);
res.setHeader('Content-Type', 'text/html; charset=utf-8');
res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
return res.status(200).send(html);
} catch (err) {
console.error('blog-render-index error:', err.message, err.stack);
return res.status(500).send('Internal server error: ' + err.message);
}
};
