'use client';

import { useState } from 'react';
import BackendStatus from './BackendStatus';

// Client-side Web Wallet interface. Everything here runs in the browser.
//
// Security invariants (see SECURITY.md):
//  - No private keys, mnemonics or signing seeds are ever transmitted,
//    stored in localStorage by default, or included in the static build.
//  - Key material entered for experimentation stays in memory only and is
//    wiped when the component unmounts or the page is refreshed.
//  - Transaction signing happens client-side; the (future) API Gateway only
//    ever receives already-signed transactions for relay.
export default function WalletPanel() {
  const [experimentalUnlocked, setExperimentalUnlocked] = useState(false);
  const [ephemeralKey, setEphemeralKey] = useState('');
  const [notice, setNotice] = useState('');

  function handleUnlock(e) {
    e.preventDefault();
    setNotice(
      'Experimental mode: key material is held in memory for this session only and is never sent anywhere. Production signing services are not yet enabled.'
    );
    setExperimentalUnlocked(true);
  }

  return (
    <BackendStatus backendId="api-gateway">
      <section className="wallet-panel" aria-label="Web Wallet">
        <h2>Web Wallet</h2>

        {!experimentalUnlocked ? (
          <form onSubmit={handleUnlock} className="wallet-form">
            <label htmlFor="ephemeral-key">
              Experimental unlock (paste a test-only key — never use a real
              wallet key here)
            </label>
            <input
              id="ephemeral-key"
              type="password"
              value={ephemeralKey}
              onChange={(e) => setEphemeralKey(e.target.value)}
              autoComplete="off"
              placeholder="Test key — memory only, never stored"
            />
            <button type="submit">Enter experimental mode</button>
            <p className="wallet-warning">
              The production Web Wallet is gated behind owner approval and a
              completed backend API Gateway. Do not enter real keys.
            </p>
          </form>
        ) : (
          <div className="wallet-body">
            <p>{notice}</p>
            <ul>
              <li>Balance: requires Blockchain Indexer (offline)</li>
              <li>Transaction history: requires Blockchain Indexer (offline)</li>
              <li>Broadcast: requires API Gateway relay (offline)</li>
            </ul>
          </div>
        )}
      </section>
    </BackendStatus>
  );
}
