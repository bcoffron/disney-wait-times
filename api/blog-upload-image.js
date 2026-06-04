import jwt from 'jsonwebtoken';
import { put } from '@vercel/blob';

const rl = {};

export const config = {
    api: { bodyParser: false }
};

function parseMultipart(body, boundary) {
    const boundaryBuf = Buffer.from('--' + boundary);
    const parts = [];
    let start = 0;
    while (start < body.length) {
          const boundaryIdx = body.indexOf(boundaryBuf, start);
          if (boundaryIdx === -1) break;
          const headerStart = boundaryIdx + boundaryBuf.length;
          if (body[headerStart] === 0x2d && body[headerStart + 1] === 0x2d) break; // --boundary--
      // skip \r\n after boundary
      const contentStart = headerStart + 2;
          const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), contentStart);
          if (headerEnd === -1) break;
          const headerStr = body.slice(contentStart, headerEnd).toString();
          const dataStart = headerEnd + 4;
          const nextBoundary = body.indexOf(boundaryBuf, dataStart);
          const dataEnd = nextBoundary === -1 ? body.length : nextBoundary - 2; // -2 for \r\n
      parts.push({ headers: headerStr, data: body.slice(dataStart, dataEnd) });
          start = nextBoundary === -1 ? body.length : nextBoundary;
    }
    return parts;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', chunk => chunks.push(chunk));
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
    });
}

export default async function handler(req, res) {
    const sentToken = req.headers['x-admin-key'] || '';
    try {
          jwt.verify(sentToken, process.env.JWT_SECRET);
    } catch (err) {
          return res.status(401).json({ error: 'Unauthorized' });
    }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    if (!rl[ip] || now - rl[ip].start > 60000) rl[ip] = { count: 0, start: now };
    rl[ip].count++;
    if (rl[ip].count > 20) return res.status(429).json({ error: 'Rate limit exceeded' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
        const rawContentType = req.headers['content-type'] || '';
        const filename = req.headers['x-filename'] || ('upload-' + Date.now() + '.jpg');

      let fileBuffer;
        let fileContentType = 'image/jpeg';

      if (rawContentType.startsWith('multipart/form-data')) {
              // Parse multipart body to extract the file binary
          const boundaryMatch = rawContentType.match(/boundary=([^\s;]+)/);
              if (!boundaryMatch) return res.status(400).json({ error: 'Missing multipart boundary' });
              const boundary = boundaryMatch[1];
              const body = await readBody(req);
              const parts = parseMultipart(body, boundary);
              const filePart = parts.find(p =>
                        /content-disposition/i.test(p.headers) && /name="file"/i.test(p.headers)
                                                ) || parts[0];
              if (!filePart) return res.status(400).json({ error: 'No file part found in multipart body' });
              const ctMatch = filePart.headers.match(/content-type:\s*([^\r\n]+)/i);
              fileContentType = ctMatch ? ctMatch[1].trim() : 'image/jpeg';
              fileBuffer = filePart.data;
      } else {
              // Raw binary upload — read stream directly
          fileBuffer = await readBody(req);
              fileContentType = rawContentType || 'image/jpeg';
      }

      const blob = await put('blog-images/' + filename, fileBuffer, {
              access: 'public',
              contentType: fileContentType,
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
