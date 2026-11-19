#!/usr/bin/env node
// Emit provenance for the exact static files that will be tested and deployed.
// Only allowlisted, non-secret flags/booleans are recorded; env values such as
// Firebase public config, endpoints, tokens, and keys are never serialized.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), 'out');
const commit = String(process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: process.cwd(), encoding: 'utf8',
})).trim();
if (!/^[a-f0-9]{40}$/i.test(commit)) {
  throw new Error(`Cannot write build manifest: invalid git commit "${commit}"`);
}

const workingTreeDirty = Boolean(execFileSync('git', ['status', '--porcelain'], {
  cwd: process.cwd(), encoding: 'utf8',
}).trim());
const sha256 = (path) => createHash('sha256').update(readFileSync(join(out, path))).digest('hex');
const enabled = (name) => process.env[name] === '1';
const configured = (...names) => names.every((name) => Boolean(process.env[name]?.trim()));

const manifest = {
  schemaVersion: 1,
  commit: commit.toLowerCase(),
  workingTreeDirty,
  environment: {
    nodeEnv: process.env.NODE_ENV || 'production',
    basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
    chatRelayEnabled: enabled('NEXT_PUBLIC_CHAT_RELAY'),
    apiSameOrigin: enabled('NEXT_PUBLIC_API_SAME_ORIGIN'),
    firebaseConfigured: configured(
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
      'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
      'NEXT_PUBLIC_FIREBASE_APP_ID',
    ),
    webPushConfigured: configured('NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY'),
  },
  files: {
    'index.html': sha256('index.html'),
    'sw.js': sha256('sw.js'),
  },
};

writeFileSync(join(out, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Build manifest: ${manifest.commit}${workingTreeDirty ? ' (working tree dirty)' : ''}`);
console.log(`  index.html sha256 ${manifest.files['index.html']}`);
console.log(`  sw.js       sha256 ${manifest.files['sw.js']}`);
