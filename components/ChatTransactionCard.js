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

// A transfer in the conversation reads as one bubble: the amount first, then
// its verdict. The hash, ledger and parties are evidence, not conversation, so
// they stay behind a Details disclosure instead of filling the bubble.
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
  const amount = verified ? state.amount : card.amount;
  const from = verified ? state.from : card.from;
  const to = verified ? state.to : card.to;
  const time = verified && state.closeTime
    ? new Date(state.closeTime * 1000).toLocaleString()
    : '';

  return (
    <div className="nw-chat-text nw-chat-tx-card">
      <div className="nw-chat-tx-top">
        <span className="nw-chat-tx-mark" aria-hidden>◎</span>
        <span className="nw-chat-tx-amount">{groupDigits(amount)} NSAT</span>
      </div>
      <div className="nw-chat-tx-status">{cardLabel(state.status)}</div>
      {state.status === 'failed' ? (
        <div className="nw-small nw-dim">Included in the ledger but failed on-chain — only the fee moved.</div>
      ) : null}
      {state.status === 'pending' ? (
        <div className="nw-small nw-dim">Waiting for the exact hash to close in a ledger.</div>
      ) : null}
      <details className="nw-chat-tx-more">
        <summary>Details</summary>
        <div className="nw-small nw-dim">From {shortAddress(from)} · to {shortAddress(to)}</div>
        {verified ? (
          <div className="nw-small nw-dim">
            {state.status === 'finalized' ? 'Ledger' : 'Failed in ledger'} {state.ledger}
            {state.resultCode ? ` · ${state.resultCode}` : ''}
          </div>
        ) : null}
        {verified && state.network ? (
          <div className="nw-small nw-dim">Network: {state.network}</div>
        ) : null}
        {time ? <div className="nw-small nw-dim">{time}</div> : null}
        <div className="nw-small nw-mono" style={{ wordBreak: 'break-all', marginTop: 4 }}>
          Hash: {card.hash}
        </div>
      </details>
      <div className="nw-btn-row" style={{ marginTop: 6 }}>
        <button type="button" className="nw-chip-btn" onClick={() => setAttempt((value) => value + 1)}>
          {state.status === 'checking' ? 'Check again' : state.status === 'pending' ? 'Check status' : 'Recheck'}
        </button>
        {href ? <a className="nw-chip-btn" href={href}>View transaction</a> : null}
      </div>
    </div>
  );
}
