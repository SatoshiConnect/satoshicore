'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  isGatewayConfigured, EXPECTED_NETWORK_ID,
  verifyNetworkIdentity, getChainInfo, getAccount,
  submitSignedTransaction, estimateFee, formatExactBalance,
} from '../lib/nsatClient';
import {
  keystoreCreate, keystoreImport, keystoreUnlock, keystoreList,
  keystoreHas, keystoreExport, keystoreRestore,
  buildSignedTx, waitSeqReached, historyLoad, historyPush,
} from '../lib/nsatWallet';
import { decodeSeed } from '../lib/nsatCodec';

// Full transactional Web Wallet. Everything user-facing happens in the
// browser; the gateway only ever relays ALREADY-SIGNED envelopes and
// read-only queries. No private key material is ever transmitted, logged,
// or held server-side. Shielded operations are intentionally NOT offered
// here (native Orchard kernel required) — see the Desktop Wallet.
//
// Session identity model: the unlocked wallet name + seed live in React
// state only. A page reload or sidecar restart clears signing power; the
// UI re-derives everything from the gateway's session-truth responses.

const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

export default function WalletPanel({ onNotify }) {
  // gateway/network
  const [net, setNet] = useState(null);          // { ok, network, reason }
  const [ledger, setLedger] = useState(null);
  const [fee, setFee] = useState(null);          // live base fee (stroops)
  // wallet session
  const [wallets, setWallets] = useState([]);
  const [active, setActive] = useState(null);    // { name, pubkey, seed32 }
  const [balance, setBalance] = useState(null);  // exact string
  const [locked, setLocked] = useState(true);
  // forms
  const [newName, setNewName] = useState('');
  const [newPass, setNewPass] = useState('');
  const [importSeed, setImportSeed] = useState('');
  const [unlockName, setUnlockName] = useState('');
  const [unlockPass, setUnlockPass] = useState('');
  const [dest, setDest] = useState('');
  const [createDest, setCreateDest] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);          // { text, kind }
  const [history, setHistory] = useState([]);

  const notify = (text, kind = 'ok') => {
    setMsg({ text, kind });
    window.setTimeout(() => setMsg(null), 6000);
  };

  const configured = isGatewayConfigured();

  // Network identity: strict, gateway-independent-of-config check via the
  // SDK — the reported on-chain identity must equal EXPECTED_NETWORK_ID.
  // The result gates EVERY signing action (see the `net.ok` checks below).
  const verifyNetwork = useCallback(async () => {
    if (!configured) { setNet({ ok: false, reason: 'gateway not configured' }); return null; }
    const r = await verifyNetworkIdentity();
    setNet(r);
    setLedger(r.ledger);
    if (r.ok) {
      try { setFee(await estimateFee()); } catch { setFee(null); }
    }
    return r;
  }, [configured]);

  const refreshWallets = useCallback(() => setWallets(keystoreList()), []);

  const refreshBalance = useCallback(async (name, pubkey) => {
    try {
      const r = await getAccount(pubkey);
      setBalance(r.status === 'ok' ? (r.balance128 ?? String(r.balance)) : null);
    } catch { setBalance(null); }
  }, []);

  useEffect(() => { setWallets(keystoreList()); }, []);
  useEffect(() => { void verifyNetwork(); }, [verifyNetwork]);
  useEffect(() => {
    if (active) { void refreshBalance(active.name, active.pubkey); setHistory(historyLoad(active.name)); }
    else { setBalance(null); setHistory([]); }
  }, [active, refreshBalance]);

  // ---------------- wallet actions ----------------
  async function doCreate(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await keystoreCreate(newName.trim(), newPass);
      setWallets(keystoreList());
      // The freshly created seed is still in this closure's memory only;
      // establishing the signing session now is the same trust level as an
      // explicit Unlock (the panel never sends it anywhere).
      setActive({ name: r.name, pubkey: r.pubkeyG, seed32: decodeSeed(r.seedS) });
      setLocked(false);
      setNewName(''); setNewPass('');
      // Truth: the seed is never displayed by this wallet. The user's backup
      // is the ENCRYPTED keystore blob — direct them to export it now.
      notify(`Wallet "${r.name}" created. Export the encrypted backup NOW (button above) and store it privately — it is the only copy.`, 'ok');
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
      setLocked(false);
      setNewName(''); setNewPass(''); setImportSeed('');
      notify(`Wallet "${r.name}" imported.`, 'ok');
    } catch (err) { notify(String(err.message || err), 'err'); }
    setBusy(false);
  }

  async function doUnlock(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const seed32 = await keystoreUnlock(unlockName, unlockPass);
      const list = keystoreList();
      const entry = list.find(w => w.name === unlockName);
      setActive({ name: unlockName, pubkey: entry?.pubkey, seed32 });
      setLocked(false);
      setUnlockName(''); setUnlockPass('');
      notify(`Wallet "${unlockName}" unlocked.`, 'ok');
    } catch (err) { notify(String(err.message || err), 'err'); }
    setBusy(false);
  }

  function doLock() {
    setActive(null);
    setLocked(true);
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
      notify('Keystore restored. Unlock a wallet to sign.', 'ok');
    } catch (err) { notify(`restore failed: ${err.message}`, 'err'); }
  }

  // ---------------- shielded-free transparent send ----------------
  async function doSend(e) {
    e.preventDefault();
    if (!active?.seed32) { notify('Unlock the wallet first.', 'err'); return; }
    if (!net?.ok) { notify('Network identity not verified — refusing to sign.', 'err'); return; }
    // Re-assert the identity that was VERIFIED — signing uses this exact
    // passphrase so signature and submission can never straddle two networks.
    if (net.network !== EXPECTED_NETWORK_ID) {
      notify('Network identity changed since verification — refusing to sign.', 'err');
      return;
    }
    setBusy(true);
    try {
      // Fees and reserves come from the LIVE ledger — never a baked constant.
      const baseFee = await estimateFee();
      const info = await getChainInfo();
      const baseReserve = Number(info?.info?.ledger?.baseReserve || 0);
      const amtClean = amount.replace(/[,_ ]/g, '');
      // A brand-new destination account needs a starting balance of at least
      // 2× base reserve on this fork; below it the tx finalizes but the op
      // fails on-chain (fee charged, funds not moved). Fail BEFORE signing.
      if (createDest && baseReserve > 0 && /^\d+$/.test(amtClean)
        && BigInt(amtClean) < BigInt(2 * baseReserve)) {
        notify(`CREATE starting balance must be ≥ ${BigInt(2 * baseReserve).toLocaleString()} stroops (2× base reserve) — the chain would charge the fee and fail the operation.`, 'err');
        setBusy(false);
        return;
      }
      // Capture the pre-send balance so the finalization check below can
      // verify the operation ACTUALLY moved the amount and not just fees.
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
        setBusy(false);
        return;
      }
      if (r.status !== 'PENDING') {
        const friendly = {
          DUPLICATE: 'the node already has this exact transaction (already submitted).',
          TRY_AGAIN_LATER: 'node queue is full — try again shortly; nothing was lost.',
          FILTERED: 'the node filtered this transaction (fee/size policy).',
        };
        notify(`Node responded ${r.status}: ${friendly[r.status] || JSON.stringify(r)}`, r.status === 'DUPLICATE' ? 'warn' : 'err');
        setBusy(false);
        return;
      }
      notify('Submitted — waiting for finalization…', 'warn');
      // Finalization: the account's sequence number only moves when the
      // transaction is APPLIED in a closed ledger, so seq-advance is the
      // confirmation signal.
      const ok = await waitSeqReached(
        async () => {
          const d = await getAccount(active.pubkey);
          return Number(d.seqnum ?? d.sequence ?? 0);
        },
        signed.seq, 90000, 2000);
      if (!ok) { notify('Not finalized within 90 s — check Activity later.', 'warn'); setBusy(false); return; }
      // Ledger truth: seq-advance also happens when the tx finalizes with a
      // FAILED operation (fee charged, nothing moved). A send is CONFIRMED
      // only if the balance debit matches amount + fee exactly.
      const afterD = await getAccount(active.pubkey).catch(() => null);
      const afterBal = afterD?.status === 'ok'
        ? BigInt(afterD.balance ?? afterD.balance128) : null;
      const debited = prevBalance != null && afterBal != null
        && BigInt(prevBalance) - afterBal === BigInt(amount) + BigInt(signed.fee);
      // Ledger evidence for the history entry — read from the live chain info.
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
        setBusy(false);
        return;
      }
      historyPush(active.name, {
        time: new Date().toLocaleString(), dir: 'sent', to: dest.trim(),
        amount: amount.trim(), fee: signed.fee, txhash: signed.txHashHex,
        ledger: liLedger?.num, ledger_hash: liLedger?.hash, status: 'confirmed',
      });
      setHistory(historyLoad(active.name));
      notify(`Confirmed on ledger ${liLedger?.num ?? '(latest)'}.`, 'ok');
      setAmount('');
      void refreshBalance(active.name, active.pubkey);
    } catch (err) { notify(String(err.message || err), 'err'); }
    setBusy(false);
  }

  const netOk = !!net?.ok;
  const amtOk = /^\d+$/.test(amount.replace(/[,_ ]/g, '')) && BigInt(amount.replace(/[,_ ]/g, '') || '0') > 0n;
  const destOk = ACCOUNT_RE.test(dest.trim()) && dest.trim() !== active?.pubkey;

  return (
    <section className="wallet-panel" aria-label="Web Wallet">
      <h2>Web Wallet</h2>

      {!configured && (
        <p className="wallet-warning">
          Offline mode: set NEXT_PUBLIC_API_GATEWAY_URL (+ NEXT_PUBLIC_API_GATEWAY_TOKEN)
          at build time to connect.
        </p>
      )}

      {net && (
        <p className={net.ok ? 'net-ok' : 'net-bad'} data-testid="network-identity">
          {net.ok ? '✓ Network verified:' : '⚠ NETWORK MISMATCH —'}{' '}
          <strong>{net.network || 'unreachable'}</strong>
          {ledger != null && <span> (ledger {ledger})</span>}
          {!net.ok && net.reason && <em> — {net.reason}</em>}
        </p>
      )}

      <p className="wallet-warning">
        Keys are generated and stored encrypted IN THIS BROWSER (AES-GCM,
        PBKDF2 600k). The gateway relays signed envelopes only — it never
        sees a key. Shielded transfers need the native kernel: use the
        Desktop Wallet for those.
      </p>

      {/* ---------- session ---------- */}
      <section className="card" style={{ marginTop: 12 }}>
        <h2>{active ? `Active: ${active.name}` : 'Locked'}</h2>
        {active && (
          <ul className="wallet-body">
            <li>Public key: <code>{active.pubkey}</code></li>
            <li>Confirmed balance (balance128):{' '}
              <strong>{balance == null ? '…' : `${formatExactBalance(balance)} NSAT`}</strong></li>
            <li>Network: {net?.network || '—'} {netOk ? '✓' : '✗'}</li>
          </ul>
        )}
        <div className="btn-row" style={{ marginTop: 10 }}>
          {!active && wallets.length > 0 && (
            <select value={unlockName} onChange={(e) => setUnlockName(e.target.value)}
              aria-label="Wallet to unlock">
              <option value="">— wallet —</option>
              {wallets.map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
            </select>
          )}
          {!active && wallets.length > 0 && (
            <form onSubmit={doUnlock} className="btn-row" style={{ gap: 8 }}>
              <input type="password" placeholder="password" value={unlockPass}
                onChange={(e) => setUnlockPass(e.target.value)} aria-label="Wallet password" />
              <button className="chip-btn" type="submit" disabled={busy || !unlockName}>Unlock</button>
            </form>
          )}
          {active && <button className="chip-btn" onClick={doLock}>Lock wallet</button>}
          <button className="chip-btn" onClick={doBackup}>Export encrypted backup</button>
          <label className="chip-btn" style={{ cursor: 'pointer' }}>
            Restore keystore
            <input type="file" accept=".json" style={{ display: 'none' }} onChange={doRestore} />
          </label>
        </div>
      </section>

      {/* ---------- create / import (only when no active wallet) ---------- */}
      {!active && (
        <div className="grid-2" style={{ marginTop: 12 }}>
          <section className="card">
            <h2>Create wallet</h2>
            <form onSubmit={doCreate} className="wallet-form">
              <label htmlFor="wn">Name</label>
              <input id="wn" value={newName} onChange={(e) => setNewName(e.target.value)} required />
              <label htmlFor="wp">Password (encrypts the seed, ≥ 8 chars)</label>
              <input id="wp" type="password" value={newPass}
                onChange={(e) => setNewPass(e.target.value)} minLength={8} required />
              <button type="submit" className="chip-btn" disabled={busy || !newName || newPass.length < 8}>
                Create</button>
            </form>
          </section>
          <section className="card">
            <h2>Import wallet</h2>
            <form onSubmit={doImport} className="wallet-form">
              <label htmlFor="in">Name</label>
              <input id="in" value={newName} onChange={(e) => setNewName(e.target.value)} required />
              <label htmlFor="is">Secret seed (S…)</label>
              <input id="is" type="password" value={importSeed}
                onChange={(e) => setImportSeed(e.target.value)} required spellCheck={false} />
              <label htmlFor="ip">Password</label>
              <input id="ip" type="password" value={newPass}
                onChange={(e) => setNewPass(e.target.value)} minLength={8} required />
              <button type="submit" className="chip-btn" disabled={busy || !newName || !importSeed}>
                Import</button>
            </form>
          </section>
        </div>
      )}

      {/* ---------- send (needs active + unlocked + verified network) ---------- */}
      {active && (
        <section className="card" style={{ marginTop: 12 }}>
          <h2>Send NSAT (transparent)</h2>
          {!netOk && <p className="wallet-warning">Network identity not verified — sending disabled.</p>}
          {needUnlockNotice(active, locked) && (
            <p className="wallet-warning">Unlock the wallet to sign transactions.</p>
          )}
          <form onSubmit={doSend} className="wallet-form">
            <label htmlFor="dest">Destination G…</label>
            <input id="dest" className="mono" spellCheck={false} value={dest}
              onChange={(e) => setDest(e.target.value)} placeholder="G…" />
            <label htmlFor="amt">Amount NSAT</label>
            <input id="amt" inputMode="numeric" value={amount}
              onChange={(e) => setAmount(e.target.value)} placeholder="exact integers" />
            <label className="small dim" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={createDest} aria-label="Create destination account"
                onChange={(e) => setCreateDest(e.target.checked)} />
              Destination has no account yet (CREATE — moves the amount itself as
              starting balance; required only for a brand-new G… )
            </label>
            <div className="small dim">Fee: {fee ?? '…'} stroops per operation (live from the verified ledger)</div>
            <button type="submit" className="send-btn" disabled={busy || !netOk || !amtOk || !destOk}>
              {busy ? 'Signing & submitting…' : 'Sign & send'}
            </button>
          </form>
        </section>
      )}

      {/* ---------- history ---------- */}
      {active && (
        <section className="card" style={{ marginTop: 12 }}>
          <h2>History — {active.name}</h2>
          {history.length === 0
            ? <p className="small dim">No transactions yet.</p>
            : <ul className="tx-list">
              {history.map((h, i) => (
                <li key={i} className="tx-row">
                  <div className={h.dir === 'sent' ? 'tx-dir sent' : 'tx-dir rec'}>
                    {h.dir === 'sent' ? '↗' : '↙'}</div>
                  <div style={{ flex: 1 }}>
                    <div>{h.dir === 'sent' ? `To ${h.to}` : 'Received'}{' '}
                      <Badge kind={h.status === 'confirmed' ? 'ok' : 'err'}>{h.status}</Badge></div>
                    <div className="small dim">{h.time} · fee {h.fee}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>{h.amount} NSAT
                    {h.ledger && <div className="small dim">ledger {h.ledger}</div>}</div>
                </li>
              ))}
            </ul>}
        </section>
      )}

      {msg && (
        <div className="card" role="status"
          style={{ marginTop: 12, borderColor: msg.kind === 'err' ? 'var(--danger)' : 'var(--ok)' }}>
          {msg.text}
        </div>
      )}
    </section>
  );
}

function needUnlockNotice(active, locked) {
  return locked || !active;
}

function Badge({ kind, children }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}
