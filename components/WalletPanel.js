'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isGatewayConfigured, isIndexerConfigured, EXPECTED_NETWORK_ID,
  verifyNetworkIdentity, getChainInfo, getAccount, getAccountHistory, getMintStatus,
  readAccountBalance, submitSignedTransaction, estimateFee, formatExactBalance,
  waitForConfirmation, accountEventsUrl,
} from '../lib/nsatClient';
import {
  keystoreCreate, keystoreImport, keystoreUnlock, keystoreList,
  keystoreExport, keystoreRestore, keystoreRemove, zeroSeed, MIN_PASSWORD_LENGTH,
  buildSignedTx, historyLoad, historyClear, historyPush, historyPatch,
} from '../lib/nsatWallet';
import { decodeSeed } from '../lib/nsatCodec';
// Shared send gate (mirror of the desktop/prototype reason contract — one
// source of truth for WHY a send is blocked; see NSAT-WALLET-BUTTON-STATES).
import { sendPreflight, maxSendable, fmtGroup } from '../lib/nsatSendPreflight';
import { startBalanceRefresh } from '../lib/walletBalanceRefresh.mjs';
import {
  ACCOUNT_SIGNED_OUT_EVENT, isFirebaseWebConfigured, loadGoogleAuth, signOutGoogleSession,
} from '../lib/firebaseAuth';
import { pullLinkedAddressesForUser } from '../lib/walletLinks';
import {
  biometricWalletNames, enableBiometricUnlock, hasBiometricUnlock,
  removeBiometricUnlock, unlockWithBiometric,
} from '../lib/biometricUnlock';
import { backupSilently } from '../lib/driveBackup';
import {
  bindOwner, normalizeAccount, ownerOf, unbindOwner, walletNameForAccount,
} from '../lib/walletBinding';
import GoogleAccount from './GoogleAccount';
import DriveBackupCard from './DriveBackupCard';
import BackupReminder from './BackupReminder';
import ThemeToggle from './ThemeToggle';
import { recordDriveBackup } from '../lib/backupReminder';
import { NSAT } from '../lib/nsatToken';

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
const SHOW_GOOGLE_ACCOUNT = process.env.NEXT_PUBLIC_EXTENSION_BUILD !== '1';
// Phone-style app: three tabs, arranged the way the iPhone build arranges
// them. Send and Receive are actions on the wallet screen, not tabs — a phone
// wallet does not spend a third of its tab bar on one form. Shielded is
// desktop-only, so Settings links to the explanation instead of advertising a
// feature the browser cannot run.
const NAV_PAGES = ['overview', 'activity', 'settings'];
const NAV_LABEL = {
  overview: 'Wallet', activity: 'Activity', settings: 'Settings',
};
const PAGE_GLYPH = {
  overview: '◆', activity: '⚡', settings: '⚙',
};
// Pages reached from an action; the app bar shows Back instead of Receive.
const SUB_PAGES = ['send', 'receive', 'shielded'];
const PAGE_TITLE = {
  overview: 'Overview', send: 'Send NSAT', receive: 'Receive NSAT',
  shielded: 'Shielded NSAT', activity: 'Activity', settings: 'Settings',
};
// One short line per section — context only, never an essay. Overview and
// Settings need none: the cards say what they are.
const PAGE_LEAD = {
  overview: null,
  send: 'Recipient, amount, then a review with the exact total.',
  receive: 'Your public address only.',
  shielded: 'Desktop only — the native prover is required.',
  activity: 'Every indexed transfer, with the ledger\'s verdict.',
  settings: null,
};

// Founder Mint totals come from the ledger header, never from a rate applied
// here. `totalCoins` is the chain's own supply figure and the genesis supply is
// fixed, so minted-since-activation is an exact subtraction. Both numbers
// exceed 2^53, which is why this is BigInt and never a Number.
const GENESIS_SUPPLY = 2_100_000_000_000_000_000_000_000n;
const HISTORY_PAGE = 100;

function supplyAndMinted(totalCoins) {
  try {
    const supply = BigInt(String(totalCoins));
    const minted = supply - GENESIS_SUPPLY;
    return { supply: supply.toString(), minted: minted >= 0n ? minted.toString() : null };
  } catch {
    return { supply: null, minted: null };
  }
}

const historyKey = (item) => `${item.hash}:${item.op_index ?? 0}`;

function mergeHistory(prev, doc) {
  const seen = new Set(prev.map(historyKey));
  const add = (Array.isArray(doc?.items) ? doc.items : []).filter((item) => !seen.has(historyKey(item)));
  return [...prev, ...add];
}

