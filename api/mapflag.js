// Map surface kill switch (msg 166 flip): the fleet rollback for the
// native map default. To roll the fleet back to the web map, set
// NATIVE_MAP_DEFAULT to false and push -- Vercel redeploys and every
// device falls back at its next flag refresh. Clients treat any
// absent/unreachable/invalid value as true: this flag can only ever
// switch native OFF, never gate it on.
const NATIVE_MAP_DEFAULT = false;
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.json({ nativeDefault: NATIVE_MAP_DEFAULT });
}
