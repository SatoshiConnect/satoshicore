'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  isGatewayConfigured, EXPECTED_NETWORK_ID,
  verifyNetworkIdentity, getChainInfo, getAccount,
  submitSignedTransaction, estimateFee, formatExactBalance,
} from '../lib/nsatClient';
import {
  keystoreCreate, keystoreImport, keystoreUnlock, keystoreList,
  keystoreExport, keystoreRestore,
  buildSignedTx, waitSeqReached, historyLoad, historyPush,
} from '../lib/nsatWallet';
import { decodeSeed } from '../lib/nsatCodec';

// Full transactional Web Wallet rendered in the ORIGINAL DESKTOP WALLET
// DESIGN (canonical source: nsat-core desktop/satoshicore-wallet
// tauri/ui/src/{theme.css,App.tsx} — see app/wallet/wallet.css).
//
// Everything user-facing happens in the browser; the gateway only ever
// relays ALREADY-SIGNED envelopes and read-only queries. No private key
// material is ever transmitted, logged, or held server-side. Shielded
// operations are intentionally NOT offered here (native Orchard kernel
// required) — the Shielded page shows the honest gate state instead and
// points at the Desktop Wallet, exactly as the desktop build does.
//
// Session identity model: the unlocked wallet name + seed live in React
// state only. A reload clears signing power; the UI re-derives everything
// from the gateway's session-truth responses.

const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
const PAGES = ['overview', 'send', 'receive', 'shielded', 'activity', 'settings'];
const PAGE_GLYPH = {
  overview: '◈', send: '↗', receive: '↙', shielded: '◆',
  activity: '≡', settings: '⚙',
};
const PAGE_TITLE = {
  overview: 'Overview', send: 'Send NSAT', receive: 'Receive NSAT',
  shielded: 'Shielded NSAT', activity: 'Activity', settings: 'Settings',
};