export default function WalletPanel() {
  // gateway/network
  const [net, setNet] = useState(null);          // { ok, network, reason, ledger }
  const [liveLedger, setLiveLedger] = useState(null); // public ledger height, polled
  const [fee, setFee] = useState(null);          // live base fee (NSAT integer unit)
  const [reserve, setReserve] = useState(null);  // live base reserve (NSAT integer unit)
  // wallet session
  const [wallets, setWallets] = useState([]);
  const [biometricWallets, setBiometricWallets] = useState([]);
  const [active, setActive] = useState(null);    // { name, pubkey, seed32 }
  const [balance, setBalance] = useState(null);  // exact stroops string
  const [funded, setFunded] = useState(null);    // true / false / unknown
  // Watch-only: PUBLIC addresses linked to the signed-in website account. They
  // show a balance and a receive screen on a device with no key, and can do
  // nothing else — there is no seed here, so nothing can be signed. One account
  // can link several wallets, so `watchPick` is which of them this screen shows.
  const [watchAddresses, setWatchAddresses] = useState([]);
  const [watchPick, setWatchPick] = useState('');
  // ui
  const [page, setPage] = useState('overview');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);      // { text, kind }
  // forms
  const [newName, setNewName] = useState('');
  const [newPass, setNewPass] = useState('');
  // Signed-in website account, if any. It seeds the wallet name so a Google
  // sign-up creates a wallet without typing one; the password stays the user's.
  const [accountEmail, setAccountEmail] = useState('');
  const [accountUid, setAccountUid] = useState('');
  // Signing in with Google is the start of a session and signing out is its
  // end: without an account there is nothing to open, so the panel shows only
  // the gate. `accountReady` keeps the wallet from flashing while the first
  // auth-state callback is still in flight.
  const signInRequired = SHOW_GOOGLE_ACCOUNT && isFirebaseWebConfigured();
  const [accountReady, setAccountReady] = useState(!signInRequired);
  const [importSeed, setImportSeed] = useState('');
  const [unlockName, setUnlockName] = useState('');
  const [unlockPass, setUnlockPass] = useState('');
  // Account switcher, opened from the name pill in the app bar — the same
  // gesture as the iPhone build, where tapping the account name lists the
  // wallets on this device instead of jumping into Settings.
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [walletManagerView, setWalletManagerView] = useState('list');
  const [walletDetails, setWalletDetails] = useState(null);
  const [walletRemoveState, setWalletRemoveState] = useState(null);
  const [switchName, setSwitchName] = useState('');
  const [switchPass, setSwitchPass] = useState('');
  // name -> { kind: 'loading' | 'exact' | 'missing' | 'unavailable', value }
  const [switchBalances, setSwitchBalances] = useState({});
  // Read-only account existence/balance for every local wallet on the homepage.
  const [overviewWalletStates, setOverviewWalletStates] = useState({});
  // public address -> balance state for linked wallet choices in Send
  const [sendRecipientBalances, setSendRecipientBalances] = useState({});
  const [dest, setDest] = useState('');
  const [createDest, setCreateDest] = useState(false);
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState(null);    // { amount, fee, total }
  const [history, setHistory] = useState([]);
  // Indexed chain history for the address on screen, newest first, paged with a
  // `(ledger, tx, op)` cursor so "load older" never repeats a row. `coverage`
  // is what the index actually holds: history is never claimed beyond it.
  const [chainHistory, setChainHistory] = useState({
    phase: 'idle', items: [], total: null, coverage: null, next: null,
    loadingMore: false, error: '',
  });
  // Founder Mint state read from the latest indexed ledger header.
  const [mintStatus, setMintStatus] = useState({
    phase: 'idle', data: null, timeline: [], unattributed: null, error: '',
  });

  const notify = (text, kind = 'ok') => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 6000);
  };

  // Locking must destroy the seed bytes, not just drop the state reference:
  // an unreferenced Uint8Array is still readable until the GC runs. Reading the
  // session through a ref keeps the wipe correct even when an event handler
  // (background/pagehide) holds a stale closure.
  const activeRef = useRef(null);
  const lockEpoch = useRef(0);
  const pendingSeedsRef = useRef(new Set());
  const lockWallet = useCallback((message) => {
    lockEpoch.current += 1;
    const current = activeRef.current;
    if (current?.seed32) zeroSeed(current.seed32);
    for (const seed32 of pendingSeedsRef.current) zeroSeed(seed32);
    pendingSeedsRef.current.clear();
    activeRef.current = null;
    setActive(null);
    setUnlockPass('');
    setNewPass('');
    setImportSeed('');
    if (message) setToast({ text: message, kind: 'ok' });
  }, []);
  const activateWallet = useCallback((session) => {
    const previous = activeRef.current;
    if (previous?.seed32 && previous.seed32 !== session.seed32) zeroSeed(previous.seed32);
    activeRef.current = session;
    setActive(session);
  }, []);

  // Everything a session accumulated. `lockWallet` zeroes the signing key; this
  // also drops every screen state that belonged to the account — watch list,
  // balances, history, mint data, forms and open dialogs — so the next person
  // starts from the sign-in gate, not from the previous user's screen.
  const endSession = useCallback(() => {
    lockWallet();
    setWatchAddresses([]);
    setWatchPick('');
    setHistory([]);
    setChainHistory({ phase: 'idle', items: [], total: null, coverage: null, next: null, loadingMore: false, error: '' });
    setMintStatus({ phase: 'idle', data: null, timeline: [], unattributed: null, error: '' });
    setBalance(null);
    setReview(null);
    setAccountsOpen(false);
    setWalletDetails(null);
    setWalletRemoveState(null);
    setDest(''); setAmount(''); setCreateDest(false);
    setUnlockName('');
    setSwitchName(''); setSwitchPass('');
    setSwitchBalances({});
    setOverviewWalletStates({});
    setSendRecipientBalances({});
    setToast(null);
    setPage('overview');
    // A sign-out must not leave the panel busy: the same component instance is
    // still mounted behind the gate and serves the next sign-in.
    setBusy(false);
  }, [lockWallet]);

  // A sign-out — from Settings, from the account switcher, or from another tab
  // — ends the whole session, not just the Google identity.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onSignedOut = () => endSession();
    window.addEventListener(ACCOUNT_SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(ACCOUNT_SIGNED_OUT_EVENT, onSignedOut);
  }, [endSession]);

  // The auth callback is authoritative: a session that disappears without the
  // event (expired token, revoked access, another tab signing out) tears the
  // wallet down here too.
  const lastAccountUid = useRef('');
  useEffect(() => {
    const had = lastAccountUid.current;
    lastAccountUid.current = accountUid;
    if (had && !accountUid) endSession();
  }, [accountUid, endSession]);

  // An in-app route change unmounts this panel without a pagehide event, so
  // wipe the session buffer on unmount as well: a client-side navigation must
  // not leave signing-key bytes behind in a detached component.
  useEffect(() => () => {
    lockEpoch.current += 1;
    if (activeRef.current?.seed32) zeroSeed(activeRef.current.seed32);
    for (const seed32 of pendingSeedsRef.current) zeroSeed(seed32);
    pendingSeedsRef.current.clear();
    activeRef.current = null;
  }, []);

  // Lock immediately when the app leaves the foreground, and invalidate any
  // pending WebCrypto operation so an unlock cannot resurrect the session.
  useEffect(() => {
    // Locking on background is a guarantee, not an event to announce: on a
    // phone the user switches apps constantly, and the toast followed them
    // back over the unlock screen. The wallet still locks; the unlock form
    // already says so.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        lockWallet();
      }
    };
    const onPageHide = () => lockWallet();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [lockWallet]);

  // Idle auto-lock: signing power must not outlive inattention. Any user
  // activity resets the timer; after the idle window the wallet locks via
  // lockWallet(), which wipes the seed. Default 5 min. The operator can tune
  // NEXT_PUBLIC_IDLE_LOCK_MS between 1 and 60 minutes, but cannot disable the
  // lock: values outside that range clamp instead of switching it off.
  const idleLockMs = Math.min(
    Math.max(Number(process.env.NEXT_PUBLIC_IDLE_LOCK_MS) || 5 * 60_000, 60_000),
    60 * 60_000,
  );
  useEffect(() => {
    if (!active) return undefined;
    let lastActive = Date.now();
    const bump = () => { lastActive = Date.now(); };
    const events = ['pointerdown', 'keydown', 'mousemove', 'wheel', 'touchstart'];
    events.forEach((ev) => window.addEventListener(ev, bump, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - lastActive >= idleLockMs) {
        lockWallet('Wallet locked after inactivity — signing key cleared.');
      }
    }, 10_000);
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, bump));
      window.clearInterval(timer);
    };
  }, [active, idleLockMs, lockWallet]);

  


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
      try { setReserve(Number((await getChainInfo())?.info?.ledger?.baseReserve || 0)); }
      catch { setReserve(null); }
    }
    return r;
  }, [configured]);

  // What this browser may list for the account signed in now. A wallet bound to
  // another account stays encrypted on disk — nothing is deleted — but its name
  // is not shown, so a shared browser does not hand the next person the
  // previous person's wallet list. Signing back in as the bound account brings
  // it back.
  const visibleWallets = useCallback(() => {
    const all = keystoreList();
    if (!accountEmail) return all;
    const mine = normalizeAccount(accountEmail);
    return all.filter((wallet) => {
      const owner = normalizeAccount(ownerOf(wallet.name));
      return !owner || owner === mine;
    });
  }, [accountEmail]);

  const refreshWallets = useCallback(() => {
    const listed = visibleWallets();
    setWallets(listed);
    setBiometricWallets(biometricWalletNames().filter((name) => listed.some((w) => w.name === name)));
  }, [visibleWallets]);

  // The list depends on who is signed in, so it is rebuilt whenever that
  // changes — including sign-out, where it must empty.
  useEffect(() => { refreshWallets(); }, [refreshWallets]);

  // Signing in with Google pre-fills the wallet name, so a first wallet needs
  // one thing typed — the password — instead of a form. Only ever fills an
  // empty field, never overwrites what the user already typed.
  useEffect(() => {
    if (!accountEmail) return;
    setNewName((current) => current || walletNameForAccount(accountEmail));
  }, [accountEmail]);

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

  useEffect(() => { void verifyNetwork(); }, [verifyNetwork]);

  // Ledger height for the policy-issuance figure: public, cheap, key-free, so
  // it can run every few seconds whether or not a wallet is unlocked.
  useEffect(() => {
    if (!configured) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const info = await getChainInfo();
        const num = info?.info?.ledger?.num;
        if (alive && num != null) setLiveLedger(Number(num));
      } catch {
        // A miss keeps the last value; nothing is invented.
      }
    };
    void tick();
    const id = window.setInterval(tick, 4000);
    return () => { alive = false; window.clearInterval(id); };
  }, [configured]);
  // A picked address wins only while it is still linked; otherwise the first
  // linked wallet is the one shown.
  const watchAddress = watchAddresses.includes(watchPick) ? watchPick : (watchAddresses[0] || '');

  useEffect(() => {
    if (active) {
      void refreshBalance(active.pubkey);
      setHistory(historyLoad(active.name));
    } else if (watchAddress) {
      // Read-only balance for the linked address. No key, no history of ours:
      // this wallet never signed anything from this device.
      void refreshBalance(watchAddress);
      setHistory([]);
    } else { setBalance(null); setHistory([]); }
  }, [active, watchAddress, refreshBalance]);

  // Follow the website account: if it has a linked address and this device has
  // no wallet of its own, the wallet opens in watch-only mode instead of the
  // create/import forms. Signing in is not enough to spend anything — the link
  // is a public pointer, and every send path still requires a local key.
  useEffect(() => {
    if (!SHOW_GOOGLE_ACCOUNT || !isFirebaseWebConfigured()) return undefined;
    let alive = true;
    let unsubscribe = () => {};
    loadGoogleAuth().then(({ auth, authSdk }) => {
      if (!alive) return;
      unsubscribe = authSdk.onAuthStateChanged(auth, (user) => {
        const uid = user?.uid || '';
        if (alive) setAccountEmail(user?.email || '');
        if (alive) setAccountUid(uid);
        if (alive) setAccountReady(true);
      }, () => {
        // A session read failure must not leave the panel stuck on "checking";
        // with no confirmed account the gate stays closed.
        if (alive) setAccountReady(true);
      });
    }).catch(() => { /* sign-in unavailable: watch-only simply stays off */ });
    return () => { alive = false; unsubscribe(); };
  }, []);

  // The linked-wallet list is read once per account and again whenever Settings
  // changes it. Without this, linking or removing a wallet left this screen
  // showing the old set until a reload.
  useEffect(() => {
    if (!accountUid) { setWatchAddresses([]); return undefined; }
    let alive = true;
    const reload = () => {
      pullLinkedAddressesForUser(accountUid).then((list) => {
        if (alive) setWatchAddresses(list);
      }).catch(() => { /* no database yet: leave the wallet as it is */ });
    };
    reload();
    window.addEventListener('nsat:links-changed', reload);
    return () => { alive = false; window.removeEventListener('nsat:links-changed', reload); };
  }, [accountUid]);

  // Activity reads the indexer for the address on screen, so older transfers
  // (and transfers signed elsewhere) appear. Read-only: no key, no signing.
  useEffect(() => {
    const address = active?.pubkey || watchAddress;
    if (page !== 'activity') return undefined;
    if (!address) {
      setChainHistory({ phase: 'none', items: [], total: null, coverage: null, next: null, loadingMore: false, error: '' });
      return undefined;
    }
    if (!isIndexerConfigured()) {
      setChainHistory({ phase: 'unavailable', items: [], total: null, coverage: null, next: null, loadingMore: false, error: 'indexer not configured' });
      return undefined;
    }
    let cancelled = false;
    setChainHistory({ phase: 'loading', items: [], total: null, coverage: null, next: null, loadingMore: false, error: '' });
    getAccountHistory(address, { limit: HISTORY_PAGE })
      .then((doc) => {
        if (cancelled) return;
        const items = Array.isArray(doc?.items) ? doc.items : [];
        setChainHistory({
          phase: 'ready',
          items,
          total: Number.isFinite(Number(doc?.total)) ? Number(doc.total) : items.length,
          coverage: doc?.coverage || null,
          next: doc?.next_cursor || null,
          loadingMore: false,
          error: '',
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setChainHistory({ phase: 'unavailable', items: [], total: null, coverage: null, next: null, loadingMore: false, error: String(err?.message || err) });
      });
    return () => { cancelled = true; };
  }, [page, active?.pubkey, watchAddress]);

  // Founder Mint is close-level accounting carried in the ledger header. Read it
  // from the index (the header itself), never recomputed from a policy rate.
  //
  // Every ledger close writes a new heartbeat and grows totalCoins, so a single
  // read freezes the figure the moment Activity opens. While the page is on
  // screen it is re-read on an interval, and again as soon as the tab becomes
  // visible — the card therefore shows the latest indexed header, not the one
  // that happened to be current at the first click.
  useEffect(() => {
    if (page !== 'activity' || !isIndexerConfigured()) return undefined;
    let cancelled = false;
    let inFlight = false;
    const read = async ({ first = false } = {}) => {
      if (inFlight) return;
      inFlight = true;
      if (first) {
        setMintStatus({ phase: 'loading', data: null, timeline: [], unattributed: null, fetchedAt: null, error: '' });
      }
      try {
        const doc = await getMintStatus();
        if (cancelled) return;
        setMintStatus({
          phase: 'ready',
          data: doc?.mint || null,
          // Issuance eras derived by the index from consecutive header
          // totalCoins deltas, plus the growth they cannot attribute.
          timeline: Array.isArray(doc?.timeline) ? doc.timeline : [],
          unattributed: doc?.timeline_unattributed ?? null,
          fetchedAt: Date.now(),
          error: '',
        });
      } catch (err) {
        if (cancelled) return;
        // A refresh that fails must not blank the last known header: it stays
        // on screen, and the error travels with it.
        setMintStatus((cur) => (cur.data
          ? { ...cur, phase: 'ready', error: String(err?.message || err) }
          : {
            phase: 'unavailable', data: null, timeline: [], unattributed: null,
            fetchedAt: null, error: String(err?.message || err),
          }));
      } finally {
        inFlight = false;
      }
    };
    void read({ first: true });
    // The API is a live header read; avoid reusing the 5-second HTTP cache.
    // Poll at that same cadence so normal ledger closes are reflected promptly.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, 5_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [page]);

  // One older page, appended. Paging stops on an error and says so rather than
  // silently ending the list as if it were complete.
  const loadOlderHistory = useCallback(async () => {
    const address = active?.pubkey || watchAddress;
    const before = chainHistory.next;
    if (!address || !before || chainHistory.loadingMore) return;
    setChainHistory((cur) => ({ ...cur, loadingMore: true, error: '' }));
    try {
      const doc = await getAccountHistory(address, { limit: HISTORY_PAGE, before });
      setChainHistory((cur) => ({
        ...cur,
        phase: 'ready',
        items: mergeHistory(cur.items, doc),
        total: Number.isFinite(Number(doc?.total)) ? Number(doc.total) : cur.total,
        coverage: doc?.coverage || cur.coverage,
        next: doc?.next_cursor || null,
        loadingMore: false,
      }));
    } catch (err) {
      setChainHistory((cur) => ({
        ...cur,
        loadingMore: false,
        error: `Could not load older transfers (${String(err?.message || err)}).`,
      }));
    }
  }, [active?.pubkey, watchAddress, chainHistory.next, chainHistory.loadingMore]);

  // Read the signed-in account's other linked wallets for the Send shortcuts.
  // Their public balances are informational only; the sender's local key remains
  // the sole authority for signing, and the normal review gate is unchanged.
  useEffect(() => {
    const recipients = watchAddresses.filter((address) => address && address !== active?.pubkey);
    if (page !== 'send' || recipients.length === 0) return undefined;
    let cancelled = false;
    setSendRecipientBalances((current) => {
      const next = {};
      for (const address of recipients) {
        next[address] = current[address] ?? { kind: 'loading', value: null };
      }
      return next;
    });
    Promise.all(recipients.map(async (address) => {
      let entry;
      try { entry = readAccountBalance(await getAccount(address)); }
      catch { entry = { kind: 'unavailable', value: null }; }
      if (!cancelled) setSendRecipientBalances((current) => ({ ...current, [address]: entry }));
    }));
    return () => { cancelled = true; };
  }, [page, watchAddresses, active?.pubkey]);

  // Recipient/sender balance notifications.
  //
  // The index emits an event for every row it COMMITS (after the ledger result
  // is link-confirmed), so a balance refresh is triggered by verified ledger
  // application instead of a fixed timer. If the stream is unavailable — no
  // indexer configured, proxy buffering, EventSource missing — the shared
  // startBalanceRefresh() poller keeps the wallet usable (its contract lives in
  // lib/walletBalanceRefresh.mjs and tests/balance-refresh.test.mjs).
  // EventSource reconnects on its own and replays from `Last-Event-ID`, so a
  // dropped connection does not lose the transfer that caused the refresh.
  useEffect(() => {
    const pubkey = active?.pubkey;
    if (!pubkey) return undefined;
    let closed = false;
    let stream = null;
    let stopPolling = null;
    const startPolling = () => {
      if (stopPolling || closed) return;
      stopPolling = startBalanceRefresh(pubkey, refreshBalance, window);
    };
    if (!isIndexerConfigured() || typeof window === 'undefined' || !window.EventSource) {
      startPolling();
      return () => { closed = true; stopPolling?.(); };
    }
    try {
      stream = new window.EventSource(accountEventsUrl(pubkey, 0));
      stream.addEventListener('tx', () => { void refreshBalance(pubkey); });
      stream.addEventListener('error', () => {
        // The stream is bounded (the indexer closes it after ~1 minute) and a
        // proxy can buffer it; poll until EventSource reconnects.
        startPolling();
      });
    } catch {
      startPolling();
    }
    return () => {
      closed = true;
      if (stream) stream.close();
      stopPolling?.();
    };
  }, [active?.pubkey, refreshBalance]);

  // Re-check one stored transfer against the exact-hash endpoint. This never
  // upgrades a row to "confirmed" without a ledger result for that hash.
  const recheckTransfer = useCallback(async (entry) => {
    if (!active?.name || !entry?.txhash) return;
    if (!isIndexerConfigured()) { notify('No indexer configured — cannot read the ledger result.', 'err'); return; }
    try {
      const verdict = await waitForConfirmation(entry.txhash, { timeoutMs: 8_000 });
      if (verdict.status === 'confirmed' || verdict.status === 'failed') {
        setHistory(historyPatch(active.name, entry.txhash, {
          status: verdict.status, ledger: verdict.ledger,
          ledger_hash: verdict.ledger_hash, result_code: verdict.result_code,
          evidence: verdict.evidence, confirmed_at: verdict.confirmation_time,
        }));
        notify(`Ledger ${verdict.ledger}: ${verdict.result_code}.`, verdict.status === 'confirmed' ? 'ok' : 'err');
      } else {
        notify(`Still ${verdict.status}${verdict.reason ? ` (${verdict.reason})` : ''} — no ledger result for this hash yet.`, 'warn');
      }
    } catch (err) { notify(String(err.message || err), 'err'); }
  }, [active?.name, notify]);

  // ---------------- wallet actions (logic unchanged from the audited build) ----
  async function doCreate(e) {
    e.preventDefault();
    const operationEpoch = lockEpoch.current;
    setBusy(true);
    try {
      const r = await keystoreCreate(newName.trim(), newPass);
      const seed32 = decodeSeed(r.seedS);
      r.seedS = '';
      if (operationEpoch !== lockEpoch.current) {
        zeroSeed(seed32);
        return;
      }
      setWallets(visibleWallets());
      // The freshly created seed stays in this closure's memory only —
      // the same trust level as an explicit Unlock.
      activateWallet({ name: r.name, pubkey: r.pubkeyG, seed32 });
      setNewName(''); setNewPass(''); setImportSeed('');
      setAccountsOpen(false);
      setWalletManagerView('list');
      // A wallet created while signed in belongs to that account, so a later
      // account on this browser cannot adopt it.
      if (accountEmail) bindOwner(r.name, accountEmail);
      notify(`Wallet "${r.name}" created. Export the encrypted backup NOW (Settings) and store it privately — it is the only copy.`, 'ok');
      // Only refreshes a Drive backup this session already has access to; it
      // never opens a Google window on its own.
      void backupSilentlyAfterChange(r.name);
    } catch (err) { notify(String(err.message || err), 'err'); }
    finally {
      setNewPass('');
      setImportSeed('');
      setBusy(false);
    }
  }

  async function doImport(e) {
    e.preventDefault();
    const operationEpoch = lockEpoch.current;
    setBusy(true);
    try {
      const r = await keystoreImport(newName.trim(), importSeed.trim(), newPass);
      const seed32 = decodeSeed(r.seedS);
      r.seedS = '';
      if (operationEpoch !== lockEpoch.current) {
        zeroSeed(seed32);
        return;
      }
      setWallets(visibleWallets());
      activateWallet({ name: r.name, pubkey: r.pubkeyG, seed32 });
      setNewName(''); setNewPass(''); setImportSeed('');
      setAccountsOpen(false);
      setWalletManagerView('list');
      notify(`Wallet "${r.name}" imported.`, 'ok');
      void backupSilentlyAfterChange(r.name);
    } catch (err) { notify(String(err.message || err), 'err'); }
    finally {
      setNewPass('');
      setImportSeed('');
      setBusy(false);
    }
  }

  // A new or imported wallet is bound to the signed-in account and, when this
  // page already has Drive access, re-uploaded as ciphertext. Failures stay
  // silent here: Settings owns the visible status and the manual button.
  async function backupSilentlyAfterChange(name) {
    try {
      const result = await backupSilently(keystoreExport());
      if (result.backedUp && result.email) {
        bindOwner(name, result.email);
        // A silent upload counts: the copy in Drive is current again, and it
        // covers the wallet that was just added.
        recordDriveBackup(result.email, result.modifiedTime ? new Date(result.modifiedTime) : new Date(), {
          wallets: keystoreList().map((wallet) => wallet.pubkey),
        });
        setWallets(visibleWallets());
      }
    } catch { /* no session, no Drive grant, or offline: manual backup remains */ }
  }

  async function doUnlock(e) {
    e.preventDefault();
    if (!unlockName) return;
    const name = unlockName;
    const password = unlockPass;
    setUnlockPass('');
    const ok = await unlockWithPassword(name, password);
    if (ok) setUnlockName('');
  }

  // One unlock path for both the sign-in card and the account switcher. The
  // password is only ever held for the duration of the call; the session it
  // produces replaces any previous one through activateWallet(), which wipes
  // the previous seed first.
  async function unlockWithPassword(name, password) {
    const operationEpoch = lockEpoch.current;
    setBusy(true);
    try {
      const seed32 = await keystoreUnlock(name, password);
      if (operationEpoch !== lockEpoch.current) {
        zeroSeed(seed32);
        return false;
      }
      // Only a wallet this account may see can be unlocked: another account's
      // wallet stays hidden even if its name is guessed.
      const list = visibleWallets();
      const entry = list.find(w => w.name === name);
      activateWallet({ name, pubkey: entry?.pubkey, seed32 });
      notify(`Wallet "${name}" unlocked.`, 'ok');
      return true;
    } catch (err) {
      notify(String(err?.message || err), 'err');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function unlockWithDevice(name = unlockName) {
    const entry = visibleWallets().find((wallet) => wallet.name === name);
    if (!entry || !hasBiometricUnlock(name)) {
      notify('Device unlock is not set up for this wallet. Use its password.', 'err');
      return false;
    }
    const operationEpoch = lockEpoch.current;
    setBusy(true);
    try {
      const seed32 = await unlockWithBiometric(name, entry.pubkey);
      if (operationEpoch !== lockEpoch.current) {
        zeroSeed(seed32);
        return false;
      }
      activateWallet({ name, pubkey: entry.pubkey, seed32 });
      setUnlockName('');
      notify(`Wallet "${name}" unlocked on this device.`, 'ok');
      return true;
    } catch (err) {
      notify(String(err.message || 'Device unlock failed. Use the wallet password.'), 'err');
      return false;
    } finally {
      setBusy(false);
    }
  }

  // The homepage shows whether each local wallet has been created on-chain.
  // Public account lookups need no unlock and never access key material.
  useEffect(() => {
    if (page !== 'overview' || wallets.length === 0) return undefined;
    let cancelled = false;
    setOverviewWalletStates((current) => {
      const next = {};
      for (const wallet of wallets) {
        next[wallet.name] = current[wallet.name]?.pubkey === wallet.pubkey
          ? current[wallet.name]
          : { pubkey: wallet.pubkey, balance: { kind: 'loading', value: null } };
      }
      return next;
    });
    Promise.all(wallets.map(async (wallet) => {
      let balanceState;
      try { balanceState = readAccountBalance(await getAccount(wallet.pubkey)); }
      catch { balanceState = { kind: 'unavailable', value: null }; }
      if (!cancelled) {
        setOverviewWalletStates((current) => ({
          ...current,
          [wallet.name]: { pubkey: wallet.pubkey, balance: balanceState },
        }));
      }
    }));
    return () => { cancelled = true; };
  }, [page, wallets]);

  // Balances inside the switcher come from a read-only lookup of each public
  // address — no key involved — so a locked wallet can still show its amount
  // and a person can pick by balance. One failure only affects its own row.
  useEffect(() => {
    if (!accountsOpen || wallets.length === 0) return undefined;
    let cancelled = false;
    setSwitchBalances((cur) => {
      const next = {};
      for (const w of wallets) next[w.name] = cur[w.name] ?? { kind: 'loading', value: null };
      return next;
    });
    (async () => {
      for (const w of wallets) {
        if (!w.pubkey) continue;
        let entry;
        try {
          entry = readAccountBalance(await getAccount(w.pubkey));
        } catch {
          entry = { kind: 'unavailable', value: null };
        }
        if (cancelled) return;
        setSwitchBalances((cur) => ({ ...cur, [w.name]: entry }));
      }
    })();
    return () => { cancelled = true; };
  }, [accountsOpen, wallets]);

  async function toggleBiometricUnlock() {
    if (!active?.seed32) {
      notify('Unlock this wallet with its password before setting up device unlock.', 'err');
      return;
    }
    const name = active.name;
    if (hasBiometricUnlock(name)) {
      removeBiometricUnlock(name);
      setBiometricWallets(biometricWalletNames());
      notify('Device unlock removed from this browser. Your wallet password still works.', 'ok');
      return;
    }
    const session = activeRef.current;
    const operationEpoch = lockEpoch.current;
    const canContinue = () => operationEpoch === lockEpoch.current && activeRef.current === session;
    const seed32 = session.seed32.slice();
    pendingSeedsRef.current.add(seed32);
    setBusy(true);
    try {
      await enableBiometricUnlock({
        name, pubkey: active.pubkey, seed32,
        shouldCancel: () => !canContinue(),
      });
      if (!canContinue()) return;
      setBiometricWallets(biometricWalletNames());
      notify('Device unlock enabled for this browser. Keep using your wallet password as a backup.', 'ok');
    } catch (err) {
      notify(String(err.message || err), 'err');
    } finally {
      zeroSeed(seed32);
      pendingSeedsRef.current.delete(seed32);
      setBusy(false);
    }
  }

  function doLock() {
    lockWallet('Wallet locked — signing key cleared from memory.');
  }

  async function checkWalletRemoval(wallet) {
    if (!wallet?.name || !wallet?.pubkey || wallet.name !== walletDetails?.name) return;
    setBusy(true);
    setWalletRemoveState({ phase: 'checking', message: 'Checking the live network…' });
    try {
      const identity = await verifyNetworkIdentity();
      if (!identity.ok || identity.network !== EXPECTED_NETWORK_ID) {
        throw new Error('Could not verify NSAT Mainnet. The wallet was not removed. Try again when the network is available.');
      }
      const account = await getAccount(wallet.pubkey);
      if (account?.status !== 'not_found') {
        throw new Error('This address has an on-chain account (or an unexpected response). It was not removed. Move any funds or retain the wallet safely.');
      }
      setWalletRemoveState({ phase: 'confirm', message: 'Mainnet confirms this address has no on-chain account. Confirm only if you have another backup or no longer need this key.' });
    } catch (error) {
      setWalletRemoveState({ phase: 'error', message: String(error?.message || 'Wallet was not removed.') });
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemoveWallet(wallet) {
    if (!wallet?.name || !wallet?.pubkey || wallet.name !== walletDetails?.name
      || walletRemoveState?.phase !== 'confirm') return;
    setBusy(true);
    setWalletRemoveState({ phase: 'checking', message: 'Rechecking Mainnet before removal…' });
    try {
      const identity = await verifyNetworkIdentity();
      if (!identity.ok || identity.network !== EXPECTED_NETWORK_ID) {
        throw new Error('Could not verify NSAT Mainnet. The wallet was not removed.');
      }
      const account = await getAccount(wallet.pubkey);
      if (account?.status !== 'not_found') {
        throw new Error('The address now has an on-chain account or returned an unexpected response. The wallet was not removed.');
      }
      if (activeRef.current?.name === wallet.name) lockWallet();
      const removed = keystoreRemove(wallet.name);
      if (!removed) throw new Error('The wallet was not found in this device’s keystore.');
      removeBiometricUnlock(wallet.name);
      historyClear(wallet.name);
      unbindOwner(wallet.name);
      setWalletDetails(null);
      setWalletManagerView('list');
      refreshWallets();
      setOverviewWalletStates((current) => {
        const next = { ...current };
        delete next[wallet.name];
        return next;
      });
      setSwitchBalances((current) => {
        const next = { ...current };
        delete next[wallet.name];
        return next;
      });
      setWalletRemoveState(null);
      notify(`“${wallet.name}” was removed from this device. Its Google Drive backup was left unchanged.`, 'ok');
    } catch (error) {
      setWalletRemoveState({ phase: 'error', message: String(error?.message || 'Wallet was not removed.') });
    } finally {
      setBusy(false);
    }
  }

  // Account switching never reuses the previous key: it drops the active seed
  // and asks for THIS wallet's password, exactly like a fresh unlock. Nothing
  // is signed until that password is entered again.
  function switchTo(name) {
    if (activeRef.current?.name === name) {
      setAccountsOpen(false);
      return;
    }
    setSwitchName(name);
    setSwitchPass('');
    setAccountsOpen(true);
  }

  async function doSwitchAccount(e) {
    e.preventDefault();
    const name = switchName;
    const password = switchPass;
    setSwitchPass('');
    if (!name || !password) return;
    // Lock first so the previous key cannot survive a failed unlock.
    if (activeRef.current) lockWallet();
    const ok = await unlockWithPassword(name, password);
    if (ok) {
      setSwitchName('');
      setAccountsOpen(false);
      setPage('overview');
    }
  }

  function doBackup() {
    const blob = keystoreExport();
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/json' }));
    // In the MV3 extension popup an anchor-click download is silently
    // dropped; the chrome.downloads API (granted by the manifest) is the
    // supported path there. The web page keeps the anchor-click flow.
    const ext = typeof chrome !== 'undefined' && chrome?.downloads?.download;
    if (ext) {
      chrome.downloads.download(
        { url, filename: 'scw-web-backup.json' },
        () => URL.revokeObjectURL(url),
      );
    } else {
      const a = document.createElement('a');
      a.href = url; a.download = 'scw-web-backup.json'; a.click();
      URL.revokeObjectURL(url);
    }
    notify('Encrypted keystore downloaded. Keep it private.', 'ok');
  }

  async function doRestore(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const backup = await f.text();
      lockWallet();
      keystoreRestore(backup);
      refreshWallets();
      notify('Keystore restored. Unlock a wallet to sign.', 'ok');
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
    const session = activeRef.current;
    if (!session?.seed32 || session.name !== active.name) {
      notify('Wallet locked. Unlock again before signing.', 'err');
      return false;
    }
    setBusy(true);
    const operationEpoch = lockEpoch.current;
    const canContinue = () => operationEpoch === lockEpoch.current
      && activeRef.current === session;
    // Sign from a tracked private copy. Lock zeroizes session and pending copy,
    // and the signing engine checks canContinue after every async boundary.
    const seed32 = session.seed32.slice();
    pendingSeedsRef.current.add(seed32);
    const requireActiveSession = () => {
      if (!canContinue()) throw new Error('Wallet locked — transaction signing cancelled.');
    };
    try {
      requireActiveSession();
      // A wallet whose account is not on chain cannot be a source: the node
      // would answer "source account missing" after the signature existed.
      // Check first and say what actually has to happen.
      const source = await getAccount(active.pubkey).catch(() => null);
      requireActiveSession();
      if (!source) {
        notify('Could not read this account from the network — nothing was signed.', 'err');
        return false;
      }
      if (source.status !== 'ok') {
        notify('This wallet has no on-chain account yet, so it cannot send. An account is created by its first incoming deposit (≈ 2× base reserve). Send funds to this address first.', 'err');
        return false;
      }
      const baseFee = await estimateFee();
      requireActiveSession();
      const info = await getChainInfo();
      requireActiveSession();
      const reserve = Number(info?.info?.ledger?.baseReserve || 0);
      const amtClean = amount.replace(/[,_ ]/g, '');
      if (createDest && reserve > 0 && /^\d+$/.test(amtClean)
        && BigInt(amtClean) < BigInt(2 * reserve)) {
        notify(`CREATE starting balance must be ≥ ${BigInt(2 * reserve).toLocaleString()} NSAT (2× base reserve) — the chain would charge the fee and fail the operation.`, 'err');
        setBusy(false);
        return false;
      }
      const signed = await buildSignedTx({
        seed32,
        netPassphrase: EXPECTED_NETWORK_ID,   // the VERIFIED identity, exact
        seqFetch: async () => getAccount(active.pubkey),
        destG: dest.trim(),
        amount: amount.trim(),
        fee: baseFee,
        create: createDest,
        shouldCancel: () => !canContinue(),
      });
      requireActiveSession();
      requireActiveSession();
      const r = await submitSignedTransaction(signed.envelopeBase64);
      // Locking after submission cannot revoke a signed envelope already sent.
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
      notify('Submitted — waiting for this exact hash to appear in a closed ledger…', 'warn');
      // The ONLY thing that may confirm a transfer is the ledger's own result
      // for THIS transaction hash. The account sequence also advances for a
      // failed operation, and the balance also moves for an unrelated later
      // transfer, so neither is evidence about this payment.
      const submittedAt = Math.floor(Date.now() / 1000);
      const verdict = await waitForConfirmation(signed.txHashHex, {
        submittedAt,
        timeoutMs: 90_000,
      });
      const base = {
        time: new Date().toLocaleString(), dir: 'sent', to: dest.trim(),
        amount: amount.trim(), fee: signed.fee, txhash: signed.txHashHex,
      };
      if (verdict.status === 'confirmed' || verdict.status === 'failed') {
        historyPush(active.name, {
          ...base,
          ledger: verdict.ledger, ledger_hash: verdict.ledger_hash,
          status: verdict.status, result_code: verdict.result_code,
          evidence: verdict.evidence, confirmed_at: verdict.confirmation_time,
        });
        setHistory(historyLoad(active.name));
        setAmount(''); setDest(''); setReview(null);
        notify(
          verdict.status === 'confirmed'
            ? `Confirmed on ledger ${verdict.ledger} (${verdict.result_code}).`
            : `Included in ledger ${verdict.ledger} but FAILED on-chain: ${verdict.result_code}. Only the fee moved.`,
          verdict.status === 'confirmed' ? 'ok' : 'err');
      } else {
        // Not a confirmation and not a failure: the index could not decide yet.
        // The hash is kept so the transfer can be re-checked instead of guessed.
        historyPush(active.name, {
          ...base, ledger: null, ledger_hash: null,
          status: 'unconfirmed', reason: verdict.reason || verdict.status,
        });
        setHistory(historyLoad(active.name));
        notify(`Not confirmed yet (${verdict.status}${verdict.reason ? `: ${verdict.reason}` : ''}). Nothing is shown as confirmed until the ledger result for this hash is read.`, 'warn');
      }
      void refreshBalance(active.pubkey);
      // Re-read the header so the ledger number and live fee do not go stale.
      void verifyNetwork();
      return true;
    } catch (err) { notify(String(err.message || err), 'err'); return false; }
    finally {
      zeroSeed(seed32);
      pendingSeedsRef.current.delete(seed32);
      setBusy(false);
    }
  }

  function openReview() {
    const amtClean = amount.replace(/[,_ ]/g, '');
    const feeVal = fee ?? 0;
    setReview({
      amount: amtClean, fee: feeVal,
      total: (BigInt(amtClean) + BigInt(feeVal)).toString(),
    });
  }

  const netOk = !!net?.ok;
  const amtInt = /^\d+$/.test(amount.replace(/[,_ ]/g, ''))
    && BigInt(amount.replace(/[,_ ]/g, '') || '0') > 0n;
  const destOk = ACCOUNT_RE.test(dest.trim()) && dest.trim() !== active?.pubkey;
  const hasWallets = wallets.length > 0;
  // Wallets still encrypted on this device but bound to another Google account:
  // they are not listed, and the unlock form says so instead of looking empty.
  const hiddenWallets = Math.max(0, keystoreList().length - wallets.length);

  const ledger = net?.ledger ?? null;

  // Signed out: the gate is the whole screen. Nothing of the wallet — address,
  // balance, wallet names, history or the tab bar — is reachable before signing
  // in, which is what makes "sign out" a real end of use. The gate card renders
  // immediately, including in the static HTML; it reports the in-flight session
  // check itself instead of the page looking empty.
  if (signInRequired && (!accountReady || !accountUid)) {
    return (
      <div className="nw-root">
        <div className="nw-phone">
          <main className="nw-content">
            <h1 className="nw-visually-hidden">NSAT Wallet</h1>
            <GoogleAccount variant="gate" />
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="nw-root">
      <div className="nw-phone">
        {/* App bar, iPhone-build order: the address on the left, the account
         * in a pill in the middle, search (or lock) on the right. A sub-page
         * swaps the address button for Back, so the tab bar keeps its job. */}
        <header className="nw-appbar">
          {SUB_PAGES.includes(page) ? (
            <button type="button" className="nw-round-btn" onClick={() => setPage('overview')}
              aria-label="Back to wallet" title="Back to wallet">←</button>
          ) : (
            <button type="button" className="nw-round-btn" onClick={() => setPage('receive')}
              aria-label="Show my address" title="Receive — show your address">▦</button>
          )}
          <button type="button" className="nw-account-pill"
            onClick={() => {
              setAccountsOpen(true);
              setWalletManagerView('list');
              setWalletDetails(null);
              setSwitchName('');
              setSwitchPass('');
            }}
            aria-haspopup="dialog"
            title={`${netOk ? 'Connected' : net == null ? 'Connecting…' : 'Offline'} — switch wallet`}>
            <span className="nw-tokenlogo"><NsatCoinMark className="nw-coin-mark" /></span>
            <span className="nw-account-name">
              {active ? active.name : hasWallets ? 'Locked' : watchAddress ? 'Watch only' : 'NSAT Wallet'}
            </span>
            <span className={'nw-dot ' + (netOk ? 'ok' : net == null ? 'wait' : 'err')} aria-hidden />
            <span className="nw-account-chevron" aria-hidden>⌄</span>
          </button>
          {active ? (
            <button type="button" className="nw-round-btn" onClick={doLock}
              aria-label="Lock wallet" title="Lock the active wallet (signing stops)">🔒</button>
          ) : (
            <a className="nw-round-btn" href="/explorer/" aria-label="Search the chain"
              title="Search accounts and transactions">⌕</a>
          )}
        </header>
        {/* The phone shell carries the page's only <h1>, kept out of the visual
         * layout because the app bar states the same thing in app-sized type. */}
        <h1 className="nw-visually-hidden">{active ? `${active.name} — NSAT Wallet` : 'NSAT Wallet'}</h1>

      <main className="nw-content">
          {!configured && (
            <p className="nw-dim nw-small" style={{ marginTop: 0 }}>
              Offline: no gateway configured for this build.
            </p>
          )}

          {page !== 'overview' && (
            <div className="nw-section-head">
              <h2 className="nw-section-title">{PAGE_TITLE[page]}</h2>
              {PAGE_LEAD[page] ? <p className="nw-page-lead">{PAGE_LEAD[page]}</p> : null}
            </div>
          )}

          {/* Activity opens on the mint status: read-only ledger-header
           * accounting, so it does not need an unlocked wallet and must not be
           * pushed below the unlock form. */}
          {page === 'activity' ? <MintStatusCard mint={mintStatus} /> : null}

          {/* Locked state: unlocking is the only thing that matters, so it is
           * a card in the flow instead of a control in a toolbar. */}
          {!active && hasWallets && (
            <form className="nw-unlock nw-unlock-card" onSubmit={doUnlock}>
              <label className="nw-label" htmlFor="nw-unlock-name">Unlock a wallet</label>
              <select id="nw-unlock-name" value={unlockName}
                onChange={(e) => setUnlockName(e.target.value)}>
                <option value="">— choose a wallet —</option>
                {wallets.map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
              </select>
              <input type="password" placeholder="Password" value={unlockPass}
                onChange={(e) => setUnlockPass(e.target.value)} autoComplete="current-password"
                aria-label="Wallet password" />
              <button className="nw-send-btn" type="submit"
                disabled={busy || !unlockName}>Unlock with password</button>
              {hiddenWallets > 0 && (
                <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
                  {`${hiddenWallets} wallet${hiddenWallets === 1 ? '' : 's'} on this device `
                    + 'belong to another Google account and stay hidden until that account signs in. Nothing was deleted.'}
                </p>
              )}
              {unlockName && biometricWallets.includes(unlockName) ? (
                <button type="button" className="nw-chip-btn" disabled={busy}
                  onClick={() => void unlockWithDevice()}>
                  Unlock with this device
                </button>
              ) : null}
            </form>
          )}

          {page === 'overview' && !active && wallets.length === 0 && watchAddress && (
            <WatchOnlyHome address={watchAddress} addresses={watchAddresses} balance={balance}
              funded={funded} onSelect={setWatchPick}
              onReceive={() => setPage('receive')} onSettings={() => setPage('settings')} />
          )}

          {page === 'overview' && !(watchAddress && !active && wallets.length === 0) && (
            <OverviewPage active={active} wallets={wallets} balance={balance} funded={funded}
              walletChainStates={overviewWalletStates} baseReserve={reserve}
              bus={{ busy, doCreate, doImport, newName, setNewName, newPass, setNewPass,
                importSeed, setImportSeed, accountEmail }}
              net={{ net, netOk, ledger: liveLedger ?? ledger, fee, reserve }}
              notify={notify}
              onSend={() => setPage('send')} onReceive={() => setPage('receive')}
              onActivity={() => setPage('activity')}
              onManage={() => setPage('settings')} />
          )}

          {page === 'send' && (
            <SendPage
              state={{ dest, setDest, amount, setAmount, createDest, setCreateDest }}
              gate={{ netOk, fee, amtInt, destOk, reserve }} busy={busy}
              active={active} balance={balance}
              funded={funded}
              linkedRecipients={watchAddresses
                .filter((address) => address && address !== active?.pubkey)
                .map((address) => ({
                  address,
                  name: wallets.find((wallet) => wallet.pubkey === address)?.name || 'Linked wallet',
                }))}
              recipientBalances={sendRecipientBalances}
              onChooseRecipient={(address) => setDest(address)}
              onReview={openReview} />
          )}

          {page === 'receive' && (
            <ReceivePage activePubkey={active?.pubkey || watchAddress || ''} notify={notify} />
          )}

          {page === 'shielded' && <ShieldedGatePage />}

          {page === 'activity' && (
            <ActivityPage history={history}
              activeName={active?.name || (watchAddress ? `watch only · ${shortAddr(watchAddress, 6)}` : '')}
              chain={chainHistory}
              onLoadOlder={loadOlderHistory}
              onRecheck={recheckTransfer} canRecheck={isIndexerConfigured()} />
          )}

          {page === 'settings' && (
            <SettingsPage
                              s={{ active, busy, doLock, doBackup, doRestore, wallets, biometricWallets,
                onSwitch: switchTo, onToggleBiometric: toggleBiometricUnlock,
                onReloadWallets: refreshWallets }}
              onShielded={() => setPage('shielded')} />
          )}
      </main>

      {/* The tab bar is the app's only navigation, so it is always present —
       * even before a wallet exists (Activity is empty, Settings still holds
       * the link out to the rest of the site). */}
      <nav className="nw-bottomnav" aria-label="Wallet sections">
          {NAV_PAGES.map((p) => (
            <button key={p} type="button"
              className={'nw-navitem' + (page === p ? ' is-active' : '')}
              onClick={() => setPage(p)}
              aria-current={page === p ? 'page' : undefined}>
              <span className="nw-navicon" aria-hidden>
                {p === 'overview'
                  ? <NsatCoinMark className="nw-nav-coin" />
                  : PAGE_GLYPH[p]}
              </span>
              <span className="nw-navlabel">{NAV_LABEL[p]}</span>
            </button>
          ))}
      </nav>
      </div>

      {review && (
        <div className="nw-modal-back" role="dialog" aria-modal="true"
          onKeyDown={(e) => { if (e.key === 'Escape' && !busy) setReview(null); }}
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setReview(null); }}>
          <div className="nw-modal" tabIndex={-1} autoFocus>
            <div className="nw-step">REVIEW & SIGN · NSAT</div>
            <h3 style={{ color: 'var(--text)' }}>Review transaction</h3>
            <div className="nw-kv"><span className="nw-k">Recipient</span>
              <span className="nw-v nw-mono nw-small">{dest.trim()}</span></div>
            <div className="nw-kv"><span className="nw-k">Amount</span>
              <span className="nw-v">{formatExactBalance(review.amount)} NSAT</span></div>
            <div className="nw-kv"><span className="nw-k">Fee (live ledger)</span>
              <span className="nw-v">{review.fee} NSAT</span></div>
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

      {/* Account switcher: the name pill opens this list, the way the iPhone
       * build does. Picking another wallet locks the current key and asks for
       * the chosen wallet's password — switching never carries a key over. */}
      {accountsOpen && (
        <div className="nw-modal-back" role="dialog" aria-modal="true"
          aria-labelledby="nw-accounts-title"
          onKeyDown={(e) => { if (e.key === 'Escape' && !busy) setAccountsOpen(false); }}
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setAccountsOpen(false); }}>
          <div className="nw-modal" tabIndex={-1} autoFocus>
            <div className="nw-step">WALLETS ON THIS DEVICE</div>
            <h3 id="nw-accounts-title" style={{ color: 'var(--text)' }}>
              {walletManagerView === 'create' ? 'Create a New Wallet'
                : walletManagerView === 'import' ? 'Import an Existing Wallet'
                  : walletManagerView === 'details' ? 'Wallet details' : 'Wallets'}
            </h3>

            {walletManagerView === 'list' && (
              <>
                <div className="nw-wallet-manager-actions">
                  <button type="button" className="nw-manager-action"
                    onClick={() => { setSwitchName(''); setWalletManagerView('create'); }}>
                    <span className="nw-manager-action-icon" aria-hidden>＋</span>
                    Create a New Wallet
                  </button>
                  <button type="button" className="nw-manager-action"
                    onClick={() => { setSwitchName(''); setWalletManagerView('import'); }}>
                    <span className="nw-manager-action-icon" aria-hidden>↓</span>
                    Import an Existing Wallet
                  </button>
                </div>
                {wallets.length === 0 ? (
                  <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>
                    No wallet is stored in this browser yet — create or import one to sign here.
                  </p>
                ) : (
                  <ul className="nw-acc-list">
                    {wallets.map((w) => {
                      const isActive = active?.name === w.name;
                      return (
                        <li key={w.name} className={'nw-acc-row' + (isActive ? ' is-active' : '')}>
                          <button type="button" className="nw-acc-main"
                            onClick={() => (isActive ? setAccountsOpen(false) : switchTo(w.name))}
                            aria-current={isActive ? 'true' : undefined}>
                            <span className="nw-acc-name">{w.name}</span>
                            <span className="nw-acc-meta">
                              <span className="nw-mono">{shortAddr(w.pubkey, 6)}</span>
                              <span className="nw-acc-bal">{accountBalanceLine(switchBalances[w.name])}</span>
                            </span>
                          </button>
                          {isActive ? <span className="nw-badge ok">active</span> : null}
                          <button type="button" className="nw-wallet-gear"
                            aria-label={`Details for ${w.name}`}
                            onClick={() => {
                              setWalletDetails(w);
                              setWalletRemoveState(null);
                              setWalletManagerView('details');
                            }}>
                            ⚙
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {switchName && (
                  <form className="nw-unlock" onSubmit={doSwitchAccount} style={{ marginTop: 12 }}>
                    <label className="nw-label" htmlFor="nw-switch-pass">
                      {`Password for “${switchName}”`}
                    </label>
                    <input id="nw-switch-pass" type="password" placeholder="Password"
                      value={switchPass} onChange={(e) => setSwitchPass(e.target.value)}
                      autoComplete="current-password" autoFocus
                      aria-label={`Password for ${switchName}`} />
                    <button className="nw-send-btn" type="submit" disabled={busy || !switchPass}>
                      {busy ? 'Unlocking…' : 'Unlock and switch'}
                    </button>
                    {biometricWallets.includes(switchName) ? (
                      <button type="button" className="nw-chip-btn" disabled={busy}
                        onClick={async () => {
                          if (await unlockWithDevice(switchName)) {
                            setSwitchName('');
                            setAccountsOpen(false);
                            setPage('overview');
                          }
                        }}>
                        Unlock with this device
                      </button>
                    ) : null}
                  </form>
                )}
                <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>
                  Switching locks the current wallet first and asks for the selected wallet’s password.
                </p>
              </>
            )}

            {walletManagerView === 'create' && (
              <>
                <button type="button" className="nw-ghost-btn nw-manager-back"
                  onClick={() => setWalletManagerView('list')}>← Wallets</button>
                <form onSubmit={doCreate} className="nw-txf">
                  <label className="nw-label" htmlFor="nw-manager-new-name">Wallet name</label>
                  <input id="nw-manager-new-name" value={newName}
                    onChange={(e) => setNewName(e.target.value)} placeholder="Personal wallet" required />
                  <label className="nw-label" htmlFor="nw-manager-new-pass">
                    Password (at least {MIN_PASSWORD_LENGTH} characters)
                  </label>
                  <input id="nw-manager-new-pass" type="password" value={newPass}
                    onChange={(e) => setNewPass(e.target.value)} autoComplete="new-password"
                    minLength={MIN_PASSWORD_LENGTH} required />
                  <p className="nw-small nw-dim">Google sign-in cannot recover this password.</p>
                  <button type="submit" className="nw-send-btn" disabled={busy}>
                    {busy ? 'Creating…' : 'Create Wallet'}
                  </button>
                </form>
              </>
            )}

            {walletManagerView === 'import' && (
              <>
                <button type="button" className="nw-ghost-btn nw-manager-back"
                  onClick={() => setWalletManagerView('list')}>← Wallets</button>
                <form onSubmit={doImport} className="nw-txf">
                  <label className="nw-label" htmlFor="nw-manager-import-name">Wallet name</label>
                  <input id="nw-manager-import-name" value={newName}
                    onChange={(e) => setNewName(e.target.value)} required />
                  <label className="nw-label" htmlFor="nw-manager-import-seed">Secret seed (S…)</label>
                  <input id="nw-manager-import-seed" type="password" spellCheck={false}
                    autoComplete="off" value={importSeed}
                    onChange={(e) => setImportSeed(e.target.value)} required />
                  <label className="nw-label" htmlFor="nw-manager-import-pass">
                    Password (at least {MIN_PASSWORD_LENGTH} characters)
                  </label>
                  <input id="nw-manager-import-pass" type="password" value={newPass}
                    onChange={(e) => setNewPass(e.target.value)} autoComplete="new-password"
                    minLength={MIN_PASSWORD_LENGTH} required />
                  <button type="submit" className="nw-send-btn" disabled={busy}>
                    {busy ? 'Importing…' : 'Import Wallet'}
                  </button>
                </form>
              </>
            )}

            {walletManagerView === 'details' && walletDetails && (
              <div className="nw-wallet-details">
                <button type="button" className="nw-ghost-btn nw-manager-back"
                  onClick={() => setWalletManagerView('list')}>← Wallets</button>
                <div className="nw-wallet-details-mark" aria-hidden>
                  <NsatCoinMark className="nw-coin-mark" />
                </div>
                <strong>{walletDetails.name}</strong>
                <div className="nw-small nw-dim nw-mono">{walletDetails.pubkey}</div>
                <button type="button" className="nw-chip-btn"
                  onClick={async () => {
                    await navigator.clipboard.writeText(walletDetails.pubkey);
                    notify('Copied public address.');
                  }}>Copy address</button>
                {active?.name === walletDetails.name
                  ? <span className="nw-badge ok">active</span>
                  : <button type="button" className="nw-send-btn" onClick={() => {
                    setWalletManagerView('list');
                    switchTo(walletDetails.name);
                  }}>Switch wallet</button>}
                <p className="nw-small nw-dim">
                  Private keys stay in the encrypted browser keystore and are never displayed here.
                </p>
                <p className="nw-small nw-dim">
                  Remove deletes only this device&apos;s encrypted key and local history. A Google Drive backup is not changed. Removal is available only after Mainnet confirms the address has no on-chain account.
                </p>
                {walletRemoveState?.phase === 'checking' && (
                  <p className="nw-small nw-dim" role="status">{walletRemoveState.message}</p>
                )}
                {walletRemoveState?.phase === 'error' && (
                  <p className="nw-small nw-google-error" role="alert">{walletRemoveState.message}</p>
                )}
                {walletRemoveState?.phase === 'confirm' ? (
                  <div className="nw-remove-confirm" role="alert">
                    <p className="nw-small">{walletRemoveState.message}</p>
                    <p className="nw-small nw-dim">
                      This permanently removes the encrypted key, device-unlock entry, and local history from this browser. It does not delete the Google Drive backup.
                    </p>
                    <div className="nw-btn-row">
                      <button type="button" className="nw-danger-btn" disabled={busy}
                        onClick={() => void confirmRemoveWallet(walletDetails)}>
                        Confirm remove
                      </button>
                      <button type="button" className="nw-ghost-btn" disabled={busy}
                        onClick={() => setWalletRemoveState(null)}>
                        Keep wallet
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="nw-danger-btn nw-remove-wallet"
                    disabled={busy}
                    onClick={() => void checkWalletRemoval(walletDetails)}>
                    {busy ? 'Checking…' : 'Check before removing'}
                  </button>
                )}
              </div>
            )}

            <div className="nw-btn-row">
              <button type="button" className="nw-ghost-btn" disabled={busy}
                onClick={() => setAccountsOpen(false)}>Close</button>
              {signInRequired && accountEmail ? (
                <button type="button" className="nw-danger-btn" disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      // Locks the wallet and clears the session before the
                      // Google call returns, then the gate replaces this screen.
                      await signOutGoogleSession();
                    } catch {
                      notify('Could not sign out of Google. Please try again.', 'err');
                    } finally {
                      // endSession also clears it; this keeps the panel usable
                      // when the sign-out request itself failed.
                      setBusy(false);
                    }
                  }}>
                  {busy ? 'Signing out…' : 'Sign out of Google'}
                </button>
              ) : null}
            </div>
            {signInRequired && accountEmail ? (
              <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
                {`Signing out ends this session as ${accountEmail}: the wallet locks, this screen is cleared and the next person starts at the sign-in screen. Wallets are not deleted.`}
              </p>
            ) : null}
          </div>
        </div>
      )}

      {toast && (
        <div className={`nw-toast ${toast.kind}`} role="status">{toast.text}</div>
      )}
    </div>
  );
}

/* ------------------------------ Watch only ------------------------------- */
// The address is a public pointer on the signed-in website account, so this
// device can show the balance and the receive screen without a key. Everything
// that needs a signature is explicitly out of reach here instead of failing
// later: no Send button, and a plain sentence saying why.
function WatchOnlyHome({ address, addresses = [], balance, funded, onSelect, onReceive, onSettings }) {
  const exact = balance == null ? '…' : formatExactBalance(balance);
  return (
    <div className="nw-home">
      <section className="nw-hero">
        <div className="nw-hero-amount">
          {exact}
          <span className="nw-hero-unit">NSAT</span>
        </div>
        <div className="nw-hero-foot">
          <span className={'nw-badge ' + (funded === true ? 'ok' : 'warn')}>
            {funded === true ? 'funded' : funded === false ? 'not funded yet' : 'funding unknown'}
          </span>
          <span className="nw-badge info">watch only</span>
          <span className="nw-chip-btn nw-mono">{shortAddr(address, 8)}</span>
        </div>
      </section>

      <div className="nw-quick-actions">
        <button type="button" className="nw-action-card" onClick={onReceive}>
          <span className="nw-action-icon" aria-hidden>▦</span>
          <span className="nw-action-label">Receive</span>
        </button>
        <button type="button" className="nw-action-card" onClick={onSettings}>
          <span className="nw-action-icon" aria-hidden>⚙</span>
          <span className="nw-action-label">Settings</span>
        </button>
      </div>

      {addresses.length > 1 ? (
        <section className="nw-card" aria-labelledby="nw-watch-pick-title">
          <h2 id="nw-watch-pick-title" style={{ color: 'var(--text)' }}>Linked wallets</h2>
          <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
            {`${addresses.length} wallets on this account. Pick the one to watch on this device.`}
          </p>
          <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
            {addresses.map((item) => (
              <button key={item} type="button" className="nw-chip-btn nw-mono"
                aria-pressed={item === address}
                onClick={() => onSelect?.(item)}>
                {item === address ? `● ${shortAddr(item, 6)}` : shortAddr(item, 6)}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="nw-card">
        <h2 style={{ color: 'var(--text)' }}>Read-only on this device</h2>
        <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
          This address is linked to your website account. An address is public, so it can be
          watched, but it cannot move funds: sending needs the wallet&apos;s password and key
          on the device that holds them.
        </p>
        <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
          To send from here, restore your encrypted keystore in Settings, or open the wallet on
          the device where it was created.
        </p>
      </section>
    </div>
  );
}

/* ------------------------- On-chain wallet status ----------------------- */
function WalletChainStatus({ wallets, states = {}, baseReserve, activeName = '' }) {
  if (!wallets?.length) return null;
  const reserveKnown = Number.isSafeInteger(baseReserve) && baseReserve > 0;
  const minimum = reserveKnown ? (BigInt(baseReserve) * 2n).toString() : null;
  const missing = wallets.filter((wallet) => states[wallet.name]?.balance?.kind === 'missing');

  return (
    <section className="nw-card nw-wallet-chain-status" aria-labelledby="nw-wallet-chain-title">
      <h2 id="nw-wallet-chain-title" style={{ color: 'var(--text)' }}>
        Wallet account status
      </h2>
      <p className="nw-small nw-dim" style={{ margin: '6px 0 10px' }}>
        Each address is checked directly against the network; this does not unlock or use its key.
      </p>
      <ul className="nw-acc-list">
        {wallets.map((wallet) => {
          const entry = states[wallet.name]?.balance;
          const notCreated = entry?.kind === 'missing';
          const exists = entry?.kind === 'exact';
          return (
            <li key={wallet.name} className="nw-acc-row nw-chain-wallet-row">
              <div className="nw-acc-main">
                <span className="nw-acc-name">{wallet.name}{wallet.name === activeName ? ' · active' : ''}</span>
                <span className="nw-acc-meta">
                  <span className="nw-mono">{shortAddr(wallet.pubkey, 6)}</span>
                  {exists ? (
                    <span className="nw-acc-bal">on chain · {formatExactBalance(entry.value)} NSAT</span>
                  ) : notCreated ? (
                    <span className="nw-badge warn">no on-chain account yet</span>
                  ) : entry?.kind === 'unavailable' ? (
                    <span className="nw-badge info">status unavailable</span>
                  ) : (
                    <span className="nw-acc-bal">checking…</span>
                  )}
                </span>
                {notCreated && (
                  <span className="nw-small nw-chain-minimum">
                    {minimum
                      ? `Needs at least ${fmtGroup(minimum)} NSAT in its first deposit (2× live base reserve).`
                      : 'Minimum first deposit unavailable — waiting for the live base reserve.'}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {missing.length > 0 && (
        <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>
          Until a wallet receives its minimum first deposit, it has no account on-chain and cannot send.
        </p>
      )}
    </section>
  );
}

/* --------------------------------- Overview ------------------------------ */
function OverviewPage({ active, wallets, balance, funded, walletChainStates, baseReserve, bus, net, notify, onSend, onReceive, onActivity, onManage }) {
  // First run is one decision, not two competing forms: a phone wallet offers
  // Create or Import as a segmented control, then shows the chosen form.
  const [mode, setMode] = useState('create');
  // With a wallet already stored, creating another one is a deliberate act,
  // not something to put in front of the unlock form.
  const [showNew, setShowNew] = useState(false);
  const hideSetup = wallets.length > 0 && !showNew;
  if (!active) {
    return (
      <div>
        {wallets.length > 0 && (
          <WalletChainStatus wallets={wallets} states={walletChainStates} baseReserve={baseReserve} />
        )}
        {wallets.length > 0 && (
          <section className="nw-card" hidden={!hideSetup}>
            <h2 style={{ color: 'var(--text)' }}>Add another wallet</h2>
            <p className="nw-small nw-dim" style={{ margin: '8px 0 12px' }}>
              Create a new wallet or restore one from a backup. Existing wallets stay as they are.
            </p>
            <button type="button" className="nw-chip-btn" onClick={() => setShowNew(true)}>
              Create or import another wallet
            </button>
          </section>
        )}
        <div hidden={hideSetup}>
        <div className="nw-segmented" role="tablist" aria-label="Wallet setup">
          <button type="button" role="tab" aria-selected={mode === 'create'}
            className={'nw-seg' + (mode === 'create' ? ' is-active' : '')}
            onClick={() => setMode('create')}>Create</button>
          <button type="button" role="tab" aria-selected={mode === 'import'}
            className={'nw-seg' + (mode === 'import' ? ' is-active' : '')}
            onClick={() => setMode('import')}>Import</button>
        </div>

        {/* The website account belongs on the wallet screen itself: signing in
         * identifies the session, and someone who never opens Settings would
         * otherwise never see it. It touches no key, no balance and no seed. */}
        {SHOW_GOOGLE_ACCOUNT ? (
          <div className="nw-signin-entry"><GoogleAccount variant="row" /></div>
        ) : null}

        {/* Both forms stay in the markup — the segmented control only chooses
         * which one is shown, so a static export still carries both actions
         * and Import is one tap away instead of a page away. */}
        <section className="nw-card" hidden={mode !== 'create'}>
          <h2 style={{ color: 'var(--text)' }}>Create a New Wallet</h2>
          <p className="nw-small nw-dim">
            {bus.accountEmail
              ? `Signed in as ${bus.accountEmail}. The wallet name is already filled in — set a password and it is ready. Keys are generated and encrypted in this browser.`
              : `Generated and encrypted in this browser. Use a unique passphrase of at least ${MIN_PASSWORD_LENGTH} characters.`}
          </p>
          <form onSubmit={bus.doCreate} className="nw-txf" style={{ marginTop: 10 }}>
            <label className="nw-label" htmlFor="nw-new-name">Wallet name</label>
            <input id="nw-new-name" value={bus.newName}
              onChange={(e) => bus.setNewName(e.target.value)}
              placeholder="Personal wallet" required />
            <label className="nw-label" htmlFor="nw-new-pass">Password (≥ {MIN_PASSWORD_LENGTH} chars, needed to sign)</label>
            <input id="nw-new-pass" type="password" value={bus.newPass}
              onChange={(e) => bus.setNewPass(e.target.value)}
              minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" required />
            <div className="nw-small nw-dim">There is no server-side recovery.</div>
            <div className="nw-btn-row" style={{ margin: '4px 0 0' }}>
              <button type="submit" className="nw-send-btn" disabled={bus.busy}>
                Create Wallet</button>
            </div>
          </form>
        </section>
        <section className="nw-card" hidden={mode !== 'import'}>
          <h2 style={{ color: 'var(--text)' }}>Import Existing Wallet</h2>
          <p className="nw-small nw-dim">Encrypted immediately; never shown again.</p>
          <form onSubmit={bus.doImport} className="nw-txf" style={{ marginTop: 10 }}>
            <label className="nw-label" htmlFor="nw-imp-name">Wallet name</label>
            <input id="nw-imp-name" value={bus.newName}
              onChange={(e) => bus.setNewName(e.target.value)} required />
            <label className="nw-label" htmlFor="nw-imp-seed">Secret seed (S…)</label>
            <input id="nw-imp-seed" type="password" spellCheck={false} autoComplete="off"
              value={bus.importSeed} onChange={(e) => bus.setImportSeed(e.target.value)} required />
            <label className="nw-label" htmlFor="nw-imp-pass">Password (≥ {MIN_PASSWORD_LENGTH} chars)</label>
            <input id="nw-imp-pass" type="password" value={bus.newPass}
              onChange={(e) => bus.setNewPass(e.target.value)}
              minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" required />
            <div className="nw-btn-row" style={{ margin: '4px 0 0' }}>
              <button type="submit" className="nw-send-btn" disabled={bus.busy}>
                Import</button>
            </div>
          </form>
        </section>
        </div>
      </div>
    );
  }

  // `funded` comes from the gateway answer (404 → false). A known balance of 0
  // is not the same thing as a funded account, so never derive it from balance.
  const fundedBadge = funded;
  const exact = balance == null ? '…' : formatExactBalance(balance);
  return (
    <div className="nw-home">
      {/* The one number the app exists to show, centred the way the phone
       * build centres it: no card, no label competing with it. */}
      <section className="nw-hero">
        <div className="nw-hero-amount">
          {exact}
          <span className="nw-hero-unit">NSAT</span>
        </div>
        <div className="nw-hero-foot">
          <span className={'nw-badge ' + (fundedBadge === true ? 'ok' : 'warn')}>
            {fundedBadge === true ? 'funded' : fundedBadge === false ? 'not funded yet' : 'funding unknown'}
          </span>
          <button type="button" className="nw-chip-btn nw-mono"
            title="Copy your public address"
            onClick={async () => {
              await navigator.clipboard.writeText(active.pubkey);
              notify('📋 Copied: Address');
            }}>
            {shortAddr(active.pubkey, 8)}
          </button>
        </div>
      </section>

      {wallets.length > 0 && (
        <WalletChainStatus wallets={wallets} states={walletChainStates} baseReserve={baseReserve} activeName={active.name} />
      )}

      {/* Money on this device with a stale Drive copy is the one failure the
       * wallet cannot undo, so it is raised here and recedes on its own. */}
      <BackupReminder balance={balance} email={bus.accountEmail} notify={notify} />

      {/* Send · Receive · Backup — the round actions the phone build puts under
       * the balance. There is no Buy button: nothing behind it can sell NSAT. */}
      <div className="nw-quick-actions">
        <button type="button" className="nw-action-card" onClick={onSend}>
          <span className="nw-action-icon" aria-hidden>↗</span>
          <span className="nw-action-label">Send</span>
        </button>
        <button type="button" className="nw-action-card" onClick={onReceive}>
          <span className="nw-action-icon" aria-hidden>▦</span>
          <span className="nw-action-label">Receive</span>
        </button>
        <button type="button" className="nw-action-card" onClick={onManage}>
          <span className="nw-action-icon" aria-hidden>⇩</span>
          <span className="nw-action-label">Backup</span>
        </button>
      </div>

      {/* Same entry as on first run, above the asset list so it stays visible
       * without hunting through Settings. */}
      {SHOW_GOOGLE_ACCOUNT ? (
        <div className="nw-signin-entry"><GoogleAccount variant="row" /></div>
      ) : null}

      {/* One asset, listed the way a wallet lists tokens: name and exact
       * balance, with the live chain state directly under it. */}
      <div className="nw-assets">
        <button type="button" className="nw-asset" onClick={onActivity}>
          <span className="nw-asset-logo"><NsatCoinMark className="nw-coin-mark" /></span>
          <span className="nw-asset-main">
            <span className="nw-asset-name">NSAT</span>
            <span className="nw-asset-sub">SatoshiCore mainnet</span>
          </span>
          <span className="nw-asset-value">{exact}</span>
          <span className="nw-asset-chevron" aria-hidden>›</span>
        </button>
        <button type="button" className="nw-asset" onClick={onManage}>
          <span className="nw-asset-logo" aria-hidden>≣</span>
          <span className="nw-asset-main">
            <span className="nw-asset-name">Network &amp; fee</span>
            <span className="nw-asset-sub">
              <NetworkBadge net={net.net ? { ...net.net, ledger: net.ledger } : null} />
              {' · '}{net.fee != null ? `fee ${net.fee} NSAT` : 'fee …'}
            </span>
          </span>
          <span className="nw-asset-chevron" aria-hidden>›</span>
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------- Send --------------------------------- */
function SendPage({ state, gate, busy, active, balance, funded, linkedRecipients = [], recipientBalances = {}, onChooseRecipient, onReview }) {
  // ONE preflight decides the disabled state and shows WHY (shared with the
  // Desktop wallet / prototype — NSAT-WALLET-BUTTON-STATES.md).
  const pf = sendPreflight({
    active,
    netOk: gate.netOk,
    dest: state.dest,
    amount: state.amount,
    balance,
    fee: gate.fee ?? '0',
    createDest: state.createDest,
    baseReserve: gate.reserve ?? 0,
  });
  const canReview = pf.ok;
  const block = pf.block;
  const hasBalance = balance != null;
  const mx = hasBalance ? maxSendable(balance, gate.fee ?? '0') : 0n;
  const doMax = () => {
    if (!hasBalance) return;
    // Max = exact balance − fee, BigInt only; empty form if nothing sendable
    const v = mx.toString();
    state.setAmount(v === '0' ? '' : v);
  };
  return (
    <section className="nw-card">
      <div className="nw-txf">
        <div className="nw-row">
          <label htmlFor="nw-dest">Recipient</label>
          <input id="nw-dest" spellCheck={false} className="nw-mono" value={state.dest}
            onChange={(e) => state.setDest(e.target.value)}
            placeholder="G… (56-char account address)" />
        </div>
        {linkedRecipients.length > 0 && (
          <div>
            <div className="nw-label">Other wallets linked to this account</div>
            <ul className="nw-acc-list nw-send-recipient-list">
              {linkedRecipients.map(({ address, name }) => (
                <li key={address}>
                  <button type="button"
                    className={'nw-acc-row nw-send-recipient' + (state.dest.trim() === address ? ' is-selected' : '')}
                    aria-pressed={state.dest.trim() === address}
                    onClick={() => onChooseRecipient?.(address)}>
                    <span className="nw-acc-main">
                      <span className="nw-acc-name">{name}</span>
                      <span className="nw-acc-meta">
                        <span className="nw-mono">{shortAddr(address, 6)}</span>
                        <span className="nw-acc-bal">{accountBalanceLine(recipientBalances[address])}</span>
                      </span>
                    </span>
                    <span className="nw-chip-btn">Use</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
              Selecting a wallet fills its public address. Review the recipient before sending.
            </p>
          </div>
        )}
        <div className="nw-row">
          <label htmlFor="nw-amt">Amount NSAT</label>
          <input id="nw-amt" inputMode="numeric" value={state.amount}
            onChange={(e) => state.setAmount(e.target.value)}
            placeholder="exact integers — no decimals" />
        </div>
        <div className="nw-row nw-small">
          <label htmlFor="nw-max">Max</label>
          <button id="nw-max" type="button" className="nw-chip-btn"
            disabled={!hasBalance || mx <= 0n}
            title={hasBalance ? 'Set amount to exact balance − fee (BigInt math)' : 'Funding a brand-new account needs ≥ 2× base reserve.'}
            onClick={doMax}>
            Max (balance − fee)
          </button>
          {hasBalance && mx > 0n && (
            <span className="nw-small nw-dim">{fmtGroup(mx.toString())} NSAT sendable</span>
          )}
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
        {state.createDest && (gate.reserve ?? 0) > 0 && (
          <div className="nw-small" style={{ color: 'var(--warn)' }}>
            CREATE needs ≥ {fmtGroup((BigInt(2 * gate.reserve)).toString())} NSAT at once (2× base reserve).
          </div>
        )}
        <div className="nw-row nw-small nw-dim"><label>Fee</label>
          <span>{gate.fee ?? '…'} NSAT per operation (live from the verified ledger; exact total shown at Review)</span></div>
        {funded === false && (
          <div role="status" className="nw-small nw-send-warning">
            This wallet has no on-chain account yet. Its first incoming deposit creates the
            account (≥ 2× base reserve) — until that arrives, sending cannot succeed.
          </div>
        )}
        <div className="nw-row">
          <button className="nw-send-btn" disabled={!canReview}
            onClick={onReview} aria-describedby={block ? 'nw-send-block-reason' : undefined}>
            Review Transaction</button>
        </div>
        {block && (
          <div id="nw-send-block-reason" role="status" className="nw-small"
            style={{
              color: block.kind === 'insufficient'
                ? 'var(--warn)'
                : block.kind === 'recipient' && !state.dest.trim()
                  ? 'var(--text-dim)'
                  : 'var(--danger)',
              marginTop: 2
            }}>
            {block.reason}
          </div>
        )}
        {pf.warn && (
          <div role="status" className="nw-small" style={{ color: 'var(--warn)', marginTop: 2 }}>
            {pf.warn.reason}
          </div>
        )}
      </div>
      {busy && <p className="nw-small nw-dim" style={{ marginTop: 8 }}>Working…</p>}
    </section>
  );
}

/* -------------------------------- Receive -------------------------------- */
function ReceivePage({ activePubkey, notify }) {
  return (
    <section className="nw-card" style={{ textAlign: 'center' }}>
      {!activePubkey
        ? <EmptyState text="No wallet selected" />
        : (<>
          <div className="nw-mono"
            style={{ wordBreak: 'break-all', padding: '12px 0', color: 'var(--cyan)' }}>
            {activePubkey}
          </div>
          <button className="nw-chip-btn"
            onClick={async () => {
              await navigator.clipboard.writeText(activePubkey);
              notify('📋 Copied: Address');
            }}>
            Copy address
          </button>
          <p className="nw-small nw-dim" style={{ marginTop: 14 }}>
            Public address only. A brand-new account needs 2× base reserve.
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
            <div className="nw-balance-label">SHIELDED NSAT</div>
            <div className="nw-balance-amount">DESKTOP ONLY</div>
            <div className="nw-small nw-dim">
              Needs the native prover, which only the Desktop Wallet runs.
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* -------------------------------- Activity ------------------------------- */
/* Mint status card. It is the first thing Activity shows: the mint is
 * close-level accounting carried in the ledger header, so it can never be a row
 * in the transfer list, it needs no unlocked wallet to read, and it must not sit
 * below the unlock form the page body renders. Every figure comes from that
 * header — never from a rate applied to the current height. */
function MintStatusCard({ mint }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const chainTime = (seconds) => {
    const n = Number(seconds);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toLocaleString() : '';
  };
  const mintData = mint?.data;
  const eras = Array.isArray(mint?.timeline) ? mint.timeline : [];
  const { supply, minted } = supplyAndMinted(mintData?.total_coins);
  return (
    <section className="nw-card nw-mint-head" aria-labelledby="nw-mint-title">
        <div className="nw-mint-compact-top">
          <h2 id="nw-mint-title">Mint status</h2>
          <span className={`nw-badge ${mint?.error ? 'warn' : mintData ? 'ok' : 'info'}`}>
            {mint?.error ? 'stale' : mintData ? 'live' : 'loading'}
          </span>
        </div>
        {mint?.phase === 'loading' || mint?.phase === 'idle' ? (
          <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>
            Reading the mint state from the ledger header…
          </p>
        ) : !mintData ? (
          <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>
            {`No indexed ledger header carries the Founder Mint extension yet${mint?.error ? ` (${mint.error})` : ''}. No minted total is shown rather than an estimate.`}
          </p>
        ) : (
          <>
            <div className="nw-mint-head-value">{minted == null ? '—' : `${fmtGroup(minted)} NSAT`}</div>
            <div className="nw-mint-live-meta">
              {`Minted since activation · ledger ${fmtGroup(String(mintData.ledger))}`}
              {` · heartbeat ${fmtGroup(String(mintData.heartbeat ?? 0))}`}
              {mint?.fetchedAt
                ? ` · updated ${Math.max(0, Math.floor((now - mint.fetchedAt) / 1000))}s ago`
                : ''}
            </div>
            <details className="nw-mint-details">
              <summary>More mint status</summary>
            <div className="nw-kv" style={{ marginTop: 6 }}>
              <span className="nw-k">Total supply on chain</span>
              <span className="nw-v">{supply == null ? '—' : `${fmtGroup(supply)} NSAT`}</span>
            </div>
            <div className="nw-kv">
              <span className="nw-k">Heartbeats counted</span>
              <span className="nw-v">{fmtGroup(String(mintData.heartbeat ?? 0))}</span>
            </div>
            <div className="nw-kv">
              <span className="nw-k">Pending escrow</span>
              <span className="nw-v">{String(mintData.escrow ?? '0') === '0'
                ? 'none — fully delivered'
                : `${fmtGroup(String(mintData.escrow))} NSAT`}</span>
            </div>
            <div className="nw-kv">
              <span className="nw-k">As of ledger</span>
              <span className="nw-v">{`${fmtGroup(String(mintData.ledger))}${chainTime(mintData.close_time) ? ` · ${chainTime(mintData.close_time)}` : ''}`}</span>
            </div>
            {mintData.activation_ledger != null && (
              <div className="nw-kv">
                <span className="nw-k">Activation ledger</span>
                <span className="nw-v">{fmtGroup(String(mintData.activation_ledger))}</span>
              </div>
            )}
            {eras.length > 0 && (
              <details className="nw-mint-eras">
                <summary>
                  <span>{`Issuance eras · ${eras.length}`}</span>
                  <span className="nw-dim">
                    {`${fmtGroup(String(eras.reduce((sum, era) => sum + Number(era.ledgers || 0), 0)))} ledgers`}
                  </span>
                </summary>
                <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                  Each era is a run of finalized ledgers whose header supply (totalCoins) grew by the
                  same exact amount at every close, read from the headers themselves.
                </p>
                <ul className="nw-tx-list" style={{ marginTop: 8 }}>
                  {eras.map((era) => (
                    <li key={`${era.from_ledger}-${era.to_ledger}`} className="nw-tx-row"
                      style={{ alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <div>
                          {`Ledger ${fmtGroup(String(era.from_ledger))}–${fmtGroup(String(era.to_ledger))}`}{' '}
                          <span className="nw-badge info">{`${fmtGroup(String(era.ledgers))} ledgers`}</span>
                        </div>
                        <div className="nw-small nw-dim">
                          {`heartbeats ${fmtGroup(String(era.heartbeat_from))}–${fmtGroup(String(era.heartbeat_to))}`}
                          {chainTime(era.opened_at) ? ` · ${chainTime(era.opened_at)}` : ''}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {era.per_ledger == null
                          ? <span className="nw-badge warn">rate unknown</span>
                          : `${fmtGroup(String(era.per_ledger))} / ledger`}
                        <div className="nw-small nw-dim">
                          {`${fmtGroup(String(era.minted))} NSAT${era.complete ? '' : ' · partial'}`}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                {mint?.unattributed != null && mint.unattributed !== '0' && (
                  <p className="nw-small" style={{ margin: '8px 0 0', color: 'var(--warn)' }}>
                    {`${fmtGroup(String(mint.unattributed))} NSAT of header supply growth is not attributable to an era: this index is missing ledgers inside that range.`}
                  </p>
                )}
              </details>
            )}
            {mint?.error ? (
              <p className="nw-small" style={{ margin: '8px 0 0', color: 'var(--warn)' }}>
                {`The last refresh did not answer (${mint.error}). The figures above are the last header read, not a frozen estimate.`}
              </p>
            ) : null}
            <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>
              {`Read from the ledger header: totalCoins minus the fixed genesis supply of ${fmtGroup(GENESIS_SUPPLY.toString())} NSAT. `}
              One heartbeat is one finalized ledger; the mint is written during the close, so it is
              not a transaction and never appears in a transfer list. Re-read every 5 seconds while
              this page is open, and again when you return to the tab.
            </p>
            </details>
          </>
        )}
      </section>

  );
}

function ActivityPage({ history, activeName, chain, onLoadOlder, onRecheck, canRecheck }) {
  // Anything the index already knows is shown from the index; the local list
  // keeps only what the chain has not reported yet (a transfer sent moments
  // ago, or one the node rejected before inclusion).
  const chainItems = chain?.items || [];
  const onChainHashes = new Set(chainItems.map((item) => String(item.hash || '').toLowerCase()));
  const localOnly = (history || []).filter(
    (entry) => !onChainHashes.has(String(entry.txhash || '').toLowerCase()),
  );
  const chainTime = (seconds) => {
    const n = Number(seconds);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toLocaleString() : '';
  };
  const coverage = chain?.coverage;
  const total = chain?.total;
  const shown = chainItems.length;
  const sent = chainItems.filter((item) => item.direction === 'out').length;
  const received = chainItems.filter((item) => item.direction !== 'out').length;
  return (
    <div>
      <section className="nw-card">
        <h2 style={{ color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {activeName ? `On-chain activity — ${activeName}` : 'On-chain activity'}
          <span className="nw-badge info">from the chain index · read-only</span>
        </h2>
        {chain?.phase === 'none' ? (
          <EmptyState text="No wallet selected." />
        ) : chain?.phase === 'loading' || chain?.phase === 'idle' ? (
          <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>Reading the chain index…</p>
        ) : chain?.phase === 'unavailable' ? (
          <p className="nw-small" style={{ margin: '10px 0 0', color: 'var(--warn)' }}>
            {`Chain history is unavailable right now${chain.error ? ` (${chain.error})` : ''}. Transfers signed on this device still appear below.`}
          </p>
        ) : chainItems.length === 0 ? (
          <>
            <EmptyState text="No indexed transfers for this address." />
            {coverage?.from_ledger != null && (
              <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
                {`The index covers ledgers ${fmtGroup(String(coverage.from_ledger))}–${fmtGroup(String(coverage.to_ledger))}, and no transfer in that range involves this address.`}
              </p>
            )}
          </>
        ) : (
          <>
          <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>
            {`Showing ${fmtGroup(String(shown))}${total != null && total > shown ? ` of ${fmtGroup(String(total))}` : ''} indexed transfers · ${fmtGroup(String(sent))} sent · ${fmtGroup(String(received))} received`}
          </p>
          <ul className="nw-tx-list" style={{ marginTop: 10 }}>
            {chainItems.map((item) => (
              <li key={historyKey(item)} className="nw-tx-row">
                <div className={'nw-tx-dir ' + (item.direction === 'out' ? 'sent' : 'rec')}>
                  {item.direction === 'out' ? '↗' : '↙'}</div>
                <div style={{ flex: 1 }}>
                  <div>
                    {item.direction === 'out' ? 'To' : 'From'}{' '}
                    <span className="nw-mono">{shortAddr(item.counterparty)}</span>{' '}
                    <span className={'nw-badge ' + (item.success ? 'ok' : 'err')}>
                      {item.success ? 'confirmed' : (item.result_code || 'failed')}</span>
                  </div>
                  <div className="nw-small nw-dim">
                    {`${item.kind || 'payment'} · fee ${item.fee ?? '—'}${chainTime(item.close_time) ? ` · ${chainTime(item.close_time)}` : ''}`}
                  </div>
                  {String(item.hash || '') && (
                    <div className="nw-small nw-dim nw-mono">
                      {`${String(item.hash).slice(0, 10)}…${String(item.hash).slice(-8)}`}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right' }}>
                  {`${item.direction === 'out' ? '−' : '+'}${fmtGroup(String(item.amount_stroops ?? item.amount ?? '0'))} NSAT`}
                  <div className="nw-small nw-dim">
                    {item.success ? `ledger ${item.ledger}` : `ledger ${item.ledger} · not moved`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {chain.error && (
            <p className="nw-small" style={{ margin: '8px 0 0', color: 'var(--warn)' }}>{chain.error}</p>
          )}
          <div className="nw-btn-row" style={{ margin: '10px 0 0' }}>
            {chain.next ? (
              <button type="button" className="nw-chip-btn" onClick={onLoadOlder}
                disabled={Boolean(chain.loadingMore)}>
                {chain.loadingMore ? 'Loading older transfers…' : 'Load older transfers'}
              </button>
            ) : (
              <span className="nw-badge ok">end of indexed history</span>
            )}
          </div>
          {coverage?.from_ledger != null && (
            <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
              {`Index coverage: ledgers ${fmtGroup(String(coverage.from_ledger))}–${fmtGroup(String(coverage.to_ledger))} (${fmtGroup(String(coverage.ledgers))} ledgers). Transfers outside that range are not in this index.`}
            </p>
          )}
          </>
        )}
      </section>

      <section className="nw-card">
        <h2 style={{ color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          Signed on this device
          <span className="nw-badge info">local record</span>
        </h2>
        {localOnly.length === 0 ? (
          <EmptyState text={chainItems.length > 0
            ? 'Nothing pending — every transfer signed here also appears in the chain index.'
            : 'No signed transfers yet.'} />
        ) : (
          <ul className="nw-tx-list" style={{ marginTop: 10 }}>
            {localOnly.map((h, i) => (
              <li key={`${h.txhash || 'row'}-${i}`} className="nw-tx-row">
                <div className={'nw-tx-dir ' + (h.dir === 'sent' ? 'sent' : 'rec')}>
                  {h.dir === 'sent' ? '↗' : '↙'}</div>
                <div style={{ flex: 1 }}>
                  <div>
                    {h.dir === 'sent' ? 'To' : 'Received'}{' '}
                    <span className="nw-mono">{shortAddr(h.to)}</span>{' '}
                    <span className={'nw-badge ' + (h.status === 'confirmed' ? 'ok' : h.status === 'failed' ? 'err' : 'warn')}>
                      {h.status}</span>
                  </div>
                  <div className="nw-small nw-dim">{h.time} · fee {h.fee}</div>
                  {h.result_code && (
                    <div className="nw-small nw-dim">result {h.result_code}{h.evidence ? ` · ${h.evidence}` : ''}</div>
                  )}
                  {h.reason && <div className="nw-small nw-dim">reason {h.reason}</div>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  {fmtGroup(h.amount)} NSAT
                  {h.ledger && <div className="nw-small nw-dim">ledger {h.ledger}</div>}
                  {canRecheck && h.status !== 'confirmed' && h.status !== 'failed' && (
                    <button type="button" className="nw-chip-btn" style={{ marginTop: 4 }}
                      onClick={() => onRecheck(h)}>Check ledger</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

    </div>
  );
}

/* ------------------------------- Settings -------------------------------- */
function SettingsPage({ s, onShielded }) {
  return (
    <div>
      {SHOW_GOOGLE_ACCOUNT ? <GoogleAccount /> : null}
      {SHOW_GOOGLE_ACCOUNT ? <DriveBackupCard onKeystoreChanged={s.onReloadWallets} /> : null}
      <section className="nw-card">
        <h2 style={{ color: 'var(--text)' }}>Privacy</h2>
        <div className="nw-kv" style={{ marginTop: 10 }}>
          <span className="nw-k">Device unlock</span>
          <span className="nw-v">
            {s.active ? (
              <button className="nw-chip-btn" onClick={s.onToggleBiometric} disabled={s.busy}>
                {s.biometricWallets.includes(s.active.name) ? 'Turn off on this browser' : 'Set up Face ID / device unlock'}
              </button>
            ) : <span className="nw-badge info">{s.biometricWallets.length ? 'available on this browser' : 'not set up'}</span>}
          </span>
        </div>
        <p className="nw-small nw-dim" style={{ margin: '6px 0 10px' }}>
          Uses your device&apos;s secure check (Face ID, fingerprint, Windows Hello, or device PIN, depending on the device). This site never sees face or fingerprint data. Your password remains the backup; this setup works only in this browser.
        </p>
        <div className="nw-kv">
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
                {s.active?.name === w.name
                  ? <span className="nw-badge ok">active</span>
                  : (
                    <button type="button" className="nw-chip-btn"
                      onClick={() => s.onSwitch(w.name)}
                      title="Lock the current wallet and unlock this one">
                      Switch
                    </button>
                  )}
              </li>
            ))}
          </ul>}
      </section>
      <section className="nw-card">
        <h2 style={{ color: 'var(--text)' }}>Backup & restore</h2>
        <p className="nw-small nw-dim" style={{ margin: '8px 0 12px' }}>
          Encrypted keystore. Restores here or in another browser.
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
        <h2 style={{ color: 'var(--text)' }}>Shielded transfers</h2>
        <p className="nw-small nw-dim" style={{ margin: '8px 0 12px' }}>
          Desktop only — the browser has no verified Orchard prover, so this wallet will not
          pretend to offer a private transfer.
        </p>
        <button type="button" className="nw-chip-btn" onClick={onShielded}>
          Why shielded is desktop-only
        </button>
      </section>
      <section className="nw-card">
        <h2 style={{ color: 'var(--text)' }}>Appearance</h2>
        <div className="nw-kv" style={{ marginTop: 10, alignItems: 'center' }}>
          <span className="nw-k">Theme</span>
          <span className="nw-v" style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <ThemeToggle />
          </span>
        </div>
        <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
          Follows this browser. If you opted in, the choice is also stored with your Google
          account.
        </p>
      </section>
      {/* The wallet is the whole site now — no site header above it — so the
       * rest of SatoshiCore is reached from here instead of from a nav bar. */}
      <section className="nw-card">
        <h2 style={{ color: 'var(--text)' }}>SatoshiCore</h2>
        <div className="nw-linklist">
          <a className="nw-linkrow" href="/explorer/">Search the chain<span aria-hidden>›</span></a>
          <a className="nw-linkrow" href="/dashboard/">Explorer<span aria-hidden>›</span></a>
          <a className="nw-linkrow" href="/docs/">Docs<span aria-hidden>›</span></a>
          <a className="nw-linkrow" href="/status/">Network status<span aria-hidden>›</span></a>
        </div>
        <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>
          Non-custodial · {NSAT.baseFee} NSAT per operation · not a sale or investment offer.
        </p>
      </section>
      <section className="nw-card">
        <h2 style={{ color: 'var(--text)' }}>Security model</h2>
        <div className="nw-kv" style={{ marginTop: 10 }}>
          <span className="nw-k">Keys</span>
          <span className="nw-v">Ed25519 · PBKDF2 + AES-GCM in this browser</span></div>
        <div className="nw-kv"><span className="nw-k">Signing</span>
          <span className="nw-v">client-side only — the gateway never sees a key</span></div>
        <div className="nw-kv"><span className="nw-k">Network gate</span>
          <span className="nw-v">exact identity match before any signature</span></div>
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

/* The NSAT coin: the gold ring and N from the app icon (public/icons),
 * redrawn as inline SVG so it stays sharp at any size and needs no raster
 * fetch inside the wallet shell. */
function NsatCoinMark({ className = '' }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle cx="32" cy="32" r="27" fill="#050a14" stroke="#f0b90b" strokeWidth="4" />
      <path d="M21 44V20l22 24V20" fill="none" stroke="#f0b90b"
        strokeWidth="5.5" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
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

// One line per wallet in the switcher. "not on chain yet" is a real state (a
// fresh address is invisible until its first deposit), not a failure.
function accountBalanceLine(entry) {
  if (!entry || entry.kind === 'loading') return '…';
  if (entry.kind === 'missing') return 'not on chain yet';
  if (entry.kind === 'unavailable') return 'balance unavailable';
  return `${formatExactBalance(entry.value)} NSAT`;
}

function shortAddr(addr, keep = 8) {
  if (!addr) return '—';
  return addr.length <= keep * 2 + 3 ? addr : `${addr.slice(0, keep)}…${addr.slice(-4)}`;
}
