#!/usr/bin/env node
// Photo reference check (Oct 20, 2026): every literal assets/photos/<file>
// reference in the repo's HTML must resolve — the file must exist in
// assets/photos/ AND have an entry in assets/photos/credits.json.
//
// Why: the photo bundle drift check covers the manifest side (what ships),
// but nothing covered the consumer side (what the pages point at). When
// new-orleans-square-riverfront.jpg was removed in the Oct 2026 photo
// provenance program, pretrip.html kept referencing it and the Step 5
// (Food & Reservations) photo band rendered blank until a user screenshot
// caught it months later.
//
// SCOPE HONESTY: this check covers LITERAL paths only ("assets/photos/x.jpg"
// appearing verbatim in an .html file). References constructed dynamically
// (string concatenation, template variables) are NOT covered.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const photosDir = join(root, 'assets', 'photos');

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

const credits = JSON.parse(readFileSync(join(photosDir, 'credits.json'), 'utf8'));
const credited = new Set(credits.map((e) => e.file));

const REF = /assets\/photos\/([A-Za-z0-9._-]+)/g;
const problems = [];
let refCount = 0;

for (const file of walk(root, [])) {
  const text = readFileSync(file, 'utf8');
  const seen = new Set();
  for (const m of text.matchAll(REF)) {
    const name = m[1];
    if (name === 'credits.json') continue; // the registry itself, not a photo
    if (seen.has(name)) continue;
    seen.add(name);
    refCount++;
    if (!existsSync(join(photosDir, name))) {
      problems.push(relative(root, file) + ': references missing file assets/photos/' + name);
    } else if (!credited.has(name)) {
      problems.push(relative(root, file) + ': assets/photos/' + name + ' has no credits.json entry');
    }
  }
}

if (problems.length) {
  console.error('PHOTO REFERENCE CHECK FAILED (' + problems.length + '):');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('photo references ok: ' + refCount + ' literal reference(s) resolve to a file with a credits.json entry');
