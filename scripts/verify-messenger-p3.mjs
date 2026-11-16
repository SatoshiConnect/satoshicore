#!/usr/bin/env node
// Read-only acceptance check for the P3 transaction card against a running
// gateway + indexer. It NEVER signs with a funded wallet, publishes a chat key,
// stores a message or submits a transaction.
//
//   node scripts/verify-messenger-p3.mjs
//   node scripts/verify-messenger-p3.mjs --require-relay-gates
//   NSAT_GATEWAY_URL=http://127.0.0.1:8798 node scripts/verify-messenger-p3.mjs --require-relay-gates
//
// The default target is the public production gateway. `--require-relay-gates`
// additionally proves the P2 relay is the one being served: a freshly generated
// throwaway wallet signs a GET /chat/blocks request, which returns its (empty)
// list only on a relay with block support. That request reads state; it writes
// nothing. A 404 means the web build would show "Could not read the block list".
import nacl from 'tweetnacl';

const GATEWAY = (process.env.NSAT_GATEWAY_URL || 'https://gateway.satoshicore.org').replace(/\/+$/, '');
const INDEXER = (process.env.NSAT_INDEXER_URL || GATEWAY).replace(/\/+$/, '');
const NETWORK = process.env.NSAT_EXPECTED_NETWORK || 'NSAT Mainnet ; October 2026 ; bc3098829fffc717';
const REQUIRE_RELAY_GATES = process.argv.includes('--require-relay-gates');

// Public, immutable Mainnet evidence: TransferTest-A → TransferTest-B, 10,000
// NSAT, finalized in ledger 301705. Read-only; no funds move in this check.
const KNOWN = {
  hash: '6de0ea9eae8f908f6627afcdbddbe581e1fb2ff2720201389315b916f176fe4d',
  amount: '10000000000',
  from: 'GAHS2RVHB7PFWMHTRSYUI2AT5TGLPUOLQQUAYJUWUN5JH6DZE2WWHK3W',
  to: 'GBO5VKDDKVXR5CXZT4NPWLRAXFXGBWD3FHSUXK5BK6QQGGJ2GYY24RWN',
  ledger: 301705,
};

process.env.NEXT_PUBLIC_API_SAME_ORIGIN = '0';
process.env.NEXT_PUBLIC_API_GATEWAY_URL = GATEWAY;
process.env.NEXT_PUBLIC_INDEXER_URL = INDEXER;
process.env.NEXT_PUBLIC_NSAT_NETWORK_ID = NETWORK;

const {
  createTransactionCardText, parseTransactionCardText, verifyTransactionCard,
} = await import('../lib/chatTransaction.js');
const { createChatClient } = await import('../lib/chatClient.js');
const { encodeG } = await import('../lib/nsatCodec.js');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function getJson(path) {
  const response = await fetch(`${GATEWAY}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

try {
  const status = await getJson('/api/v1/network/status');
  check(
    'gateway reports the exact NSAT network identity',
    status.status === 200 && status.body.network === NETWORK,
    `HTTP ${status.status}, network=${JSON.stringify(status.body.network)}`,
  );

  const exactCard = parseTransactionCardText(createTransactionCardText(KNOWN), KNOWN.from);
  const exact = await verifyTransactionCard(exactCard);
  check(
    'a known Mainnet transfer verifies from its exact hash',
    exact.status === 'finalized'
      && exact.hash === KNOWN.hash
      && exact.amount === KNOWN.amount
      && exact.from === KNOWN.from
      && exact.to === KNOWN.to
      && exact.ledger === KNOWN.ledger,
    JSON.stringify(exact),
  );

  const wrongCard = parseTransactionCardText(
    createTransactionCardText({ ...KNOWN, amount: '10000000001' }), KNOWN.from,
  );
  const wrong = await verifyTransactionCard(wrongCard);
  check(
    'the same hash with a different amount never finalizes',
    wrong.status === 'unknown' && wrong.reason === 'transaction_mismatch',
    JSON.stringify(wrong),
  );

  if (REQUIRE_RELAY_GATES) {
    const seed = nacl.randomBytes(32);
    const keypair = nacl.sign.keyPair.fromSeed(seed);
    const address = encodeG(keypair.publicKey);
    try {
      const client = createChatClient({ origin: GATEWAY });
      const blocked = await client.blocks({ seed32: seed, address });
      check('the deployed relay serves the P2 block gate', Array.isArray(blocked), `blocked=${blocked.length}`);
    } catch (error) {
      check('the deployed relay serves the P2 block gate', false, String(error?.message || error));
    } finally {
      seed.fill(0);
      keypair.secretKey.fill(0);
    }
  }
} catch (error) {
  check('read-only verification completed', false, String(error?.message || error));
}

const failed = results.filter((result) => !result.ok);
console.log(JSON.stringify({
  gateway: GATEWAY,
  indexer: INDEXER,
  checks: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  writes: 'none (no key published, no message stored, no transaction submitted)',
}, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
