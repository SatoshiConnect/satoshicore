#!/usr/bin/env node
// Copy the packaged extension into public/ so /download can link to it.
//
// The zips live in extension/ (committed) but Next only publishes public/, so
// /download used to print a filename that could not be clicked — and the
// obvious guess, /extension/<file>.zip, returned 404. This runs from prebuild
// and predev, so every build serves exactly the artifacts release.json
// describes. public/extension/ is generated and stays out of git.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const release = JSON.parse(readFileSync(join(root, 'extension', 'release.json'), 'utf8'));
const target = join(root, 'public', 'extension');

const files = [release.file, release.firefoxFile].filter(Boolean);
const missing = files.filter((name) => !existsSync(join(root, 'extension', name)));

if (files.length === 0 || missing.length > 0) {
  console.error(
    `extension downloads: missing packaged artifact(s): ${missing.join(', ') || '(none listed in release.json)'}\n` +
      'Run: npm run build:extension && npm run build:extension:firefox && npm run release:extension',
  );
  process.exit(1);
}

mkdirSync(target, { recursive: true });
for (const name of files) {
  const from = join(root, 'extension', name);
  copyFileSync(from, join(target, name));
  console.log(`extension download ready: /extension/${name} (${statSync(from).size} bytes)`);
}
