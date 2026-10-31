import Link from 'next/link';

export default function HomePage() {
  return (
    <div>
      <section className="hero">
        <h1>SatoshiCore Web Platform</h1>
        <p className="lead">
          Version 24.0 — a fully static web platform. This site is served
          without a Node.js backend; all interactive features are client-side,
          and backend-dependent functionality is clearly marked while those
          services are rolled out separately.
        </p>
        <div className="cta-row">
          <Link href="/wallet" className="button">
            Open Web Wallet
          </Link>
          <Link href="/docs" className="button secondary">
            Documentation
          </Link>
        </div>
      </section>

      <section className="grid-3">
        <div className="card">
          <h3>Static-first architecture</h3>
          <p>
            Built with Next.js static export. Served from GitHub Pages with no
            application server, no server-side secrets and minimal attack
            surface.
          </p>
        </div>
        <div className="card">
          <h3>Separate backend services</h3>
          <p>
            The Web Wallet API Gateway and the Blockchain Indexer are
            independent services with their own deployment lifecycles. This
            site talks to them only from the browser, only when they are
            configured.
          </p>
        </div>
        <div className="card">
          <h3>Security by default</h3>
          <p>
            No private keys, credentials or signing seeds exist in this
            repository or the deployed static output. Administrative APIs are
            never exposed through this site.
          </p>
        </div>
      </section>
    </div>
  );
}
