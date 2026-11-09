#!/usr/bin/env node
// NSAT sponsor-side tool: prepare one sponsored account opening.
//
// This is the operator half of the account-accessibility flow. It holds the
// sponsor key, enforces the spend policy, and prints a partially signed
// transaction for the new account owner to complete in their wallet:
//
//   1. the wallet creates its key locally and shows the G… address
//   2. operator:  node services/sponsor/sponsor-open.mjs --account G…
//   3. the wallet verifies the transaction shape, adds its own signature and
//      submits it (lib/nsatSponsorship.js coSignSponsoredOpen)
//
// Safety rules enforced here:
//   - the sponsor secret is read from NSAT_SPONSOR_SEED_FILE (mode 0600) and
//     is never printed, logged or written anywhere else
//   - the node's network identity must equal NSAT_EXPECT_NETWORK exactly
//   - the ledger must already be on Core protocol 30 (the sponsorship gate);
//     on protocol 29 the tool refuses to produce anything
//   - the created account starts at 0 NSAT: the sponsor pays the reserve only
//   - a daily budget and a daily request cap must both be configured and are
//     checked against a local append-only ledger before signing
//   - the tool never submits anything itself
//
// Usage:
//   node services/sponsor/sponsor-open.mjs --account G… [--out FILE] [--check]

import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { URL } from 'node:url';

import { decodeSeed, decodeG, encodeG, ed25519Keypair } from '../../lib/nsatCodec.js';
import {
  SPONSORSHIP_PROTOCOL_VERSION, reserveForNewAccount, signSponsoredOpen,
  verifySponsoredOpenTx,
} from '../../lib/nsatSponsorship.js';

const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
const CORE = (process.env.NSAT_CORE_HTTP_URL || 'http://127.0.0.1:11626').replace(/\/$/, '');
const EXPECTED_NETWORK = (process.env.NSAT_EXPECT_NETWORK || '').trim();
const DAILY_BUDGET = BigInt(process.env.NSAT_SPONSOR_DAILY_BUDGET_STROOPS || '0');
const MAX_PER_DAY = Number(process.env.NSAT_SPONSOR_MAX_PER_DAY || '0');
const LEDGER_FILE = process.env.NSAT_SPONSOR_LEDGER_FILE || '';
const SEED_FILE = process.env.NSAT_SPONSOR_SEED_FILE || '';
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(message, code = 1) {
  process.stderr.write(JSON.stringify({ ok: false, error: message }) + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const out = { account: null, out: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account') out.account = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--check') out.check = true;
    else fail(`unknown argument ${a}`, 2);
  }
  return out;
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, CORE), { timeout: 10_000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error(`${pathname}: non-JSON response`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`${pathname}: timeout`)); });
    req.on('error', reject);
    req.end();
  });
}

