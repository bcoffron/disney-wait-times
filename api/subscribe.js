// api/subscribe.js
// Adds email to Resend audience for TPCP early access list

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_MMCfhr4J_CPbk5wJ24YgMtL4NcgnqCieW';

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
