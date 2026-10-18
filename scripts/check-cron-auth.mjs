#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-cron-auth.mjs -- cron auth CLASS CHECK (Oct 17, 2026).
//
// Every Vercel cron endpoint in this repo must authenticate its cron path
// on the CRON_SECRET bearer alone: the authorization header compared
// against 'Bearer ' + CRON_SECRET. The retired pattern -- ALSO requiring
// the x-vercel-cron header -- stopped authenticating on Oct 6, 2026, and
// silently 401'd every blog-reconcile run for three days (fixed in
// PR #76) because the Oct 6 hardening reached the files that existed then
// and a file written a week later inherited the retired shape. This check
// closes the class, per Claude's ruling on the PR #76 review:
//
//   1. Endpoints are ENUMERATED from vercel.json's cron rows -- never a
//      hardcoded list -- so a future endpoint joins the check by existing.
//   2. Each handler's code (comments stripped, strings intact) must show
//      the bearer comparison: CRON_SECRET, a 'Bearer ' literal, and an
//      authorization read.
//   3. No handler may READ the x-vercel-cron header in code. Mentions in
//      comments are history; comments are stripped before this is judged,
//      and a bare string mention is not a read.
//   4. Four endpoints carry a sanctioned second path for manual runs --
//      the ADMIN_KEY header (x-admin-key). That allowance is encoded
//      exactly (ADMIN_ALLOWED below): a listed file must show the admin
//      path, and an unlisted file must not grow one silently.
//
// Unknown shapes fail rather than pass: a cron row whose handler file is
// missing, or a handler with no recognizable bearer comparison, is drift.
//
// Run: node scripts/check-cron-auth.mjs   (exit 1 on any violation)
// CRON_AUTH_ROOT env var points at an alternate repo root (tests).
// ---------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.env.CRON_AUTH_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Endpoints whose handler may ALSO accept the ADMIN_KEY manual-run path
// (x-admin-key header). Sanctioned alongside the Oct 6, 2026 bearer
// hardening for dashboard/manual runs. Encoded exactly -- see rule 4.
const ADMIN_ALLOWED = new Set([
  'api/cron-cache.js',
  'api/cron-push-monitor.js',
  'api/cron-booking-alerts.js',
  'api/trip-closure-scan.js',
]);

// Strip // and /* */ comments while preserving string literals, template
// literals, and regex literals: the '//' in a URL string is not a comment,
// and neither is a '/' inside a regex. Comment characters are replaced
// with spaces (newlines kept) so positions stay meaningful.
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | sq | dq | tpl | regex | regexClass | line | block
  const tplDepth = []; // brace depths at which a template expression closes
  let braces = 0;
  let prev = ''; // last significant code character (regex-vs-divide heuristic)
  const regexOkAfter = new Set(['', '=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; continue; }
      if (c === '`') { state = 'tpl'; out += c; i++; continue; }
      if (c === '/' && (regexOkAfter.has(prev) || /^(return|typeof|case|in|of)$/.test(prevWord(src, i)))) {
        state = 'regex'; out += c; prev = '/'; i++; continue;
      }
      out += c;
      if (c === '{') braces++;
      if (c === '}') {
        if (tplDepth.length && braces === tplDepth[tplDepth.length - 1]) {
          tplDepth.pop(); braces--; state = 'tpl'; i++; continue;
        }
        braces--;
      }
      if (!/\s/.test(c)) prev = c;
      i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; } else out += ' ';
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    if (state === 'sq' || state === 'dq') {
      const q = state === 'sq' ? "'" : '"';
      out += c;
      if (c === '\\') { out += d; i += 2; continue; }
      if (c === q) { state = 'code'; prev = q; }
      i++; continue;
    }
    if (state === 'tpl') {
      out += c;
      if (c === '\\') { out += d; i += 2; continue; }
      if (c === '`') { state = 'code'; prev = '`'; i++; continue; }
      if (c === '$' && d === '{') {
        out += d; i += 2; braces++; tplDepth.push(braces); state = 'code'; continue;
      }
      i++; continue;
    }
    if (state === 'regex') {
      out += c;
      if (c === '\\') { out += d; i += 2; continue; }
      if (c === '[') { state = 'regexClass'; i++; continue; }
      if (c === '/') { state = 'code'; prev = '/'; i++; continue; }
      if (c === '\n') { state = 'code'; i++; continue; }
      i++; continue;
    }
    if (state === 'regexClass') {
      out += c;
      if (c === '\\') { out += d; i += 2; continue; }
      if (c === ']') state = 'regex';
      i++; continue;
    }
  }
  return out;
}

function prevWord(src, i) {
  const m = /([A-Za-z]+)\s*$/.exec(src.slice(0, i));
  return m ? m[1] : '';
}

export function bearerOk(code) {
  return /CRON_SECRET/.test(code) && /['"]Bearer /.test(code) && /authorization/.test(code);
}

export function readsRetiredHeader(code) {
  return /headers\s*\[\s*['"]x-vercel-cron['"]\s*\]/.test(code)
    || /headers\.x-vercel-cron\b/.test(code)
    || /\.get\s*\(\s*['"]x-vercel-cron['"]/.test(code);
}

export function hasAdminPath(code) {
  return /ADMIN_KEY/.test(code) && /x-admin-key/.test(code);
}

export function cronEndpoints(vercelJson) {
  const rows = (vercelJson && vercelJson.crons) || [];
  const seen = new Set();
  for (const row of rows) {
    const p = String(row.path || '').split('?')[0].replace(/^\//, '');
    if (p) seen.add(p + '.js');
  }
  return [...seen].sort();
}

export function checkRoot(root) {
  const problems = [];
  let vercel;
  try {
    vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  } catch (e) {
    return { problems: ['vercel.json unreadable or unparseable: ' + e.message], endpoints: [] };
  }
  const endpoints = cronEndpoints(vercel);
  if (!endpoints.length) problems.push('vercel.json carries no cron rows -- nothing enumerated, nothing proven');
  for (const rel of endpoints) {
    let src;
    try {
      src = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      problems.push(rel + ': cron row in vercel.json has no handler file');
      continue;
    }
    const code = stripComments(src);
    if (!bearerOk(code)) {
      problems.push(rel + ': no CRON_SECRET bearer comparison found (CRON_SECRET + \'Bearer \' literal + authorization read)');
    }
    if (readsRetiredHeader(code)) {
      problems.push(rel + ': reads the retired x-vercel-cron header in code');
    }
    const admin = hasAdminPath(code);
    if (admin && !ADMIN_ALLOWED.has(rel)) {
      problems.push(rel + ': has an ADMIN_KEY manual path that is not on the sanctioned list');
    }
    if (!admin && ADMIN_ALLOWED.has(rel)) {
      problems.push(rel + ': is on the sanctioned admin list but shows no ADMIN_KEY path (list rot -- remove the allowance or restore the path)');
    }
  }
  return { problems, endpoints };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { problems, endpoints } = checkRoot(ROOT);
  if (problems.length) {
    console.log('CRON AUTH DRIFT (' + problems.length + '):');
    for (const p of problems) console.log('  - ' + p);
    process.exit(1);
  }
  const admins = endpoints.filter((e) => ADMIN_ALLOWED.has(e)).length;
  console.log('cron auth OK: ' + endpoints.length + ' enumerated endpoints, all CRON_SECRET bearer-only'
    + (admins ? ' (+' + admins + ' sanctioned ADMIN_KEY manual paths)' : '') + '.');
}