export default function WalletPanel() {
  // gateway/network
  const [net, setNet] = useState(null);          // { ok, network, reason, ledger }
  const [fee, setFee] = useState(null);          // live base fee (stroops)
  // wallet session
  const [wallets, setWallets] = useState([]);
  const [active, setActive] = useState(null);    // { name, pubkey, seed32 }
  const [balance, setBalance] = useState(null);  // exact stroops string
  const [funded, setFunded] = useState(null);    // true / false / unknown
  // ui
  const [page, setPage] = useState('overview');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);      // { text, kind }
  // forms
  const [newName, setNewName] = useState('');
  const [newPass, setNewPass] = useState('');
  const [importSeed, setImportSeed] = useState('');
  const [unlockName, setUnlockName] = useState('');
  const [unlockPass, setUnlockPass] = useState('');
  const [dest, setDest] = useState('');
  const [createDest, setCreateDest] = useState(false);
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState(null);    // { amount, fee, total }
  const [history, setHistory] = useState([]);

  const notify = (text, kind = 'ok') => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 6000);
  };

  // Idle auto-lock: signing power must not outlive inattention. Any user
  // activity resets the timer; after the idle window the wallet locks via
  // the same path as the explicit lock button (setActive(null)), dropping
  // the seed from memory. Default 15 min; NEXT_PUBLIC_IDLE_LOCK_MS overrides
  // (a value ≤ 0 disables — never recommended on shared machines).
  const idleLockMs = Number(process.env.NEXT_PUBLIC_IDLE_LOCK_MS) || 15 * 60_000;
  useEffect(() => {
    if (!active || idleLockMs <= 0) return undefined;
    let lastActive = Date.now();
    const bump = () => { lastActive = Date.now(); };
    const events = ['pointerdown', 'keydown', 'mousemove', 'wheel', 'touchstart'];
    events.forEach((ev) => window.addEventListener(ev, bump, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - lastActive >= idleLockMs) {
        // same behavior as the Lock button
        setActive(null);
        setToast({ text: 'Wallet locked after inactivity — signing key cleared.', kind: 'ok' });
      }
    }, 10_000);
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, bump));
      window.clearInterval(timer);
    };
  }, [active?.name, idleLockMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const configured = isGatewayConfigured();

  const verifyNetwork = useCallback(async () => {
    if (!configured) {
      setNet({ ok: false, network: null, reason: 'gateway not configured' });
      return null;
    }
    const r = await verifyNetworkIdentity();
    setNet(r);
    if (r.ok) {
      try { setFee(await estimateFee()); } catch { setFee(null); }
    }
    return r;
  }, [configured]);

  const refreshWallets = useCallback(() => setWallets(keystoreList()), []);

  const refreshBalance = useCallback(async (pubkey) => {
    // A brand-new (unfunded) account reads as HTTP 404 from the gateway —
    // desktop parity: show exact 0 with a NOT-FUNDED badge, never "…".
    try {
      const r = await getAccount(pubkey);
      if (r.status === 'ok') {
        setBalance(r.balance128 ?? String(r.balance));
        setFunded(true);
      } else {
        setBalance('0');
        setFunded(false);
      }
    } catch (err) {
      if (err?.status === 404) { setBalance('0'); setFunded(false); }
      else { setBalance(null); setFunded(null); }
    }
  }, []);

  useEffect(() => { setWallets(keystoreList()); }, []);
  useEffect(() => { void verifyNetwork(); }, [verifyNetwork]);
  useEffect(() => {
    if (active) {
      void refreshBalance(active.pubkey);
      setHistory(historyLoad(active.name));
    } else { setBalance(null); setHistory([]); }
  }, [active, refreshBalance]);

  // ---------------- wallet actions (logic unchanged from the audited build) ----
  async function doCreate(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await keystoreCreate(newName.trim(), newPass);
      setWallets(keystoreList());
      // The freshly created seed stays in this closure's memory only —
      // the same trust level as an explicit Unlock.
      setActive({ name: r.name, pubkey: r.pubkeyG, seed32: decodeSeed(r.seedS) });
      setNewName(''); setNewPass('');
      notify(`Wallet "${r.name}" created. Export the encrypted backup NOW (Settings) and store it privately — it is the only copy.`, 'ok');
    } catch (err) { notify(String(err.message || err), 'err'); }
    setBusy(false);
  }

  async function doImport(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await keystoreImport(newName.trim(), importSeed.trim(), newPass);
      setWallets(keystoreList());
      setActive({ name: r.name, pubkey: r.pubkeyG, seed32: decodeSeed(r.seedS) });
      setNewName(''); setNewPass(''); setImportSeed('');
      notify(`Wallet "${r.name}" imported.`, 'ok');
    } catch (err) { notify(String(err.message || err), 'err'); }
    setBusy(false);
  }

  async function doUnlock(e) {
    e.preventDefault();
    if (!unlockName) return;
    setBusy(true);
    try {
      const seed32 = await keystoreUnlock(unlockName, unlockPass);
      const list = keystoreList();
      const entry = list.find(w => w.name === unlockName);
      setActive({ name: unlockName, pubkey: entry?.pubkey, seed32 });
      setUnlockName(''); setUnlockPass('');
      notify(`Wallet "${unlockName}" unlocked.`, 'ok');
    } catch (err) { notify(String(err.message || err), 'err'); }
    setBusy(false);
  }

  function doLock() {
    setActive(null);
    notify('Wallet locked — signing key cleared from memory.', 'ok');
  }

  function doBackup() {
    const blob = keystoreExport();
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'scw-web-backup.json'; a.click();
    URL.revokeObjectURL(url);
    notify('Encrypted keystore downloaded. Keep it private.', 'ok');
  }

  async function doRestore(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      keystoreRestore(await f.text());
      refreshWallets();
      notify('Wallet backup imported. Existing wallets were kept.', 'ok');
    } catch (err) { notify(`restore failed: ${err.message}`, 'err'); }
  }

  // The real send pipeline (unchanged from the audited build). Returns true
  // when the caller may close the review modal; on failure leaves the modal
  // open with the exact reason surfaced as a toast.
  async function submitSend() {
    if (!active?.seed32) { notify('Unlock the wallet first.', 'err'); return false; }
    if (!net?.ok) { notify('Network identity not verified — refusing to sign.', 'err'); return false; }
    if (net.network !== EXPECTED_NETWORK_ID) {
      notify('Network identity changed since verification — refusing to sign.', 'err');
      return false;
    }
    setBusy(true);
    try {
      const baseFee = await estimateFee();
      const info = await getChainInfo();
      const reserve = Number(info?.info?.ledger?.baseReserve || 0);
      const amtClean = amount.replace(/[,_ ]/g, '');
      if (createDest && reserve > 0 && /^\d+$/.test(amtClean)
        && BigInt(amtClean) < BigInt(2 * reserve)) {
        notify(`CREATE starting balance must be ≥ ${BigInt(2 * reserve).toLocaleString()} stroops (2× base reserve) — the chain would charge the fee and fail the operation.`, 'err');
        setBusy(false);
        return false;
      }
      let prevBalance = null;
      const signed = await buildSignedTx({
        seed32: active.seed32,
        netPassphrase: EXPECTED_NETWORK_ID,   // the VERIFIED identity, exact
        seqFetch: async () => {
          const d = await getAccount(active.pubkey);
          prevBalance = d.balance128 ?? (d.balance != null ? String(d.balance) : null);
          return d;
        },
        destG: dest.trim(),
        amount: amount.trim(),
        fee: baseFee,
        create: createDest,
      });
      const r = await submitSignedTransaction(signed.envelopeBase64);
      // Core /tx statuses (verified in nsat-core TransactionQueue.cpp):
      //   PENDING | DUPLICATE | ERROR | TRY_AGAIN_LATER | FILTERED
      if (r.status === 'ERROR') {
        notify('Node REJECTED the transaction before inclusion (invalid or insufficient). Nothing was signed again — see Activity.', 'err');
        historyPush(active.name, {
          time: new Date().toLocaleString(), dir: 'sent', to: dest.trim(),
          amount: amount.trim(), fee: 0, txhash: signed.txHashHex,
          ledger: null, ledger_hash: null, status: 'rejected',
        });
        setHistory(historyLoad(active.name));
        return true;
      }
      if (r.status !== 'PENDING') {
        const friendly = {
          DUPLICATE: 'the node already has this exact transaction (already submitted).',
          TRY_AGAIN_LATER: 'node queue is full — try again shortly; nothing was lost.',
          FILTERED: 'the node filtered this transaction (fee/size policy).',
        };
        notify(`Node responded ${r.status}: ${friendly[r.status] || JSON.stringify(r)}`,
          r.status === 'DUPLICATE' ? 'warn' : 'err');
        return true;
      }
      notify('Submitted — waiting for finalization…', 'warn');
      // Finalization: the account sequence only moves when the transaction is
      // APPLIED in a closed ledger.
      const ok = await waitSeqReached(
        async () => {
          const d = await getAccount(active.pubkey);
          return Number(d.seqnum ?? d.sequence ?? 0);
        },
        signed.seq, 90000, 2000);
      if (!ok) { notify('Not finalized within 90 s — check Activity later.', 'warn'); return true; }
      // Ledger truth: seq-advance also happens on a FAILED operation (fee
      // charged, nothing moved). CONFIRMED requires the exact debit.
      const afterD = await getAccount(active.pubkey).catch(() => null);
      const afterBal = afterD?.status === 'ok'
        ? BigInt(afterD.balance ?? afterD.balance128) : null;
      const debited = prevBalance != null && afterBal != null
        && BigInt(prevBalance) - afterBal === BigInt(amount) + BigInt(signed.fee);
      const li = await getChainInfo().catch(() => null);
      const liLedger = li?.info?.ledger ?? null;
      if (!debited) {
        historyPush(active.name, {
          time: new Date().toLocaleString(), dir: 'sent', to: dest.trim(),
          amount: amount.trim(), fee: signed.fee, txhash: signed.txHashHex,
          ledger: liLedger?.num, ledger_hash: liLedger?.hash, status: 'op_failed_on_chain',
        });
        setHistory(historyLoad(active.name));
        notify('Finalized but the operation FAILED on-chain — only the fee was charged. No funds moved.', 'err');
        return true;
      }
      historyPush(active.name, {
        time: new Date().toLocaleString(), dir: 'sent', to: dest.trim(),
        amount: amount.trim(), fee: signed.fee, txhash: signed.txHashHex,
        ledger: liLedger?.num, ledger_hash: liLedger?.hash, status: 'confirmed',
      });
      setHistory(historyLoad(active.name));
      notify(`Confirmed on ledger ${liLedger?.num ?? '(latest)'}.`, 'ok');
      setAmount(''); setDest(''); setReview(null);
      void refreshBalance(active.pubkey);
      return true;
    } catch (err) { notify(String(err.message || err), 'err'); return false; }
    finally { setBusy(false); }
  }

  function openReview() {
    const amtClean = amount.replace(/[,_ ]/g, '');
    const feeVal = fee ?? 0;
    setReview({
      amount: amtClean, fee: feeVal,
      total: (BigInt(amtClean) + BigInt(feeVal)).toString(),
    });
  }

  async function copyPublicAddress(address) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(address);
      notify('Public address copied. It is safe to share.', 'ok');
    } catch {
      notify('Could not copy automatically. Select and copy the public address manually.', 'err');
    }
  }

  const netOk = !!net?.ok;
  const amtInt = /^\d+$/.test(amount.replace(/[,_ ]/g, ''))
    && BigInt(amount.replace(/[,_ ]/g, '') || '0') > 0n;
  const destOk = ACCOUNT_RE.test(dest.trim()) && dest.trim() !== active?.pubkey;
  const sendBlocked = !active ? 'Unlock a wallet before preparing a transfer.'
    : !netOk ? 'Network identity is not verified. Sending stays disabled until it is verified.'
    : fee == null ? 'The current network fee could not be verified. Refresh the connection before sending.'
    : !destOk ? 'Enter a valid NSAT address different from your own.'
    : !amtInt ? 'Enter a positive whole-number amount in NSAT.' : null;
  const hasWallets = wallets.length > 0;

  const ledger = net?.ledger ?? null;
  const connLine = !configured ? 'offline — gateway not configured'
    : net == null ? 'connecting…'
    : netOk ? 'connected' : 'offline';

  return (
    <div className="nw-root">
      <div className="nw-shell">
        <nav className="nw-sidebar" aria-label="Primary">
          <div className="nw-brand">
            <div className="nw-brand-mark" aria-hidden>◈</div>
            <div>
              <div className="nw-brand-name">SatoshiCore</div>
              <div className="nw-brand-sub">NSAT wallet · web</div>
            </div>
          </div>
          <div className="nw-nav-group">
            {PAGES.map((p) => (
              <button key={p}
                className={'nw-nav-item' + (page === p ? ' active' : '')}
                onClick={() => setPage(p)}
                aria-current={page === p ? 'page' : undefined}>
                <span aria-hidden>{PAGE_GLYPH[p]}</span> {PAGE_TITLE[p]}
              </button>
            ))}
          </div>
          <div className="nw-nav-group">
            {!active && hasWallets && (
              <form onSubmit={doUnlock}
                style={{ display: 'grid', gap: 6, padding: '6px 2px' }}>
                <select value={unlockName} aria-label="Wallet to unlock"
                  onChange={(e) => setUnlockName(e.target.value)}>
                  <option value="">— wallet —</option>
                  {wallets.map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
                </select>
                <input type="password" placeholder="Password" value={unlockPass}
                  onChange={(e) => setUnlockPass(e.target.value)}
                  aria-label="Wallet password" />
                <button className="nw-send-btn" type="submit"
                  disabled={busy || !unlockName}>Unlock</button>
              </form>
            )}
            {active && (
              <button className="nw-nav-item" onClick={doLock}
                title="Lock the active wallet (signing stops)">🔒 Lock wallet</button>
            )}
          </div>
          <div className="nw-sidebar-footer">
            {ledger != null && <div>● ledger {Number(ledger).toLocaleString()}</div>}
            <div style={{ opacity: 0.7 }}>{connLine}</div>
          </div>
        </nav>

        <main className="nw-content">
          {!configured && (
            <p className="nw-dim nw-small" style={{ marginTop: 0 }}>
              Offline mode: set NEXT_PUBLIC_API_GATEWAY_URL at build time to
              connect to the NSAT API Gateway.
            </p>
          )}

          <div className="nw-page-title">
            <div>
              <h1>{PAGE_TITLE[page]}</h1>
              <div className="nw-dim nw-small">
                {active ? active.name : 'Locked'} · NSAT
              </div>
            </div>
            <NetworkBadge net={net} />
          </div>

          {page === 'overview' && (
            <OverviewPage active={active} wallets={wallets} balance={balance}
              bus={{ busy, doCreate, doImport, newName, setNewName, newPass, setNewPass,
                importSeed, setImportSeed }}
              net={{ net, netOk, ledger, fee }}
              onSend={() => setPage('send')} onReceive={() => setPage('receive')}
              onManage={() => setPage('settings')}
              onCopy={() => copyPublicAddress(active?.pubkey ?? '')} />
          )}

          {page === 'send' && (
            <SendPage
              state={{ dest, setDest, amount, setAmount, createDest, setCreateDest }}
              gate={{ netOk, fee, amtInt, destOk, sendBlocked }} busy={busy}
              onReview={openReview} />
          )}

          {page === 'receive' && (
            <ReceivePage activePubkey={active?.pubkey ?? ''} onCopy={copyPublicAddress} />
          )}

          {page === 'shielded' && <ShieldedGatePage />}

          {page === 'activity' && (
            <ActivityPage history={history} activeName={active?.name} />
          )}

          {page === 'settings' && (
            <SettingsPage s={{ active, doLock, doBackup, doRestore, wallets }} />
          )}
        </main>
      </div>

      {review && (
        <div className="nw-modal-back" role="dialog" aria-modal="true">
          <div className="nw-modal">
            <div className="nw-step">REVIEW & SIGN · NSAT</div>
            <h3 style={{ color: 'var(--text)' }}>Review transaction</h3>
            <div className="nw-kv"><span className="nw-k">Recipient</span>
              <span className="nw-v nw-mono nw-small">{dest.trim()}</span></div>
            <div className="nw-kv"><span className="nw-k">Amount</span>
              <span className="nw-v">{formatExactBalance(review.amount)} NSAT</span></div>
            <div className="nw-kv"><span className="nw-k">Fee (live ledger)</span>
              <span className="nw-v">{formatExactBalance(review.fee)} NSAT</span></div>
            <div className="nw-kv"><span className="nw-k">Total debit</span>
              <span className="nw-v">{formatExactBalance(review.total)} NSAT</span></div>
            {createDest && (
              <div className="nw-kv"><span className="nw-k">CREATE account</span>
                <span className="nw-v"><span className="nw-badge warn">new account funding</span></span></div>
            )}
            <div className="nw-kv"><span className="nw-k">Network</span>
              <span className="nw-v nw-mono nw-small">{net?.network ?? '—'}</span></div>
            <div className="nw-small nw-dim" style={{ marginTop: 8 }}>
              The signature is created in your browser with the VERIFIED network
              identity; the gateway receives the signed envelope only.
            </div>
            <div className="nw-btn-row">
              <button className="nw-send-btn" disabled={busy || !netOk}
                onClick={async () => {
                  const ok = await submitSend();
                  if (ok && review) {
                    // submitSend clears review itself on success paths that
                    // mutate; keep the modal only when it asked to stay.
                    setReview((cur) => (cur === review ? null : cur));
                  }
                }}>
                {busy ? 'Signing & submitting…' : 'Confirm and Send'}
              </button>
              <button className="nw-ghost-btn" onClick={() => setReview(null)}
                disabled={busy}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`nw-toast ${toast.kind}`} role="status">{toast.text}</div>
      )}
    </div>
  );
}

