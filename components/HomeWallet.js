import Link from 'next/link';

// Homepage = wallet access, not a landing page (NSAT UNIVERSAL WALLET DIRECTIVE §7).
// Two primary actions only: open the wallet, or install the extension. Everything
// else is secondary. No promises, no price, no investment framing.
export default function HomeWallet() {
  return (
    <section className="hero">
      <p className="mono" style={{ color: 'var(--muted)', letterSpacing: '.18em', marginBottom: '.75rem' }}>
        NSAT · MAINNET
      </p>
      <h1>NSAT Wallet</h1>
      <p className="lead">
        A non-custodial wallet for NSAT. Keys are generated and encrypted on this
        device, transactions are signed locally, and the gateway only ever relays an
        already-signed envelope — it never holds a key. Works in this browser and as
        an installable app.
      </p>

      <div className="cta-row">
        <Link className="button" href="/wallet/">Open NSAT Wallet</Link>
        <Link className="button secondary" href="/download/">Install Browser Extension</Link>
      </div>

      <div className="hero-badges">
        <span>Non-custodial</span>
        <span>0 decimals</span>
        <span>10 NSAT per operation</span>
        <span>Mainnet only</span>
      </div>

      <div className="grid-3" style={{ marginTop: '2.5rem' }}>
        <article className="card">
          <h3>Network</h3>
          <p>Live node status, ledger height and the exact network identity the wallet signs against.</p>
          <Link href="/status/">Network status →</Link>
        </article>
        <article className="card">
          <h3>Explorer</h3>
          <p>Read the indexed ledger: accounts, transfers and the ledger&apos;s own verdict for a transaction hash.</p>
          <Link href="/explorer/">Open explorer →</Link>
        </article>
        <article className="card">
          <h3>Documentation</h3>
          <p>How the wallet protects keys, what is verified against the chain, and what stays out of scope.</p>
          <Link href="/docs/">Read the docs →</Link>
        </article>
      </div>

      {/* Secondary (directive §7): security and the legal drafts are one click
          away without competing with the two wallet actions above. */}
      <p className="mono" style={{ marginTop: '1.5rem', color: 'var(--muted)', fontSize: '.85rem' }}>
        <Link href="/security/">Security model</Link>
        {' · '}
        <Link href="/terms/">Terms</Link>
        {' · '}
        <Link href="/privacy/">Privacy</Link>
      </p>
    </section>
  );
}
