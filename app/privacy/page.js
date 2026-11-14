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
    where: 'this browser or the extension storage area',
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
    what: 'Theme and session preferences',
    where: 'localStorage / in memory',
    detail: 'Theme persists; session state clears when the page closes.'
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
          <span className="panel-meta">no account · no tracking</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            <li>No account, email, phone number or identity document.</li>
            <li>No analytics, advertising, fingerprinting or third-party scripts.</li>
            <li>No cookies.</li>
            <li>No seed, password or private key transmitted, logged or stored in plaintext.</li>
            <li>Nothing sold or shared, because nothing is collected.</li>
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
            These reach the gateway and read-only indexer behind this domain, which record
            standard access data (IP, time, path, user agent). The log retention period is
            still to be specified in the reviewed notice.
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
