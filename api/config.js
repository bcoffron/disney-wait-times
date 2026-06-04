// config.js - SECURITY: API key is NEVER returned to clients
// The app calls Anthropic directly through Vercel endpoints only
// This endpoint now only handles Pusher config (non-sensitive)

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    // Only return non-sensitive config - NEVER the API key
    return res.status(200).json({
      pusherKey: process.env.PUSHER_KEY || '',
      pusherCluster: process.env.PUSHER_CLUSTER || 'us2'
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

handler.config = { maxDuration: 10 };
export default handler;
