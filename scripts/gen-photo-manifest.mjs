#!/usr/bin/env node
// ---------------------------------------------------------------------------
// gen-photo-manifest.mjs -- regenerate the PHOTO BUNDLE MANIFEST block in
// api/scaffold.js from the app bundle itself (Item 9, Oct 7, 2026).
//
// The bundle is the truth: assets/photos/credits.json (the license
// manifest) + the image files under assets/photos/. A photo-op spot is
// COVERED iff credits.json names a file for it AND that file ships in the
// bundle. The generated block (PHOTO_BUNDLE_COVERED in api/scaffold.js)
// is what generation consults when composing photo-op cards, so prose
// and photoLinks can only ever promise covered spots.
//
// Run after ANY bundle change (photo added/removed, credits entry added):
//   node scripts/gen-photo-manifest.mjs           (rewrites the block)
//   node scripts/gen-photo-manifest.mjs --check   (exit 1 if stale)
// No dependencies; run from anywhere (paths resolve from this file).
// ---------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CREDITS = path.join(ROOT, 'assets', 'photos', 'credits.json');
const PHOTOS_DIR = path.join(ROOT, 'assets', 'photos');
const SCAFFOLD = path.join(ROOT, 'api', 'scaffold.js');
const START = '// === GENERATED PHOTO BUNDLE MANIFEST -- DO NOT HAND-EDIT ===';
const END = '// === END GENERATED PHOTO BUNDLE MANIFEST ===';

// The shared photo-spot join key. MUST stay byte-equivalent to photoNorm
// in app.html (client) and photoSpotKey in api/scaffold.js: lowercase,
// curly quotes folded to straight, non-alphanumeric runs to one space.
function photoSpotKey(name) {
  return String(name || '').toLowerCase().replace(/[‘’“”]/g, '"').replace(/[^a-z0-9]+/g, ' ').trim();
}

function derive() {
  const creditsRaw = fs.readFileSync(CREDITS);
  const credits = JSON.parse(creditsRaw.toString('utf8'));
  const filesOnDisk = new Set(fs.readdirSync(PHOTOS_DIR));
  const covered = {};
  const warnings = [];
  const claimedFiles = new Set();
  for (const e of credits) {
    if (!e || !e.spot) continue;
    if (!e.file) {
      if (e.status && !String(e.status).startsWith('uncovered')) {
        warnings.push(`credits entry "${e.spot}" has status "${e.status}" but no file -- treated as uncovered`);
      }
      continue;
    }
    claimedFiles.add(e.file);
    if (!filesOnDisk.has(e.file)) {
      warnings.push(`credits entry "${e.spot}" names ${e.file}, which is NOT in assets/photos/ -- treated as uncovered`);
      continue;
    }
    const key = photoSpotKey(e.spot);
    if (covered[key] && covered[key] !== e.file) {
      warnings.push(`duplicate covered key "${key}" (${covered[key]} vs ${e.file}) -- keeping the first`);
      continue;
    }
    covered[key] = e.file;
  }
  for (const f of filesOnDisk) {
    if (/\.(jpe?g|png|webp)$/i.test(f) && !claimedFiles.has(f)) {
      warnings.push(`image ${f} ships in assets/photos/ but has NO credits.json entry -- not covered (license unknown)`);
    }
  }
  const sha = crypto.createHash('sha256').update(creditsRaw).digest('hex');
  return { covered, warnings, sha };
}

function renderBlock({ covered, sha }) {
  const keys = Object.keys(covered).sort();
  const lines = keys.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(covered[k])},`);
  return [
    START,
    `// Derived from assets/photos/credits.json (sha256 ${sha})`,
    `// plus the image files present in assets/photos/ at generation time.`,
    `// Covered spots: ${keys.length}. Regenerate: node scripts/gen-photo-manifest.mjs`,
    'const PHOTO_BUNDLE_COVERED = {',
    ...lines,
    '};',
    END,
  ].join('\n');
}

const { covered, warnings, sha } = derive();
for (const w of warnings) console.error('WARN:', w);
const block = renderBlock({ covered, sha });
const scaffold = fs.readFileSync(SCAFFOLD, 'utf8');
const si = scaffold.indexOf(START);
const ei = scaffold.indexOf(END);
if (si < 0 || ei < 0 || ei < si) {
  console.error('FATAL: manifest markers not found in api/scaffold.js');
  process.exit(2);
}
const current = scaffold.slice(si, ei + END.length);
if (process.argv.includes('--check')) {
  if (current === block) {
    console.log(`photo manifest up to date (${Object.keys(covered).length} covered spots)`);
    process.exit(0);
  }
  console.error('photo manifest is STALE -- run: node scripts/gen-photo-manifest.mjs');
  process.exit(1);
}
if (current === block) {
  console.log(`photo manifest unchanged (${Object.keys(covered).length} covered spots)`);
} else {
  fs.writeFileSync(SCAFFOLD, scaffold.slice(0, si) + block + scaffold.slice(ei + END.length));
  console.log(`photo manifest regenerated: ${Object.keys(covered).length} covered spots`);
}
