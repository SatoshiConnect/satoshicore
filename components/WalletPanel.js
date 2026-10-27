'use client';

import { useEffect, useState } from 'react';
import {
  isGatewayConfigured,
  verifyNetworkIdentity,
  getAccount,
  formatExactBalance,
  EXPECTED_NETWORK_NAME
} from '../lib/nsatClient';

// Client-side Web Wallet interface. Everything here runs in the browser.
//
// Security invariants (see SECURITY.md):
//  - No private keys, mnemonics or signing seeds are ever transmitted,
//    stored in localStorage by default, or included in the static build.
//  - Key material entered for experimentation stays in memory only and is
//    wiped when the component unmounts or the page is refreshed.
//  - Transaction signing happens client-side; the API Gateway only ever
//    receives already-signed transactions for relay.
//  - Network identity MUST verify before any balance or action UI is shown.
//
// Scope note (honest limitation): SHIELDED operations require native
// proof generation (Orchard/Halo2) and the local kernel — unsupported in the
// browser. Never offer shielded actions here; the Desktop Wallet is the
// supported shielded interface.
const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

export default function WalletPanel() {
  const [net, setNet] = useState(null); // network identity result
  const [addr, setAddr] = useState('');
  const [acct, setAcct] = useState(null);
  const [acctErr, setAcctErr] = useState('');

  useEffect(() => {
    if (isGatewayConfigured()) {
      verifyNetworkIdentity().then(setNet);
    }
  }, []);

  async function lookup(e) {
    e.preventDefault();
    setAcct(null);
    setAcctErr('');
    if (!ACCOUNT_RE.test(addr)) {
      setAcctErr('Enter a valid public account id (56-character G… strkey).');
      return;
    }
    try {
      const a = await getAccount(addr);
      if (a.status === 'not_found') setAcctErr('Account not on this ledger (no entry yet).');
      else setAcct(a);
    } catch (err) {
      setAcctErr(err.busy ? 'Core ledger busy — try again in a moment.' : (err.message || 'lookup failed'));
    }
  }

  return (
    <section className="wallet-panel" aria-label="Web Wallet">
      <h2>Web Wallet</h2>

      {!isGatewayConfigured() && (
        <p className="wallet-warning">
          Offline mode: no API Gateway configured (set `NEXT_PUBLIC_API_GATEWAY_URL`
          at build time). Nothing here contacts the network.
        </p>
      )}

      {net && (
        <p className={net.ok ? 'net-ok' : 'net-bad'} data-testid="network-identity">
          {net.ok ? '✓ Network verified:' : '⚠ NETWORK MISMATCH —'}{' '}
          <strong>{net.network || 'unreachable'}</strong>{' '}
          {net.ledger != null && <span>(ledger {net.ledger})</span>}
          {!net.ok && net.reason && <em> — {net.reason}</em>}
          {net.ok && <span className="net-expected"> (expected: {EXPECTED_NETWORK_NAME})</span>}
        </p>
      )}

      <p className="wallet-warning">
        Read-only balance mode. Never paste private keys or seeds here.
        Wallet keys stay with you — the gateway holds none.
      </p>

      <form onSubmit={lookup} className="wallet-form">
        <label htmlFor="addr">Public account id (G…)</label>
        <input
          id="addr"
          type="text"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="G…"
        />
        <button type="submit" disabled={!net || !net.ok}>
          Check exact balance
        </button>
      </form>

      {acctErr && <p className="wallet-warning">{acctErr}</p>}
      {acct && (
        <ul className="wallet-body">
          <li>
            Account: <code>{acct.id}</code>
          </li>
          <li>
            Exact balance (balance128):{' '}
            <strong data-testid="exact-balance">
              {formatExactBalance(acct.balance128)} NSAT
            </strong>
          </li>
          <li>Sequence number: {acct.seqnum}</li>
        </ul>
      )}

      <div className="wallet-limitations">
        <h3>Shielded transactions — see the Desktop Wallet</h3>
        <p>
          Shielded NSAT (Orchard notes, local proof generation) requires the
          native kernel and is not offered in the browser: a web page cannot
          safely hold spending keys or produce halo2 proofs today. The Desktop
          Wallet is the supported shielded interface — proof generation and
          signing stay on your machine and spending keys never reach the
          gateway, or any server.
        </p>
      </div>
    </section>
  );
}
