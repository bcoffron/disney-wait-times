import jwt from 'jsonwebtoken';
import { put } from '@vercel/blob';
import Busboy from 'busboy';

const rl = {};

export const config = {
        api: { bodyParser: false }
};

export default async function handler(req, res) {
        // Auth
  const sentToken = req.headers['x-admin-key'] || '';
        try {
                  jwt.verify(sentToken, process.env.JWT_SECRET);
        } catch {
                  return res.status(401).json({ error: 'Unauthorized' });
        }

  // Rate limit: 100 requests per 60-second window per IP
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
        rl[ip].count++;
        if (rl[ip].count > 100) return res.status(429).json({ error: 'Rate limit exceeded' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
            const filename = req.headers['x-filename'] || ('upload-' + Date.now() + '.jpg');

          // Use busboy to extract the file part from the multipart body
          const busboy = Busboy({ headers: req.headers });

          const fileData = await new Promise((resolve, reject) => {
                      let fileBuffer = null;
                      let fileMime = 'image/jpeg';

                                                   busboy.on('file', (_fieldname, fileStream, info) => {
                                                                 fileMime = info.mimeType || 'image/jpeg';
                                                                 const chunks = [];
                                                                 fileStream.on('data', chunk => chunks.push(chunk));
                                                                 fileStream.on('end', () => {
                                                                                 fileBuffer = Buffer.concat(chunks);
                                                                 });
                                                                 fileStream.on('error', reject);
                                                   });

                                                   busboy.on('finish', () => {
                                                                 if (fileBuffer) {
                                                                                 resolve({ buffer: fileBuffer, mime: fileMime });
                                                                 } else {
                                                                                 reject(new Error('No file received'));
                                                                 }
                                                   });

                                                   busboy.on('error', reject);
                      req.pipe(busboy);
          });

          const blob = await put('blog-images/' + filename, fileData.buffer, {
                      access: 'public',
                      contentType: fileData.mime,
                      allowOverwrite: true
          });

          return res.status(200).json({
                      url: blob.url,
                      filename: filename,
                      uploadedAt: new Date().toISOString()
          });
  } catch (err) {
            console.error('blog-upload-image error:', err);
            return res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
}