/* --------------------------------- Overview ------------------------------ */
function OverviewPage({ active, wallets, balance, bus, net, onSend, onReceive, onManage, onCopy }) {
  if (!active) {
    return (
      <div className="nw-grid-2">
        <section className="nw-card">
          <div className="nw-step">SATOSHICORE · NEW</div>
          <h2 style={{ color: 'var(--text)' }}>Create a New Wallet</h2>
          <p className="nw-small nw-dim">
            Keys are generated locally with a CSPRNG, encrypted at rest with
            PBKDF2 + AES-GCM, and never leave this browser.
          </p>
          <form onSubmit={bus.doCreate} className="nw-txf" style={{ marginTop: 10 }}>
            <label className="nw-label" htmlFor="nw-new-name">Wallet name</label>
            <input id="nw-new-name" value={bus.newName}
              onChange={(e) => bus.setNewName(e.target.value)}
              placeholder="Personal wallet" required />
            <label className="nw-label" htmlFor="nw-new-pass">Password (encrypts the seed, ≥ 8 chars)</label>
            <input id="nw-new-pass" type="password" value={bus.newPass}
              onChange={(e) => bus.setNewPass(e.target.value)} minLength={8} required />
            <div className="nw-small nw-dim">
              Needed every time you sign. There is no server-side recovery.
            </div>
            <div className="nw-btn-row" style={{ margin: '4px 0 0' }}>
              <button type="submit" className="nw-send-btn" disabled={bus.busy}>
                Create Wallet</button>
            </div>
          </form>
        </section>
        <section className="nw-card">
          <div className="nw-step">SATOSHICORE · IMPORT</div>
          <h2 style={{ color: 'var(--text)' }}>Import Existing Wallet</h2>
          <p className="nw-small nw-dim">
            Bring in an S… secret seed. It is encrypted immediately and never
            displayed back.
          </p>
          <form onSubmit={bus.doImport} className="nw-txf" style={{ marginTop: 10 }}>
            <label className="nw-label" htmlFor="nw-imp-name">Wallet name</label>
            <input id="nw-imp-name" value={bus.newName}
              onChange={(e) => bus.setNewName(e.target.value)} required />
            <label className="nw-label" htmlFor="nw-imp-seed">Secret seed (S…)</label>
            <input id="nw-imp-seed" type="password" spellCheck={false}
              value={bus.importSeed} onChange={(e) => bus.setImportSeed(e.target.value)} required />
            <label className="nw-label" htmlFor="nw-imp-pass">Password</label>
            <input id="nw-imp-pass" type="password" value={bus.newPass}
              onChange={(e) => bus.setNewPass(e.target.value)} minLength={8} required />
            <div className="nw-btn-row" style={{ margin: '4px 0 0' }}>
              <button type="submit" className="nw-send-btn" disabled={bus.busy}>
                Import</button>
            </div>
          </form>
        </section>
      </div>
    );
  }

  const funded = balance != null;
  const fundedBadge = funded == null ? 'unknown' : funded;
  return (
    <div>
      <section className="nw-card nw-balance-card">
        <div className="nw-balance-row">
          <div>
            <div className="nw-balance-label">Confirmed NSAT balance</div>
            <div className="nw-balance-amount">
              {balance == null ? '…' : formatExactBalance(balance)}
              <span className="nw-balance-unit">NSAT</span>
            </div>
            <div className="nw-small nw-dim">Exact on-chain amount in whole NSAT</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="nw-address-chip">
              <span>{shortAddr(active.pubkey)}</span>
              <button className="nw-chip-btn" onClick={onCopy}>Copy</button>
            </div>
          </div>
        </div>
      </section>

      <div className="nw-quick-actions">
        <button className="nw-action-card" onClick={onSend}>
          <div className="nw-action-icon"
            style={{ background: 'rgba(79,140,255,.15)', color: 'var(--blue)' }}>↗</div>
          <div><div style={{ fontWeight: 700 }}>Send</div>
            <div className="nw-small nw-dim">Pay someone in NSAT</div></div>
        </button>
        <button className="nw-action-card" onClick={onReceive}>
          <div className="nw-action-icon"
            style={{ background: 'rgba(53,213,232,.15)', color: 'var(--cyan)' }}>↙</div>
          <div><div style={{ fontWeight: 700 }}>Receive</div>
            <div className="nw-small nw-dim">Show address</div></div>
        </button>
        <button className="nw-action-card" onClick={onManage}>
          <div className="nw-action-icon"
            style={{ background: 'rgba(34,197,94,.15)', color: 'var(--ok)' }}>#</div>
          <div><div style={{ fontWeight: 700 }}>Backup</div>
            <div className="nw-small nw-dim">In Settings</div></div>
        </button>
      </div>

      <div className="nw-grid-2" style={{ marginTop: 14 }}>
        <section className="nw-card">
          <h2 style={{ color: 'var(--text)' }}>Wallet</h2>
          <div className="nw-kv" style={{ marginTop: 10 }}><span className="nw-k">Address</span>
            <span className="nw-v nw-mono">{shortAddr(active.pubkey, 14)}</span></div>
          <div className="nw-kv"><span className="nw-k">Funded on network</span>
            <span className="nw-v"><span className={'nw-badge ' + (fundedBadge === true ? 'ok' : 'warn')}>
              {fundedBadge === true ? 'Yes' : fundedBadge === false ? 'No / not funded' : 'unknown'}</span></span></div>
          <div className="nw-kv"><span className="nw-k">Latest ledger</span>
            <span className="nw-v">{net.ledger == null ? '—' : Number(net.ledger).toLocaleString()}</span></div>
        </section>
        <section className="nw-card">
          <h2 style={{ color: 'var(--text)' }}>Network</h2>
          <div className="nw-kv" style={{ marginTop: 10 }}><span className="nw-k">Status</span>
            <span className="nw-v">{net.netOk ? 'Connected' : 'Offline'}</span></div>
          <div className="nw-kv"><span className="nw-k">Network</span>
            <span className="nw-v nw-mono nw-small">{net.net?.network ?? '—'}</span></div>
          <div className="nw-kv"><span className="nw-k">Base fee (NSAT)</span>
            <span className="nw-v">{net.fee ?? '…'} <small className="nw-dim">live</small></span></div>
        </section>
      </div>
    </div>
  );
}

