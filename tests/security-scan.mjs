// Security scan of the static output. Fails the build if the deployed
// artifact could leak credentials, administrative API surface, or backend
// implementation details that must stay server-side.
import { walkSync } from './lib/fs.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || join(process.cwd(), 'out');

// Patterns that must never appear in publicly served static assets.
const RULES = [
  { name: 'GitHub token', re: /ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'Generic API key assignment', re: /\b(API_KEY|SECRET|PRIVATE_KEY|MNEMONIC|SEED|PASSWORD)\s*[:=]\s*['"][^'"]{8,}['"]/ },
  { name: 'Admin API route reference', re: /\/admin\/(api|v\d)/i },
  { name: 'Internal service URL', re: /https?:\/\/[a-z0-9.-]*(internal|admin|staging)\.[a-z]{2,}/i },
  { name: 'Connection string', re: /(mongodb(\+srv)?|postgres(ql)?|redis|amqp):\/\/[^\s'"]+:[^\s'"]+@/ }
];

let scanned = 0;
let failures = [];

for (const file of walkSync(OUT)) {
  if (!/\.(html|js|css|json|txt|xml|svg|map)$/.test(file)) continue;
  scanned++;
  const content = readFileSync(file, 'utf8');
  for (const rule of RULES) {
    if (rule.re.test(content)) {
      failures.push(`${rule.name} matched in ${file}`);
    }
  }
}

assert.ok(
  failures.length === 0,
  `Security scan failed (${failures.length} finding(s)):\n` + failures.join('\n')
);
console.log(`Security scan passed: ${scanned} files, no credential/admin/internal-service findings.`);
