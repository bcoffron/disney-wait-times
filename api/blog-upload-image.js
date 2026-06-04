import jwt from 'jsonwebtoken';
import { put } from '@vercel/blob';
import Busboy from 'busboy';

const rl = {};

// MIME type lookup by extension — fallback when Content-Type header is absent/wrong
const MIME_BY_EXT = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg',
            png: 'image/png',
            webp: 'image/webp',
            gif: 'image/gif',
            avif: 'image/avif',
};

function mimeFromFilename(filename) {
            const ext = (filename || '').split('.').pop().toLowerCase();
            return MIME_BY_EXT[ext] || 'image/jpeg';
}

export const config = {
            api: {
                          bodyParser: false, // CRITICAL — must be false or Vercel pre-consumes the stream
            },
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
                const rawContentType = req.headers['content-type'] || '';

              // Buffer the entire raw body first in all cases.
              // Vercel's runtime may have already started reading the stream; buffering
              // ensures busboy (or the raw path) gets the complete bytes.
              const rawBody = await new Promise((resolve, reject) => {
                              const chunks = [];
                              req.on('data', chunk => chunks.push(chunk));
                              req.on('end', () => resolve(Buffer.concat(chunks)));
                              req.on('error', reject);
              });

              let fileBuffer;
                let fileMime;

              if (rawContentType.startsWith('multipart/form-data')) {
                              // --- Multipart path (upload scripts, curl, etc.) ---
                  // Feed the buffered body into busboy via write()/end() instead of
                  // piping req, which avoids "Unexpected end of form" when Vercel has
                  // already touched the stream.
                  const busboy = Busboy({ headers: req.headers });

                  const fileData = await new Promise((resolve, reject) => {
                                    let buf = null;
                                    let mime = null;

                                                             busboy.on('file', (_fieldname, fileStream, info) => {
                                                                                 // Prefer Content-Type from part headers; fall back to filename ext
                                                                                 mime = (info.mimeType && info.mimeType !== 'application/octet-stream')
                                                                                   ? info.mimeType
                                                                                                       : mimeFromFilename(info.filename || filename);
                                                                                 const parts = [];
                                                                                 fileStream.on('data', d => parts.push(d));
                                                                                 fileStream.on('end', () => { buf = Buffer.concat(parts); });
                                                                                 fileStream.on('error', reject);
                                                             });

                                                             busboy.on('finish', () => {
                                                                                 buf ? resolve({ buffer: buf, mime }) : reject(new Error('No file received'));
                                                             });
                                    busboy.on('error', reject);

                                                             busboy.write(rawBody);
                                    busboy.end();
                  });

                  fileBuffer = fileData.buffer;
                              fileMime   = fileData.mime;

              } else {
                              // --- Raw binary path (what blog-admin.js uploadFile() sends) ---
                  // The browser sends: Content-Type: image/jpeg (or image/png, image/webp…)
                  // with the raw image bytes as the body. No multipart envelope at all.
                  fileBuffer = rawBody;

                  // Use the request Content-Type if it looks like an image MIME type,
                  // otherwise derive from the filename extension.
                  fileMime = rawContentType.startsWith('image/')
                                ? rawContentType.split(';')[0].trim()   // strip any ;charset= suffix
                                    : mimeFromFilename(filename);
              }

              const blob = await put('blog-images/' + filename, fileBuffer, {
                              access: 'public',
                              contentType: fileMime,   // tells Vercel Blob what MIME to serve — prevents Content-Disposition: attachment
                              allowOverwrite: true,
              });

              return res.status(200).json({
                              url: blob.url,
                              filename,
                              uploadedAt: new Date().toISOString(),
              });
  } catch (err) {
                console.error('blog-upload-image error:', err);
                return res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
}
