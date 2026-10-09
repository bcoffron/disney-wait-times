// scripts/build-capacitor-www.mjs
// Builds the Capacitor web directory (www/) from the repo's static frontend.
// Single source of truth: the repo-root web files. Regenerate with `npm run cap:www`.
// Do NOT edit www/ by hand and do NOT commit it (see .gitignore).
// Also stamps the bundle vintage (git HEAD sha + build time) into
// www/index.html as window.__TPCP_BUNDLE__ -- the Info tab renders it so
// an installed bundle's client snapshot is identifiable on device
// (Claude msg 98). The repo app.html itself is never stamped.
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www = join(root, 'www');

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

// Entry point: Capacitor serves www/index.html
cpSync(join(root, 'app.html'), join(www, 'index.html'));

// Bundle-vintage stamp (Claude msg 98): inject the git HEAD being bundled
// + the build timestamp into www/index.html, right after <head> so the
// constant exists before any app script runs. If git is unavailable the
// stamp is SKIPPED (loudly) and the bundle honestly reads "unstamped" in
// the Info tab -- a fabricated or hand-maintained vintage is the failure
// mode this exists to kill.
try {
  const sha = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('unexpected rev-parse output: ' + sha);
  const builtAt = new Date().toISOString();
  const stamp = '<script>window.__TPCP_BUNDLE__={"sha":' + JSON.stringify(sha) + ',"builtAt":' + JSON.stringify(builtAt) + '};</script>';
  const idxPath = join(www, 'index.html');
  const idxHtml = readFileSync(idxPath, 'utf8');
  const stamped = idxHtml.includes('<head>') ? idxHtml.replace('<head>', '<head>\n' + stamp) : stamp + '\n' + idxHtml;
  writeFileSync(idxPath, stamped);
  console.log('[cap:www] bundle stamp:', sha.substring(0, 7), builtAt);
} catch (e) {
  console.warn('[cap:www] bundle stamp SKIPPED (bundle will read "unstamped"):', e.message);
}

// Pages + PWA manifest + root icons referenced by the app
for (const f of ['pretrip.html', 'manifest.json', 'apple-touch-icon.png', 'castle.webp']) {
  const src = join(root, f);
  if (existsSync(src)) cpSync(src, join(www, f));
  else console.warn('[cap:www] missing (skipped):', f);
}

// Park map + directions assets (Oct 2026): lazy-loaded by app.html at runtime
for (const f of ['map-leaflet.js', 'map-router.js', 'park-graph-dl.js', 'park-graph-dca.js', 'park-graph-dtd.js', 'park-tiles-dl.js', 'park-tiles-dca.js', 'park-tiles-resort.js']) {
  const src = join(root, f);
  if (existsSync(src)) cpSync(src, join(www, f));
  else console.warn('[cap:www] missing (skipped):', f);
}

// Static assets (brand, icons)
cpSync(join(root, 'assets'), join(www, 'assets'), { recursive: true });

console.log('[cap:www] built', www);
