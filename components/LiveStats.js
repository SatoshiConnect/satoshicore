'use client';

import { useEffect, useState } from 'react';
import {
  getChainInfo, getNetworkStatus, getIndexerHealth,
  isGatewayConfigured, isIndexerConfigured, EXPECTED_NETWORK_ID,
} from '../lib/nsatClient';
import { NSAT, groupExact } from '../lib/nsatToken';

// Live NSAT numbers, straight from the node (via the gateway) and the indexer.
// Nothing here is mocked: if a service is unreachable the tile says so instead
// of showing a stale or invented value.
export default function LiveStats() {
  const [s, setS] = useState({ phase: 'loading', chain: null, index: null, net: null });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const out = { phase: 'done', chain: null, index: null, net: null };
      if (isGatewayConfigured()) {
        try { out.net = await getNetworkStatus(); } catch { /* offline */ }
        try { out.chain = await getChainInfo(); } catch { /* offline */ }
      }
      if (isIndexerConfigured()) {
        try { out.index = await getIndexerHealth(); } catch { /* offline */ }
      }
      if (!cancelled) setS(out);
    };
    void load();
    const t = window.setInterval(load, 15_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, []);

  const ledger = s.chain?.info?.ledger || null;
  const fee = ledger?.baseFee;
  const num = ledger?.num ?? s.net?.ledger ?? null;
  const indexed = s.index?.indexed_head ?? null;
  const behind = num != null && indexed != null ? Number(num) - Number(indexed) : null;
  const verified = s.net?.network === EXPECTED_NETWORK_ID;

  const tile = (label, value, hint, tone) => (
    <div className="stat" key={label}>
      <div className="stat-label">{label}</div>
      <div className={'stat-value' + (tone ? ` ${tone}` : '')}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );

  return (
    <section className="stats-block" aria-label="Live NSAT network numbers">
      <div className="stats-strip">
        {tile('Latest ledger', num == null ? '—' : groupExact(num),
          ledger?.age != null ? `closed ${ledger.age}s ago` : 'from the node')}
        {tile('Fee per operation', fee == null ? '—' : `${groupExact(fee)} NSAT`,
          'read live from the ledger header')}
        {tile('Network', verified ? 'mainnet' : s.net ? 'mismatch' : 'connecting…',
          'identity checked before every signature')}
        {tile('Indexed history',
          s.index == null ? '—' : `${groupExact(s.index.txs ?? 0)} txs`,
          s.index == null
            ? 'indexer unreachable'
            : `${groupExact(s.index.accounts ?? 0)} accounts · head ${groupExact(indexed)}`)}
      </div>

      <div className="stats-foot">
        <span className={'net-pill ' + (verified ? 'ok' : s.net ? 'bad' : 'wait')}>
          {verified ? '● mainnet verified' : s.net ? '● identity mismatch' : '● connecting…'}
        </span>
        <span className="mono muted">{s.net?.network || NSAT.network}</span>
        {behind != null && behind > 0 && (
          <span className="net-pill wait" title="The indexer is a separate read-only service and trails the node.">
            indexer {groupExact(behind)} ledgers behind
          </span>
        )}
        <span className="mono muted">
          {NSAT.decimals} decimals · one unit is one NSAT
        </span>
      </div>
    </section>
  );
}
