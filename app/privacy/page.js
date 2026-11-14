import Link from 'next/link';
import PageHeader from '../../components/PageHeader';

export const metadata = {
  title: 'Privacy — NSAT Wallet (draft)',
  description:
    'Draft privacy disclosure: optional Google sign-in for the website only; wallet keys stay on the device, alongside chain reads and signed-envelope relay.'
};

const STORED = [
  {
    what: 'Encrypted keystore',
    where: 'this browser',
    detail:
      'Ciphertext only (AES-GCM-256, PBKDF2-HMAC-SHA256 600,000 iterations). The seed is never stored in plaintext and never leaves the device.'
  },
  {
    what: 'Wallet name and public address',
    where: 'same store',
    detail: 'Needed to list wallets and show the address before unlock. A public address is not a secret.'
  },
  {
    what: 'Local transaction history',
    where: 'same store, per wallet',
    detail: 'Recipient, amount, fee, hash and the ledger result once read. Not a full chain history, and never sent anywhere.'
  },
  {
    what: 'Google website sign-in session (optional)',
    where: 'Firebase Authentication, browser-session persistence',
    detail: 'When you choose Google sign-in, Firebase stores the website identity session for this browser session. It is not connected to the wallet keystore and does not sync or recover signing keys.'
  },
  {
    what: 'Theme and session preferences',
    where: 'localStorage / in memory · optional account copy',
    detail: 'Theme persists on this device. If you turn on theme sync with Google sign-in, only your light or dark choice is stored with your website account in Firebase; turning sync off deletes it. Wallet signing state clears when the page closes.'
  }
];

const TRANSMITTED = [
  {
    what: 'GET chain info, network status, explorer snapshot',
    why: 'Ledger height, network identity and base fee. No wallet data included.'
  },
  {
    what: 'GET account?acc=<public address>',
    why: 'Balance and sequence number. The gateway never receives password, seed or keys.'
  },
  {
    what: 'POST tx (already-signed envelope)',
    why: 'Relays a transaction you approved; the gateway has no key and cannot alter or re-sign it.'
  },
  {
    what: 'GET transactions / confirmations by hash',
    why: 'Indexed history and the ledger verdict for one transaction.'
  },
  {
    what: 'Google sign-in (only when you choose it)',
    why: 'Google and Firebase Authentication receive the identity data needed to authenticate your website session, such as your Google account ID, name and email. The app does not request Gmail mailbox access and does not send wallet name, address, seed, password, balance or history.'
  },
  {
    what: 'Theme sync (only when you turn it on)',
    why: 'Writes one document containing your light or dark theme choice, readable only by your own signed-in account. The site database rejects any other field, so wallet name, address, balance, history, seed and password cannot be stored there.'
  }
];

export default function PrivacyPage() {
  return (
    <div className="stack">
      <PageHeader
        eyebrow="NSAT · legal"
        title="Privacy"
        lead="What stays on your device, what the network sees, and what is never collected."
        actions={
          <>
            <Link href="/terms/" className="button secondary">Terms</Link>
            <Link href="/security/" className="button secondary">Security model</Link>
          </>
        }
      />

      <section className="panel" style={{ borderColor: 'var(--warn, #f0b90b)' }}>
        <div className="panel-head">
          <h2 className="panel-title">Status of this document</h2>
          <span className="panel-meta">draft · pending legal review</span>
        </div>
        <div className="panel-body">
          <p>
            <strong>Draft.</strong> These statements describe the code as it runs today. The
            data-controller identity, retention periods and PDPA wording must be completed by
            the owner with counsel before this is a final notice.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">What we do not collect</h2>
          <span className="panel-meta">optional account · no analytics</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            <li>No wallet account is required. Google sign-in is optional and only identifies a website session.</li>
            <li>Theme sync is off by default and separate from sign-in: nothing is uploaded unless you turn it on, and it covers the light or dark theme only.</li>
            <li>No analytics, advertising or fingerprinting. Firebase Auth code is bundled locally; authentication requests may restore an existing browser-session login and interactive sign-in starts only after you choose Google.</li>
            <li>The site does not set its own cookies. Google/Firebase may use their own authentication cookies during sign-in.</li>
            <li>No seed, wallet password or private key transmitted to Google/Firebase, logged or stored in plaintext.</li>
            <li>Google/Firebase receive account identity data only if you opt into sign-in; SatoshiCore does not use it to access your Gmail mailbox or wallet keys.</li>
          </ul>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Stored on your device</h2>
          <span className="panel-meta">you can clear it at any time</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            {STORED.map((row) => (
              <li key={row.what}>
                <strong>{row.what}</strong> — {row.where}. {row.detail}
              </li>
            ))}
          </ul>
          <p>
            Clearing site data deletes this store — and without an exported backup, the only
            copy of the key.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Sent to the network</h2>
          <span className="panel-meta">same origin · read-only except a signed relay</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            {TRANSMITTED.map((row) => (
              <li key={row.what}>
                <span className="mono">{row.what}</span> — {row.why}
              </li>
            ))}
          </ul>
          <p>
            Chain requests reach the gateway and read-only indexer behind this domain, which
            record standard access data (IP, time, path, user agent). If you choose Google
            sign-in, the Google identity provider and Firebase Authentication also process
            sign-in and session data under their own privacy terms. SatoshiCore does not
            request Gmail mailbox access or send wallet contents to those providers. The log
            retention period is still to be specified in the reviewed notice.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Your controls</h2>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            <li>Lock at any time; the signing key is dropped from memory.</li>
            <li>Export the encrypted keystore and keep it offline.</li>
            <li>Use a separate wallet per purpose.</li>
            <li>
              Chain data is public: a transfer to or from your address is visible on the
              ledger. Only the desktop wallet can shield a transfer.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
