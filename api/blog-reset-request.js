// api/blog-reset-request.js — POST /api/blog-reset-request — request password reset email
import { put } from '@vercel/blob';
import { Resend } from 'resend';
import crypto from 'crypto';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'beau.coffron@life.church';
const RESET_TOKEN_KEY = 'blog:admin:reset-token';

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const MAX_REQUEST_SIZE = 1 * 1024;
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > MAX_REQUEST_SIZE) {
    return res.status(413).json({ error: 'Request too large' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { email } = body || {};

  // Always return success to prevent email enumeration
  if (!email || email !== ADMIN_EMAIL) {
    return res.status(200).json({ success: true });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 60 * 60 * 1000;

  await put(RESET_TOKEN_KEY, JSON.stringify({ token, expiresAt }), {
    access: 'public',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: 'application/json',
    token: process.env.BLOB_READ_WRITE_TOKEN
  });

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const resetUrl = `https://themeparkcopilot.com/admin?reset=${token}`;

    await resend.emails.send({
      from: 'Theme Park Co-Pilot <hello@themeparkcopilot.com>',
      to: ADMIN_EMAIL,
      subject: 'Admin Password Reset',
      html: `
        <p>You requested a password reset for the Theme Park Co-Pilot admin panel.</p>
        <p><a href="${resetUrl}">Click here to reset your password</a></p>
        <p>This link expires in 1 hour.</p>
        <p>If you did not request this, ignore this email.</p>
      `
    });
    console.log('[SECURITY] Password reset email sent at', new Date().toISOString());
  } catch(e) {
    console.error('[SECURITY] Failed to send reset email:', e.message);
  }

  return res.status(200).json({ success: true });
}
