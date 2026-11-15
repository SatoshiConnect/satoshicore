'use client';

import { useEffect, useState } from 'react';
import { getChainInfo, isGatewayConfigured } from '../lib/nsatClient';

// Live chain status card. Reads nsat-core state through the Web Wallet API
// Gateway; falls back to the offline/experimental notice when the gateway is
// not configured or unreachable.
export default function ChainStatus() {
  const [state, setState] = useState({ phase: 'loading' });

  useEffect(() => {
    if (!isGatewayConfigured()) {
      setState({ phase: 'offline' });
      return;
    }
    let cancelled = false;
    getChainInfo()
      .then((info) => {
        if (!cancelled) setState({ phase: 'online', info });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: 'offline' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === 'online') {
    const ledger = state.info?.info?.ledger || {};
    return (
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Live chain status</h2>
          <span className="panel-meta">via API Gateway</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            <li>
              <strong>Ledger:</strong> {ledger.num ?? 'unknown'} ({ledger.age ?? '?'}s old)
            </li>
            <li>
              <strong>Network:</strong> {state.info?.info?.network || 'SatoshiCore'}
            </li>
          </ul>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Live chain status</h2>
        <span className="panel-meta">via API Gateway</span>
      </div>
      <div className="panel-body">
        <div className="offline-banner" role="status">
          {state.phase === 'loading'
            ? 'Checking API Gateway…'
            : 'Offline mode: the Web Wallet API Gateway is not configured or unreachable. Chain status will appear here automatically once it is connected.'}
        </div>
      </div>
    </section>
  );
}
