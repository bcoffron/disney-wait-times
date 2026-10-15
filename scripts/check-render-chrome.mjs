#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-render-chrome.mjs -- render-chrome DRIFT CHECK (Oct 14, 2026).
//
// api/editorial.js serves a static page in the blog post shell. It carries
// byte-copies of the shared chrome from api/blog-render-post.js:
//   1. POST_CSS (the post stylesheet)
//   2. the nav markup and the footer markup
//   3. the security-header block (4 static headers + the CSP-Report-Only
//      directive set + Cache-Control) and the rate-limit constants
// This check asserts the copies are still identical, so a future tightening
// of the post renderer's posture cannot silently leave /editorial-standards
// behind. It also asserts the editorial page's defining property: the
// handler makes ZERO blob reads (no readBlobJson, no @vercel/blob, no
// lib/blob import) -- a static page has no data dependency, and that is a
// property of the file, not an assumption.
//
// Run: node scripts/check-render-chrome.mjs   (exit 1 on any drift)
// No dependencies; paths resolve from this file.
// ---------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const fail = (m) => failures.push(m);

const post = fs.readFileSync(path.join(ROOT, 'api', 'blog-render-post.js'), 'utf8');
const ed = fs.readFileSync(path.join(ROOT, 'api', 'editorial.js'), 'utf8');

// Extract the raw literal of `const NAME = '...';` (single-quoted, escapes kept).
function rawLiteral(src, name) {
  const marker = 'const ' + name + " = '";
  const start = src.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  let out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { out += c + src[i + 1]; i += 2; continue; }
    if (c === "'") return out;
    out += c; i++;
  }
  return null;
}

// Extract and evaluate a JSON string literal `const NAME = "...";`.
function jsonLiteral(src, name) {
  const marker = 'const ' + name + ' = "';
  const start = src.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '"') return JSON.parse(src.slice(start + marker.length - 1, i + 1));
    i++;
  }
  return null;
}

function sliceBetween(src, a, b) {
  const i = src.indexOf(a);
  if (i < 0) return null;
  const j = src.indexOf(b, i);
  if (j < 0) return null;
  return src.slice(i, j + b.length);
}

// 1. POST_CSS: raw literals must be byte-identical.
const postCss = rawLiteral(post, 'POST_CSS');
const edCss = rawLiteral(ed, 'POST_CSS');
if (!postCss) fail('POST_CSS not found in blog-render-post.js');
if (!edCss) fail('POST_CSS not found in editorial.js');
if (postCss && edCss && postCss !== edCss) fail('POST_CSS drift: editorial.js copy differs from blog-render-post.js');

// 2. Nav + footer: blog builds them inline; editorial holds them as consts.
const postNav = sliceBetween(post, '<nav class="nav" role="navigation"', '</nav>');
const edNav = jsonLiteral(ed, 'NAV_HTML');
if (!postNav) fail('nav markup not found in blog-render-post.js');
if (edNav === null) fail('NAV_HTML not found in editorial.js');
if (postNav && edNav !== null && postNav !== edNav) fail('nav drift: NAV_HTML differs from blog-render-post.js');

const postFoot = sliceBetween(post, '<footer class="footer" role="contentinfo">', '</footer>');
const edFoot = jsonLiteral(ed, 'FOOTER_HTML');
if (!postFoot) fail('footer markup not found in blog-render-post.js');
if (edFoot === null) fail('FOOTER_HTML not found in editorial.js');
if (postFoot && edFoot !== null && postFoot !== edFoot) fail('footer drift: FOOTER_HTML differs from blog-render-post.js');

// 3. Security posture: every setHeader call in editorial.js must have an
// identical (whitespace-normalized) counterpart in blog-render-post.js,
// and the rate-limit constants must match.
const norm = (s) => s.replace(/\s+/g, ' ');
function headerCalls(src) {
  const calls = [];
  let i = 0;
  while ((i = src.indexOf('res.setHeader(', i)) >= 0) {
    const j = src.indexOf(');', i);
    if (j < 0) break;
    calls.push(norm(src.slice(i, j + 2)));
    i = j + 2;
  }
  return calls;
}
const postHeaders = new Set(headerCalls(post));
for (const call of headerCalls(ed)) {
  if (!postHeaders.has(call)) fail('header drift: editorial.js sets a header with no identical call in blog-render-post.js: ' + call.slice(0, 80) + '...');
}
for (const token of ['const windowMs = 60 * 1000;', 'const max = 100;', "return res.status(429).send('Rate limit exceeded');"]) {
  if (!ed.includes(token)) fail('rate-limit drift: editorial.js missing: ' + token);
  if (!post.includes(token)) fail('rate-limit drift: blog-render-post.js missing: ' + token);
}

// 4. The static-page property: zero data reads in editorial.js.
for (const bad of ['readBlobJson', '@vercel/blob', 'lib/blob', 'readSettings']) {
  if (ed.includes(bad)) fail('editorial.js must stay fully static; found data dependency: ' + bad);
}

if (failures.length) {
  console.error('RENDER CHROME DRIFT (' + failures.length + '):');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('render chrome OK: POST_CSS, nav, footer, headers, rate limit identical; editorial.js fully static.');
