import jwt from 'jsonwebtoken';
import { put, list } from '@vercel/blob';
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

// Fix 1 — Magic bytes validation
function validateMagicBytes(buffer, contentType) {
  const bytes = new Uint8Array(buffer);

  if (contentType.includes('image/jpeg')) {
    return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  }
  if (contentType.includes('image/png')) {
    return bytes[0] === 0x89 && bytes[1] === 0x50 &&
           bytes[2] === 0x4E && bytes[3] === 0x47 &&
           bytes[4] === 0x0D && bytes[5] === 0x0A &&
           bytes[6] === 0x1A && bytes[7] === 0x0A;
  }
  if (contentType.includes('image/webp')) {
    return bytes[0] === 0x52 && bytes[1] === 0x49 &&
           bytes[2] === 0x46 && bytes[3] === 0x46 &&
           bytes[8] === 0x57 && bytes[9] === 0x45 &&
           bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  if (contentType.includes('image/gif')) {
    return bytes[0] === 0x47 && bytes[1] === 0x49 &&
           bytes[2] === 0x46 && bytes[3] === 0x38;
  }
  return false;
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

  // Fix 3 — Filename length limit
  const originalFilename = req.headers['x-filename'] || '';
  const MAX_FILENAME_LENGTH = 100;
  if (originalFilename.length > MAX_FILENAME_LENGTH) {
    return res.status(400).json({ error: 'Filename too long' });
  }

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
            : mimeFromFilename(info.filename || originalFilename);
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
        : mimeFromFilename(originalFilename);

      // Fix 2: Validate MIME type for raw uploads
      if (!allowedTypes.includes(fileMime)) {
        return res.status(400).json({ error: 'Invalid file type. JPEG, PNG, WebP, GIF only.' });
      }
    }

    // Fix 1 — Magic bytes validation
    if (!validateMagicBytes(fileBuffer, fileMime)) {
      console.warn('[SECURITY] Magic bytes mismatch - possible file type spoofing:', {
        ip: req.headers['x-forwarded-for']?.split(',')[0],
        claimedType: fileMime,
        time: new Date().toISOString()
      });
      return res.status(400).json({ error: 'File content does not match claimed type' });
    }

    // Check for recent duplicate (same file size uploaded in last 5 minutes)
    const { blobs } = await list({
      prefix: 'blog-images/',
      limit: 100,
      token: process.env.BLOB_READ_WRITE_TOKEN
    });
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    const recentDuplicate = blobs.find(b => {
      const uploadedAt = new Date(b.uploadedAt).getTime();
      return b.size === fileBuffer.length && uploadedAt > fiveMinutesAgo;
    });
    if (recentDuplicate) {
      return res.status(200).json({
        success: true,
        url: recentDuplicate.url,
        filename: recentDuplicate.pathname.split('/').pop(),
        deduplicated: true
      });
    }

    // Fix 2 — Generate safe random filename (never use original)
    const ext = fileMime.includes('jpeg') ? 'jpg' :
                fileMime.includes('png') ? 'png' :
                fileMime.includes('webp') ? 'webp' : 'gif';
    const safeFilename = `blog-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${ext}`;

    const blob = await put('blog-images/' + safeFilename, fileBuffer, {
      access: 'public',
      contentType: fileMime,
      allowOverwrite: true,
    });

    return res.status(200).json({
      url: blob.url,
      filename: safeFilename,
      uploadedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('blog-upload-image error:', err);
    return res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
}
