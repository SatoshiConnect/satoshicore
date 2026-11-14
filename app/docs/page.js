import Link from 'next/link';
import PageHeader from '../../components/PageHeader';
import { NSAT, groupExact } from '../../lib/nsatToken';

export const metadata = {
  title: 'Docs — SatoshiCore NSAT'
};

export default function DocsPage() {
  return (
    <div className="stack">
      <PageHeader
        eyebrow="NSAT · documentation"
        title="Documentation"
        lead="What NSAT is, how this site works, and how the wallet keeps a key safe."
        actions={
          <>
            <Link href="/dashboard" className="button">Live explorer</Link>
            <Link href="/wallet" className="button secondary">Open the wallet</Link>
          </>
        }
      />

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">What this project is (and is not)</h2>
          <span className="panel-meta">study project</span>
        </div>
        <div className="panel-body">
          <p>
            An independent, non-commercial study project. Nothing is sold, there is
            no presale, and nothing here is investment advice.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">What NSAT is</h2>
          <span className="panel-meta">{NSAT.decimals} decimals · fee {NSAT.baseFee}</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            <li>
              <strong>Own chain:</strong> SatoshiCore, own genesis, fixed supply —
              not a token on another network.
            </li>
            <li>
              <strong>Decimals:</strong> {NSAT.decimals} — whole NSAT only.
            </li>
            <li>
              <strong>Fee:</strong> {NSAT.baseFee} NSAT per operation, read from the
              live ledger before signing.
            </li>
            <li>
              <strong>Base reserve:</strong> {groupExact(NSAT.baseReserve)} NSAT; a
              new account needs {groupExact(NSAT.createMinimum)} NSAT on its first
              deposit (2× reserve).
            </li>
            <li>
              <strong>Accounts:</strong> {NSAT.accountKey} — one address across the
              iPhone app, desktop wallet and this site.
            </li>
          </ul>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">How this site is served</h2>
          <span className="panel-meta">static export · one origin</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            <li>
              <strong>Static export</strong> served by Caddy — no Node.js server
              behind the page.
            </li>
            <li>
              Same origin only: <code>/api/v1/*</code> is the gateway,{' '}
              <code>/v1/*</code> is the indexer behind{' '}
              <Link href="/explorer">search</Link>.
            </li>
            <li>
              If a service is down the UI says so — it never shows a fabricated
              balance or history row.
            </li>
          </ul>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Security model</h2>
          <span className="panel-meta">client-side signing</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            <li>
              Seeds are generated here, encrypted with PBKDF2 + AES-GCM, and stored
              only as ciphertext. Signing is client-side; the gateway relays signed
              envelopes.
            </li>
            <li>
              No signature unless the gateway reports the exact network identity{' '}
              <span className="mono">{NSAT.network}</span>.
            </li>
            <li>
              Shielded transfers need the native prover, so they are desktop-only.
            </li>
            <li>Full review: <code>SECURITY.md</code> in the repository.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
