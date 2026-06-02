#!/usr/bin/env node
// scripts/migrate-blog.js  — LOCAL ONLY, never deployed
// Usage:
//   ADMIN_KEY=CWdis2026admin GITHUB_PAT=<your_pat> node scripts/migrate-blog.js
//
// Required env vars:
//   ADMIN_KEY    — your blog admin password (matches Vercel ADMIN_KEY env var)
//   GITHUB_PAT   — GitHub Personal Access Token with repo read access for bcoffron/themeparkcopilot-landing

const https = require('https');
const http = require('http');

const ADMIN_KEY = process.env.ADMIN_KEY;
const GITHUB_PAT = process.env.GITHUB_PAT;
if (!ADMIN_KEY) { console.error('ERROR: ADMIN_KEY env var required'); process.exit(1); }
if (!GITHUB_PAT) { console.error('ERROR: GITHUB_PAT env var required'); process.exit(1); }

const LANDING_REPO = 'bcoffron/themeparkcopilot-landing';
const BLOG_API_BASE = 'https://disney-wait-times-lupt.vercel.app';
const SKIP_FILES = new Set(['index.html', 'post-template.html']);

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const opts = { headers: { 'User-Agent': 'blog-migrate/1.0', ...headers } };
    lib.get(url, opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'User-Agent': 'blog-migrate/1.0',
        ...headers
      }
    };
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function getMetaContent(html, name) {
  const re1 = new RegExp('<meta[^>]+name=["\']' + name + '["\'\'][^>]+content=["\']([^"\'\'>]+)["\'\']', 'i');
  let m = html.match(re1);
  if (m) return m[1].trim();
  const re2 = new RegExp('<meta[^>]+content=["\']([^"\'\'>]+)["\'\'][^>]+name=["\']' + name + '["\'\']', 'i');
  m = html.match(re2);
  return m ? m[1].trim() : '';
}

