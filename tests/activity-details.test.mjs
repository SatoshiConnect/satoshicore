import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wallet = readFileSync(new URL('../components/WalletPanel.js', import.meta.url), 'utf8');

test('activity detail dialog exposes exact-hash result and native keyboard dismissal', () => {
  assert.match(wallet, /<button[^>]*onClick=\{\(\) => setSelectedTx\(h\)\}>View details<\/button>/);
  assert.match(wallet, /<dialog[\s\S]*?aria-labelledby="nw-activity-dialog-title"/);
  assert.match(wallet, /showModal\(\)/);
  assert.match(wallet, /onClose=\{\(\) => setSelectedTx\(null\)\}/);
  assert.match(wallet, /selectedTx\.txhash/);
  assert.match(wallet, /selectedTx\.ledger_hash/);
  assert.match(wallet, /selectedTx\.result_code/);
});
