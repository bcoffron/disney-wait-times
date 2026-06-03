// api/blog-render-index.js — GET /blog — public, renders blog index HTML
const { list } = require('@vercel/blob');
const rl = {};

async function readBlob(pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 10 });
  const matches = (blobs || []).filter(b => b.pathname === pathname).sort((a,b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) return null;
  const r = await fetch(matches[0].url);
  if (!r.ok) return null;
  return r.json();
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { year:'numeric', month:'long' });
  } catch(e) { return ''; }
}

function tagClass(park) {
  if (park === 'dl') return 'tag-abs-dl';
  if (park === 'wdw') return 'tag-abs-wdw';
  return '';
}

function tagStyle(park) {
  if (park === 'both') return 'style="background:rgba(184,134,11,0.92);color:#FFF8E0;"';
  return '';
}

function filterAttr(post) {
  const cats = [];
  if (post.park === 'dl') cats.push('disneyland');
  else if (post.park === 'wdw') cats.push('walt-disney-world');
  else { cats.push('disneyland'); cats.push('walt-disney-world'); }
  const cat = (post.category || '').toLowerCase();
  if (cat.includes('planning')) cats.push('planning-tips');
  if (cat.includes('lightning') || (post.tagLabel||'').toLowerCase().includes('lightning')) cats.push('lightning-lane');
  if (cat.includes('dining') || cat.includes('restaurant') || cat.includes('snack') || cat.includes('food')) cats.push('dining');
  if (cat.includes('hotel') || cat.includes('resort') || cat.includes('on-site') || cat.includes('off-site')) cats.push('hotels');
  const slug = post.slug || '';
  if (slug.includes('lightning-lane')) cats.push('lightning-lane');
  if (slug.includes('restaurant') || slug.includes('dining') || slug.includes('snack') || slug.includes('food')) cats.push('dining');
  if (slug.includes('hotel') || slug.includes('on-site') || slug.includes('off-site')) cats.push('hotels');
  if (slug.includes('plan') || slug.includes('budget') || slug.includes('itinerary') || slug.includes('tips') || slug.includes('guide') || slug.includes('strategy') || slug.includes('best-time')) cats.push('planning-tips');
  return [...new Set(cats)].join(' ');
}

