import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
export default function handler(req, res) {
  const css = readFileSync(join(__dirname, '../admin-client.css'), 'utf8');
  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'no-cache');
  res.status(200).send(css);
}
