// scripts/build-capacitor-www.mjs
// Builds the Capacitor web directory (www/) from the repo's static frontend.
// Single source of truth: the repo-root web files. Regenerate with `npm run cap:www`.
// Do NOT edit www/ by hand and do NOT commit it (see .gitignore).
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www = join(root, 'www');

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

// Entry point: Capacitor serves www/index.html
cpSync(join(root, 'app.html'), join(www, 'index.html'));

// Pages + PWA manifest + root icons referenced by the app
for (const f of ['pretrip.html', 'manifest.json', 'apple-touch-icon.png', 'castle.webp']) {
  const src = join(root, f);
  if (existsSync(src)) cpSync(src, join(www, f));
  else console.warn('[cap:www] missing (skipped):', f);
}

// Park map + directions assets (Oct 2026): lazy-loaded by app.html at runtime
for (const f of ['map-leaflet.js', 'map-router.js', 'park-graph-dl.js', 'park-graph-dca.js', 'park-tiles-dl.js', 'park-tiles-dca.js']) {
  const src = join(root, f);
  if (existsSync(src)) cpSync(src, join(www, f));
  else console.warn('[cap:www] missing (skipped):', f);
}

// Static assets (brand, icons)
cpSync(join(root, 'assets'), join(www, 'assets'), { recursive: true });

console.log('[cap:www] built', www);