function readLedger() {
  if (!LEDGER_FILE) return [];
  let raw;
  try {
    raw = fs.readFileSync(LEDGER_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return raw.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function windowSpend(entries, now) {
  const recent = entries.filter((e) => now - Number(e.at || 0) < DAY_MS);
  const spent = recent.reduce((sum, e) => sum + BigInt(e.reserve_stroops || 0), 0n);
  return { count: recent.length, spent };
}

function loadSponsorSeed() {
  if (!SEED_FILE) fail('NSAT_SPONSOR_SEED_FILE is required for signing', 2);
  const st = fs.statSync(SEED_FILE);
  if ((st.mode & 0o077) !== 0) {
    fail(`sponsor key file must not be group/world readable `
      + `(mode ${(st.mode & 0o777).toString(8)})`, 2);
  }
  return new Uint8Array(decodeSeed(fs.readFileSync(SEED_FILE, 'utf8').trim()));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!ACCOUNT_RE.test(args.account || '')) fail('--account must be a 56-char G-strkey', 2);
  const sponsoredPub = decodeG(args.account);

  if (!EXPECTED_NETWORK) fail('NSAT_EXPECT_NETWORK is required (fail closed)', 2);

  const info = await getJson('/info');
  if (info.status !== 200 || !info.body || !info.body.info) fail('core /info unavailable', 3);
  const { network, protocol_version: protocolVersion, ledger } = info.body.info;
  if (network !== EXPECTED_NETWORK) {
    fail(`wrong network: expected "${EXPECTED_NETWORK}", core reports "${network}"`, 3);
  }
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion < SPONSORSHIP_PROTOCOL_VERSION) {
    fail(`sponsorship requires Core protocol ${SPONSORSHIP_PROTOCOL_VERSION}; `
      + `this ledger is on ${protocolVersion}`, 4);
  }
  const baseReserve = BigInt(ledger.baseReserve);
  const fee = BigInt(ledger.baseFee) * 3n; // three operations in this transaction
  const reserve = reserveForNewAccount(baseReserve);

  if (DAILY_BUDGET <= 0n) fail('NSAT_SPONSOR_DAILY_BUDGET_STROOPS must be set (> 0)', 2);
  if (!(MAX_PER_DAY > 0)) fail('NSAT_SPONSOR_MAX_PER_DAY must be set (> 0)', 2);

  const now = Date.now();
  const { count, spent } = windowSpend(readLedger(), now);
  if (count >= MAX_PER_DAY) fail(`daily request cap reached (${count}/${MAX_PER_DAY})`, 5);
  if (spent + reserve > DAILY_BUDGET) {
    fail(`daily reserve budget would be exceeded `
      + `(spent ${spent} + ${reserve} > ${DAILY_BUDGET} stroops)`, 5);
  }

  // Sponsoring an account that already exists pays nothing and is not what
  // this tool is for; report it instead of quietly signing.
  const existing = await getJson(`/account?acc=${encodeURIComponent(args.account)}`);
  if (existing.status === 200 && existing.body && existing.body.status === 'ok') {
    fail('account already exists on this network; nothing to sponsor', 6);
  }

  if (args.check) {
    process.stdout.write(JSON.stringify({
      ok: true, check: true, network, protocolVersion,
      reservePerAccount: reserve.toString(), fee: fee.toString(),
      usedToday: count, spentToday: spent.toString(), budget: DAILY_BUDGET.toString(),
    }) + '\n');
    return;
  }

  const sponsorSeed = loadSponsorSeed();
  const sponsorG = encodeG(ed25519Keypair(sponsorSeed).pub32);
  const sponsorAccount = await getJson(`/account?acc=${encodeURIComponent(sponsorG)}`);
  if (sponsorAccount.status !== 200 || sponsorAccount.body.status !== 'ok') {
    fail('sponsor account is not funded on this network', 7);
  }
  const seq = BigInt(sponsorAccount.body.seqnum) + 1n;

  const signed = await signSponsoredOpen({
    sponsorSeed32: sponsorSeed,
    newPub32: sponsoredPub,
    fee: Number(fee),
    seq,
    netPassphrase: network,
  });

  const selfCheck = verifySponsoredOpenTx(signed.txXdr, sponsoredPub);
  if (!selfCheck.ok) fail(`self-check failed: ${selfCheck.reason}`, 8);

  if (LEDGER_FILE) {
    const entry = {
      at: now,
      sponsored: args.account,
      sponsor: sponsorG,
      reserve_stroops: reserve.toString(),
      fee_stroops: fee.toString(),
      seq: seq.toString(),
      tx_hash: crypto.createHash('sha256')
        .update(Buffer.from(signed.txXdr, 'base64')).digest('hex'),
    };
    fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  const payload = JSON.stringify({
    ok: true,
    network,
    protocolVersion,
    sponsor: sponsorG,
    sponsored: args.account,
    reserve_stroops: reserve.toString(),
    fee_stroops: fee.toString(),
    seq: seq.toString(),
    tx_xdr: signed.txXdr,
    envelope_xdr: signed.envelopeXdr,
  }) + '\n';

  if (args.out) {
    const target = path.resolve(args.out);
    fs.writeFileSync(target, payload, { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: true, wrote: target }) + '\n');
  } else {
    process.stdout.write(payload);
  }
}

main().catch((err) => fail(err && err.message ? err.message : String(err), 9));
