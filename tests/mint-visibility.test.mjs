// Mint status is shown only for the wallet the Founder Mint pays. These tests
// pin that rule and the address it is keyed to.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { FOUNDER_MINT_DESTINATION, seesMintStatus } from '../lib/mintVisibility.js';

test('mint status is visible for the Founder Mint destination wallet', () => {
  assert.equal(seesMintStatus(FOUNDER_MINT_DESTINATION), true);
  assert.equal(seesMintStatus(` ${FOUNDER_MINT_DESTINATION.toLowerCase()} `), true);
});

test('mint status is hidden for every other wallet', () => {
  // A real mainnet-style account that does not receive the mint.
  assert.equal(seesMintStatus('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H'), false);
  assert.equal(seesMintStatus(''), false);
  assert.equal(seesMintStatus(undefined), false);
  assert.equal(seesMintStatus(null), false);
  // A prefix or a one-character change must not pass.
  assert.equal(seesMintStatus(FOUNDER_MINT_DESTINATION.slice(0, -1)), false);
  assert.equal(seesMintStatus(`${FOUNDER_MINT_DESTINATION}G`), false);
});

test('the address matches the protocol constant it mirrors', () => {
  // The protocol source is a sibling checkout, absent in a web-only CI run, so
  // this guard runs where it can and stays quiet where it cannot.
  const core = path.resolve(process.cwd(), '..', 'nsat-core', 'src', 'ledger', 'NSATFounderMint.cpp');
  if (!existsSync(core)) return;
  const source = readFileSync(core, 'utf8');
  const compiled = source.match(/std::string\("(G[A-Z2-7]{55})"\)/);
  assert.ok(compiled, 'could not read the destination from NSATFounderMint.cpp');
  assert.equal(FOUNDER_MINT_DESTINATION, compiled[1]);
});
