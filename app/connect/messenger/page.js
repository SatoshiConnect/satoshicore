'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { encodeG, ed25519Pub, ed25519Sign } from '../../../lib/nsatCodec';
import { keystoreList, keystoreUnlock, zeroSeed } from '../../../lib/nsatWallet';
import './page.css';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const CHAT_ORIGIN = 'https://chat.satoshicore.org';

function parseRequest() {
  const values = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = values.get('token') || '';
  const message = values.get('message') || '';
  if (!TOKEN_RE.test(token) || message.length > 1000) return null;
  const lines = message.split('\n');
  const account = lines[2]?.startsWith('Account: @') ? lines[2].slice(10) : '';
  const challenge = lines[3]?.startsWith('Challenge: ') ? lines[3].slice(11) : '';
  const issued = Number(lines[4]?.slice('Issued: '.length));
  const expires = Number(lines[5]?.slice('Expires: '.length));
  const now = Math.floor(Date.now() / 1000);
  if (lines[0] !== 'SatoshiCore Messenger wallet link v1'
      || lines[1] !== `Origin: ${CHAT_ORIGIN}`
      || !/^[A-Za-z0-9._-]{1,32}$/.test(account)
      || challenge !== token
      || !Number.isSafeInteger(issued) || !Number.isSafeInteger(expires)
      || issued > now + 60 || expires <= now || expires - issued > 300) return null;
  return { token, message, account, expires };
}

function base64Url(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export default function MessengerWalletLinkPage() {
  const [request, setRequest] = useState(undefined);
  const [wallets, setWallets] = useState([]);
  const [walletName, setWalletName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setRequest(parseRequest());
    try {
      const localWallets = keystoreList();
      setWallets(localWallets);
      setWalletName(localWallets[0]?.name || '');
    } catch {
      setWallets([]);
    }
  }, []);

  const selected = useMemo(() => wallets.find((wallet) => wallet.name === walletName), [wallets, walletName]);

  async function approve(event) {
    event.preventDefault();
    setError('');
    if (!request || !selected || !password) {
      setError('Select a wallet and enter its password to approve.');
      return;
    }
    if (request.expires <= Math.floor(Date.now() / 1000)) {
      setError('This Messenger request expired. Start again from Messenger.');
      return;
    }
    setBusy(true);
    let seed32;
    try {
      seed32 = await keystoreUnlock(selected.name, password);
      const address = encodeG(ed25519Pub(seed32));
      if (!ADDRESS_RE.test(address) || address !== String(selected.pubkey || '').toUpperCase()) {
        throw new Error('The unlocked wallet does not match its saved address.');
      }
      const signature = base64Url(ed25519Sign(seed32, new TextEncoder().encode(request.message)));
      const callback = new URL(CHAT_ORIGIN);
      callback.hash = new URLSearchParams({
        walletLink: request.token,
        address,
        signature,
      }).toString();
      setPassword('');
      window.location.replace(callback.href);
    } catch (cause) {
      setError(String(cause?.message || 'Wallet approval failed. Nothing was linked.'));
      setBusy(false);
    } finally {
      if (seed32) zeroSeed(seed32);
    }
  }

  return (
    <main className="messenger-link-page">
      <section className="messenger-link-card">
        <span className="messenger-link-mark" aria-hidden="true">S</span>
        <p className="messenger-link-eyebrow">SatoshiCore Wallet</p>
        <h1>Connect to Messenger</h1>
        {request ? (
          <>
            <p className="messenger-link-lead">
              Connect wallet <strong>{selected?.pubkey || 'selected below'}</strong> to the Messenger account <strong>@{request.account}</strong>.
            </p>
            <div className="messenger-link-warning">
              This signs a one-time ownership proof only. It does not send NSAT or give Messenger access to your recovery phrase or private key.
            </div>
            {wallets.length ? (
              <form onSubmit={approve} className="messenger-link-form">
                <label htmlFor="messenger-link-wallet">Wallet</label>
                <select id="messenger-link-wallet" value={walletName} onChange={(event) => setWalletName(event.target.value)} disabled={busy}>
                  {wallets.map((wallet) => <option key={wallet.name} value={wallet.name}>{wallet.name} · {wallet.pubkey}</option>)}
                </select>
                <label htmlFor="messenger-link-password">Wallet password</label>
                <input id="messenger-link-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} required />
                {error ? <p className="messenger-link-error" role="alert">{error}</p> : null}
                <button type="submit" disabled={busy || !selected}>{busy ? 'Signing…' : 'Approve wallet connection'}</button>
              </form>
            ) : (
              <p className="messenger-link-empty">
                No wallet is saved on this device. Create or import a wallet in SatoshiCore Wallet,
                then start Connect Wallet again from Messenger.
              </p>
            )}
          </>
        ) : (
          <p className="messenger-link-error" role="alert">This Messenger request is invalid or expired. Return to Messenger and start a new connection.</p>
        )}
        <p className="messenger-link-foot">Verify the account name and domain above before approving.</p>
        <Link href="/" className="messenger-link-back">Cancel and return to Wallet</Link>
      </section>
    </main>
  );
}
