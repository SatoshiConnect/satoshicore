// Which wallet may see Founder Mint status.
//
// The mint is close-level accounting in the ledger header: every heartbeat
// credits exactly one protocol destination account (see
// nsat-core/src/ledger/NSATFounderMint.cpp, compiledInDestination()), and the
// balances of every other account are untouched by it. So the mint status is a
// statement about that one wallet — showing it inside Activity for a wallet that
// receives nothing from the mint tells its owner about chain-wide issuance that
// has no bearing on their balance.
//
// The destination is a public address, already compiled into the protocol
// source and visible on-chain; it is not a secret and is safe to ship in the
// client. Keep it identical to the protocol constant: if that address ever
// changes, this copy must change with it, and until it does the card simply
// stays hidden (fail-closed, never a wrong wallet).
export const FOUNDER_MINT_DESTINATION = 'GDAILW75CM6I6OJHOM242PSB2NOHNBONZKOQCBTVSMHJTMYHU77LQB55';

/** True only for the wallet the mint actually pays; false for everything else. */
export function seesMintStatus(address) {
  return String(address || '').trim().toUpperCase() === FOUNDER_MINT_DESTINATION;
}
