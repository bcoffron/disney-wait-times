export default function handler(req, res) {
  res.json({ sha: process.env.VERCEL_GIT_COMMIT_SHA || 'unknown' });
}
