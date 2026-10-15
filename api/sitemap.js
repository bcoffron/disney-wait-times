// api/sitemap.js
import { readBlobJson } from './lib/blob.js';
const rl = {};

function toYMD(iso) {
  if (!iso) return '';
  try { return new Date(iso).toISOString().slice(0, 10); } catch(e) { return ''; }
}

export default async function handler(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
  rl[ip].count++;
  if (rl[ip].count > 30) return res.status(429).send('Rate limit exceeded');

  try {
    let posts = [];
    try { posts = (await readBlobJson('blog/posts/index', 'sitemap', { expected: true })) || []; } catch(e) { posts = []; }
    posts = posts.filter(p => p.published !== false);
    // Dedupe by slug, newest wins - the same rule the feed path
    // (blog-index.js toPublicIndex) applies. Without this, a bloated
    // index produced one URL per stored copy (435 URLs, ~386 of them
    // duplicates, on the pre-repair index); the sitemap must not
    // depend on the index happening to be clean.
    const bySlug = {};
    for (const p of posts) {
      if (!p || !p.slug) continue;
      const t = new Date(p.updatedAt || p.publishedAt || 0).getTime();
      const cur = bySlug[p.slug];
      if (!cur || t >= cur._t) { p._t = t; bySlug[p.slug] = p; }
    }
    posts = Object.keys(bySlug).map(k => { const p = bySlug[k]; delete p._t; return p; });

    const postUrls = posts.map(p => {
      const lastmod = toYMD(p.updatedAt || p.publishedAt);
      const lastmodTag = lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : '';
      return `  <url>\n    <loc>https://themeparkcopilot.com/blog/${p.slug}</loc>${lastmodTag}\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://themeparkcopilot.com/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://themeparkcopilot.com/blog</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://themeparkcopilot.com/editorial-standards</loc>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
${postUrls}
</urlset>`;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).send(xml);
  } catch(err) {
    console.error('sitemap error:', err.message);
    return res.status(500).send('Internal server error');
  }
};