function renderCard(post, isFeatured) {
  const slug = escHtml(post.slug);
  const title = escHtml(post.title);
  const intro = escHtml(post.intro || post.metaDescription || '');
  const heroImage = escHtml(post.heroImage || '');
  const heroAlt = escHtml(post.heroAlt || title);
  const tagLabel = escHtml(post.tagLabel || (post.park === 'dl' ? 'Disneyland' : post.park === 'wdw' ? 'Walt Disney World' : 'Disney'));
  const readTime = escHtml(post.readTime || '8');
  const cat = filterAttr(post);
  const tClass = tagClass(post.park);
  const tStyle = tagStyle(post.park);

  if (isFeatured) {
    return `<a class="post-card post-card--featured" href="/blog/${slug}" data-category="${cat}" aria-label="${title}">
  <div class="post-card__img-wrap">
    <img src="${heroImage}" alt="${heroAlt}" class="post-card__img" loading="lazy">
    <span class="post-card__badge">START HERE</span>
  </div>
  <div class="post-card__body">
    <div class="post-card__meta"><span class="post-tag ${tClass}" ${tStyle}>${tagLabel.toUpperCase()}</span> <span class="post-card__category">${escHtml(post.category || '')}</span></div>
    <h2 class="post-card__title">${title}</h2>
    <p class="post-card__intro">${intro}</p>
    <div class="post-card__footer"><span class="post-card__read">${readTime} min read</span><span class="post-card__cta">Read the guide →</span></div>
  </div>
</a>`;
  }

  return `<a class="post-card" href="/blog/${slug}" data-category="${cat}" aria-label="${title}">
  <div class="post-card__img-wrap">
    <img src="${heroImage}" alt="${heroAlt}" class="post-card__img" loading="lazy">
    <span class="post-tag post-tag--card ${tClass}" ${tStyle}>${tagLabel.toUpperCase()}</span>
  </div>
  <h2 class="post-card__title">${title}</h2>
  <p class="post-card__intro">${intro}</p>
  <div class="post-card__footer"><span class="post-card__read">${readTime} min read</span><span class="post-card__cta">Read →</span></div>
</a>`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Rate limit 20/min/IP
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
  rl[ip].count++;
  if (rl[ip].count > 20) return res.status(429).send('Rate limit exceeded');

  let posts = [];
  try {
    posts = (await readBlob('blog/posts/index')) || [];
  } catch(e) { posts = []; }

  // Only published, sorted newest first
  posts = posts.filter(p => p.published !== false).sort((a,b) => new Date(b.publishedAt||0) - new Date(a.publishedAt||0));

  const featuredPost = posts[0];
  const remainingPosts = posts.slice(1);

  const css = `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body { font-family: 'Outfit', sans-serif; background: #EEF5F4; color: #071E25; -webkit-font-smoothing: antialiased; }
.nav { background: #071E25; height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 40px; position: sticky; top: 0; z-index: 100; border-bottom: 1px solid rgba(255,255,255,0.07); }
.nav-left { display: flex; align-items: center; gap: 10px; text-decoration: none; }
.nav-icon { width: 30px; height: 30px; border-radius: 7px; overflow: hidden; border: 1px solid rgba(212,168,48,0.3); flex-shrink: 0; }
.nav-icon img { width: 100%; height: 100%; object-fit: cover; display: block; }
.nav-wordmark { font-size: 13px; font-weight: 800; color: #fff; letter-spacing: -0.2px; }
.nav-wordmark span { color: #F5A623; }
.nav-right { display: flex; align-items: center; gap: 20px; }
.nav-link { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.55); text-decoration: none; transition: color .15s; letter-spacing: .02em; }
.nav-link:hover, .nav-link.active { color: #fff; }
.nav-cta { font-size: 11px; font-weight: 700; color: #071E25; background: #F5A623; border-radius: 100px; padding: 7px 14px; text-decoration: none; letter-spacing: .02em; transition: opacity .15s; }
.nav-cta:hover { opacity: .85; }
.blog-hero { background: #071E25; padding: 64px 40px 56px; }
.blog-hero-inner { max-width: 680px; }
.blog-hero-eyebrow { font-size: 9px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: #F5A623; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; }
.blog-hero-eyebrow::before { content: ''; display: block; width: 28px; height: 1.5px; background: #F5A623; }
.blog-hero-h1 { font-family: 'Fraunces', serif; font-size: 52px; font-weight: 900; color: #fff; line-height: 1.05; letter-spacing: -1px; margin-bottom: 18px; }
.blog-hero-h1 em { color: #F5A623; font-style: italic; }
.blog-hero-sub { font-size: 15px; color: rgba(255,255,255,0.55); line-height: 1.6; max-width: 480px; }
.filter-bar { background: #fff; border-bottom: 0.5px solid rgba(7,30,37,0.08); padding: 0 40px; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
.filter-bar::-webkit-scrollbar { display: none; }
.filter-pill { font-size: 11px; font-weight: 700; color: #4A7A7C; background: none; border: none; cursor: pointer; padding: 14px 14px; border-bottom: 2px solid transparent; white-space: nowrap; transition: color .15s, border-color .15s; letter-spacing: .02em; }
.filter-pill:hover { color: #071E25; }
.filter-pill.active { color: #071E25; border-bottom-color: #F5A623; }
.post-grid { max-width: 1100px; margin: 0 auto; padding: 48px 40px 64px; display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.post-card { display: flex; flex-direction: column; background: #fff; border-radius: 14px; overflow: hidden; border: 0.5px solid rgba(7,30,37,0.07); text-decoration: none; color: inherit; transition: box-shadow .2s, transform .15s; }
.post-card:hover { box-shadow: 0 8px 32px rgba(7,30,37,0.10); transform: translateY(-2px); }
.post-card--featured { grid-column: 1 / -1; flex-direction: row; }
.post-card__img-wrap { position: relative; overflow: hidden; flex-shrink: 0; }
.post-card--featured .post-card__img-wrap { width: 52%; }
.post-card__img { width: 100%; height: 100%; object-fit: cover; display: block; aspect-ratio: 16/9; transition: transform .35s; }
.post-card--featured .post-card__img { aspect-ratio: auto; height: 100%; }
.post-card:hover .post-card__img { transform: scale(1.03); }
.post-card__badge { position: absolute; bottom: 12px; left: 12px; font-size: 9px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; background: #F5A623; color: #071E25; border-radius: 100px; padding: 5px 11px; }
.post-tag { font-size: 9px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; border-radius: 100px; padding: 4px 10px; }
.post-tag--card { position: absolute; top: 12px; left: 12px; }
.tag-abs-dl { background: rgba(26,104,96,0.92); color: #E0F5EE; }
.tag-abs-wdw { background: rgba(184,134,11,0.92); color: #FFF8E0; }
.post-card__body { padding: 24px 28px; display: flex; flex-direction: column; flex: 1; }
.post-card__meta { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.post-card__category { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .10em; color: #8AACAE; }
.post-card__title { font-family: 'Fraunces', serif; font-size: 21px; font-weight: 900; color: #071E25; line-height: 1.2; margin-bottom: 10px; letter-spacing: -0.3px; }
.post-card--featured .post-card__title { font-size: 28px; }
.post-card__intro { font-size: 13px; color: #4A7A7C; line-height: 1.6; flex: 1; margin-bottom: 20px; }
.post-card__footer { display: flex; justify-content: space-between; align-items: center; padding-top: 16px; border-top: 0.5px solid rgba(7,30,37,0.07); }
.post-card__read { font-size: 11px; color: #8AACAE; font-weight: 600; }
.post-card__cta { font-size: 11px; font-weight: 700; color: #1A6860; }
.newsletter { background: #071E25; padding: 56px 40px; display: flex; justify-content: space-between; align-items: center; gap: 40px; }
.newsletter-eyebrow { font-size: 9px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: #F5A623; margin-bottom: 10px; }
.newsletter-title { font-family: 'Fraunces', serif; font-size: 32px; font-weight: 900; color: #fff; line-height: 1.1; }
.newsletter-title em { color: #F5A623; font-style: italic; }
.newsletter-form { display: flex; gap: 8px; }
.newsletter-input { font-family: 'Outfit', sans-serif; font-size: 13px; padding: 12px 16px; border-radius: 100px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.07); color: #fff; width: 240px; outline: none; }
.newsletter-input::placeholder { color: rgba(255,255,255,0.35); }
.newsletter-btn { font-family: 'Outfit', sans-serif; font-size: 12px; font-weight: 700; background: #F5A623; color: #071E25; border: none; border-radius: 100px; padding: 12px 20px; cursor: pointer; white-space: nowrap; }
.footer { background: #071E25; padding: 20px 40px; display: flex; align-items: center; justify-content: space-between; border-top: 1px solid rgba(255,255,255,0.07); }
.footer-left { font-size: 10px; color: rgba(255,255,255,0.30); }
.footer-right { display: flex; gap: 16px; }
.footer-link { font-size: 10px; color: rgba(255,255,255,0.30); text-decoration: none; }
.footer-link:hover { color: rgba(255,255,255,0.60); }
.no-posts { text-align: center; padding: 80px 40px; color: #4A7A7C; font-size: 16px; }
@media (max-width: 700px) {
  .blog-hero { padding: 40px 20px 36px; }
  .blog-hero-h1 { font-size: 34px; }
  .filter-bar { padding: 0 20px; }
  .post-grid { grid-template-columns: 1fr; padding: 32px 20px 48px; gap: 20px; }
  .post-card--featured { flex-direction: column; }
  .post-card--featured .post-card__img-wrap { width: 100%; }
  .newsletter { flex-direction: column; padding: 40px 20px; text-align: center; }
  .newsletter-form { flex-direction: column; width: 100%; }
  .newsletter-input { width: 100%; }
  .nav { padding: 0 20px; }
  .nav-right .nav-link { display: none; }
  .footer { padding: 16px 20px; flex-direction: column; gap: 10px; text-align: center; }
}`;

  const featuredHtml = featuredPost ? renderCard(featuredPost, true) : '';
  const cardsHtml = remainingPosts.map(p => renderCard(p, false)).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Theme Park Planning Tips &amp; Guides — Theme Park Co-Pilot Blog</title>
  <meta name="description" content="Expert tips, strategies, and real insights for Disneyland and Walt Disney World. Plan smarter days and make more magic.">
  <meta property="og:title" content="Theme Park Co-Pilot Blog">
  <meta property="og:description" content="Expert tips for Disneyland and Walt Disney World.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://themeparkcopilot.com/blog">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,900;1,9..144,900&family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
  <link rel="icon" href="https://app.themeparkcopilot.com/assets/brand/favicon.PNG">
  <style>${css}</style>
</head>
<body>
<nav class="nav" role="navigation" aria-label="Main navigation">
  <a href="https://themeparkcopilot.com" class="nav-left">
    <div class="nav-icon"><img src="https://app.themeparkcopilot.com/assets/brand/favicon.PNG" alt="Theme Park Co-Pilot"></div>
    <div class="nav-wordmark">Theme Park Co<span>✦</span>Pilot</div>
  </a>
  <div class="nav-right">
    <a href="/blog" class="nav-link active">Blog</a>
    <a href="https://themeparkcopilot.com" class="nav-link">Home</a>
    <a href="https://themeparkcopilot.com" class="nav-cta">Try free →</a>
  </div>
</nav>

<header class="blog-hero" role="banner">
  <div class="blog-hero-inner">
    <div class="blog-hero-eyebrow">Smarter days. More magic.</div>
    <h1 class="blog-hero-h1">Tips, strategies,<br>and <em>real insights.</em></h1>
    <p class="blog-hero-sub">Everything your family needs to spend less time waiting and more time making memories — at Disneyland and Walt Disney World.</p>
  </div>
</header>

<div class="filter-bar" role="navigation" aria-label="Filter posts">
  <button class="filter-pill active" data-filter="all">All posts</button>
  <button class="filter-pill" data-filter="disneyland">Disneyland</button>
  <button class="filter-pill" data-filter="walt-disney-world">Walt Disney World</button>
  <button class="filter-pill" data-filter="planning-tips">Planning Tips</button>
  <button class="filter-pill" data-filter="lightning-lane">Lightning Lane</button>
  <button class="filter-pill" data-filter="dining">Dining</button>
  <button class="filter-pill" data-filter="hotels">Hotels</button>
</div>

<main>
  <div class="post-grid" id="post-grid">
    ${featuredHtml}
    ${cardsHtml}
  </div>
  ${posts.length === 0 ? '<div class="no-posts">No posts found.</div>' : ''}
</main>

<section class="newsletter" aria-label="Newsletter signup">
  <div>
    <div class="newsletter-eyebrow">Stay in the know</div>
    <div class="newsletter-title">Smarter days.<br><em>More magic.</em></div>
  </div>
  <form class="newsletter-form" action="https://disney-wait-times-lupt.vercel.app/api/subscribe" method="POST">
    <input class="newsletter-input" type="email" name="email" placeholder="your@email.com" required aria-label="Email address">
    <button class="newsletter-btn" type="submit">Get park tips →</button>
  </form>
</section>

<footer class="footer" role="contentinfo">
  <div class="footer-left">© 2026 Lunchbox Dad LLC · Theme Park Co-Pilot · hello@themeparkcopilot.com</div>
  <div class="footer-right">
    <a href="https://themeparkcopilot.com" class="footer-link">Home</a>
    <a href="/blog" class="footer-link">Blog</a>
    <a href="https://themeparkcopilot.com/privacy" class="footer-link">Privacy</a>
    <a href="https://themeparkcopilot.com/terms" class="footer-link">Terms</a>
  </div>
</footer>

<script>
(function() {
  var pills = document.querySelectorAll('.filter-pill');
  var cards = document.querySelectorAll('.post-grid [data-category]');
  pills.forEach(function(pill) {
    pill.addEventListener('click', function() {
      var filter = this.getAttribute('data-filter');
      pills.forEach(function(p) { p.classList.remove('active'); });
      this.classList.add('active');
      cards.forEach(function(card) {
        if (filter === 'all' || card.getAttribute('data-category').indexOf(filter) !== -1) {
          card.style.display = '';
        } else {
          card.style.display = 'none';
        }
      });
    });
  });
})();
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  return res.status(200).send(html);
};