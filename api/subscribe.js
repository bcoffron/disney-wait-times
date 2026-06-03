// api/subscribe.js
async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return res.status(200).json({ ok: true, hasKey: !!process.env.RESEND_API_KEY });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Email service not configured' });

  try {
    // Add to audience
    const audienceId = await getOrCreateAudience(RESEND_API_KEY);
    const contactRes = await fetch(
      `https://api.resend.com/audiences/${audienceId}/contacts`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), unsubscribed: false }),
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

    // Send welcome email — non-fatal if fails
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Theme Park Co-Pilot <hello@themeparkcopilot.com>',
          to: email.trim().toLowerCase(),
          subject: "You\u2019re on the list \u2014 Theme Park Co-Pilot",
          html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#071E25;color:#fff;border-radius:12px;">
            <div style="font-size:26px;font-weight:900;color:#fff;margin-bottom:10px;">Smarter days.<br><span style="color:#F5A623;">More magic.</span></div>
            <p style="font-size:14px;color:rgba(255,255,255,0.55);line-height:1.65;">You're on the early access list. We'll email you the moment Theme Park Co-Pilot launches.</p>
            <p style="font-size:11px;color:rgba(255,255,255,0.25);">Questions? <a href="mailto:hello@themeparkcopilot.com" style="color:rgba(255,255,255,0.4);">hello@themeparkcopilot.com</a></p>
          </div>`,
        }),
      });
    } catch (emailErr) {
      console.warn('Welcome email failed (non-fatal):', emailErr.message);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Subscribe error:', err.message);
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
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: AUDIENCE_NAME }),
  });
  const created = await createRes.json();
  if (!createRes.ok) throw new Error('Could not create audience: ' + JSON.stringify(created));
  return created.id;
}

handler.config = { maxDuration: 10 };
export default handler;
