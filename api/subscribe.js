// api/subscribe.js
// Adds email to Resend audience and sends welcome email

const ALLOWED_ORIGINS = [
  'https://themeparkcopilot.com',
  'https://www.themeparkcopilot.com',
  'https://themeparkwize.com',
  'https://www.themeparkwize.com',
  'https://app.themeparkcopilot.com'
];

// Simple in-memory rate limit — max 3 subscribes per IP per 10 minutes
const _ipCache = {};
function isRateLimited(ip) {
  const now = Date.now();
  const window = 10 * 60 * 1000; // 10 minutes
  if (!_ipCache[ip]) { _ipCache[ip] = []; }
  _ipCache[ip] = _ipCache[ip].filter(t => now - t < window);
  if (_ipCache[ip].length >= 3) return true;
  _ipCache[ip].push(now);
  return false;
}

async function handler(req, res) {
  // CORS — only allow our own domains
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit by IP
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const { email } = req.body || {};

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Email service not configured' });

  try {
    const audienceId = await getOrCreateAudience(RESEND_API_KEY);

    const contactRes = await fetch(
      `https://api.resend.com/audiences/${audienceId}/contacts`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          unsubscribed: false,
        }),
      }
    );

    const contactData = await contactRes.json();

    if (!contactRes.ok) {
      const msg = JSON.stringify(contactData);
      if (msg.includes('already exists') || msg.includes('duplicate')) {
        return res.status(200).json({ success: true });
      }
      console.error('Resend contact error:', contactData);
      return res.status(500).json({ error: 'Could not save email', detail: contactData });
    }

    // Send welcome email — non-blocking, failure won't affect subscription success
    try {
      await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Theme Park Co-Pilot <hello@themeparkcopilot.com>',
        to: email.trim().toLowerCase(),
        subject: 'You\u2019re on the list \u2014 Theme Park Co-Pilot',
        html: `
          <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#071E25;color:#fff;border-radius:12px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:rgba(245,166,35,0.7);margin-bottom:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"><span style="font-weight:900;color:#fff;">Theme Park Co</span><span style="color:#F5A623;font-weight:900;">&#10022;</span><span style="font-weight:900;color:#fff;">Pilot</span></div>
            <div style="font-size:26px;font-weight:900;color:#fff;line-height:1.1;margin-bottom:10px;font-family:Georgia,serif;">Smarter days.<br><span style="color:#F5A623;font-style:italic;">More magic.</span></div>
            <p style="font-size:14px;color:rgba(255,255,255,0.55);line-height:1.65;margin:0 0 20px;">You\u2019re on the early access list. We\u2019ll email you the moment Theme Park Co-Pilot launches for Disneyland Resort \u2014 with a special early access offer just for you.</p>
            <div style="background:rgba(26,104,96,0.2);border:1px solid rgba(26,104,96,0.4);border-radius:8px;padding:14px 16px;font-size:13px;color:rgba(255,255,255,0.7);margin-bottom:24px;">
              \u2714 Disneyland Resort launch access<br>
              \u2714 7-day free trial when we go live<br>
              \u2714 No credit card required
            </div>
            <p style="font-size:11px;color:rgba(255,255,255,0.25);line-height:1.5;margin:0;">Questions? Reply to this email or reach us at <a href="mailto:hello@themeparkcopilot.com" style="color:rgba(255,255,255,0.4);">hello@themeparkcopilot.com</a><br><br>Theme Park Co-Pilot is not affiliated with The Walt Disney Company.</p>
          </div>
        `,
      }),
    });
    } catch (emailErr) {
      console.warn('Welcome email failed (non-fatal):', emailErr.message);
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Subscribe exception:', err.message);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
}

async function getOrCreateAudience(apiKey) {
  const AUDIENCE_NAME = 'Theme Park Co-Pilot Early Access';

  const listRes = await fetch('https://api.resend.com/audiences', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  const listData = await listRes.json();

  if (listData.data && listData.data.length > 0) {
    const existing = listData.data.find(a => a.name === AUDIENCE_NAME);
    if (existing) return existing.id;
  }

  const createRes = await fetch('https://api.resend.com/audiences', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: AUDIENCE_NAME }),
  });
  const created = await createRes.json();

  if (!createRes.ok) throw new Error('Could not create audience: ' + JSON.stringify(created));
  return created.id;
}

handler.config = { maxDuration: 10 };
module.exports = handler;
