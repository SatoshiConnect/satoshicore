// End-to-end transparent send regression on a disposable devnet.
//
//   NSAT_E2E=1 node tests/e2e-send.test.mjs
//
// Runs the real flow against the real code: gateway child process →
// disposable devnet core child process → ledger. Asserts:
//   1. The devnet identity is verifiably NOT the Mainnet identity
//      ("Disposable Devnet" passphrase, zero mainnet literals in env).
//   2. decodeSeed(S) → ed25519Keypair → encodeG round-trips the devnet's
//      GENESIS_ROOT_PUBLIC_KEY byte-for-byte (wallet codec ↔ node cfg).
//   3. A valid CREATE transfer is signed locally, submitted via
//      POST /api/v1/tx, marked PENDING, then finalizes with
//      EXACT conservation: treasury_after == treasury_before - amount - fee.
//   4. A wrong-network envelope is rejected (not PENDING) and mutates nothing.
//
// Skipped entirely unless NSAT_E2E=1 and the devnet could be started.
import { test } from 'node:test';
import { strict as a } from 'node:assert';
import { spawn } from 'node:child_process';
import {
  existsSync as exists, mkdtempSync as mkdtmp, readFileSync as read
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const CORE_REPO = process.env.NSAT_CORE_DIR
  || path.resolve(WEB_ROOT, '..', 'nsat-core');
const DEVNET_SCRIPT = path.join(CORE_REPO, 'scripts', 'wallet-devnet.sh');
const GATEWAY_SERVER = path.join(WEB_ROOT, 'services', 'api-gateway', 'server.js');

// Ephemeral free ports by default (a squatted fixed port — e.g. another
// leftover devnet or static preview — once made the pid-heal logic treat
// "port busy" as "our devnet already running" and silently skip startup).
async function freePort() {
  const srv = createServer();
  const port = await new Promise((res, rej) => {
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => res(srv.address().port));
  });
  await new Promise(res => srv.close(res));
  return port;
}

const CORE_PORT = Number(process.env.NSAT_E2E_CORE_PORT);
const GW_PORT = Number(process.env.NSAT_E2E_GW_PORT);

const CORE_URL = () => `http://127.0.0.1:${coreP}`;
const GW_URL = () => `http://127.0.0.1:${gwP}`;

// Hard guard: no Mainnet identity literals anywhere in this test process.
const MAINNET_IDENTITY = 'NSAT Mainnet ; October 2026 ; bc3098829fffc717';
a.ok(JSON.stringify(process.env).indexOf('bc3098829fffc717') === -1,
  'Mainnet identity fingerprint found in process env — refusing to start E2E');

const DEVNET_ENABLED = process.env.NSAT_E2E === '1';

let coreP = null;         // resolved devnet core port
let gwP = null;           // resolved gateway port
let devnetDir = null;
let gwChild = null;

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), ...opts });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Wait until url answers 200 with a JSON object whose shape is confirmed by
// `check`. A squatted port serving 404/HTML must never count as "up".
async function waitForOk(url, check, { tries = 40, stepMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const { status, body } = await fetchJson(url);
      if (status === 200 && check(body)) return true;
    } catch { /* not up yet */ }
    await sleep(stepMs);
  }
  return false;
}

const coreUp = () =>
  waitForOk(`${CORE_URL()}/info`, b => !!b?.info?.ledger);
const gwUp = () =>
  waitForOk(`${GW_URL()}/health`, b => b?.status === 'ok');

