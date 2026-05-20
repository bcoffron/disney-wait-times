// api/subscribe.js
// Adds email + first name to Resend audience for TPCP early access list
// Creates the audience automatically on first run if it doesn't exist

export default async function handler(req, res) {
  // CORS headers so prelaunch.html can call this from any domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, firstName } = req.body || {};

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    // Step 1: Get or create the TPCP audience
    const audienceId = await getOrCreateAudience(RESEND_API_KEY);

    // Step 2: Add contact to audience
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
          first_name: firstName ? firstName.trim() : '',
          unsubscribed: false,
        }),
      }
    );

    const contactData = await contactRes.json();

    if (!contactRes.ok) {
      // If contact already exists that's fine — treat as success
      if (contactData.name === 'validation_error' &&
          JSON.stringify(contactData).includes('already exists')) {
        return res.status(200).json({ success: true, alreadySubscribed: true });
      }
      console.error('Resend contact error:', contactData);
      return res.status(500).json({ error: 'Could not save email' });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Subscribe error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function getOrCreateAudience(apiKey) {
  const AUDIENCE_NAME = 'Theme Park Co-Pilot Early Access';

  // List existing audiences
  const listRes = await fetch('https://api.resend.com/audiences', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  const listData = await listRes.json();

  // Check if our audience already exists
  if (listData.data && listData.data.length > 0) {
    const existing = listData.data.find(a => a.name === AUDIENCE_NAME);
    if (existing) return existing.id;
  }

  // Create it if not found
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
