// Integration example — SDK against an ALREADY-RUNNING gateway (read-only).
//
//   NEXT_PUBLIC_API_GATEWAY_URL=http://127.0.0.1:8787 \
//     node --input-type=module -e "$(cat examples/sdk-ping.mjs)"
//
// Every call below is a read-only /api/v1 GET. No keys, no writes, no envelopes.
'use strict';

const GATEWAY_URL = process.env.NEXT_PUBLIC_API_GATEWAY_URL || 'http://127.0.0.1:8787';
const TREASURY = 'GDAILW75CM6I6OJHOM242PSB2NOHNBONZKOQCBTVSMHJTMYHU77LQB55';

process.env.NEXT_PUBLIC_API_GATEWAY_URL = GATEWAY_URL;
process.env.NEXT_PUBLIC_NSAT_NETWORK_NAME = 'NSAT Mainnet ; October 2026';

const sdk = await import(new URL('../../../lib/nsatClient.js', import.meta.url).href);

const identity = await sdk.verifyNetworkIdentity();
if (!identity.ok) {
  console.error('NETWORK MISMATCH — refusing further calls:', identity.reason, `(got "${identity.network}")`);
  process.exit(2);
}
const info = await sdk.getChainInfo();
const ledger = info.info.ledger;
const fee = await sdk.estimateFee();
const treasury = await sdk.getAccount(TREASURY);

console.log(JSON.stringify({
  network: identity.network,
  gateway: 'ok',
  ledger: { num: ledger.num, hash: ledger.hash, version: ledger.version },
  baseFee_stroops: fee,
  treasury: { account: TREASURY, balance128: sdk.formatExactBalance(treasury.balance128), seqnum: treasury.seqnum }
}, null, 2));
