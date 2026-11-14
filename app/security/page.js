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
    body: 'Seeds are generated with the device CSPRNG. The encrypted keystore holds only AES-GCM-256 ciphertext, with a key derived from your password using PBKDF2-HMAC-SHA256 (600,000 iterations). No seed, password or private key is sent to the gateway, logged, or written to plaintext storage.'
  },
  {
    title: 'Signing happens locally, once, after review',
    body: 'The transaction is serialised and signed in the browser or extension with Ed25519. The gateway receives an already-signed envelope and can neither alter nor re-sign it. Nothing is signed until you confirm the recipient, amount, fee and total debit on a review screen.'
  },
  {
    title: 'Exact network identity or no signature',
    body: `A signature is refused unless the network reports the byte-exact Mainnet identity "${NSAT.network}". Prefixes, short names and trimmed matches are rejected, so a test network cannot masquerade as Mainnet.`
  },
  {
    title: 'Money is integer arithmetic only',
    body: 'Balances, amounts, fees and reserves are handled as exact integers (BigInt in the browser). No floating-point value ever participates in a transfer, and the preflight refuses an amount the chain would reject.'
  },
  {
    title: 'Confirmation means a ledger result',
    body: 'A transfer is shown as confirmed only when the index returns that exact transaction hash with its ledger result. Sequence changes and balance movements are deliberately not used as proof, because they can move for other reasons.'
  },
  {
    title: 'Two independent vaults',
    body: 'The web app and the browser extension keep separate encrypted stores. Neither can read the other, and the extension never exposes keys to a web page.'
  },
  {
    title: 'Locking and idle timeout',
    body: 'Locking drops the signing key from memory. An idle timeout locks the wallet automatically; signing power never survives inattention or a page reload.'
  },
  {
    title: 'No caching of chain state',
    body: 'The service worker caches only the static shell. It never intercepts non-GET requests, cross-origin calls, or any same-origin API path, so a stale balance or verdict can never be served from a cache.'
  }
];

const LIMITS = [
  {
    title: 'A browser is not a hardware wallet',
    body: 'Extensions, OS-level malware and a compromised page can still capture input. For large balances, use a device you trust and keep an offline backup of the encrypted keystore.'
  },
  {
    title: 'Password strength is your responsibility',
    body: 'The keystore is only as strong as the password protecting it. There is no server-side reset, no recovery phrase service and no way for the project to unlock a wallet.'
  },
  {
    title: 'Shielded transfers are desktop-only',
    body: 'Private transfers need the native prover, which does not run in a browser. This site states that instead of offering a version that cannot work.'
  },
  {
    title: 'Website connections are not enabled',
    body: 'No dApp provider, no "connect wallet" prompt and no connected-sites list is shipped yet. A web page cannot request a signature, and it cannot spend NSAT through this wallet.'
  },
  {
    title: 'Not independently audited',
    body: 'The implementation has internal review and test evidence, and the cryptographic primitives are the ones used by the existing wallets. That is not the same as an external security audit, and it is not claimed as one.'
  }
];

export default function SecurityPage() {
  return (
    <div className="stack">
      <PageHeader
        eyebrow="NSAT · security"
        title="Security model"
        lead="What protects your key, what protects a transaction, and what a browser wallet honestly cannot protect."
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
            Every extension build is published with its byte size and a SHA-256 digest on the{' '}
            <Link href="/download/">download page</Link>. Check the file you have before loading
            it:
          </p>
          <pre className="mono doc-block">{`shasum -a 256 nsat-wallet-v24.0.0-production.zip`}</pre>
          <p>
            Nothing is submitted to an extension store yet, so a build is installed by loading
            the unpacked directory. A digest that does not match means the file is not the one
            this project produced.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Reporting a problem</h2>
        </div>
        <div className="panel-body">
          <p>
            Report vulnerabilities privately to the repository maintainers rather than in a
            public issue, and never include a seed, password or keystore file in a report.
            The enforced rules for this repository are in <code>SECURITY.md</code>.
          </p>
        </div>
      </section>
    </div>
  );
}