/* ---------------------------------- Send --------------------------------- */
function SendPage({ state, gate, busy, onReview }) {
  return (
    <section className="nw-card">
      <div className="nw-txf">
        <div className="nw-row">
          <label htmlFor="nw-dest">Recipient</label>
          <input id="nw-dest" spellCheck={false} className="nw-mono" value={state.dest}
            onChange={(e) => state.setDest(e.target.value)}
            placeholder="G… (56-char account address)" />
        </div>
        {state.dest && !ACCOUNT_RE.test(state.dest.trim()) && (
          <div className="nw-small" style={{ color: 'var(--danger)' }}>
            Address format is invalid.
          </div>
        )}
        <div className="nw-row">
          <label htmlFor="nw-amt">Amount NSAT</label>
          <input id="nw-amt" inputMode="numeric" value={state.amount}
            onChange={(e) => state.setAmount(e.target.value)}
            placeholder="exact integers — no decimals" />
        </div>
        <div className="nw-row nw-small">
          <label htmlFor="nw-create">CREATE account</label>
          <label htmlFor="nw-create" style={{ display: 'flex', gap: 6, width: 'auto', alignItems: 'center' }}>
            <input id="nw-create" type="checkbox" style={{ width: 'auto' }}
              aria-label="Destination has no account yet (CREATE)"
              checked={state.createDest}
              onChange={(e) => state.setCreateDest(e.target.checked)} />
            Destination has no account yet (CREATE — funds act as starting balance)
          </label>
        </div>
        <div className="nw-row nw-small nw-dim"><label>Fee</label>
          <span>{gate.fee == null ? 'unavailable' : `${formatExactBalance(gate.fee)} NSAT per operation (live from the verified ledger)`}</span></div>
        <div className="nw-row">
          <button className="nw-send-btn" disabled={!!gate.sendBlocked}
            aria-describedby={gate.sendBlocked ? 'nw-send-blocked' : undefined}
            onClick={onReview}>Review Transaction</button>
        </div>
      </div>
      {gate.sendBlocked && (
        <p id="nw-send-blocked" className="nw-small" role="status"
          style={{ color: 'var(--warn)', marginTop: 12 }}>
          {gate.sendBlocked}
        </p>
      )}
      {busy && <p className="nw-small nw-dim" style={{ marginTop: 8 }}>Working…</p>}
    </section>
  );
}

