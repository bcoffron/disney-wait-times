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
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
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
  const re1 = new RegExp('<meta[^>]+name=["\']' + name + '["\'][^>]+content=["\']([^"\']+)["\']', 'i');
  let m = html.match(re1);
  if (m) return m[1].trim();
  const re2 = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']' + name + '["\']', 'i');
  m = html.match(re2);
  return m ? m[1].trim() : '';
}

// FAQ parser: uses depth tracking to correctly handle nested divs inside .faq-item
// Each .faq-item contains a .faq-q div and a .faq-a div (which may have a nested span[itemprop="text"])
function parseFaqs(html) {
  const faqs = [];
  let faqPos = 0;

  while ((faqPos = html.indexOf('faq-item', faqPos)) !== -1) {
    const divStart = html.lastIndexOf('<div', faqPos);
    if (divStart < 0 || divStart < faqPos - 200) { faqPos++; continue; }
    const tagOpen = html.slice(divStart, faqPos + 10);
    if (!tagOpen.includes('class=')) { faqPos++; continue; }

    // Depth-track to find closing tag of this faq-item div
    let depth = 0, ci = divStart, endPos = -1;
    while (ci < html.length && ci < divStart + 5000) {
      if (html[ci] === '<') {
        if (html.slice(ci, ci + 2) === '</') {
          const closeEnd = html.indexOf('>', ci);
          depth--;
          if (depth === 0) { endPos = closeEnd + 1; break; }
          ci = closeEnd >= 0 ? closeEnd + 1 : ci + 2;
        } else if (html.slice(ci, ci + 2) !== '<!' && /^<[a-zA-Z]/.test(html.slice(ci))) {
          const tagEnd = html.indexOf('>', ci);
          if (tagEnd < 0) { ci++; continue; }
          const fullTag = html.slice(ci, tagEnd + 1);
          if (!fullTag.endsWith('/>')) depth++;
          ci = tagEnd + 1;
        } else {
          ci++;
        }
      } else {
        ci++;
      }
    }
    if (endPos < 0) { faqPos++; continue; }

    const itemHtml = html.slice(divStart, endPos);

    // Extract faq-q and faq-a text content
    const qM = itemHtml.match(/<div[^>]+class="[^"]*faq-q[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const aM = itemHtml.match(/<div[^>]+class="[^"]*faq-a[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i) ||
               itemHtml.match(/<div[^>]+class="[^"]*faq-a[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

    if (qM && aM) {
      faqs.push({ q: stripTags(qM[1]), a: stripTags(aM[1]) });
    }

    faqPos = endPos;
  }

  return faqs;
}

function parsePost(filename, html) {
  const slug = filename.replace(/\.html$/, '');

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/\s*[\u2014\u2013-]\s*Theme Park Co-Pilot\s*$/i, '').trim()
    : slug;

  const metaDescription = getMetaContent(html, 'description');

  let park = 'both';
  const catClassMatch = html.match(/class="[^"]*cat-(dl|wdw|both)[^"]*"/i);
  if (catClassMatch) park = catClassMatch[1];
  else {
    if (slug.includes('disneyland') && !slug.includes('disney-world') && !slug.includes('walt-disney')) park = 'dl';
    else if (['disney-world', 'walt-disney', 'magic-kingdom', 'epcot', 'animal-kingdom', 'hollywood-studios'].some(k => slug.includes(k))) park = 'wdw';
    else if (slug.includes('universal')) park = 'wdw';
  }

  const catDivMatch = html.match(/<[^>]+class="[^"]*post-hero-category[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)/i);
  const category = catDivMatch
    ? stripTags(catDivMatch[1])
    : (park === 'dl' ? 'Disneyland · Guide' : park === 'wdw' ? 'Walt Disney World · Guide' : 'Disney · Guide');

  const tagMatch = html.match(/<[^>]+class="[^"]*post-hero-tag[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)/i);
  const tagLabel = tagMatch
    ? stripTags(tagMatch[1])
    : (park === 'dl' ? 'Disneyland' : park === 'wdw' ? 'Walt Disney World' : 'Disney');

  let heroImage = '', heroAlt = '', heroFocal = 'center center';
  const heroImgMatch = html.match(/<img[^>]+class="[^"]*post-hero[^"]*"[^>]*>/i);
  const heroContainerMatch = html.match(/<div[^>]+class="[^"]*post-hero[^"]*"[^>]*>[\s\S]{0,500}?<img([^>]+)>/i);
  const imgTag = heroImgMatch ? heroImgMatch[0] : (heroContainerMatch ? '<img' + heroContainerMatch[1] + '>' : null);
  if (imgTag) {
    const srcM = imgTag.match(/src=["']([^"']+)["']/i); if (srcM) heroImage = srcM[1];
    const altM = imgTag.match(/alt=["']([^"']*)["']/i); if (altM) heroAlt = altM[1];
    const styleM = imgTag.match(/style=["'][^"']*object-position:\s*([^;"']+)/i); if (styleM) heroFocal = styleM[1].trim();
  }

  const introMatch = html.match(/<[^>]+class="[^"]*post-intro[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)/i);
  const intro = introMatch ? stripTags(introMatch[1]) : '';

  const bylineMatch = html.match(/<[^>]+class="[^"]*post-byline[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p|span)/i);
  let readTime = '8';
  if (bylineMatch) {
    const bt = stripTags(bylineMatch[1]);
    const rtM = bt.match(/(\d+)\s*min\s*read/i);
    if (rtM) readTime = rtM[1];
  }

  let publishedAt = '2026-06-01T00:00:00Z';
  const pubMeta = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i) ||
                  html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i);
  if (pubMeta) publishedAt = pubMeta[1];

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
        body = html.slice(openTagEnd + 1, openTagEnd + 20000).trim();
      }
    }
  }

  // Use the depth-tracking FAQ parser
  const faqs = parseFaqs(html);

  const related = [];
  const relRe = /<a[^>]+class="[^"]*related-card[^"]*"[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let relM;
  while ((relM = relRe.exec(html)) !== null) {
    const href = relM[1], inner = relM[2];
    const slugM = href.match(/\/blog\/([^/"'?#]+)/);
    const relSlug = slugM ? slugM[1].replace(/\.html$/, '') : href.split('/').pop().replace(/\.html$/, '');
    const titleM = inner.match(/<[^>]+class="[^"]*related-card-title[^"]*"[^>]*>([\s\S]*?)<\//i);
    const relTitle = titleM ? stripTags(titleM[1]) : '';
    let relPark = 'both';
    if (relSlug.includes('disneyland') && !relSlug.includes('disney-world') && !relSlug.includes('walt-disney')) relPark = 'dl';
    else if (['disney-world', 'walt-disney', 'magic-kingdom', 'epcot', 'animal-kingdom', 'hollywood-studios'].some(k => relSlug.includes(k))) relPark = 'wdw';
    if (relSlug) related.push({ slug: relSlug, park: relPark, title: relTitle });
  }

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

  console.log('Fetching blog file list from GitHub...');
  const listResp = await httpGet(
    'https://api.github.com/repos/' + LANDING_REPO + '/contents/blog',
    { 'Authorization': 'Bearer ' + GITHUB_PAT }
  );
  if (listResp.status !== 200) {
    console.error('Failed to list blog directory (HTTP ' + listResp.status + ')');
    process.exit(1);
  }
  const allFiles = JSON.parse(listResp.body);
  const postFiles = allFiles.filter(f =>
    f.type === 'file' && f.name.endsWith('.html') && !SKIP_FILES.has(f.name)
  );
  console.log('Found ' + postFiles.length + ' post HTML files\n');

  console.log('Fetching and parsing HTML files...');
  const posts = [];
  for (const file of postFiles) {
    process.stdout.write('  ' + file.name + ' ... ');
    try {
      // Use GitHub Contents API (returns base64) — avoids CORS with raw URLs
      const resp = await httpGet(
        'https://api.github.com/repos/' + LANDING_REPO + '/contents/blog/' + file.name,
        { 'Authorization': 'Bearer ' + GITHUB_PAT, 'Accept': 'application/vnd.github+json' }
      );
      if (resp.status !== 200) { console.log('SKIP (HTTP ' + resp.status + ')'); continue; }
      const data = JSON.parse(resp.body);
      const html = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      const post = parsePost(file.name, html);
      posts.push(post);
      console.log('OK  "' + post.title.slice(0, 55) + (post.title.length > 55 ? '...' : '') + '"  faqs:' + post.faqs.length);
    } catch (err) {
      console.log('ERROR: ' + err.message);
    }
  }
  console.log('\nParsed ' + posts.length + '/' + postFiles.length + ' posts.\n');

  console.log('Authenticating with /api/blog-auth...');
  try {
    const authResp = await httpPost(BLOG_API_BASE + '/api/blog-auth', { password: ADMIN_KEY });
    if (authResp.status === 200) {
      const d = JSON.parse(authResp.body);
      console.log('JWT obtained: ' + (d.token ? d.token.slice(0, 24) + '...' : 'none') + '\n');
    } else {
      console.log('Auth note (HTTP ' + authResp.status + '): will use x-admin-key header\n');
    }
  } catch(e) { console.log('Auth fetch error: ' + e.message + '\n'); }

  // Save each post individually via blog-save with 3.5s between requests
  // (rate limit is 20 req/min; 3.5s spacing = ~17/min, safely under limit)
  console.log('Saving posts via /api/blog-save (1 per 3.5s to respect rate limit)...');
  let totalSaved = 0, totalFailed = 0;
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    process.stdout.write('  [' + String(i+1).padStart(2) + '/' + posts.length + '] ' + post.slug + ' ... ');
    try {
      const r = await httpPost(
        BLOG_API_BASE + '/api/blog-save',
        post,
        { 'x-admin-key': ADMIN_KEY }
      );
      if (r.status === 200) {
        totalSaved++;
        console.log('saved  (faqs:' + post.faqs.length + ')');
      } else {
        totalFailed++;
        console.log('FAIL HTTP ' + r.status + ': ' + r.body.slice(0, 100));
      }
    } catch(err) {
      totalFailed++;
      console.log('ERROR: ' + err.message);
    }
    if (i < posts.length - 1) await sleep(3500);
  }

  console.log('\n--- Save Summary ---');
  console.log('  Posts saved:  ' + totalSaved);
  console.log('  Posts failed: ' + totalFailed);

  console.log('\nRebuilding index via GET /api/blog-migrate?action=rebuild-index...');
  try {
    const rbResp = await httpGet(
      BLOG_API_BASE + '/api/blog-migrate?action=rebuild-index',
      { 'x-admin-key': ADMIN_KEY }
    );
    if (rbResp.status === 200) {
      const d = JSON.parse(rbResp.body);
      console.log('  Index count: ' + d.count + (d.count === 30 ? ' \u2713' : ' \u2717 (expected 30)'));
    } else {
      console.log('  HTTP ' + rbResp.status + ': ' + rbResp.body.slice(0, 200));
    }
  } catch(e) { console.log('  ERROR: ' + e.message); }

  const spots = ['disneyland-rope-drop-strategy', 'magic-kingdom-guide', 'disney-world-with-toddlers'];
  console.log('\nSpot-checking 3 posts...');
  for (const s of spots) {
    try {
      const r = await httpGet(BLOG_API_BASE + '/api/blog-post?slug=' + s);
      if (r.status === 200) {
        const p = JSON.parse(r.body);
        console.log('  \u2713 ' + s);
        console.log('    title: "' + (p.title || '').slice(0, 70) + '"');
        console.log('    faqs: ' + (p.faqs||[]).length + ' | related: ' + (p.related||[]).length + ' | park: ' + p.park);
        if (p.faqs && p.faqs[0]) console.log('    first_faq.q: "' + p.faqs[0].q.slice(0,70) + '"');
      } else {
        console.log('  \u2717 ' + s + '  HTTP ' + r.status);
      }
    } catch(e) { console.log('  \u2717 ' + s + '  ERROR: ' + e.message); }
  }
  console.log('\n=== Done ===\n');
}

run().catch(err => { console.error('Fatal error:', err); process.exit(1); });
