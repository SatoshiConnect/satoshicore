import Link from 'next/link';
import PageHeader from '../../components/PageHeader';
import { NSAT } from '../../lib/nsatToken';

export const metadata = {
  title: 'Security model — NSAT Wallet',
  description:
    'How the NSAT wallet protects keys: device-side generation, AES-GCM keystore, local Ed25519 signing, exact network-identity gate, and the limits of a browser wallet.'
};

const CONTROLS = [
  {
    title: 'Keys never leave your device',
    body: 'Seeds are generated on the device and stored only as AES-GCM-256 ciphertext, keyed by your password through PBKDF2-HMAC-SHA256 (600,000 iterations). No seed, password or key is sent, logged, or stored in plaintext.'
  },
  {
    title: 'Signed locally, after review',
    body: 'Ed25519 signing happens in the browser; the gateway only relays an already-signed envelope. Nothing signs until you confirm recipient, amount, fee and total debit.'
  },
  {
    title: 'Exact network identity or no signature',
    body: `A signature is refused unless the network reports the byte-exact Mainnet identity "${NSAT.network}". Near matches are rejected, so a test network cannot pose as Mainnet.`
  },
  {
    title: 'Integer arithmetic only',
    body: 'Balances, amounts, fees and reserves are exact integers (BigInt), and the preflight refuses an amount the chain would reject.'
  },
  {
    title: 'Confirmed means a ledger result',
    body: 'A transfer is confirmed only when the index returns that exact transaction hash with its ledger result — not from a sequence or balance change.'
  },
  {
    title: 'One vault, no third copy',
    body: 'The installed app and the website run the same code over one encrypted store in this browser. There is no second vault, no sync service and no copy anywhere else.'
  },
  {
    title: 'Locking and idle timeout',
    body: 'Locking drops the signing key from memory. The idle timeout locks automatically; signing never survives a reload.'
  },
  {
    title: 'No caching of chain state',
    body: 'The service worker caches only the static shell — never API paths, so a stale balance or verdict cannot be served.'
  }
];

const LIMITS = [
  {
    title: 'A browser is not a hardware wallet',
    body: 'Extensions, OS malware or a compromised page can capture input. For large balances use a device you trust and keep the encrypted keystore backed up offline.'
  },
  {
    title: 'Password strength is your responsibility',
    body: 'The keystore is only as strong as its password. There is no server-side reset and no way for the project to unlock a wallet.'
  },
  {
    title: 'Shielded transfers are desktop-only',
    body: 'Private transfers need the native prover, which does not run in a browser.'
  },
  {
    title: 'Website connections are not enabled',
    body: 'No dApp provider or connect-wallet prompt ships yet; a web page cannot request a signature or spend NSAT.'
  },
  {
    title: 'Not independently audited',
    body: 'Internal review and test evidence, not an external security audit.'
  }
];

export default function SecurityPage() {
  return (
    <div className="stack">
      <PageHeader
        eyebrow="NSAT · security"
        title="Security model"
        lead="What protects your key, and what a browser wallet cannot protect."
        actions={
          <>
            <Link href="/wallet/" className="button">Open the wallet</Link>
            <Link href="/docs/" className="button secondary">Documentation</Link>
          </>
        }
      />

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Controls in the shipped build</h2>
          <span className="panel-meta">client-side signing</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            {CONTROLS.map((row) => (
              <li key={row.title}>
                <strong>{row.title}.</strong> {row.body}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Limits you should know</h2>
          <span className="panel-meta">stated, not hidden</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            {LIMITS.map((row) => (
              <li key={row.title}>
                <strong>{row.title}.</strong> {row.body}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">How to verify a download</h2>
        </div>
        <div className="panel-body">
          <p>
            Each build ships with its size and SHA-256 on the{' '}
            <Link href="/download/">download page</Link>. Check it before loading:
          </p>
          <pre className="mono doc-block">{`shasum -a 256 nsat-wallet-v24.0.0-production.zip`}</pre>
          <p>A mismatch means the file is not the one this project produced.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Reporting a problem</h2>
        </div>
        <div className="panel-body">
          <p>
            Report privately, never in a public issue, and never include a seed, password or
            keystore file. Rules: <code>SECURITY.md</code>.
          </p>
        </div>
      </section>
    </div>
  );
}
