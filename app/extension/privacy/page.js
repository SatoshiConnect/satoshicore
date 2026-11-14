import Link from 'next/link';
import PageHeader from '../../../components/PageHeader';

export const metadata = {
  title: 'Extension privacy — NSAT Wallet',
  description:
    'Privacy policy for the NSAT Wallet browser extension: what stays on the device, what the two first-party endpoints receive, and what is never collected.',
};

const STORED = [
  {
    what: 'Encrypted keystore',
    detail:
      'AES-GCM-256 ciphertext, keyed from your password with PBKDF2-HMAC-SHA256 (600,000 iterations). The seed is never stored in plaintext.',
  },
  {
    what: 'Wallet label and public address',
    detail: 'Needed to list your wallets and show the address before unlock. A public address is not a secret.',
  },
  {
    what: 'Local transaction history',
    detail: 'Up to 200 entries per account you viewed. Never uploaded.',
  },
  {
    what: 'Interface preferences',
    detail: 'Theme and similar display settings.',
  },
];

const TRANSMITTED = [
  {
    what: 'Account balance and sequence',
    where: 'gateway.satoshicore.org/api/v1/account?acc=<address>',
    detail: 'Sends the public wallet address you are looking at.',
  },
  {
    what: 'Chain info, base fee, network status',
    where: 'gateway.satoshicore.org/api/v1/{chain/info,explorer/snapshot,network/status}',
    detail: 'Sends nothing about you.',
  },
  {
    what: 'Transaction relay',
    where: 'gateway.satoshicore.org/api/v1/tx',
    detail: 'Sends only a transaction you reviewed and signed. The gateway has no key and cannot alter or re-sign it.',
  },
  {
    what: 'Public history and confirmations',
    where: 'satoshicore.org/v1/accounts/<address>/…, /v1/tx/<hash>',
    detail: 'Sends the public address or transaction hash being displayed.',
  },
];

export default function ExtensionPrivacyPage() {
  return (
    <div className="stack">
      <PageHeader
        eyebrow="NSAT · extension"
        title="Extension privacy"
        lead="What the browser extension stores, what its two endpoints receive, and what it never collects."
        actions={
          <>
            <Link href="/download/" className="button secondary">Download</Link>
            <Link href="/security/" className="button secondary">Security model</Link>
          </>
        }
      />

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Policy</h2>
          <span className="panel-meta">version 1.0 · 2026-11-14 · v24.0.0</span>
        </div>
        <div className="panel-body">
          <p>
            NSAT Wallet is an independent, non-commercial study project for the NSAT network.
            There is no company, no account system and no server-side copy of your wallet. This
            policy covers the browser extension; the website has its own{' '}
            <Link href="/privacy/">privacy disclosure</Link>.
          </p>
          <p>
            In one paragraph: the extension keeps your keys on your device. It has no account, no
            analytics, no advertising and no tracking. It contacts two first-party endpoints, and
            the only user data they receive is the public wallet address you are looking at and,
            when you send, a transaction you already signed.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Stored on your device</h2>
          <span className="panel-meta">removed when you uninstall</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            {STORED.map((row) => (
              <li key={row.what}>
                <strong>{row.what}</strong> — {row.detail}
              </li>
            ))}
          </ul>
          <p>
            Storage is the extension&apos;s own area (<code>chrome.storage.local</code>); no web
            page can read it, and no cookies are set. While unlocked, the decrypted seed lives in
            the popup&apos;s memory so it can sign; closing the popup destroys that context, and an
            idle auto-lock (15 minutes) locks it earlier.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">What leaves your device</h2>
          <span className="panel-meta">two first-party origins</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            {TRANSMITTED.map((row) => (
              <li key={row.what}>
                <strong>{row.what}</strong> — <code>{row.where}</code>. {row.detail}
              </li>
            ))}
          </ul>
          <p>
            Your password, seed and private keys are never transmitted. As with any web request,
            the servers necessarily receive standard metadata (IP address, time, path, user agent)
            to serve and protect the service; the extension adds no identifiers, sets no cookies
            and performs no analytics or profiling. Blockchain data is public by design: a
            transaction you send becomes visible on the NSAT chain and cannot be deleted by anyone.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">What it does not do</h2>
          <span className="panel-meta">no permissions for it either</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            <li>No account, email, phone number or identity document.</li>
            <li>No analytics, telemetry, crash reporting, advertising or third-party scripts.</li>
            <li>No access to browsing history, tabs, page content, clipboard, location or files.</li>
            <li>No remote code: everything executed ships inside the package.</li>
            <li>No third parties beyond the two endpoints above, both run by this project.</li>
          </ul>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Your choices</h2>
          <span className="panel-meta">nothing runs in the background</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            <li><strong>Stop network access:</strong> lock the wallet or close the popup; the extension has no background worker.</li>
            <li><strong>Remove local data:</strong> delete a wallet in the interface or uninstall the extension — export an encrypted backup first if you want to restore it.</li>
            <li><strong>Server-side deletion:</strong> there is none tied to you. Chain data, once broadcast, is public and permanent.</li>
          </ul>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Security, and its limits</h2>
          <span className="panel-meta">not a hardware wallet</span>
        </div>
        <div className="panel-body">
          <p>
            The seed is generated on your device, stored only as ciphertext, and used to sign
            locally; a signature is refused unless the network reports the exact Mainnet identity
            this build expects. Malware on your computer, a compromised browser, or someone who
            knows your password can still defeat these protections. There is no password reset and
            no recovery service: without the password and a backup, the funds at that address are
            unreachable. This build has internal review and test evidence, but no external audit.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Contact and changes</h2>
          <span className="panel-meta">private reports only</span>
        </div>
        <div className="panel-body">
          <p>
            Report privacy or security issues privately through the repository&apos;s security
            advisories, never in a public issue with wallet details. Material changes to this
            policy are published here and noted on the store listing before the affected version
            ships; the version and date above always identify the current text.
          </p>
          <p>
            The extension is not directed at children and should not be used by anyone under 18:
            it handles irreversibly transferable value.
          </p>
        </div>
      </section>
    </div>
  );
}