/* -------------------------------- Receive -------------------------------- */
function ReceivePage({ activePubkey, onCopy }) {
  return (
    <section className="nw-card" style={{ textAlign: 'center' }}>
      {!activePubkey
        ? <EmptyState text="No wallet selected" />
        : (<>
          <div className="nw-mono"
            style={{ wordBreak: 'break-all', padding: '12px 0', color: 'var(--cyan)' }}>
            {activePubkey}
          </div>
          <button className="nw-chip-btn" onClick={() => onCopy(activePubkey)}>
            Copy address
          </button>
          <p className="nw-small nw-dim" style={{ marginTop: 14 }}>
            This PUBLIC address only — never a secret key. Funding a brand-new
            account needs ≥ 2× base reserve; otherwise use the CREATE toggle in Send.
          </p>
        </>)}
    </section>
  );
}

/* -------------------------------- Shielded ------------------------------- */
// Honest parity with the Desktop wallet's gate model: the browser cannot run
// the native Orchard kernel, so Shielded operations are NOT offered here.
function ShieldedGatePage() {
  return (
    <div>
      <section className="nw-card nw-balance-card">
        <div className="nw-balance-row">
          <div>
            <div className="nw-balance-label">SHIELDED STATUS</div>
            <div className="nw-balance-amount">DESKTOP ONLY</div>
            <div className="nw-small nw-dim">
              The Web Wallet does not support Shielded transactions.
            </div>
          </div>
        </div>
      </section>
      <section className="nw-card">
        <p className="nw-small nw-dim">
          Shielded Protocol Ledger Version 1 is active on Mainnet, but this
          Web Wallet has no Shielded transaction path. It never receives or
          creates proof material. Do not use this wallet for Shielded deposits,
          private transfers, or withdrawals.
        </p>
      </section>
    </div>
  );
}

