'use client';

import { useEffect, useState } from 'react';

import { verifyTransactionCard } from '../lib/chatTransaction';
const explorerHrefFor = (hash) => /^[0-9a-f]{64}$/.test(String(hash || '').toLowerCase())
  ? `/explorer/?q=${String(hash).toLowerCase()}` : '';

const shortAddress = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-6)}` : 'unknown');
const groupDigits = (value) => String(value || '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function cardLabel(status) {
  if (status === 'finalized') return 'Verified · Finalized';
  if (status === 'failed') return 'Verified · Failed';
  if (status === 'pending') return 'Pending · not final yet';
  if (status === 'checking') return 'Checking exact transaction…';
  return 'Unverified · status unknown';
}

export default function ChatTransactionCard({ card, sentAt }) {
  const [state, setState] = useState({ status: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const submittedAt = Number.isSafeInteger(sentAt) && sentAt > 0
    ? Math.floor(sentAt / 1000) : null;

  useEffect(() => {
    let alive = true;
    setState({ status: 'checking' });
    verifyTransactionCard(card, { submittedAt }).then((result) => {
      if (alive) setState(result);
    }).catch(() => {
      if (alive) setState({ status: 'unknown', reason: 'verification_failed' });
    });
    return () => { alive = false; };
  }, [card.hash, card.amount, card.from, card.to, submittedAt, attempt]);

  const verified = state.status === 'finalized' || state.status === 'failed';
  const href = explorerHrefFor(card.hash);
  const time = verified && state.closeTime
    ? new Date(state.closeTime * 1000).toLocaleString()
    : '';

  return (
    <div className="nw-chat-text nw-chat-tx-card">
      <strong>{cardLabel(state.status)}</strong>
      {verified ? (
        <>
          <div style={{ marginTop: 5 }}>{groupDigits(state.amount)} NSAT</div>
          <div className="nw-small nw-dim">
            From {shortAddress(state.from)} · to {shortAddress(state.to)}
          </div>
          <div className="nw-small nw-dim">
            {state.status === 'finalized' ? 'Ledger' : 'Failed in ledger'} {state.ledger}
            {state.resultCode ? ` · ${state.resultCode}` : ''}
          </div>
          <div className="nw-small nw-dim">Network: {state.network || 'verified NSAT network'}</div>
          {time ? <div className="nw-small nw-dim">{time}</div> : null}
        </>
      ) : (
        <>
          <div className="nw-small nw-dim" style={{ marginTop: 5 }}>
            {state.status === 'pending'
            ? `Claimed amount: ${groupDigits(card.amount)} NSAT · waiting for the exact hash to close.`
            : `Claimed amount: ${groupDigits(card.amount)} NSAT · details have not been verified.`}
          </div>
          <div className="nw-small nw-dim">From {shortAddress(card.from)} · to {shortAddress(card.to)}</div>
        </>
      )}
      <div className="nw-small nw-mono" style={{ wordBreak: 'break-all', marginTop: 5 }}>
        Hash: {card.hash}
      </div>
      <div className="nw-btn-row" style={{ marginTop: 6 }}>
        <button type="button" className="nw-chip-btn" onClick={() => setAttempt((value) => value + 1)}>
          {state.status === 'checking' ? 'Check again' : state.status === 'pending' ? 'Check status' : 'Recheck'}
        </button>
        {href ? <a className="nw-chip-btn" href={href}>View transaction</a> : null}
      </div>
    </div>
  );
}
