export default function handler(req, res) {
  return res.status(404).json({ error: 'Not found' });
}
