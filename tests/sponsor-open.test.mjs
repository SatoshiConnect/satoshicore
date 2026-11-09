import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeG, encodeSeed, ed25519Keypair } from '../lib/nsatCodec.js';

const TOOL = fileURLToPath(new URL('../services/sponsor/sponsor-open.mjs', import.meta.url));
const NETWORK = 'NSAT Mainnet ; October 2026 ; bc3098829fffc717';
const sponsorSeed = new Uint8Array(32).fill(1);
const sponsorG = encodeG(ed25519Keypair(sponsorSeed).pub32);
const sponsoredG = encodeG(ed25519Keypair(new Uint8Array(32).fill(2)).pub32);

function startMockCore() {
  let submits = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/info') {
      res.end(JSON.stringify({
        info: {
          network: NETWORK,
          protocol_version: 30,
          ledger: { baseReserve: 100000000, baseFee: 10 },
        },
      }));
      return;
    }
    if (req.url.startsWith('/account?acc=')) {
      const account = new URL(req.url, 'http://127.0.0.1').searchParams.get('acc');
      if (account === sponsorG) {
        res.end(JSON.stringify({ status: 'ok', seqnum: 7 }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ status: 'missing' }));
      }
      return;
    }
    if (req.url.startsWith('/tx?')) submits += 1;
    res.statusCode = 404;
    res.end('{}');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
      get submits() { return submits; },
    }));
  });
}

function runTool(env, account = sponsoredG) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TOOL, '--account', account], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function testEnv(coreUrl, ledgerFile) {
  return {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    NSAT_CORE_HTTP_URL: coreUrl,
    NSAT_EXPECT_NETWORK: NETWORK,
    NSAT_SPONSOR_DAILY_BUDGET_STROOPS: '200000000',
    NSAT_SPONSOR_MAX_PER_DAY: '1',
    ...(ledgerFile ? { NSAT_SPONSOR_LEDGER_FILE: ledgerFile } : {}),
    NSAT_SPONSOR_SEED_FILE: path.join(path.dirname(ledgerFile || os.tmpdir()), 'test-seed-file-must-not-be-read'),
  };
}

function parseFailure(result) {
  assert.notEqual(result.code, 0, result.stdout);
  return JSON.parse(result.stderr.trim());
}

test('sponsor tool requires a ledger before contacting the core', async () => {
  const result = await runTool(testEnv('http://127.0.0.1:1', null));
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.stderr.trim()).error, /NSAT_SPONSOR_LEDGER_FILE/);
});

test('sponsor ledger rejects malformed records instead of undercounting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsat-sponsor-invalid-'));
  const core = await startMockCore();
  const ledger = path.join(dir, 'ledger.jsonl');
  try {
    fs.writeFileSync(ledger, '{invalid json}\n', { mode: 0o600 });
    const result = await runTool(testEnv(core.url, ledger));
    assert.equal(result.code, 5);
    assert.match(JSON.parse(result.stderr.trim()).error, /invalid JSON/);
    assert.equal(core.submits, 0);
  } finally {
    core.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sponsor budget reservation serializes concurrent requests and never submits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsat-sponsor-race-'));
  const core = await startMockCore();
  const ledger = path.join(dir, 'ledger.jsonl');
  const seedFile = path.join(dir, 'sponsor.seed');
  const env = {
    ...testEnv(core.url, ledger),
    NSAT_SPONSOR_SEED_FILE: seedFile,
  };
  try {
    fs.writeFileSync(seedFile, `${encodeSeed(sponsorSeed)}\n`, { mode: 0o600 });
    fs.chmodSync(seedFile, 0o600);

    const results = await Promise.all([runTool(env), runTool(env)]);
    assert.equal(results.filter((result) => result.code === 0).length, 1,
      results.map((result) => result.stderr).join('\n'));
    assert.equal(results.filter((result) => result.code !== 0).length, 1);

    const entries = fs.readFileSync(ledger, 'utf8').trim().split('\n');
    assert.equal(entries.length, 1);
    const entry = JSON.parse(entries[0]);
    assert.equal(entry.reserve_stroops, '200000000');
    assert.equal(fs.statSync(ledger).mode & 0o077, 0);
    assert.equal(core.submits, 0);

    const overBudget = await runTool(env);
    assert.equal(parseFailure(overBudget).error.includes('daily request cap reached'), true);
    assert.equal(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 1);
  } finally {
    core.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
