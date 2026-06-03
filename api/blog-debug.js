// api/blog-debug.js - TEMP DELETE AFTER USE
import { list } from '@vercel/blob';
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.query.token !== 'tpcp-debug-2026') return res.status(401).json({ error: 'Unauthorized' });
    try {
          const { blobs } = await list({ prefix: 'blog/posts/index', limit: 5, token: process.env.BLOB_READ_WRITE_TOKEN });
          const b = blobs[0];
          if (!b) return res.status(200).json({ msg: 'no blob found' });
          const r1 = await fetch(b.url, { cache: 'no-store' });
          const t1 = await r1.json();
          const r2 = b.downloadUrl ? await fetch(b.downloadUrl, { cache: 'no-store' }) : null;
          const t2 = r2 ? await r2.json() : null;
          return res.status(200).json({ cnt: blobs.length, uploadedAt: b.uploadedAt, hasDownloadUrl: !!b.downloadUrl, cdnMissing: t1.filter(p=>!p.intro).map(p=>p.slug), dlMissing: t2 ? t2.filter(p=>!p.intro).map(p=>p.slug) : null });
    } catch(e) { return res.status(500).json({ error: e.message }); }
}
