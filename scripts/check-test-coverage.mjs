#!/usr/bin/env node
// Guard the CI test inventory: every top-level tests/*.test.mjs file must be
// invoked by `npm test`, directly or through a nested `npm run <script>`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};
const expanded = new Map();
const visiting = new Set();

function expandScript(name) {
  if (expanded.has(name)) return expanded.get(name);
  if (visiting.has(name)) throw new Error(`npm script cycle detected at ${name}`);
  const source = scripts[name];
  if (!source) throw new Error(`npm test calls missing npm script: ${name}`);
  visiting.add(name);
  const result = source.replace(/\bnpm run ([\w:.-]+)\b/g, (_match, child) => {
    return `\n${expandScript(child)}\n`;
  });
  visiting.delete(name);
  expanded.set(name, result);
  return result;
}

let plan;
try {
  plan = expandScript('test');
} catch (error) {
  console.error(`test coverage guard failed: ${error.message}`);
  process.exit(1);
}

const testFiles = readdirSync(join(root, 'tests'))
  .filter((file) => file.endsWith('.test.mjs'))
  .sort();
const plannedTestPaths = [...plan.matchAll(/(?:^|[\s;&|])tests\/([^\s;&|]+)/g)].map((match) => match[1]);
function globMatcher(pattern) {
  const source = pattern.split('').map((char) => {
    if (char === '*') return '.*';
    if (char === '?') return '.';
    return /[.+^${}()|[\\]\\\\]/.test(char) ? `\\${char}` : char;
  }).join('');
  return new RegExp(`^${source}$`);
}
const plannedMatchers = plannedTestPaths.map(globMatcher);
const missing = testFiles.filter((file) =>
  !plannedMatchers.some((matches) => matches.test(file))
);

if (missing.length) {
  console.error(`npm test does not cover ${missing.length} test file(s):`);
  for (const file of missing) console.error(`  - tests/${file}`);
  console.error('Add each file to the npm test script tree or explicitly invoke a test glob.');
  process.exit(1);
}

console.log(`npm test coverage OK: all ${testFiles.length} tests/*.test.mjs files are scheduled.`);
