// api/blog-render-index.js
import { list } from '@vercel/blob';
const rl = {};

async function readBlob(pathname) {
    const { blobs } = await list({ prefix: pathname, limit: 1000 , token: process.env.BLOB_READ_WRITE_TOKEN});
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

function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// Curated post order matching the live static site
var POST_ORDER = ["disneyland-rope-drop-strategy","best-time-to-visit-disneyland","disney-world-on-site-vs-off-site-hotels","best-restaurants-disneyland","walt-disney-world-rope-drop-strategy","disneyland-on-site-vs-off-site-hotels","how-to-use-lightning-lane-disneyland","disney-world-character-dining-guide","disneyland-vs-disney-world","disneyland-tips-first-timers","disney-world-dining-plan-worth-it","how-to-use-lightning-lane-walt-disney-world","best-snacks-disneyland","walt-disney-world-tips-first-timers","disneyland-vs-disney-california-adventure","best-restaurants-disney-world","which-disney-world-park-should-you-visit-first","how-to-plan-a-disneyland-trip","best-time-to-visit-walt-disney-world","how-to-plan-a-walt-disney-world-trip","epcot-world-showcase-food-guide","animal-kingdom-guide","disneyland-with-kids","magic-kingdom-guide","universal-orlando-vs-disney-world","epcot-guide","disney-world-budget-tips","hollywood-studios-guide","disney-world-itinerary-7-days","disney-world-with-toddlers"];

function sortPosts(posts) {
    var ordered = [];
    POST_ORDER.forEach(function(slug) {
          var p = posts.find(function(x) { return x.slug === slug; });
          if (p) ordered.push(p);
    });
    posts.forEach(function(p) {
          if (!POST_ORDER.includes(p.slug)) ordered.push(p);
    });
    return ordered;
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
    var catLabel = (post.category || '').replace(/&middot;/g, 'ÃÂ·').replace(/&amp;/g, '&');

  if (isFeatured) {
        return '<a class="post-card post-card--featured" href="/blog/' + slug + '" data-category="' + cat + '" aria-label="' + title + '"><div class="post-card__img-wrap"><img src="' + heroImage + '" alt="' + heroAlt + '" class="post-card__img" loading="eager"><span class="post-card__badge">START HERE</span></div><div class="post-card__body"><p class="post-card__eyebrow">' + catLabel + '</p><h2 class="post-card__title post-card__title--featured">' + title + '</h2><p class="post-card__intro">' + intro + '</p><div class="post-card__footer"><span class="post-card__read">' + readTime + ' min read</span><span class="post-card__cta">Read the guide \u2192</span></div></div></a>';
  }
    return '<a class="post-card" href="/blog/' + slug + '" data-category="' + cat + '" aria-label="' + title + '"><div class="post-card__img-wrap"><img src="' + heroImage + '" alt="' + heroAlt + '" class="post-card__img" loading="lazy"><span class="post-tag post-tag--card ' + tClass + '"' + tStyle + '>' + tagLabel + '</span></div><div class="post-card__body"><p class="post-card__eyebrow">' + catLabel + '</p><h2 class="post-card__title">' + title + '</h2><p class="post-card__intro">' + intro + '</p><div class="post-card__footer"><span class="post-card__read">' + readTime + ' min read</span><span class="post-card__cta">Read \u2192</span></div></div></a>';
}

var CSS = '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; } html { scroll-behavior: smooth; } body { font-family: Outfit, sans-serif; background: #EEF5F4; color: #071E25; -webkit-font-smoothing: antialiased; } .nav { background: #071E25; height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 40px; position: sticky; top: 0; z-index: 100; border-bottom: 1px solid rgba(255,255,255,0.07); } .nav-left { display: flex; align-items: center; gap: 10px; text-decoration: none; } .nav-icon { width: 30px; height: 30px; border-radius: 7px; overflow: hidden; border: 1px solid rgba(212,168,48,0.3); flex-shrink: 0; } .nav-icon img { width: 100%; height: 100%; object-fit: cover; display: block; } .nav-wordmark { font-size: 13px; font-weight: 800; color: #fff; letter-spacing: -0.2px; } .nav-wordmark span { color: #F5A623; } .nav-right { display: flex; align-items: center; gap: 20px; } .nav-link { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.55); text-decoration: none; transition: color .15s; letter-spacing: .02em; } .nav-link:hover,.nav-link.active { color: #fff; } .nav-cta { font-size: 11px; font-weight: 700; color: #071E25; background: #F5A623; border-radius: 100px; padding: 7px 14px; text-decoration: none; letter-spacing: .02em; transition: opacity .15s; } .nav-cta:hover { opacity: .85; } .blog-hero { background: #071E25; padding: 64px 40px 56px; } .blog-hero-inner { max-width: 680px; } .blog-hero-eyebrow { font-size: 9px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: #F5A623; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; } .blog-hero-eyebrow::before { content: ""; display: block; width: 28px; height: 1.5px; background: #F5A623; } .blog-hero-h1 { font-family: Fraunces, serif; font-size: 52px; font-weight: 900; color: #fff; line-height: 1.05; letter-spacing: -1px; margin-bottom: 18px; } .blog-hero-h1 em { color: #F5A623; font-style: italic; } .blog-hero-sub { font-size: 15px; color: rgba(255,255,255,0.55); line-height: 1.6; max-width: 480px; } .filter-bar { background: #fff; border-bottom: 0.5px solid rgba(7,30,37,0.08); padding: 0 40px; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; } .filter-bar::-webkit-scrollbar { display: none; } .filter-pill { font-size: 11px; font-weight: 700; color: #4A7A7C; background: none; border: none; cursor: pointer; padding: 14px 14px; border-bottom: 2px solid transparent; white-space: nowrap; transition: color .15s, border-color .15s; letter-spacing: .02em; } .filter-pill:hover { color: #071E25; } .filter-pill.active { color: #071E25; border-bottom-color: #F5A623; } .post-grid { max-width: 1100px; margin: 0 auto; padding: 48px 40px 64px; display: grid; grid-template-columns: 1fr 1fr; gap: 28px; } .post-card { display: flex; flex-direction: column; background: #fff; border-radius: 14px; overflow: hidden; border: 0.5px solid rgba(7,30,37,0.07); text-decoration: none; color: inherit; transition: box-shadow .2s, transform .15s; } .post-card:hover { box-shadow: 0 8px 32px rgba(7,30,37,0.10); transform: translateY(-2px); } .post-card--featured { grid-column: 1 / -1; flex-direction: row; } .post-card__img-wrap { position: relative; overflow: hidden; flex-shrink: 0; } .post-card--featured .post-card__img-wrap { width: 52%; } .post-card__img { width: 100%; height: 100%; object-fit: cover; display: block; aspect-ratio: 16/9; transition: transform .35s; } .post-card--featured .post-card__img { aspect-ratio: auto; height: 100%; min-height: 320px; } .post-card:hover .post-card__img { transform: scale(1.03); } .post-card__badge { position: absolute; bottom: 12px; left: 12px; font-size: 9px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; background: #F5A623; color: #071E25; border-radius: 100px; padding: 5px 11px; } .post-tag { font-size: 9px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; border-radius: 100px; padding: 4px 10px; } .post-tag--card { position: absolute; top: 12px; left: 12px; } .tag-abs-dl { background: rgba(26,104,96,0.92); color: #E0F5EE; } .tag-abs-wdw { background: rgba(184,134,11,0.92); color: #FFF8E0; } .post-card__body { padding: 24px 28px; display: flex; flex-direction: column; flex: 1; } .post-card:not(.post-card--featured) .post-card__body { padding: 14px 16px 16px; } .post-card__meta { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; } .post-card__category { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .10em; color: #8AACAE; } .post-card__title { font-family: Fraunces, serif; font-size: 21px; font-weight: 900; color: #071E25; line-height: 1.2; margin-bottom: 8px; letter-spacing: -0.3px; } .post-card__title--featured { font-size: 28px; } .post-card--featured .post-card__title { font-size: 28px; } .post-card__intro { font-size: 13px; color: #4A7A7C; line-height: 1.6; flex: 1; margin-bottom: 20px; } .post-card__footer { display: flex; justify-content: space-between; align-items: center; padding-top: 10px; border-top: 0.5px solid rgba(7,30,37,0.07); } .post-card__read { font-size: 11px; color: #8AACAE; font-weight: 600; } .post-card__cta { font-size: 11px; font-weight: 700; color: #1A6860; } .newsletter { background: #071E25; padding: 56px 40px; display: flex; justify-content: space-between; align-items: center; gap: 40px; } .newsletter-eyebrow { font-size: 9px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: #F5A623; margin-bottom: 10px; } .newsletter-title { font-family: Fraunces, serif; font-size: 32px; font-weight: 900; color: #fff; line-height: 1.1; } .newsletter-title em { color: #F5A623; font-style: italic; } .newsletter-form { display: flex; gap: 8px; } .newsletter-input { font-family: Outfit, sans-serif; font-size: 13px; padding: 12px 16px; border-radius: 100px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.07); color: #fff; width: 240px; outline: none; } .newsletter-input::placeholder { color: rgba(255,255,255,0.35); } .newsletter-btn { font-family: Outfit, sans-serif; font-size: 12px; font-weight: 700; background: #F5A623; color: #071E25; border: none; border-radius: 100px; padding: 12px 20px; cursor: pointer; white-space: nowrap; } .footer { background: #071E25; padding: 20px 40px; display: flex; align-items: center; justify-content: space-between; border-top: 1px solid rgba(255,255,255,0.07); } .footer-left { font-size: 10px; color: rgba(255,255,255,0.30); } .footer-right { display: flex; gap: 16px; } .footer-link { font-size: 10px; color: rgba(255,255,255,0.30); text-decoration: none; } .footer-link:hover { color: rgba(255,255,255,0.60); } @media (max-width: 700px) { .blog-hero { padding: 40px 20px 36px; } .blog-hero-h1 { font-size: 34px; } .filter-bar { padding: 0 20px; } .post-grid { grid-template-columns: 1fr; padding: 32px 20px 48px; gap: 20px; } .post-card--featured { flex-direction: column; } .post-card--featured .post-card__img-wrap { width: 100%; } .newsletter { flex-direction: column; padding: 40px 20px; text-align: center; } .newsletter-form { flex-direction: column; width: 100%; } .newsletter-input { width: 100%; } .nav { padding: 0 20px; } .nav-right .nav-link { display: none; } .footer { padding: 16px 20px; flex-direction: column; gap: 10px; text-align: center; } } .search-bar-wrap { max-width: 1200px; margin: 0 auto; padding: 24px 40px 0; } .search-bar { display: flex; align-items: center; gap: 10px; background: #fff; border: 1.5px solid rgba(7,30,37,0.12); border-radius: 10px; padding: 10px 14px; } .search-icon { color: #8AACAE; flex-shrink: 0; } #blog-search { flex: 1; border: none; outline: none; font-family: Outfit, sans-serif; font-size: 14px; color: #071E25; background: transparent; } #blog-search::placeholder { color: #8AACAE; } .search-clear { background: none; border: none; cursor: pointer; color: #8AACAE; font-size: 14px; padding: 0; line-height: 1; } @media (max-width: 700px) { .search-bar-wrap { padding: 16px 20px 0; } }';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    var now = Date.now();
    if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
    rl[ip].count++;
    if (rl[ip].count > 120) return res.status(429).send('Rate limit exceeded');

  try {
        var posts = [];
        try { posts = (await readBlob('blog/posts/index')) || []; } catch(e) { posts = []; }
        posts = posts.filter(function(p) { return p.published !== false; });
        posts = sortPosts(posts);
    // Apply postsPerPage from settings
    var settings = await readSettings();
    var postsPerPage = settings.postsPerPage || 30;
    posts = posts.slice(0, postsPerPage);


      var featuredPost = posts[0];
        var remainingPosts = posts.slice(1);

      var featuredHtml = featuredPost ? renderCard(featuredPost, true) : '';
        var cardsHtml = remainingPosts.map(function(p) { return renderCard(p, false); }).join('\n');

      var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Theme Park Planning Tips &amp; Guides \u2014 Theme Park Co-Pilot Blog</title><meta name="description" content="Expert tips, strategies, and real insights for Disneyland and Walt Disney World. Plan smarter days and make more magic."><meta property="og:title" content="Theme Park Planning Tips &amp; Guides — Theme Park Co-Pilot Blog"><meta property="og:description" content="Expert guides for Disneyland and Walt Disney World. Wait time strategies, dining tips, Lightning Lane guides, and more."><meta property="og:type" content="website"><meta property="og:url" content="https://themeparkcopilot.com/blog"><link rel="canonical" href="https://themeparkcopilot.com/blog"><meta property="og:image" content="https://app.themeparkcopilot.com/assets/brand/landing-photo-hero.svg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:image" content="https://app.themeparkcopilot.com/assets/brand/landing-photo-hero.svg"><link rel="sitemap" type="application/xml" href="/sitemap.xml"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,900;1,9..144,900&family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet"><link rel="icon" href="https://app.themeparkcopilot.com/assets/brand/favicon.PNG"><style>' + CSS + '</style></head><body>'
        + '<nav class="nav" role="navigation" aria-label="Main navigation"><a href="https://themeparkcopilot.com" class="nav-left"><div class="nav-icon"><img src="https://app.themeparkcopilot.com/assets/brand/favicon.PNG" alt="Theme Park Co-Pilot"></div><div class="nav-wordmark">Theme Park Co<span>\u2756</span>Pilot</div></a><div class="nav-right"><a href="/blog" class="nav-link active">Blog</a><a href="https://themeparkcopilot.com" class="nav-link">Home</a><a href="https://themeparkcopilot.com" class="nav-cta">Try free \u2192</a></div></nav>'
        + '<header class="blog-hero" role="banner"><div class="blog-hero-inner"><div class="blog-hero-eyebrow">Smarter days. More magic.</div><h1 class="blog-hero-h1">Tips, strategies,<br>and <em>real insights.</em></h1><p class="blog-hero-sub">Everything your family needs to spend less time waiting and more time making memories \u2014 at Disneyland and Walt Disney World.</p></div></header>'
        + '<div class="search-bar-wrap"><div class="search-bar"><svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg><input type="text" id="blog-search" placeholder="Search guides..." autocomplete="off" /><button class="search-clear" id="search-clear" style="display:none">✕</button></div></div>'
+ '<div class="filter-bar" role="navigation" aria-label="Filter posts"><button class="filter-pill active" data-filter="all">All posts</button><button class="filter-pill" data-filter="disneyland">Disneyland</button><button class="filter-pill" data-filter="walt-disney-world">Walt Disney World</button><button class="filter-pill" data-filter="planning-tips">Planning Tips</button><button class="filter-pill" data-filter="lightning-lane">Lightning Lane</button><button class="filter-pill" data-filter="dining">Dining</button><button class="filter-pill" data-filter="hotels">Hotels</button></div>'
        + '<main><div class="post-grid" id="post-grid">' + featuredHtml + cardsHtml + '</div>' + (posts.length === 0 ? '<div style="text-align:center;padding:80px 40px;color:#4A7A7C;">No posts found.</div>' : '') + '</main>'
        + '<section class="newsletter" aria-label="Newsletter signup"><div><div class="newsletter-eyebrow">Stay in the know</div><div class="newsletter-title">Smarter days.<br><em>More magic.</em></div></div><form class="newsletter-form" action="https://disney-wait-times-lupt.vercel.app/api/subscribe" method="POST"><input class="newsletter-input" type="email" name="email" placeholder="your@email.com" required aria-label="Email address"><button class="newsletter-btn" type="submit">Get park tips \u2192</button></form></section>'
        + '<footer class="footer" role="contentinfo"><div class="footer-left">\u00a9 2026 Lunchbox Dad LLC \u00b7 Theme Park Co-Pilot \u00b7 hello@themeparkcopilot.com</div><div class="footer-right"><a href="https://themeparkcopilot.com" class="footer-link">Home</a><a href="/blog" class="footer-link">Blog</a><a href="https://themeparkcopilot.com/privacy" class="footer-link">Privacy</a><a href="https://themeparkcopilot.com/terms" class="footer-link">Terms</a></div></footer>'
        + '<script>(function(){var pills=document.querySelectorAll(".filter-pill");var grid=document.getElementById("post-grid");var searchInput=document.getElementById("blog-search");var searchClear=document.getElementById("search-clear");function applyFilters(){var q=(searchInput?searchInput.value.toLowerCase().trim():"");var activeFilter=document.querySelector(".filter-pill.active");var filter=activeFilter?activeFilter.getAttribute("data-filter"):"all";var cards=grid.querySelectorAll(".post-card");cards.forEach(function(card){var cat=card.getAttribute("data-category")||"";var filterMatch=(filter==="all"||cat.indexOf(filter)!==-1);var title=(card.querySelector(".post-card__title")||{}).textContent||"";var intro=(card.querySelector(".post-card__intro")||{}).textContent||"";var tag=(card.querySelector(".post-tag")||{}).textContent||"";var searchMatch=(!q||(title+intro+tag).toLowerCase().indexOf(q)!==-1);card.style.display=(filterMatch&&searchMatch)?"":"none";});var visible=grid.querySelectorAll(".post-card:not([style*=\"display: none\"])");var noResults=document.getElementById("search-no-results");if(!noResults){noResults=document.createElement("p");noResults.id="search-no-results";noResults.style.cssText="text-align:center;color:#8AACAE;padding:40px;font-family:Outfit,sans-serif;";noResults.textContent="No guides found. Try a different search.";grid.parentNode.insertBefore(noResults,grid.nextSibling);}noResults.style.display=visible.length===0?"block":"none";}pills.forEach(function(pill){pill.addEventListener("click",function(){pills.forEach(function(p){p.classList.remove("active");});this.classList.add("active");if(searchInput){searchInput.value="";}if(searchClear){searchClear.style.display="none";}applyFilters();});});if(searchInput){searchInput.addEventListener("input",function(){if(searchClear){searchClear.style.display=this.value?"block":"none";}applyFilters();});}if(searchClear){searchClear.addEventListener("click",function(){searchInput.value="";searchClear.style.display="none";applyFilters();searchInput.focus();});}})();<\/script>'
        + '</body></html>';

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
        return res.status(200).send(html);
  } catch (err) {
        console.error('blog-render-index error:', err.message, err.stack);
        return res.status(500).send('Internal server error: ' + err.message);
  }
};
