// The explorer's account lookup has two ways to be wrong, and both were visible
// on the deployed site: the gateway answers 200 with `{ status: 'not_found' }`
// for an account that was never funded, which the page reported as "node not
// reachable", and an exact balance of "0" was treated as an absent balance.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same-origin mode must be set before the module is imported: it is read once at
// module load to decide where the gateway and indexer live.
process.env.NEXT_PUBLIC_API_SAME_ORIGIN = '1';

const { formatExactBalance, getTxDetail, readAccountBalance } = await import('../lib/nsatClient.js');

test('an account that is not on chain is named as such, not as a dead node', () => {
  assert.deepEqual(readAccountBalance({ status: 'not_found' }), { kind: 'missing', value: null });
  // The gateway always answers 200 for this case; it is not an error state.
  assert.notEqual(readAccountBalance({ status: 'not_found' }).kind, 'unavailable');
});

test('an exact balance is read as a string, including zero', () => {
  assert.deepEqual(readAccountBalance({ status: 'ok', balance: '0' }), { kind: 'exact', value: '0' });
  assert.deepEqual(readAccountBalance({ status: 'ok', balance: '25000000' }), { kind: 'exact', value: '25000000' });
  // Newer nodes send the 128-bit form; it wins over the legacy field.
  assert.deepEqual(
    readAccountBalance({ balance: '1', balance128: '99999999' }),
    { kind: 'exact', value: '99999999' },
  );
  // Numbers are accepted only when they are whole and non-negative.
  assert.deepEqual(readAccountBalance({ balance: 10 }), { kind: 'exact', value: '10' });
  assert.equal(formatExactBalance(readAccountBalance({ balance: '0' }).value), '0');
});

test('a failed lookup stays unavailable so the UI can blame the node', () => {
  for (const account of [null, undefined, {}, { status: 'ok' }, { balance: '' }, { balance: '-5' }, { balance: 'abc' }, 'nonsense']) {
    assert.deepEqual(readAccountBalance(account), { kind: 'unavailable', value: null }, JSON.stringify(account));
  }
});

test('a transaction hash is requested lowercase, however it was typed', async () => {
  const HASH = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, status: 200, json: async () => ({ hash: HASH.toLowerCase() }) };
  };
  try {
    await getTxDetail(`  ${HASH}  `);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.ok(seen[0].endsWith(`/v1/tx/${HASH.toLowerCase()}`), seen[0]);
});
