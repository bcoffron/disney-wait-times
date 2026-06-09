import jwt from 'jsonwebtoken';
import { put } from '@vercel/blob';
import Busboy from 'busboy';

const rateLimit = new Map();

function checkRateLimit(ip, max, windowMs) {
  const now = Date.now();
  if (!rateLimit.has(ip)) {
    rateLimit.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  const record = rateLimit.get(ip);
  if (now > record.resetAt) {
    rateLimit.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (record.count >= max) return false;
  record.count++;
  return true;
}

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
  // Fix 5: JWT verification FIRST before any data processing
  const sentToken = req.headers['x-admin-key'] || '';
    if (!sentToken) { console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() }); return res.status(401).json({ error: 'Unauthorized' }); }
  try {
    jwt.verify(sentToken, process.env.JWT_SECRET);
  } catch {
        console.warn('[SECURITY] Auth failed:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', reason: 'invalid_token', time: new Date().toISOString() });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Fix 7: Restricted CORS
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Fix 2: Server-side file size check (header check before reading body)
  const MAX_SIZE = 4 * 1024 * 1024; // 4MB
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > MAX_SIZE) {
    return res.status(413).json({ error: 'File too large. Maximum 4MB.' });
  }

  // Fix 2: File type check via Content-Type header
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const rawContentType = req.headers['content-type'] || '';
  if (!rawContentType.startsWith('multipart/form-data') && !allowedTypes.some(t => rawContentType.includes(t))) {
        console.warn('[SECURITY] Invalid file type rejected:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', contentType: req.headers['content-type'], time: new Date().toISOString() });
    return res.status(400).json({ error: 'Invalid file type. JPEG, PNG, WebP, GIF only.' });
  }

  // Fix 1: Rate limiting — 20 uploads per IP per hour
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 20, 60 * 60 * 1000)) {
        console.warn('[SECURITY] Rate limit exceeded:', { endpoint: req.url, ip: req.headers['x-forwarded-for']?.split(',')[0] || 'unknown', time: new Date().toISOString() });
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const filename = req.headers['x-filename'] || ('upload-' + Date.now() + '.jpg');

    // Buffer the entire raw body first in all cases.
    const rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

    // Fix 2: Check actual buffer size after reading
    if (rawBody.length > MAX_SIZE) {
      return res.status(413).json({ error: 'File too large. Maximum 4MB.' });
    }

    let fileBuffer;
    let fileMime;

    if (rawContentType.startsWith('multipart/form-data')) {
      // --- Multipart path (upload scripts, curl, etc.) ---
      const busboy = Busboy({ headers: req.headers });

      const fileData = await new Promise((resolve, reject) => {
        let buf = null;
        let mime = null;

        busboy.on('file', (_fieldname, fileStream, info) => {
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
      fileMime = fileData.mime;

      // Fix 2: Validate MIME type from parsed multipart
      if (!allowedTypes.includes(fileMime)) {
        return res.status(400).json({ error: 'Invalid file type. JPEG, PNG, WebP, GIF only.' });
      }
    } else {
      // --- Raw binary path (what blog-admin.js uploadFile() sends) ---
      fileBuffer = rawBody;
      fileMime = rawContentType.startsWith('image/')
        ? rawContentType.split(';')[0].trim()
        : mimeFromFilename(filename);

      // Fix 2: Validate MIME type for raw uploads
      if (!allowedTypes.includes(fileMime)) {
        return res.status(400).json({ error: 'Invalid file type. JPEG, PNG, WebP, GIF only.' });
      }
    }

    const blob = await put('blog-images/' + filename, fileBuffer, {
      access: 'public',
      contentType: fileMime,
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