test('setup: disposable devnet + gateway', { skip: !DEVNET_ENABLED }, async () => {
  a.ok(exists(DEVNET_SCRIPT), `devnet script missing: ${DEVNET_SCRIPT}`);

  devnetDir = process.env.NSAT_E2E_DIR
    || mkdtmp(path.join(tmpdir(), 'nsat-e2e-'));

  // Resolve ports once, then keep them for the later tests.
  coreP = CORE_PORT || await freePort();
  gwP = GW_PORT || await freePort();

  // Detached, fire-and-forget: the devnet script leaves a nohup'd daemon
  // holding the stdio pipes, which makes ANY synchronous wait for the
  // script's exit hang forever. Readiness comes from HTTP polling instead.
  const dn = spawn('bash', [DEVNET_SCRIPT, 'start', devnetDir], {
    env: { ...process.env, NSAT_WALLET_DEVNET_PORT: String(coreP) },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  dn.unref();
  a.ok(await coreUp(), `devnet core did not come up at ${CORE_URL()}`);
  devnetPid = Number(read(path.join(devnetDir, 'node.pid'), 'utf8').trim());
  // first ledger closes are slow to become externally visible right after boot
  a.ok(exists(path.join(devnetDir, 'treasury.key')), 'devnet treasury key missing');
  gwChild = spawn('node', [GATEWAY_SERVER], {
    cwd: path.dirname(GATEWAY_SERVER),
    env: {
      ...process.env,
      PORT: String(gwP),
      NSAT_CORE_HTTP_URL: CORE_URL(),
      ALLOWED_ORIGINS: '*',   // disposable sandbox
      CORE_BUSY_RETRIES: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  a.ok(await gwUp(), 'gateway did not come up');
});

// File-scoped cleanup: the gateway child must outlive the SETUP test (an
// earlier version killed it in setup's own after-hook, which made every
// later test ECONNREFUSED) yet not outlive the process.
let devnetPid = null;
process.on('exit', () => {
  try { gwChild?.kill('SIGTERM'); } catch { /* already gone */ }
  if (devnetPid) {
    try { process.kill(devnetPid, 'SIGTERM'); } catch { /* already gone */ }
  }
});

test('no Mainnet literal ever advertised by the disposable core',
  { skip: !DEVNET_ENABLED }, async () => {
    const { body } = await fetchJson(`${GW_URL()}/api/v1/network/status`);
    a.ok(body);
    a.ok(body.network.includes('Disposable Devnet'),
      `disposable devnet must not carry a network that looks like Mainnet: ${body.network}`);
    a.ok(body.network !== MAINNET_IDENTITY);
  });

test('key codec round-trip: decodeSeed(S) → encodeG == devnet genesis account',
  { skip: !DEVNET_ENABLED }, async () => {
    const codec = await import(path.join(WEB_ROOT, 'lib', 'nsatCodec.js'));
    const s = read(path.join(devnetDir, 'treasury.key'), 'utf8')
      .split(/\r?\n/).find(l => l.startsWith('S='))?.slice(2);
    a.ok(s && /^S[A-Z2-7]{55}$/.test(s), 'devnet treasury seed strkey missing');
    const seed32 = codec.decodeSeed(s);
    const pub32 = codec.ed25519Keypair(seed32).pub32;
    const g = codec.encodeG(pub32);
    const cfg = read(path.join(devnetDir, 'nsat-devnet.cfg'), 'utf8');
    a.ok(cfg.includes(`GENESIS_ROOT_PUBLIC_KEY="${g}"`),
      'wallet–codec derived public key does not match devnet genesis key');
  });

test('CREATE transfer: sign → submit → PENDING → finalize → exact conservation',
  { skip: !DEVNET_ENABLED }, async () => {
    const codec = await import(path.join(WEB_ROOT, 'lib', 'nsatCodec.js'));
    const wallet = await import(path.join(WEB_ROOT, 'lib', 'nsatWallet.js'));

    const info = (await fetchJson(`${GW_URL()}/api/v1/chain/info`)).body.info.ledger;
    const baseReserve = Number(info.baseReserve);
    const baseFee = Number(info.baseFee);
    a.ok(baseReserve > 0 && baseFee > 0, 'bad info payload');

    const s = read(path.join(devnetDir, 'treasury.key'), 'utf8')
      .split(/\r?\n/).find(l => l.startsWith('S='))?.slice(2);
    const seed32 = codec.decodeSeed(s);
    const treasuryG = codec.encodeG(codec.ed25519Keypair(seed32).pub32);

    {
      const { status, body: acc } = await fetchJson(
        `${GW_URL()}/api/v1/account?acc=${encodeURIComponent(treasuryG)}`);
      a.equal(status, 200, JSON.stringify(acc));
      a.equal(acc.status, 'ok', JSON.stringify(acc));
      var treasuryBefore = BigInt(acc.balance128 ?? String(acc.balance));
      var seqBefore = Number(acc.seqnum);
    }

    // CREATE minimum: starting balance must be ≥ 2× base reserve.
    const AMOUNT = BigInt(2 * baseReserve);
    a.ok(treasuryBefore >= AMOUNT + BigInt(baseFee), 'insufficient treasury');

    // Disposable recipient.
    const destSeed = crypto.getRandomValues(new Uint8Array(32));
    const destG = codec.encodeG(codec.ed25519Keypair(destSeed).pub32);

    const readAccount = async (acc) => (await fetchJson(
      `${GW_URL()}/api/v1/account?acc=${encodeURIComponent(acc)}`)).body;

    const signed = await wallet.buildSignedTx({
      seed32,
      netPassphrase: read(path.join(devnetDir, 'passphrase.txt'), 'utf8').trim(),
      seqFetch: async () => readAccount(treasuryG),
      destG,
      amount: AMOUNT.toString(),
      fee: baseFee,
      create: true,
    });

    const submit = await fetchJson(`${GW_URL()}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelope_xdr: signed.envelopeBase64 }),
    });
    a.equal(submit.status, 200, JSON.stringify(submit.body));
    a.equal(submit.body.status, 'PENDING', JSON.stringify(submit.body));

    // Finalization: treasury seq reaches the submitted sequence number.
    const finalized = await wallet.waitSeqReached(async () => {
      const r = (await fetchJson(
        `${GW_URL()}/api/v1/account?acc=${encodeURIComponent(treasuryG)}`)).body;
      return r.status === 'ok' ? Number(r.seqnum) : seqBefore;
    }, seqBefore + 1, 90_000, 2_000);
    a.ok(finalized, 'treasury sequence never advanced');

    const tAfter = (await fetchJson(
      `${GW_URL()}/api/v1/account?acc=${encodeURIComponent(treasuryG)}`)).body;
    const dAcc = (await fetchJson(
      `${GW_URL()}/api/v1/account?acc=${encodeURIComponent(destG)}`)).body;

    const treasuryAfter = BigInt(tAfter.balance128 ?? String(tAfter.balance));
    a.equal(treasuryAfter, treasuryBefore - AMOUNT - BigInt(baseFee),
      'conservation violated: treasury debit ≠ amount + fee');
    a.equal(dAcc.status, 'ok', 'destination account missing after finalize');
    a.equal(dAcc.balance128 ?? String(dAcc.balance), AMOUNT.toString());
  });

test('wrong-network envelope is rejected and mutates nothing',
  { skip: !DEVNET_ENABLED }, async () => {
    const codec = await import(path.join(WEB_ROOT, 'lib', 'nsatCodec.js'));
    const wallet = await import(path.join(WEB_ROOT, 'lib', 'nsatWallet.js'));

    const s = read(path.join(devnetDir, 'treasury.key'), 'utf8')
      .split(/\r?\n/).find(l => l.startsWith('S='))?.slice(2);
    const seed32 = codec.decodeSeed(s);
    const treasuryG = codec.encodeG(codec.ed25519Keypair(seed32).pub32);

    const accB = (await fetchJson(
      `${GW_URL()}/api/v1/account?acc=${encodeURIComponent(treasuryG)}`)).body;
    const balanceBefore = BigInt(accB.balance128 ?? String(accB.balance));
    const seqBefore = Number(accB.seqnum);

    const destSeed = crypto.getRandomValues(new Uint8Array(32));
    const destG = codec.encodeG(codec.ed25519Keypair(destSeed).pub32);
    const readAccount = async (acc) => (await fetchJson(
      `${GW_URL()}/api/v1/account?acc=${encodeURIComponent(acc)}`)).body;
    const bad = await wallet.buildSignedTx({
      seed32,
      netPassphrase: 'SomeCounterfeitNetworkThatIsNotDevnet ; 1234',
      seqFetch: async () => readAccount(treasuryG),
      destG, amount: '1', fee: 10,
    });
    const repl = await fetchJson(`${GW_URL()}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelope_xdr: bad.envelopeBase64 }),
    });
    a.ok(repl.status >= 400 || repl.body?.status === 'ERROR',
      `counterfeit-network envelope must not be accepted as PENDING: ${JSON.stringify(repl.body)}`);

    const accA = (await fetchJson(
      `${GW_URL()}/api/v1/account?acc=${encodeURIComponent(treasuryG)}`)).body;
    a.equal(BigInt(accA.balance128 ?? String(accA.balance)), balanceBefore,
      'balance mutated by a rejected counterfeit-network transaction');
    a.equal(Number(accA.seqnum), seqBefore,
      'sequence mutated by a rejected counterfeit-network transaction');
  });
