import Link from 'next/link';
import PageHeader from '../../components/PageHeader';

export const metadata = {
  title: 'Privacy — NSAT Wallet (draft)',
  description:
    'Draft privacy disclosure: no accounts, no analytics, keys stay on the device, and the only network calls are chain reads and a signed-envelope relay.'
};

const STORED = [
  {
    what: 'Encrypted keystore',
    where: 'this browser (localStorage) or the extension storage area',
    detail:
      'Only ciphertext: AES-GCM-256, key derived with PBKDF2-HMAC-SHA256 (600,000 iterations) from your password. The seed is never stored in plaintext and never leaves the device.'
  },
  {
    what: 'Wallet name and public address',
    where: 'same store as the keystore',
    detail: 'Needed to list your wallets and to display the address before unlock. A public address is not a secret.'
  },
  {
    what: 'Local transaction history',
    where: 'same store, per wallet name',
    detail:
      'Entries this app created: recipient, amount, fee, transaction hash, and the ledger result once it is read. Not a complete chain history, and not sent anywhere.'
  },
  {
    what: 'Preferences (idle-lock window, active section)',
    where: 'in memory for the session',
    detail: 'Cleared when the page closes.'
  }
];

const TRANSMITTED = [
  {
    what: 'GET /api/v1/chain/info, /api/v1/network/status, /api/v1/explorer/snapshot',
    why: 'Read the ledger height, the network identity the wallet checks before signing, and the base fee. No wallet data is included.'
  },
  {
    what: 'GET /api/v1/account?acc=<your public address>',
    why: 'Read your balance and sequence number. The address is public by design; the gateway does not receive your password, seed or keys.'
  },
  {
    what: 'POST /api/v1/tx with an already-signed envelope',
    why: 'Relay a transaction you approved. The envelope is signed on your device; the gateway has no key and cannot alter or re-sign it.'
  },
  {
    what: 'GET /v1/accounts/<address>/transactions, /v1/confirmations/<hash>',
    why: 'Read indexed history and the ledger verdict for a specific transaction hash.'
  }
];

export default function PrivacyPage() {
  return (
    <div className="stack">
      <PageHeader
        eyebrow="NSAT · legal"
        title="Privacy"
        lead="What the wallet keeps on your device, what it asks the network for, and what it never collects."
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
            <strong>Draft.</strong> The statements below describe the code as it runs today.
            The data-controller identity, retention periods and the exact wording required
            by Thailand&apos;s Personal Data Protection Act must be completed by the owner
            with counsel before this page is presented as a final notice.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">What we do not collect</h2>
          <span className="panel-meta">no account · no tracking</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            <li>No account, email, phone number or identity document is requested.</li>
            <li>No analytics, advertising, fingerprinting or third-party scripts are loaded.</li>
            <li>No cookies are set by the site.</li>
            <li>No seed, password or private key is ever transmitted, logged or stored in plaintext.</li>
            <li>Nothing is sold or shared with third parties, because nothing is collected.</li>
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
            Clearing site data or uninstalling the extension deletes this store. Without an
            exported encrypted backup, that also deletes the only copy of the key.
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
            These requests reach the Web Wallet API Gateway and the read-only indexer that
            sit behind this domain. Like any web server they record standard access data
            (IP address, time, requested path, user agent); the retention period for those
            logs is one of the items to be specified in the reviewed notice.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Your controls</h2>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            <li>Lock the wallet at any time; the signing key is dropped from memory.</li>
            <li>Export the encrypted keystore and keep it offline; delete browser data afterwards.</li>
            <li>Use a separate wallet per purpose instead of reusing one address everywhere.</li>
            <li>
              Because chain data is public, a transfer to or from your address is visible to
              anyone reading the ledger. The wallet cannot make an on-chain payment private;
              shielded transfers require the desktop wallet.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
