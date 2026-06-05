// api/sitemap.js
import { list } from '@vercel/blob';
const rl = {};

async function readBlob(pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 1000, token: process.env.BLOB_READ_WRITE_TOKEN });
  const matches = (blobs || []).filter(b => b.pathname === pathname).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!matches.length) return null;
  const r = await fetch(matches[0].downloadUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.json();
}

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
    try { posts = (await readBlob('blog/posts/index')) || []; } catch(e) { posts = []; }
    posts = posts.filter(p => p.published !== false);

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
