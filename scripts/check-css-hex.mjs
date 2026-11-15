#!/usr/bin/env node
// Hex ratchet: colour literals belong in a token block, not in a component rule.
//
// Two shipped defects came from this pattern — a panel title pinned to
// `#dbe2f2` became invisible in light mode, and a status colour written inline
// ignored the theme entirely. A blanket ban cannot be applied today (the live
// console carries a deliberate data-viz palette), so this ratchet freezes the
// current count per file: any new hex outside a token declaration fails, and
// every fix lowers the ceiling.
//
//   node scripts/check-css-hex.mjs            # verify
//   node scripts/check-css-hex.mjs --update    # record today's counts
//
// Allow-listed by rule: a hex on a line that declares a custom property
// (`--name: #fff;`), because that is the token block itself.

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'css-hex-baseline.json');
const SCAN_DIRS = ['app', 'components'];
const HEX = /#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi;

const update = process.argv.includes('--update');

function walk(directory) {
  const out = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.css')) out.push(full);
  }
  return out;
}

function scan() {
  const problems = new Map();
  for (const directory of SCAN_DIRS) {
    const absolute = join(ROOT, directory);
    if (!existsSync(absolute)) continue;
    for (const file of walk(absolute)) {
      const relativePath = relative(ROOT, file).split('\\').join('/');
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        // Comment lines are documentation, not styling.
        if (/^\s*(\/\*|\*)/.test(line)) return;
        if ((line.match(HEX) || []).length === 0) return;
        if (/^\s*--[a-z0-9-]+\s*:/i.test(line)) return; // token definition
        const list = problems.get(relativePath) || [];
        list.push({ line: index + 1, text: line.trim() });
        problems.set(relativePath, list);
      });
    }
  }
  return problems;
}

const problems = scan();
const counts = Object.fromEntries([...problems.entries()].map(([file, list]) => [file, list.length]).sort());

if (update) {
  writeFileSync(`${BASELINE_PATH}`, `${JSON.stringify({ note: 'Frozen count of colour literals outside token blocks. Lower as files migrate to tokens.', files: counts }, null, 2)}\n`);
  console.log(`baseline updated: ${Object.keys(counts).length} file(s), ${Object.values(counts).reduce((a, b) => a + b, 0)} literal(s)`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error('scripts/css-hex-baseline.json is missing — run: node scripts/check-css-hex.mjs --update');
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files || {};
const failures = [];

for (const [file, list] of [...problems.entries()].sort()) {
  const allowed = baseline[file] ?? 0;
  if (list.length <= allowed) continue;
  const added = list.slice(allowed);
  failures.push(
    `${file}: ${list.length} colour literal(s) outside a token block, baseline allows ${allowed}`,
    ...added.map((entry) => `    line ${entry.line}: ${entry.text}`),
  );
}

if (failures.length > 0) {
  console.error('New hardcoded colours outside a token block:\n');
  for (const line of failures) console.error(line);
  console.error(
    '\nUse a token (var(--fg), var(--muted), var(--link), var(--ok), …) or, if the value is a real\n' +
      'palette entry, declare it as a custom property in the theme block. Data-viz colours that must\n' +
      'not follow the theme belong in the baseline: node scripts/check-css-hex.mjs --update',
  );
  process.exit(1);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`css hex ratchet OK: ${total} literal(s) in ${Object.keys(counts).length} file(s), none new`);
for (const [file, count] of Object.entries(counts)) {
  const allowed = baseline[file] ?? 0;
  if (count < allowed) console.log(`note: ${file} is down to ${count} (baseline ${allowed}) — run --update to lower the ceiling`);
}
