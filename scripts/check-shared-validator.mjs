#!/usr/bin/env node
// Shared validator drift check (Oct 20, 2026): the day-completeness
// validator tpcpDayIsComplete must exist BYTE-IDENTICALLY in app.html
// and pretrip.html, between its BEGIN/END SHARED marker lines.
//
// Why: Claude's ruling on the TEST02 identical-days defect was
// "extract, don't reimplement." The two documents cannot share a module
// (app.html ships inside the native bundle; pretrip.html is web-served),
// so the validator is carried as identical source in both files and THIS
// check is the mechanism that keeps the copies from drifting apart the
// way this codebase's other duplicated logic has (cron auth, exact-===
// reads, POST_CSS copies). If you edit the validator, edit both copies
// to the same bytes and this check passes.
//
// SCOPE HONESTY: this check covers only the delimited validator block.
// The per-page helpers that FEED it (each page's closing-time lookup)
// are deliberately page-specific and are NOT compared.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const BEGIN = 'BEGIN SHARED: tpcpDayIsComplete';
const END = 'END SHARED: tpcpDayIsComplete';

function extract(file) {
  const text = readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const b = lines.findIndex((l) => l.includes(BEGIN));
  const e = lines.findIndex((l) => l.includes(END));
  if (b === -1 || e === -1 || e <= b) return null;
  return lines.slice(b, e + 1).join('\n');
}

const problems = [];
const blocks = {};
for (const file of ['app.html', 'pretrip.html']) {
  blocks[file] = extract(file);
  if (blocks[file] === null) {
    problems.push(file + ': shared validator block not found (markers missing or out of order)');
  } else if (!blocks[file].includes('function tpcpDayIsComplete(day, closeMinutes)')) {
    problems.push(file + ': shared block does not contain the tpcpDayIsComplete definition');
  }
}

if (!problems.length && blocks['app.html'] !== blocks['pretrip.html']) {
  problems.push('app.html and pretrip.html carry DIFFERENT tpcpDayIsComplete source -- the shared validator has drifted; make the two blocks byte-identical');
}

if (problems.length) {
  console.error('SHARED VALIDATOR CHECK FAILED (' + problems.length + '):');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('shared validator ok: tpcpDayIsComplete is byte-identical in app.html and pretrip.html (' + blocks['app.html'].split('\n').length + ' lines)');
