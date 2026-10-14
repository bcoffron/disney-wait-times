#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-photo-bundle.mjs -- photo bundle DRIFT CHECK (Oct 14, 2026).
//
// The bundle has one source (assets/photos/credits.json + the image files
// in assets/photos/) and three derived artifacts that must agree with it:
//   1. api/scaffold.js  PHOTO_BUNDLE_COVERED (generated -- gen-photo-manifest)
//   2. app.html         PHOTO_BUNDLES (client render table, hand-maintained)
//   3. app.html         PHOTO_CREDITS_HTML (credits block, hand-maintained)
// This check asserts all four views name the SAME covered spot-key set with
// the SAME file per key, that every shipped image is claimed by credits.json
// (and vice versa), that PHOTO_BUNDLES source URLs match credits.json, and
// that the credits block carries exactly one row per covered spot.
//
// Many-keys-to-one-file is LEGAL (e.g. one Falcon photo serves both the
// Millennium Falcon Plaza and Galaxy's Edge Rock Spires spots) -- files are
// compared as the image of the key->file map, never as a bijection.
//
// Run: node scripts/check-photo-bundle.mjs   (exit 1 on any drift)
// No dependencies; paths resolve from this file.
// ---------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const fail = (m) => failures.push(m);

// Shared join key -- MUST stay byte-equivalent to photoNorm in app.html and
// photoSpotKey in api/scaffold.js / scripts/gen-photo-manifest.mjs.
function photoSpotKey(name) {
  return String(name || '').toLowerCase().replace(/[‘’“”]/g, '"').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Extract a JS object literal assigned as `var NAME=<literal>;` and parse it.
function extractVarJson(fileText, name) {
  const start = fileText.indexOf('var ' + name + '=');
  if (start < 0) { fail(name + ' not found'); return null; }
  let i = fileText.indexOf('{', start);
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < fileText.length; j++) {
    const ch = fileText[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) {
      try { return JSON.parse(fileText.slice(i, j + 1)); }
      catch (e) { fail(name + ' did not parse: ' + e.message); return null; }
    } }
  }
  fail(name + ' object never closed');
  return null;
}

// --- source of truth: credits.json + files on disk -------------------------
const credits = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'photos', 'credits.json'), 'utf8'));
const filesOnDisk = new Set(fs.readdirSync(path.join(ROOT, 'assets', 'photos'))
  .filter(f => /\.(jpe?g|png|webp)$/i.test(f)));

const srcCovered = {};       // key -> file
const srcByKey = {};         // key -> credits entry
for (const e of credits) {
  if (!e || !e.spot) continue;
  const key = photoSpotKey(e.spot);
  if (e.file) {
    if (srcCovered[key] && srcCovered[key] !== e.file) fail(`credits.json: key "${key}" claimed by two files`);
    srcCovered[key] = e.file;
    srcByKey[key] = e;
    if (!filesOnDisk.has(e.file)) fail(`credits.json: "${e.spot}" names ${e.file}, not present in assets/photos/`);
  }
}
const claimedFiles = new Set(Object.values(srcCovered));
for (const f of filesOnDisk) {
  if (!claimedFiles.has(f)) fail(`assets/photos/${f} ships but no credits.json entry claims it`);
}

// --- derived 1: scaffold PHOTO_BUNDLE_COVERED ------------------------------
const scaffold = fs.readFileSync(path.join(ROOT, 'api', 'scaffold.js'), 'utf8');
const blockStart = scaffold.indexOf('// === GENERATED PHOTO BUNDLE MANIFEST');
const blockEnd = scaffold.indexOf('// === END GENERATED PHOTO BUNDLE MANIFEST ===');
if (blockStart < 0 || blockEnd < 0) fail('scaffold.js: generated manifest markers not found');
const covered = {};
if (blockStart >= 0 && blockEnd > blockStart) {
  const block = scaffold.slice(blockStart, blockEnd);
  for (const m of block.matchAll(/"([^"]+)":\s*"([^"]+)"/g)) covered[m[1]] = m[2];
}

// --- derived 2 + 3: app.html PHOTO_BUNDLES + PHOTO_CREDITS_HTML ------------
const app = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const bundles = extractVarJson(app, 'PHOTO_BUNDLES') || {};
let creditSpots = [];
{
  const start = app.indexOf('var PHOTO_CREDITS_HTML=');
  if (start < 0) fail('PHOTO_CREDITS_HTML not found');
  else {
    let i = app.indexOf('"', start);
    let esc = false, end = -1;
    for (let j = i + 1; j < app.length; j++) {
      const ch = app[j];
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') { end = j; break; }
    }
    if (end < 0) fail('PHOTO_CREDITS_HTML string never closed');
    else {
      const html = JSON.parse(app.slice(i, end + 1));
      creditSpots = [...html.matchAll(/photo-credit-spot">([^<]+)</g)].map(m => photoSpotKey(m[1]));
    }
  }
}

// --- compare the three key->file views -------------------------------------
function compareMaps(label, other) {
  const a = Object.keys(srcCovered).sort(), b = Object.keys(other).sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fail(`${label}: covered key set differs from credits.json (only in credits: ${a.filter(k => !other[k]).join('; ') || 'none'} | only in ${label}: ${b.filter(k => !srcCovered[k]).join('; ') || 'none'})`);
    return;
  }
  for (const k of a) if (srcCovered[k] !== other[k]) fail(`${label}: key "${k}" maps to ${other[k]}, credits.json says ${srcCovered[k]}`);
}
compareMaps('scaffold PHOTO_BUNDLE_COVERED', covered);
const bundleFiles = {};
for (const [k, v] of Object.entries(bundles)) bundleFiles[k] = v && v.f;
compareMaps('app PHOTO_BUNDLES', bundleFiles);

// --- PHOTO_BUNDLES credit/source agreement with credits.json ---------------
for (const [key, v] of Object.entries(bundles)) {
  const e = srcByKey[key];
  if (!e) continue; // key-set failure already reported
  if (e.source_page_url) {
    if (v.s !== e.source_page_url) fail(`PHOTO_BUNDLES "${key}": source URL does not match credits.json`);
    // Credit phrasing is presentation (the public-domain entry phrases it
    // differently in each artifact); the substantive tie is the author.
    if (e.author && !String(v.c || '').includes(e.author)) fail(`PHOTO_BUNDLES "${key}": credit text does not name the credits.json author`);
  } else {
    if (v.s) fail(`PHOTO_BUNDLES "${key}": has a source URL but credits.json entry is first-party (no source)`);
    if (v.c !== e.attribution_text) fail(`PHOTO_BUNDLES "${key}": own-photo credit "${v.c}" != credits.json attribution "${e.attribution_text}"`);
  }
}

// --- credits block rows == covered spot set --------------------------------
{
  const a = Object.keys(srcCovered).sort(), b = [...creditSpots].sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fail(`PHOTO_CREDITS_HTML: row set differs from covered spots (rows: ${b.join('; ')} | covered: ${a.join('; ')})`);
  }
  if (new Set(creditSpots).size !== creditSpots.length) fail('PHOTO_CREDITS_HTML: duplicate rows');
}

if (failures.length) {
  console.error('PHOTO BUNDLE DRIFT (' + failures.length + '):');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log(`photo bundle consistent: ${Object.keys(srcCovered).length} covered spots, ${claimedFiles.size} files, credits.json / PHOTO_BUNDLES / PHOTO_BUNDLE_COVERED / PHOTO_CREDITS_HTML / files on disk all agree`);
