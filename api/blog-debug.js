// api/blog-debug.js - TEMP DELETE AFTER USE
import { list } from '@vercel/blob';
export default async function handler(req, res) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.query.token !== 'tpcp-debug-2026') return res.status(401).json({ error: 'Unauthorized' });
      try {
              const { blobs } = await list({ prefix: 'blog/posts/index', limit: 10, token: process.env.BLOB_READ_WRITE_TOKEN });
              const sorted = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
              const newest = sorted[0];
              if (!newest) return res.status(200).json({ msg: 'no blob found' });
              const r = await fetch(newest.downloadUrl || newest.url, { cache: 'no-store' });
              const data = await r.json();
              const missing = data.filter(p => !p.intro).map(p => p.slug);
              return res.status(200).json({ total: blobs.length, newestUploadedAt: newest.uploadedAt, hasDownloadUrl: !!newest.downloadUrl, postCount: data.length, missingCount: missing.length, missingSlugs: missing, allBlobDates: sorted.map(b => b.uploadedAt) });
      } catch(e) { return res.status(500).json({ error: e.message }); }
}
