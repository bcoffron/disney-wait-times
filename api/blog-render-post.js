// api/blog-render-post.js
import { list } from '@vercel/blob';
const rl = {};

async function readBlob(pathname) {
const { blobs } = await list({ prefix: pathname, limit: 1000 , token: process.env.BLOB_READ_WRITE_TOKEN });
const matches = (blobs || []).filter(b => b.pathname === pathname).sort((a,b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
if (!matches.length) return null;
const r = await fetch(matches[0].downloadUrl, { cache: 'no-store' });
if (!r.ok) return null;
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

function esc(s) {
if (!s) return '';
return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function formatDate(iso) {
if (!iso) return 'June 2026';
try { return new Date(iso).toLocaleDateString('en-US', { year:'numeric', month:'long' }); } catch(e) { return 'June 2026'; }
}

function tagClass(park) {
if (park === 'dl') return 'tag-dl';
return 'tag-wdw';
}

const CTA_TEXT = {
dl: 'Planning a Disneyland trip should not feel like a second job. Theme Park Co-Pilot builds your day, watches wait times, and helps you make the most of every hour.',
wdw: 'Planning a Walt Disney World trip is complex. Theme Park Co-Pilot makes it simple — personalized day plans, live wait times, and park strategies built for your family.',
both: 'Planning a Disney trip should not feel like a second job. Theme Park Co-Pilot builds your day, watches wait times, and helps you make the most of every hour.'
};

function ctaHtml(cta, park) {
if (!cta) cta = {};
const type = cta.type || park || 'both';
const text = cta.text || CTA_TEXT[type] || CTA_TEXT.both;
const btnText = cta.buttonText || 'Try free for 7 days →';
const btnUrl = cta.buttonUrl || 'https://themeparkcopilot.com';
return '<div class="cta-box"><div class="cta-inner"><div class="cta-brand"><img class="cta-logo" src="https://app.themeparkcopilot.com/assets/brand/favicon.PNG" alt="Theme Park Co-Pilot"><div class="cta-brand-name">Theme Park Co-Pilot</div></div><div class="cta-tagline">Smarter days.<br><em>More magic.</em></div><p class="cta-body">' + esc(text) + '</p><a href="' + esc(btnUrl) + '" class="cta-btn">' + esc(btnText) + '</a></div></div>';
}

function faqsHtml(faqs) {
if (!faqs || !faqs.length) return '';
var items = faqs.map(function(f) {
return '<div class="faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question"><div class="faq-q" itemprop="name">' + esc(f.q) + '</div><div class="faq-a" itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer"><span itemprop="text">' + esc(f.a) + '</span></div></div>';
}).join('');
return '<div class="faq" itemscope itemtype="https://schema.org/FAQPage"><h2 class="faq-title">Frequently asked questions</h2>' + items + '</div>';
}

function relatedHtml(related) {
if (!related || !related.length) return '';
var cards = related.map(function(r) {
var rPark = r.park || 'both';
var rClass = rPark === 'dl' ? 'tag-abs-dl' : 'tag-abs-wdw';
var rLabel = rPark === 'dl' ? 'DISNEYLAND' : 'WALT DISNEY WORLD';
return '<a class="related-card" href="/blog/' + esc(r.slug) + '"><span class="related-card-tag post-tag ' + rClass + '">' + rLabel + '</span><div class="related-card-title">' + esc(r.title) + '</div></a>';
}).join('');
return '<nav class="related" aria-label="Related posts"><h2 class="related-title">Keep reading</h2><div class="related-grid">' + cards + '</div></nav>';
}

function faqSchema(faqs) {
if (!faqs || !faqs.length) return '';
var mainEntity = faqs.map(function(f) { return { '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } }; });
return JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: mainEntity });
}

function not404Html() {
return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Post Not Found — Theme Park Co-Pilot</title><link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,900;1,9..144,900&family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet"><link rel="icon" href="https://app.themeparkcopilot.com/assets/brand/favicon.PNG"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Outfit,sans-serif;background:#EEF5F4;color:#071E25;min-height:100vh;display:flex;flex-direction:column}.nav{background:#071E25;height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 40px}.nav-left{display:flex;align-items:center;gap:10px;text-decoration:none}.nav-icon{width:30px;height:30px;border-radius:7px;overflow:hidden;border:1px solid rgba(212,168,48,0.3);flex-shrink:0}.nav-icon img{width:100%;height:100%;object-fit:cover}.nav-wordmark{font-size:13px;font-weight:800;color:#fff}.nav-wordmark span{color:#F5A623}.nav-right{display:flex;align-items:center;gap:20px}.nav-link{font-size:11px;font-weight:600;color:rgba(255,255,255,0.55);text-decoration:none}.nav-cta{font-size:11px;font-weight:700;color:#071E25;background:#F5A623;border-radius:100px;padding:7px 14px;text-decoration:none}.not-found{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 40px;text-align:center}.nf-code{font-family:Fraunces,serif;font-size:96px;font-weight:900;color:#F5A623;line-height:1}.nf-title{font-family:Fraunces,serif;font-size:28px;font-weight:900;color:#071E25;margin:16px 0 12px}.nf-sub{font-size:15px;color:#4A7A7C;margin-bottom:32px}.nf-btn{display:inline-block;background:#071E25;color:#fff;font-family:Outfit,sans-serif;font-size:13px;font-weight:700;padding:12px 24px;border-radius:100px;text-decoration:none}footer{background:#071E25;padding:20px 40px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid rgba(255,255,255,0.07)}.fl{font-size:10px;color:rgba(255,255,255,0.30)}.fr{display:flex;gap:16px}.flink{font-size:10px;color:rgba(255,255,255,0.30);text-decoration:none}</style></head><body><nav class="nav"><a href="https://themeparkcopilot.com" class="nav-left"><div class="nav-icon"><img src="https://app.themeparkcopilot.com/assets/brand/favicon.PNG" alt="Theme Park Co-Pilot"></div><div class="nav-wordmark">Theme Park Co<span>&#10022;</span>Pilot</div></a><div class="nav-right"><a href="/blog" class="nav-link">Blog</a><a href="https://themeparkcopilot.com" class="nav-cta">Try free →</a></div></nav><div class="not-found"><div class="nf-code">404</div><h1 class="nf-title">Post not found</h1><p class="nf-sub">The post you are looking for does not exist or may have moved.</p><a href="/blog" class="nf-btn">← Back to all posts</a></div><footer><div class="fl">© 2026 Lunchbox Dad LLC · Theme Park Co-Pilot · hello@themeparkcopilot.com</div><div class="fr"><a href="https://themeparkcopilot.com" class="flink">Home</a><a href="/blog" class="flink">Blog</a><a href="https://themeparkcopilot.com/privacy" class="flink">Privacy</a><a href="https://themeparkcopilot.com/terms" class="flink">Terms</a></div></footer></body></html>';
}

const POST_CSS = '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; } html { scroll-behavior: smooth; } body { font-family: Outfit, sans-serif; background: #EEF5F4; color: #071E25; -webkit-font-smoothing: antialiased; } .nav { background: #071E25; height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 40px; position: sticky; top: 0; z-index: 100; border-bottom: 1px solid rgba(255,255,255,0.07); } .nav-left { display: flex; align-items: center; gap: 10px; text-decoration: none; } .nav-icon { width: 30px; height: 30px; border-radius: 7px; overflow: hidden; border: 1px solid rgba(212,168,48,0.3); flex-shrink: 0; } .nav-icon img { width: 100%; height: 100%; object-fit: cover; display: block; } .nav-wordmark { font-size: 13px; font-weight: 800; color: #fff; letter-spacing: -0.2px; } .nav-wordmark span { color: #F5A623; } .nav-right { display: flex; align-items: center; gap: 20px; } .nav-link { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.55); text-decoration: none; transition: color .15s; } .nav-link:hover { color: #fff; } .nav-cta { font-size: 11px; font-weight: 700; color: #071E25; background: #F5A623; border-radius: 100px; padding: 7px 14px; text-decoration: none; } .post-hero { position: relative; width: 100%; overflow: hidden; background: #0d2a30; } .post-hero img { width: 100%; height: 100%; object-fit: cover; display: block; } .post-hero-overlay { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(7,30,37,0.15) 0%, rgba(7,30,37,0.55) 100%); } .post-hero-tag { position: absolute; top: 20px; left: 20px; } .post-tag { font-size: 9px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; border-radius: 100px; padding: 5px 12px; } .tag-dl { background: rgba(26,104,96,0.92); color: #E0F5EE; } .tag-wdw { background: rgba(184,134,11,0.92); color: #FFF8E0; } .tag-abs-dl { background: rgba(26,104,96,0.92); color: #E0F5EE; } .tag-abs-wdw { background: rgba(184,134,11,0.92); color: #FFF8E0; } .post-back { max-width: 720px; margin: 0 auto; padding: 24px 40px 0; } .post-back__btn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: #1A6860; background: #fff; border: 1.5px solid #1A6860; border-radius: 100px; padding: 7px 14px; text-decoration: none; transition: background .15s, color .15s; } .post-back__btn:hover { background: #1A6860; color: #fff; } .article-wrap { max-width: 720px; margin: 0 auto; padding: 48px 40px 64px; } header.article-wrap { padding-bottom: 0; } .article-body-wrap { padding-top: 0; } .post-category { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; color: #8AACAE; margin-bottom: 14px; } .post-title { font-family: Fraunces, serif; font-size: 36px; font-weight: 900; color: #071E25; line-height: 1.12; letter-spacing: -0.5px; margin-bottom: 18px; } .post-intro { font-size: 16px; color: #2A4A50; line-height: 1.65; margin-bottom: 22px; font-weight: 500; } .post-byline { display: flex; align-items: center; gap: 14px; font-size: 11px; color: #8AACAE; font-weight: 600; border-top: 0.5px solid rgba(7,30,37,0.09); border-bottom: 0.5px solid rgba(7,30,37,0.09); padding: 14px 0; margin-bottom: 10px; } .post-byline-dot { width: 3px; height: 3px; border-radius: 50%; background: #8AACAE; flex-shrink: 0; } .article-body { font-size: 15px; line-height: 1.75; color: #2A4A50; } .article-body h2 { font-family: Fraunces, serif; font-size: 24px; font-weight: 900; color: #071E25; margin: 40px 0 16px; line-height: 1.2; } .article-body h3 { font-family: Fraunces, serif; font-size: 20px; font-weight: 900; color: #071E25; margin: 32px 0 12px; } .article-body p { margin-bottom: 20px; } .article-body ul, .article-body ol { padding-left: 20px; margin-bottom: 18px; } .article-body li { margin-bottom: 8px; } .article-body strong { font-weight: 700; color: #071E25; } .article-body a { color: #1A6860; text-decoration: underline; } .callout { background: #fff; border-left: 3px solid #1A6860; border-radius: 0 10px 10px 0; padding: 14px 18px; margin: 24px 0; } .callout p { margin: 0; font-size: 14px; color: #2A4A50; } .share-bar { margin: 40px 0 0; padding: 24px 0 0; border-top: 0.5px solid rgba(7,30,37,0.10); } .share-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .14em; color: #8AACAE; margin-bottom: 12px; } .share-buttons { display: flex; gap: 8px; flex-wrap: wrap; } .share-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 100px; font-family: Outfit, sans-serif; font-size: 11px; font-weight: 700; text-decoration: none; cursor: pointer; border: none; transition: opacity .15s; } .share-btn:hover { opacity: .8; } .share-btn-facebook { background: #1877F2; color: #fff; } .share-btn-x { background: #000; color: #fff; } .share-btn-pinterest { background: #E60023; color: #fff; } .share-btn-instagram { background: #C13584; color: #fff; } .share-btn-copy { background: #F0F4F4; color: #071E25; } .share-tooltip { position: relative; } .share-tooltip-text { display: none; position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); background: #071E25; color: #fff; font-size: 10px; font-weight: 600; padding: 6px 10px; border-radius: 6px; white-space: nowrap; z-index: 10; } .share-tooltip.show-tip .share-tooltip-text { display: block; } .cta-box { background: #071E25; border-radius: 16px; padding: 32px; margin: 40px 0; } .cta-inner { display: flex; flex-direction: column; gap: 12px; } .cta-brand { display: flex; align-items: center; gap: 10px; } .cta-logo { width: 28px; height: 28px; border-radius: 6px; } .cta-brand-name { font-size: 12px; font-weight: 800; color: #fff; } .cta-tagline { font-family: Fraunces, serif; font-size: 24px; font-weight: 900; color: #fff; line-height: 1.15; } .cta-tagline em { color: #F5A623; font-style: italic; } .cta-body { font-size: 13px; color: rgba(255,255,255,0.65); line-height: 1.6; } .cta-btn { display: inline-block; background: #F5A623; color: #071E25; font-family: Outfit, sans-serif; font-size: 13px; font-weight: 700; padding: 12px 22px; border-radius: 100px; text-decoration: none; margin-top: 4px; align-self: flex-start; } .faq { margin-top: 40px; } .faq-title { font-family: Fraunces, serif; font-size: 24px; font-weight: 900; color: #071E25; margin-bottom: 20px; } .faq-item { background: #fff; border-radius: 10px; border: 0.5px solid rgba(7,30,37,0.07); padding: 16px 18px; margin-bottom: 10px; } .faq-q { font-size: 13px; font-weight: 700; color: #071E25; margin-bottom: 8px; } .faq-a { font-size: 13px; color: #4A7A7C; line-height: 1.6; } .author-bio { background: #fff; border-radius: 12px; border: 0.5px solid rgba(7,30,37,0.07); padding: 18px 20px; margin: 40px 0; display: flex; gap: 14px; align-items: flex-start; } .author-avatar { width: 44px; height: 44px; border-radius: 50%; background: #071E25; flex-shrink: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; } .author-avatar img { width: 100%; height: 100%; object-fit: cover; } .author-name { font-size: 12px; font-weight: 700; color: #071E25; margin-bottom: 4px; } .author-bio-text { font-size: 12px; color: #4A7A7C; line-height: 1.55; } .related { margin: 48px 0; } .related-title { font-family: Fraunces, serif; font-size: 22px; font-weight: 900; color: #071E25; margin-bottom: 18px; } .related-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; } .related-card { display: flex; flex-direction: column; background: #fff; border-radius: 12px; border: 0.5px solid rgba(7,30,37,0.07); padding: 18px 20px; text-decoration: none; color: inherit; transition: box-shadow .2s; gap: 10px; } .related-card:hover { box-shadow: 0 4px 16px rgba(7,30,37,0.10); } .related-card-tag { align-self: flex-start; } .related-card-title { font-family: Fraunces, serif; font-size: 16px; font-weight: 900; color: #071E25; line-height: 1.25; } .footer { background: #071E25; padding: 20px 40px; display: flex; align-items: center; justify-content: space-between; border-top: 1px solid rgba(255,255,255,0.07); } .footer-left { font-size: 10px; color: rgba(255,255,255,0.30); } .footer-right { display: flex; gap: 16px; } .footer-link { font-size: 10px; color: rgba(255,255,255,0.30); text-decoration: none; } .footer-link:hover { color: rgba(255,255,255,0.60); } @media (max-width: 700px) { .article-wrap { padding: 32px 18px 48px; } .article-body-wrap { padding-top: 0; } .post-back { padding: 16px 18px 0; } .post-title { font-size: 28px; } .post-hero { height: 280px; } .related-grid { grid-template-columns: 1fr; } .nav { padding: 0 20px; } .nav-right .nav-link { display: none; } .footer { padding: 16px 20px; flex-direction: column; gap: 10px; text-align: center; } } @media (min-width: 701px) { .post-hero { height: 520px; } }';

export default async function handler(req, res) {
res.setHeader('Access-Control-Allow-Origin', '*');
if (req.method === 'OPTIONS') return res.status(200).end();
var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
var now = Date.now();
if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
rl[ip].count++;
if (rl[ip].count > 20) return res.status(429).send('Rate limit exceeded');

var slug = req.query.slug || '';
if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
res.setHeader('Content-Type', 'text/html; charset=utf-8');
return res.status(404).send(not404Html());
}

var post = null;
try { post = await readBlob('blog/posts/' + slug); } catch(e) { post = null; }
if (!post) {
res.setHeader('Content-Type', 'text/html; charset=utf-8');
return res.status(404).send(not404Html());
}

// Read settings for byline
var settings = await readSettings();
var byline = settings.byline || 'By the Theme Park Co-Pilot Team';

var pageUrl = 'https://themeparkcopilot.com/blog/' + esc(post.slug);
var pageTitle = esc(post.title) + ' — Theme Park Co-Pilot';
var ogImg = esc(post.heroImage || '');
var tClass = tagClass(post.park);
var focalStyle = post.heroFocal ? 'object-position:' + post.heroFocal + ';' : '';

var articleSchema = JSON.stringify({
'@context': 'https://schema.org', '@type': 'Article',
headline: post.title, description: post.metaDescription || post.intro || '',
image: post.heroImage || '', datePublished: post.publishedAt || '', dateModified: post.updatedAt || post.publishedAt || '',
author: { '@type': 'Organization', name: 'Theme Park Co-Pilot' },
publisher: { '@type': 'Organization', name: 'Theme Park Co-Pilot', logo: { '@type': 'ImageObject', url: 'https://app.themeparkcopilot.com/assets/brand/favicon.PNG' } }
});

var shareUrl = encodeURIComponent(pageUrl);
var shareTitle = encodeURIComponent((post.title || '') + ' — Theme Park Co-Pilot');
var shareImg = encodeURIComponent(post.heroImage || '');
var tagLabel = esc((post.tagLabel || (post.park === 'dl' ? 'Disneyland' : 'Walt Disney World')).toUpperCase());

var faqSchemaTag = (post.faqs && post.faqs.length) ? '<script type="application/ld+json">' + faqSchema(post.faqs) + '<\/scr' + 'ipt>' : '';

var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' + pageTitle + '</title><meta name="description" content="' + esc(post.metaDescription || post.intro || '') + '"><meta property="og:title" content="' + esc(post.title) + '"><meta property="og:description" content="' + esc(post.metaDescription || post.intro || '') + '"><meta property="og:type" content="article"><meta property="og:url" content="' + pageUrl + '"><meta property="og:image" content="' + ogImg + '"><meta property="article:published_time" content="' + esc(post.publishedAt || '') + '"><meta property="article:modified_time" content="' + esc(post.updatedAt || '') + '"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="' + esc(post.title) + '"><meta name="twitter:description" content="' + esc(post.metaDescription || post.intro || '') + '"><meta name="twitter:image" content="' + ogImg + '"><link rel="canonical" href="' + pageUrl + '"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,900;1,9..144,900&family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet"><link rel="icon" href="https://app.themeparkcopilot.com/assets/brand/favicon.PNG"><style>' + POST_CSS + '</style><script type="application/ld+json">' + articleSchema + '<\/scr' + 'ipt>' + faqSchemaTag + '</head><body>'
+ '<nav class="nav" role="navigation" aria-label="Main navigation"><a href="https://themeparkcopilot.com" class="nav-left"><div class="nav-icon"><img src="https://app.themeparkcopilot.com/assets/brand/favicon.PNG" alt="Theme Park Co-Pilot"></div><div class="nav-wordmark">Theme Park Co<span>&#10022;</span>Pilot</div></a><div class="nav-right"><a href="/blog" class="nav-link">Blog</a><a href="https://themeparkcopilot.com" class="nav-link">Home</a><a href="https://themeparkcopilot.com" class="nav-cta">Try free →</a></div></nav>'
+ '<div class="post-hero"><img src="' + esc(post.heroImage || '') + '" alt="' + esc(post.heroAlt || post.title) + '" style="width:100%;height:100%;object-fit:cover;' + focalStyle + '" loading="eager"><div class="post-hero-overlay"></div><div class="post-hero-tag"><span class="post-tag ' + tClass + '">' + tagLabel + '</span></div></div>'
+ '<div class="post-back"><a href="/blog" class="post-back__btn">← Back to all guides</a></div><article><header class="article-wrap"><div class="post-category">' + (post.category || '').replace(/&middot;/g, '·').replace(/&amp;/g, '&') + '</div><h1 class="post-title">' + esc(post.title) + '</h1><div class="post-byline"><span>' + esc(byline) + '</span><span class="post-byline-dot"></span><span>' + formatDate(post.publishedAt) + '</span><span class="post-byline-dot"></span><span>' + esc(post.readTime || '8') + ' min read</span></div><p class="post-intro">' + esc(post.intro || '') + '</p></header>'
+ '<div class="article-wrap article-body-wrap"><div class="article-body">' + (post.body || '').replace(/^(\s*<p>\s*<\/p>\s*)+/i, '').trim() + '</div>'
+ '<div class="share-bar"><div class="share-label">Share this post</div><div class="share-buttons"><a href="https://www.facebook.com/sharer/sharer.php?u=' + shareUrl + '" class="share-btn share-btn-facebook" target="_blank" rel="noopener">Facebook</a><a href="https://twitter.com/intent/tweet?url=' + shareUrl + '&text=' + shareTitle + '" class="share-btn share-btn-x" target="_blank" rel="noopener">X</a><a href="https://pinterest.com/pin/create/button/?url=' + shareUrl + '&media=' + shareImg + '&description=' + shareTitle + '" class="share-btn share-btn-pinterest" target="_blank" rel="noopener">Pinterest</a><button class="share-btn share-btn-instagram" onclick="copyLink()" type="button">Instagram</button><button class="share-btn share-btn-copy share-tooltip" id="copy-btn" onclick="copyLink()" type="button"><span class="share-tooltip-text" id="copy-tip">Copied!</span>Copy link</button></div></div>'
+ ctaHtml(post.cta, post.park)
+ faqsHtml(post.faqs)
+ '<div class="author-bio"><div class="author-avatar"><img src="https://app.themeparkcopilot.com/assets/brand/favicon.PNG" alt="Theme Park Co-Pilot"></div><div><div class="author-name">Theme Park Co-Pilot Team</div><div class="author-bio-text">Disney planning obsessives who have spent countless hours studying wait time patterns, crowd behavior, and what actually makes a theme park day feel magical. We built Theme Park Co-Pilot because we kept giving the same advice to friends — and wanted to share it with every family.</div></div></div>'
+ relatedHtml(post.related)
+ '</div></article>'
+ '<footer class="footer" role="contentinfo"><div class="footer-left">© 2026 Lunchbox Dad LLC · Theme Park Co-Pilot · hello@themeparkcopilot.com</div><div class="footer-right"><a href="https://themeparkcopilot.com" class="footer-link">Home</a><a href="/blog" class="footer-link">Blog</a><a href="https://themeparkcopilot.com/privacy" class="footer-link">Privacy</a><a href="https://themeparkcopilot.com/terms" class="footer-link">Terms</a></div></footer>'
+ '<script>var _purl="' + pageUrl + '";function copyLink(){if(navigator.clipboard){navigator.clipboard.writeText(_purl).then(showCopied);}else{var el=document.createElement("textarea");el.value=_purl;document.body.appendChild(el);el.select();document.execCommand("copy");document.body.removeChild(el);showCopied();}}function showCopied(){var b=document.getElementById("copy-btn");if(b){b.classList.add("show-tip");setTimeout(function(){b.classList.remove("show-tip");},2000);}}<\/script>'
+ '</body></html>';

res.setHeader('Content-Type', 'text/html; charset=utf-8');
res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
return res.status(200).send(html);
};