/* -------------------------------- Activity ------------------------------- */
function ActivityPage({ history, activeName }) {
  return (
    <section className="nw-card">
      <h2 style={{ color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {activeName ? `History — ${activeName}` : 'History'}
        <span className="nw-badge info">locally verified · not a chain indexer</span>
      </h2>
      {history.length === 0 ? (
        <EmptyState
          text={'No verified transactions yet.\nThe list records transfers this app signed and confirmed on-chain.'} />
      ) : (
        <ul className="nw-tx-list" style={{ marginTop: 10 }}>
          {history.map((h, i) => (
            <li key={i} className="nw-tx-row">
              <div className={'nw-tx-dir ' + (h.dir === 'sent' ? 'sent' : 'rec')}>
                {h.dir === 'sent' ? '↗' : '↙'}</div>
              <div style={{ flex: 1 }}>
                <div>
                  {h.dir === 'sent' ? 'To' : 'Received'}{' '}
                  <span className="nw-mono">{shortAddr(h.to)}</span>{' '}
                  <span className={'nw-badge ' + (h.status === 'confirmed' ? 'ok' : 'err')}>
                    {h.status}</span>
                </div>
                <div className="nw-small nw-dim">{h.time} · fee {h.fee}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                {h.amount} NSAT
                {h.ledger && <div className="nw-small nw-dim">ledger {h.ledger}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------- Settings -------------------------------- */
function SettingsPage({ s }) {
  return (
    <div>
      <section className="nw-card">
        <h2 style={{ color: 'var(--text)' }}>Privacy</h2>
        <div className="nw-kv" style={{ marginTop: 10 }}>
          <span className="nw-k">Signing power</span>
          <span className="nw-v">
            {s.active
              ? <button className="nw-chip-btn" onClick={s.doLock}>Lock now (clears key from memory)</button>
              : <span className="nw-badge warn">locked — no seed in memory</span>}
          </span>
        </div>
      </section>
      <section className="nw-card">
        <h2 style={{ color: 'var(--text)' }}>Stored wallets</h2>
        {s.wallets.length === 0
          ? <EmptyState text="No wallets stored yet" />
          : <ul className="nw-tx-list" style={{ marginTop: 10 }}>
            {s.wallets.map((w) => (
              <li key={w.name} className="nw-tx-row">
                <div style={{ flex: 1 }}>
                  <div>{w.name}</div>
                  <div className="nw-small nw-dim nw-mono">{shortAddr(w.pubkey)}</div>
                </div>
                <div className="nw-small nw-dim">
                  {s.active?.name === w.name ? 'active' : ''}
                </div>
              </li>
            ))}
          </ul>}
      </section>
      <section className="nw-card">
        <h2 style={{ color: 'var(--text)' }}>Backup & restore</h2>
        <p className="nw-small nw-dim" style={{ margin: '8px 0 12px' }}>
          Exports the ENCRYPTED keystore (AES-GCM, PBKDF2 600k). Restoring it
          here rebuilds this wallet&apos;s locker — the same file also imports into
          fresh browsers.
        </p>
        <div className="nw-btn-row" style={{ margin: 0 }}>
          <button className="nw-send-btn" onClick={s.doBackup}>Export encrypted backup</button>
          <label className="nw-chip-btn" style={{ cursor: 'pointer' }}>
            Restore keystore
            <input type="file" accept=".json" style={{ display: 'none' }}
              onChange={s.doRestore} />
          </label>
        </div>
      </section>
      <section className="nw-card">
        <h2 style={{ color: 'var(--text)' }}>Security model</h2>
        <div className="nw-kv" style={{ marginTop: 10 }}>
          <span className="nw-k">Key scheme</span>
          <span className="nw-v">Ed25519 · strkey CRC16 (same codec as the Desktop Wallet)</span></div>
        <div className="nw-kv"><span className="nw-k">Keystore</span>
          <span className="nw-v">PBKDF2-HMAC-SHA256 (600k) + AES-GCM in this browser</span></div>
        <div className="nw-kv"><span className="nw-k">Signing</span>
          <span className="nw-v">client-side only — the gateway never sees a key</span></div>
        <div className="nw-kv"><span className="nw-k">Network gate</span>
          <span className="nw-v">exact identity match required before any signature</span></div>
      </section>
    </div>
  );
}

/* --------------------------------- Shared -------------------------------- */
function NetworkBadge({ net }) {
  if (net == null) return <span className="nw-badge warn">● connecting…</span>;
  if (net.ok) {
    return (
      <span className="nw-badge ok">
        ● Mainnet verified
        {net.ledger != null ? ` · ledger ${Number(net.ledger).toLocaleString()}` : ''}
      </span>
    );
  }
  return <span className="nw-badge err">● Offline / identity mismatch</span>;
}

function EmptyState({ text }) {
  const [first, ...rest] = String(text).split('\n');
  return (
    <div className="nw-empty">
      <div className="nw-empty-big" aria-hidden>◇</div>
      {first}
      {rest.length > 0 && (
        <div className="nw-small nw-dim" style={{ marginTop: 4 }}>{rest.join(' ')}</div>
      )}
    </div>
  );
}

function shortAddr(addr, keep = 8) {
  if (!addr) return '—';
  return addr.length <= keep * 2 + 3 ? addr : `${addr.slice(0, keep)}…${addr.slice(-4)}`;
}