function parsePost(filename, html) {
  const slug = filename.replace(/\.html$/, '');

  // Title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/\s*[\u2014\u2013-]\s*Theme Park Co-Pilot\s*$/i, '').trim()
    : slug;

  // Meta description
  const metaDescription = getMetaContent(html, 'description');

  // Park from category class
  let park = 'both';
  const catClassMatch = html.match(/class="[^"]*cat-(dl|wdw|both)[^"]*"/i);
  if (catClassMatch) park = catClassMatch[1];
  else {
    if (slug.includes('disneyland') && !slug.includes('disney-world') && !slug.includes('walt-disney')) park = 'dl';
    else if (['disney-world', 'walt-disney', 'magic-kingdom', 'epcot', 'animal-kingdom', 'hollywood-studios'].some(k => slug.includes(k))) park = 'wdw';
    else if (slug.includes('universal')) park = 'wdw';
  }

  // Category label
  const catDivMatch = html.match(/<[^>]+class="[^"]*post-hero-category[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)/i);
  const category = catDivMatch
    ? stripTags(catDivMatch[1])
    : (park === 'dl' ? 'Disneyland · Guide' : park === 'wdw' ? 'Walt Disney World · Guide' : 'Disney · Guide');

  // Tag label
  const tagMatch = html.match(/<[^>]+class="[^"]*post-hero-tag[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)/i);
  const tagLabel = tagMatch
    ? stripTags(tagMatch[1])
    : (park === 'dl' ? 'Disneyland' : park === 'wdw' ? 'Walt Disney World' : 'Disney');

  // Hero image
  let heroImage = '', heroAlt = '', heroFocal = 'center center';
  // First try img with class containing post-hero
  const heroImgMatch = html.match(/<img[^>]+class="[^"]*post-hero[^"]*"[^>]*>/i);
  // Or img inside a .post-hero div
  const heroContainerMatch = html.match(/<div[^>]+class="[^"]*post-hero[^"]*"[^>]*>[\s\S]{0,500}?<img([^>]+)>/i);
  const imgTag = heroImgMatch ? heroImgMatch[0] : (heroContainerMatch ? '<img' + heroContainerMatch[1] + '>' : null);
  if (imgTag) {
    const srcM = imgTag.match(/src=["']([^"']+)["']/i); if (srcM) heroImage = srcM[1];
    const altM = imgTag.match(/alt=["']([^"']*)["']/i); if (altM) heroAlt = altM[1];
    const styleM = imgTag.match(/style=["'][^"']*object-position:\s*([^;"']+)/i); if (styleM) heroFocal = styleM[1].trim();
  }

  // Intro
  const introMatch = html.match(/<[^>]+class="[^"]*post-intro[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)/i);
  const intro = introMatch ? stripTags(introMatch[1]) : '';

  // Read time
  const bylineMatch = html.match(/<[^>]+class="[^"]*post-byline[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p|span)/i);
  let readTime = '8';
  if (bylineMatch) {
    const bt = stripTags(bylineMatch[1]);
    const rtM = bt.match(/(\d+)\s*min\s*read/i);
    if (rtM) readTime = rtM[1];
  }

  // Published date
  let publishedAt = '2026-06-01T00:00:00Z';
  const pubMeta = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i) ||
                  html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i);
  if (pubMeta) publishedAt = pubMeta[1];

  // Body HTML
  let body = '';
  const bodyMatch = html.match(/<[^>]+class="[^"]*article-body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div|<section|<footer|<!--)/i);
  if (bodyMatch) {
    body = bodyMatch[1].trim();
  } else {
    const abIdx = html.indexOf('article-body');
    if (abIdx > 0) {
      const openTagStart = html.lastIndexOf('<', abIdx);
      const openTagEnd = html.indexOf('>', abIdx);
      if (openTagStart > 0 && openTagEnd > 0) {
        const contentStart = openTagEnd + 1;
        body = html.slice(contentStart, contentStart + 15000).trim();
      }
    }
  }

  // FAQs
  const faqs = [];
  const faqRe = /<[^>]+class="[^"]*faq-item[^"]*"[^>]*>([\s\S]*?)<\/(?:div|li)>/gi;
  let faqM;
  while ((faqM = faqRe.exec(html)) !== null) {
    const h = faqM[1];
    const qM = h.match(/<[^>]+class="[^"]*faq-q[^"]*"[^>]*>([\s\S]*?)<\//i);
    const aM = h.match(/<[^>]+class="[^"]*faq-a[^"]*"[^>]*>([\s\S]*?)<\//i);
    if (qM && aM) faqs.push({ q: stripTags(qM[1]), a: stripTags(aM[1]) });
  }

  // Related posts
  const related = [];
  const relRe = /<a[^>]+class="[^"]*related-card[^"]*"[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let relM;
  while ((relM = relRe.exec(html)) !== null) {
    const href = relM[1];
    const inner = relM[2];
    const slugM = href.match(/\/blog\/([^/?"'#]+)/);
    const relSlug = slugM ? slugM[1].replace(/\.html$/, '') : href.split('/').pop().replace(/\.html$/, '');
    const titleM = inner.match(/<[^>]+class="[^"]*related-card-title[^"]*"[^>]*>([\s\S]*?)<\//i);
    const relTitle = titleM ? stripTags(titleM[1]) : '';
    let relPark = 'both';
    if (relSlug.includes('disneyland') && !relSlug.includes('disney-world') && !relSlug.includes('walt-disney')) relPark = 'dl';
    else if (['disney-world', 'walt-disney', 'magic-kingdom', 'epcot', 'animal-kingdom', 'hollywood-studios'].some(k => relSlug.includes(k))) relPark = 'wdw';
    if (relSlug) related.push({ slug: relSlug, park: relPark, title: relTitle });
  }

  // CTA
  let ctaType = 'both', ctaText = '', ctaButtonText = 'Try free for 7 days \u2192', ctaButtonUrl = 'https://themeparkcopilot.com';
  const ctaMatch = html.match(/<a[^>]+class="[^"]*cta-btn[^"]*"[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i) ||
                   html.match(/<a[^>]+href=["']([^"']+)["'][^>]+class="[^"]*cta-btn[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  if (ctaMatch) {
    ctaButtonUrl = ctaMatch[1];
    ctaButtonText = stripTags(ctaMatch[2]).trim() || ctaButtonText;
    if (ctaButtonText.toLowerCase().includes('try')) ctaType = 'dl';
    else if (ctaButtonText.toLowerCase().includes('waitlist') || ctaButtonText.toLowerCase().includes('join')) ctaType = 'wdw';
  }
  const ctaBodyM = html.match(/<[^>]+class="[^"]*cta-(?:body|text|desc)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)/i);
  if (ctaBodyM) ctaText = stripTags(ctaBodyM[1]);

  return {
    slug, title, metaDescription, park, category, tagLabel,
    heroImage, heroAlt, heroFocal, intro, readTime,
    publishedAt, updatedAt: publishedAt, published: true,
    body, faqs, related,
    cta: { type: ctaType, text: ctaText, buttonText: ctaButtonText, buttonUrl: ctaButtonUrl }
  };
}

async function run() {
  console.log('\n=== Theme Park Co-Pilot Blog Migration ===\n');

  // 1. List blog files
  console.log('Fetching blog file list from GitHub...');
  const listResp = await httpGet(
    'https://api.github.com/repos/' + LANDING_REPO + '/contents/blog',
    { 'Authorization': 'Bearer ' + GITHUB_PAT }
  );
  if (listResp.status !== 200) {
    console.error('Failed to list blog directory (HTTP ' + listResp.status + '):', listResp.body.slice(0,200));
    process.exit(1);
  }
  const allFiles = JSON.parse(listResp.body);
  const postFiles = allFiles.filter(f =>
    f.type === 'file' && f.name.endsWith('.html') && !SKIP_FILES.has(f.name)
  );
  console.log('Found ' + postFiles.length + ' post HTML files\n');

  // 2. Parse all posts
  console.log('Fetching and parsing HTML files...');
  const posts = [];
  for (const file of postFiles) {
    process.stdout.write('  ' + file.name + ' ... ');
    try {
      const resp = await httpGet(file.download_url, { 'Authorization': 'Bearer ' + GITHUB_PAT });
      if (resp.status !== 200) { console.log('SKIP (HTTP ' + resp.status + ')'); continue; }
      const post = parsePost(file.name, resp.body);
      posts.push(post);
      console.log('OK  "' + post.title.slice(0, 55) + (post.title.length > 55 ? '...' : '') + '"');
    } catch (err) {
      console.log('ERROR: ' + err.message);
    }
  }
  console.log('\nParsed ' + posts.length + '/' + postFiles.length + ' posts.\n');

  // 3. Authenticate
  console.log('Authenticating with /api/blog-auth...');
  try {
    const authResp = await httpPost(BLOG_API_BASE + '/api/blog-auth', { password: ADMIN_KEY });
    if (authResp.status === 200) {
      const d = JSON.parse(authResp.body);
      console.log('JWT obtained: ' + (d.token ? d.token.slice(0, 24) + '...' : 'none') + '\n');
    } else {
      console.log('Auth warning (HTTP ' + authResp.status + '): continuing with x-admin-key\n');
    }
  } catch(e) { console.log('Auth fetch error: ' + e.message + ' — continuing\n'); }

  // 4. Migrate in batches of 5
  console.log('Migrating posts via /api/blog-migrate (batches of 5, 500ms between)...');
  const BATCH = 5;
  let totalSaved = 0, totalFailed = 0;
  for (let i = 0; i < posts.length; i += BATCH) {
    const batch = posts.slice(i, i + BATCH);
    const batchLabel = batch.map(p => p.slug).join(', ');
    process.stdout.write('  Batch ' + (Math.floor(i/BATCH)+1) + ': [' + batchLabel.slice(0,70) + '] ... ');
    try {
      const r = await httpPost(BLOG_API_BASE + '/api/blog-migrate', batch, { 'x-admin-key': ADMIN_KEY });
      if (r.status === 200) {
        const d = JSON.parse(r.body);
        totalSaved += d.saved || 0;
        totalFailed += d.failed || 0;
        console.log('saved:' + d.saved + ' failed:' + d.failed);
        if (d.details && d.details.failed) {
          d.details.failed.forEach(f => console.log('    FAIL: ' + f.slug + ' — ' + f.error));
        }
      } else if (r.status === 410) {
        console.log('\nMigration endpoint returned 410 Gone — migration was already completed!');
        break;
      } else {
        console.log('HTTP ' + r.status + ': ' + r.body.slice(0, 200));
        totalFailed += batch.length;
      }
    } catch(err) {
      console.log('ERROR: ' + err.message);
      totalFailed += batch.length;
    }
    if (i + BATCH < posts.length) await sleep(500);
  }

  console.log('\n--- Migration Summary ---');
  console.log('  Posts saved: ' + totalSaved);
  console.log('  Posts failed: ' + totalFailed);
  if (totalFailed > 0) console.log('  WARNING: ' + totalFailed + ' posts failed!');

  // 5. Verify index count
  console.log('\nVerifying /api/blog-index...');
  try {
    const idxR = await httpGet(BLOG_API_BASE + '/api/blog-index');
    if (idxR.status === 200) {
      const idx = JSON.parse(idxR.body);
      const ok = idx.length === 31;
      console.log('  blog-index count: ' + idx.length + (ok ? ' ✓  (expected 31)' : ' ✗  (expected 31!)'));
    } else {
      console.log('  HTTP ' + idxR.status + ': ' + idxR.body.slice(0, 200));
    }
  } catch(e) { console.log('  ERROR: ' + e.message); }

  // 6. Spot-check 3 posts
  const spots = ['disneyland-rope-drop-strategy', 'magic-kingdom-guide', 'disney-world-with-toddlers'];
  console.log('\nSpot-checking 3 posts...');
  for (const s of spots) {
    try {
      const r = await httpGet(BLOG_API_BASE + '/api/blog-post?slug=' + s);
      if (r.status === 200) {
        const p = JSON.parse(r.body);
        console.log('  ✓ ' + s);
        console.log('    title: "' + (p.title || '').slice(0, 70) + '"');
        console.log('    park: ' + p.park + '  readTime: ' + p.readTime + ' min  faqs: ' + (p.faqs || []).length + '  related: ' + (p.related || []).length);
      } else {
        console.log('  ✗ ' + s + '  HTTP ' + r.status);
      }
    } catch(e) { console.log('  ✗ ' + s + '  ERROR: ' + e.message); }
  }
  console.log('\n=== Done ===\n');
}

run().catch(err => { console.error('Fatal error:', err); process.exit(1); });
