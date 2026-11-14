'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { EXPECTED_NETWORK_ID } from '../lib/nsatClient';
import { NSAT, groupExact } from '../lib/nsatToken';

// Live figures for the home page.
//
// Only /api/v1/network/status is used: it answers with the gateway's health,
// the core's health, the current ledger and the on-chain network identity.
// /api/v1/chain/info is deliberately NOT polled here — it forwards to the node
// and the node's /info can take tens of seconds under load, which used to make
// the page sit on "connecting" with no explanation.
const POLL_MS = 15000;

const networkShort = (identity) =>
  typeof identity === 'string' && identity.trim() ? identity.split(';')[0].trim() : null;

export default function HomeNeon() {
  const [state, setState] = useState({
    phase: 'connecting',
    ledger: null,
    network: null,
    core: null,
    gateway: null,
    latency: null,
    updatedAt: null
  });
  const alive = useRef(true);

  const poll = useCallback(async () => {
    const started = performance.now();
    try {
      const res = await fetch('/api/v1/network/status', {
        signal: AbortSignal.timeout(9000),
        headers: { Accept: 'application/json' }
      });
      const body = await res.json().catch(() => ({}));
      const latency = Math.round(performance.now() - started);
      if (!alive.current) return;
      if (!res.ok) throw new Error(body.error || `gateway ${res.status}`);
      setState({
        phase: 'live',
        ledger: Number.isSafeInteger(body.ledger) ? body.ledger : null,
        network: typeof body.network === 'string' ? body.network : null,
        core: body.core ?? null,
        gateway: body.gateway ?? null,
        latency,
        updatedAt: new Date()
      });
    } catch {
      if (!alive.current) return;
      setState((prev) => ({ ...prev, phase: prev.ledger ? 'stale' : 'offline' }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [poll]);

  const live = state.phase === 'live';
  const verified = state.network === EXPECTED_NETWORK_ID;
  // A slow node answers /v1/network/status with core:"unreachable" and no
  // network at all. That is "the node did not answer", not an identity
  // mismatch, and the page must not blur the two.
  const coreBusy = live && !state.ledger;
  const networkLabel = !live
    ? '—'
    : verified
      ? 'mainnet verified'
      : coreBusy
        ? 'node not answering'
        : 'identity mismatch';
  const ledgerValue = state.ledger ? `#${state.ledger.toLocaleString('en-US')}` : '—';
  const statusLabel =
    state.phase === 'connecting' ? 'Connecting' : live ? 'Live' : state.phase === 'stale' ? 'Stale' : 'Offline';

  return (
    <div className="np">
      <section className="np-hero">
        <div className="np-halo" aria-hidden="true" />
        <div className="np-badges">
          <span className={`np-pill ${live ? 'is-green' : 'is-amber'}`}>
            <i /> {live ? 'NSAT Mainnet running' : statusLabel}
          </span>
          <span className="np-pill">built to learn · nothing for sale</span>
          <span className="np-pill">{NSAT.decimals} decimals — the unit is the coin</span>
        </div>

        <h1>
          NSAT — a working coin
          <br />
          you can actually study
        </h1>

        <p className="np-lead">
          SatoshiCore is a chain that exists to answer one question properly: what
          does money look like when you build it from the protocol up? NSAT is its
          coin — its own genesis, its own Ed25519 accounts, its own ledger, whole
          number balances and one flat {NSAT.baseFee} NSAT fee per operation.
        </p>
        <p className="np-lead is-muted">
          It is here to be understood, not sold. Create an account, move value,
          then read the ledger and check the result yourself — every step is
          visible, and nothing in this project asks you for money.
        </p>

        <div className="np-cta">
          <Link href="/wallet" className="np-button">
            Open Web Wallet
          </Link>
          <Link href="/dashboard" className="np-button is-secondary">
            Open the dashboard
          </Link>
          <Link href="/explorer" className="np-button is-ghost">
            Search an account
          </Link>
        </div>

        <div className="np-live" aria-live="polite">
          <div className="np-tile">
            <span className="np-tile-label">Latest ledger</span>
            <b>{ledgerValue}</b>
            <span className="np-tile-sub">
              {live
                ? state.ledger
                  ? 'read from the running chain'
                  : 'the node did not answer — left empty on purpose'
                : 'waiting for the gateway'}
            </span>
          </div>
          <div className={`np-tile ${verified ? 'is-cyan' : 'is-amber'}`}>
            <span className="np-tile-label">Network</span>
            <b>{networkLabel}</b>
            <span className="np-tile-sub">checked before every signature</span>
          </div>
          <div className="np-tile is-violet">
            <span className="np-tile-label">Gateway latency</span>
            <b>{state.latency !== null ? `${state.latency} ms` : '—'}</b>
            <span className="np-tile-sub">round-trip from this browser</span>
          </div>
          <div className="np-tile is-amber">
            <span className="np-tile-label">Fee per operation</span>
            <b>{NSAT.baseFee} NSAT</b>
            <span className="np-tile-sub">one flat fee, no priority market</span>
          </div>
        </div>

        <p className="np-relay mono">
          {state.network ? networkShort(state.network) : 'NSAT Mainnet'} ·{' '}
          {state.phase === 'live'
            ? `gateway ${state.gateway} · core ${state.core} · updated ${state.updatedAt.toLocaleTimeString('en-GB')}`
            : state.phase === 'connecting'
              ? 'contacting the gateway…'
              : 'gateway did not answer — the figures above stay empty instead of guessing'}
        </p>
        {coreBusy ? (
          <p className="np-relay mono is-warn">
            The node is busy answering other requests right now, so the ledger
            height is withheld rather than cached or invented. It refreshes by
            itself once the node replies.
          </p>
        ) : null}
      </section>

      <section className="np-section">
        <h2>What the ledger guarantees</h2>
        <div className="np-grid">
          <div className="np-card">
            <h3>Fixed, never re-minted</h3>
            <p className="np-mono-line">set once at genesis</p>
            <p>
              No mint key, no inflation curve, no halving schedule to model. What
              exists is what the ledger accounts for — and every unit moving
              between accounts is visible there.
            </p>
          </div>
          <div className="np-card is-green">
            <h3>No decimals, no rounding</h3>
            <p className="np-mono-line">1 NSAT = 1 unit ({NSAT.decimals} decimals)</p>
            <p>
              Balances are integers, so the wallet shows the whole number and keeps
              128-bit precision for large accounts. There is no “0.00000001 NSAT”
              to lose in a float.
            </p>
          </div>
          <div className="np-card is-amber">
            <h3>{NSAT.baseFee} NSAT per operation</h3>
            <p className="np-mono-line">base reserve {groupExact(NSAT.baseReserve)}</p>
            <p>
              The fee is read from the ledger header, not a hard-coded guess. A
              brand-new account needs {groupExact(NSAT.createMinimum)} NSAT on its
              first deposit (2× reserve).
            </p>
          </div>
        </div>
      </section>

      <section className="np-section">
        <h2>Why it exists</h2>
        <p className="np-lead">
          This is an independent study project, paid for by the people building it.
          There is no company behind it, no presale, no token offering, no
          investment product and no promise about price. The goal of the first
          phase is simple and deliberately unglamorous: make a chain and a wallet
          that exist and work without problems — send, receive, verify, repeat.
        </p>
        <div className="np-grid">
          <div className="np-card">
            <h3>Learning first</h3>
            <p>
              Consensus, accounts, fees, reserves and signing are easier to
              understand when you can move a real balance and watch the ledger
              agree with you.
            </p>
          </div>
          <div className="np-card is-violet">
            <h3>Honest by default</h3>
            <p>
              Every number on this site is read from a running service. When a
              service is down the page says so instead of filling the gap with a
              prettier story.
            </p>
          </div>
          <div className="np-card is-cyan">
            <h3>Open to a later chapter</h3>
            <p>
              If NSAT one day turns out to be worth something, that is a decision
              to make in the open, with the groundwork finished first. Until then,
              this page makes no claims about value.
            </p>
          </div>
        </div>
      </section>

      <section className="np-section">
        <h2>One account, three wallets</h2>
        <div className="np-grid">
          <div className="np-card">
            <h3>iPhone</h3>
            <p>
              The native app with the same gem mark and the same addresses. NSAT
              accounts are not Bitcoin accounts — no shared seed, no wrapped
              balance.
            </p>
          </div>
          <div className="np-card">
            <h3>Desktop</h3>
            <p>
              The Rust wallet, and the only place shielded operations run: the
              private-transfer kernel needs a local prover, so the web build
              refuses to pretend it can shield.
            </p>
          </div>
          <div className="np-card is-green">
            <h3>Web</h3>
            <p>
              Create, import, unlock, send, receive and back up — in this tab.
              <Link href="/wallet"> Open it →</Link>
            </p>
          </div>
        </div>
      </section>

      <section className="np-section">
        <h2>How NSAT moves</h2>
        <div className="np-grid">
          <div className="np-card">
            <h3>1 · Receive</h3>
            <p>
              Share your G… address. Nothing else is needed — no memo, no tag. A
              first deposit has to be at least 2× base reserve or the chain rejects
              the CREATE.
            </p>
          </div>
          <div className="np-card">
            <h3>2 · Send</h3>
            <p>
              The wallet signs locally against the verified network identity and
              submits the signed envelope. If the gateway reports a different
              network, signing is refused outright.
            </p>
          </div>
          <div className="np-card">
            <h3>3 · Confirmed</h3>
            <p>
              A transfer is final when the ledger closes and the source account
              sequence advances. The wallet waits for that, then re-reads the
              balance to prove the exact debit.
            </p>
          </div>
        </div>
      </section>

      <section className="np-section np-run">
        <h2>Run it yourself</h2>
        <p className="np-lead">
          This page is a static export. The node, the Web Wallet API Gateway and
          the block indexer are separate services that can each run on your own
          machine — the numbers above come from them, not from a spreadsheet. If
          you are here to learn, running the whole stack locally is the point.
        </p>
        <p className="np-mono-line">{EXPECTED_NETWORK_ID}</p>
        <div className="np-cta">
          <Link href="/docs" className="np-button is-secondary">
            Read the docs
          </Link>
          <Link href="/status" className="np-button is-ghost">
            Service status
          </Link>
        </div>
      </section>
    </div>
  );
}
