'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  formatExactBalance,
  getAccount,
  getAccountHistory,
  getIndexerHealth,
  getTxDetail,
  isGatewayConfigured,
  isIndexerConfigured
} from '../lib/nsatClient';

// NSAT account IDs are 56-character public keys starting with G; transaction
// hashes are 64 hex characters. Anything else is rejected before a request, so
// a typo never turns into a misleading "not found".
const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
const HASH_RE = /^[0-9a-f]{64}$/i;

function timeAgo(unixSeconds) {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '—';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function short(value, head = 8, tail = 6) {
  const text = String(value ?? '');
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

export default function ExplorerPanel() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState({ phase: 'idle' });
  const [coverage, setCoverage] = useState(null);

  const explorerReady = isIndexerConfigured();
  const walletReady = isGatewayConfigured();

  useEffect(() => {
    if (!explorerReady) return;
    let cancelled = false;
    getIndexerHealth()
      .then((health) => {
        if (!cancelled) setCoverage(health);
      })
      .catch(() => {
        if (!cancelled) setCoverage({ unavailable: true });
      });
    return () => {
      cancelled = true;
    };
  }, [explorerReady]);

  const load = useCallback(
    async (target) => {
      setResult({ phase: 'loading', target });
      try {
        if (target.kind === 'account') {
          // The live balance comes from the node through the wallet gateway;
          // history comes from the indexer. Either can be down independently,
          // so a missing balance never hides an indexed history.
          const [account, history] = await Promise.all([
            walletReady ? getAccount(target.value).catch(() => null) : Promise.resolve(null),
            getAccountHistory(target.value)
          ]);
          setResult({ phase: 'account', target, account, history });
        } else {
          const tx = await getTxDetail(target.value);
          setResult({ phase: 'tx', target, tx });
        }
      } catch (error) {
        setResult({
          phase: 'error',
          message:
            error.status === 404
              // A missing hash is almost always "sent moments ago": the node
              // publishes history per 64-ledger checkpoint (~5-6 minutes) and the
              // indexer reads only that archive, so it cannot know the tx yet.
              ? 'Not in the index yet. History is published every 64 ledgers — about 5–6 minutes after a ledger closes — so a transaction sent just now appears within that window. Retry in a few minutes; if it is older than that, check the hash.'
              : error.message
        });
      }
    },
    [walletReady]
  );

  function submit(event) {
    event.preventDefault();
    const value = query.trim();
    if (ACCOUNT_RE.test(value)) {
      load({ kind: 'account', value });
      return;
    }
    if (HASH_RE.test(value)) {
      load({ kind: 'tx', value });
      return;
    }
    setResult({
      phase: 'error',
      message: 'Enter an NSAT account ID (56 characters, starts with G) or a transaction hash (64 hex characters).'
    });
  }

  // The node answers { balance, id, seqnum, status }; newer builds also carry
  // balance128. Both are exact decimal strings, never floats — take whichever
  // the node sent so a funded account never reads as "unavailable".
  const balance = result.account?.balance128 ?? result.account?.balance ?? null;

  return (
    <div>
      <form className="explorer-form" onSubmit={submit}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Account ID or transaction hash"
          aria-label="Account ID or transaction hash"
          spellCheck={false}
        />
        <button type="submit" className="button">
          Search
        </button>
      </form>

      {!explorerReady && (
        <div className="offline-banner">
          The indexer is not configured in this build (NEXT_PUBLIC_INDEXER_URL),
          so search is unavailable.
        </div>
      )}

      {coverage && (
        <p className="explorer-coverage">
          {coverage.unavailable
            ? 'Indexer is not responding.'
            : `Indexer: ledger ${coverage.indexed_head ?? '—'} · ${Number(
                coverage.txs ?? 0
              ).toLocaleString()} txs · ${Number(
                coverage.accounts ?? 0
              ).toLocaleString()} accounts`}
        </p>
      )}

      {result.phase === 'error' && <p className="net-bad">{result.message}</p>}
      {result.phase === 'loading' && <p className="muted">Searching…</p>}

      {result.phase === 'account' && (
        <div className="card">
          <h3>Account</h3>
          <p className="mono explorer-full">{result.target.value}</p>
          <ul className="status-list">
            <li>
              <strong>Balance:</strong>{' '}
              {balance
                ? `${formatExactBalance(balance)} NSAT`
                : 'live balance unavailable (node not reachable) — history below is from the indexer'}
            </li>
            {result.account && (
              <li>
                <strong>Sequence:</strong> {result.account.seqnum ?? '—'}
              </li>
            )}
            <li>
              <strong>Indexed head:</strong> {result.history?.indexed_head ?? '—'}
            </li>
          </ul>

          <h3>Transactions</h3>
          {!result.history?.items?.length ? (
            <p className="muted">No indexed transactions for this account.</p>
          ) : (
            <table className="tx-table">
              <thead>
                <tr>
                  <th>Hash</th>
                  <th>Ledger</th>
                  <th>Direction</th>
                  <th>Counterparty</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {result.history.items.map((item) => (
                  <tr key={item.hash}>
                    <td className="mono">{short(item.hash)}</td>
                    <td>{item.ledger}</td>
                    <td>{item.direction}</td>
                    <td className="mono">{short(item.counterparty)}</td>
                    <td>{item.amount} NSAT</td>
                    <td className={item.success ? 'net-ok' : 'net-bad'}>
                      {item.success ? 'success' : item.result_code || 'failed'}
                    </td>
                    <td>{timeAgo(item.close_time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {result.phase === 'tx' && (
        <div className="card">
          <h3>Transaction</h3>
          <p className="mono explorer-full">{result.target.value}</p>
          <ul className="status-list">
            <li>
              <strong>Ledger:</strong> {result.tx.ledger ?? '—'}
            </li>
            <li>
              <strong>Source:</strong> <span className="mono">{result.tx.source ?? '—'}</span>
            </li>
            <li>
              <strong>Fee:</strong> {result.tx.fee ?? '—'} NSAT
            </li>
            <li>
              <strong>Status:</strong>{' '}
              <span className={result.tx.success ? 'net-ok' : 'net-bad'}>
                {result.tx.success ? 'success' : result.tx.result_code || 'failed'}
              </span>
            </li>
            <li>
              <strong>Closed:</strong> {timeAgo(result.tx.close_time)}
            </li>
            {result.tx.memo ? (
              <li>
                <strong>Memo:</strong> {result.tx.memo_type} · {result.tx.memo}
              </li>
            ) : null}
          </ul>

          {result.tx.ops?.length ? (
            <table className="tx-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Kind</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {result.tx.ops.map((op) => (
                  <tr key={op.idx}>
                    <td>{op.idx}</td>
                    <td>{op.kind}</td>
                    <td className="mono">{short(op.source)}</td>
                    <td className="mono">{short(op.destination)}</td>
                    <td className="mono">{op.amount_stroops ?? '—'} NSAT</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No operations indexed for this transaction.</p>
          )}
        </div>
      )}
    </div>
  );
}
