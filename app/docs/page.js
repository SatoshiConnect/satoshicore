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
        lead="What this project is, what NSAT is, how this site is served, and how the wallet keeps a key safe. Everything below describes the running chain — no roadmap promises and no valuation claims."
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
            SatoshiCore is an independent, non-commercial study project: it exists to
            understand — by building and running — how a coin, a ledger and a wallet
            really behave. Nothing here is sold, there is no presale or token
            offering, and nothing on this site is investment advice. The first phase
            has one goal: a chain and wallet that simply work, send and receive
            included. If NSAT ever comes to have value, that would be a later, openly
            discussed chapter — this page makes no claims about it today.
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
              <strong>Own chain:</strong> SatoshiCore, with its own genesis — not a
              token on another network and not a Bitcoin account.
            </li>
            <li>
              <strong>Supply:</strong> fixed at genesis and never re-minted — no
              inflation and no halving schedule. The exact figure is a ledger fact,
              not a marketing number.
            </li>
            <li>
              <strong>Decimals:</strong> {NSAT.decimals} — one atomic unit is one
              NSAT; the wallet refuses fractional amounts.
            </li>
            <li>
              <strong>Fee:</strong> {NSAT.baseFee} NSAT per operation, read from the
              live ledger header before signing.
            </li>
            <li>
              <strong>Base reserve:</strong> {groupExact(NSAT.baseReserve)} NSAT; a
              brand-new account needs {groupExact(NSAT.createMinimum)} NSAT on its
              first deposit (2× reserve, a CREATE).
            </li>
            <li>
              <strong>Accounts:</strong> {NSAT.accountKey} — the same address works
              on the iPhone app, the desktop wallet and this site.
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
              <code>satoshicore.org</code> is a <strong>static export</strong>
              {' '}(<code>output: &apos;export&apos;</code>) served by Caddy from
              this machine — no Node.js server runs behind the page itself.
            </li>
            <li>
              The page calls its <strong>own origin</strong>: <code>/api/v1/*</code>{' '}
              goes to the Web Wallet API Gateway and <code>/v1/*</code> to the block
              indexer. One domain, no CORS preflight, and the same build works on any
              hostname Caddy answers on.
            </li>
            <li>
              Three separate services sit behind it: the <code>nsat-core</code> node
              (loopback only), the API gateway (read-only lookups + relay of
              already-signed envelopes), and the read-only indexer that powers the{' '}
              <Link href="/explorer">search page</Link>.
            </li>
            <li>
              If a service is down the UI says so — it never shows a fabricated
              balance, fee or history row.
            </li>
          </ul>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Updating the site</h2>
          <span className="panel-meta">build &amp; publish</span>
        </div>
        <div className="panel-body">
          <pre className="mono doc-block">
{`# build with the same-origin API switch
NEXT_PUBLIC_API_SAME_ORIGIN=1 npx next build

# publish the export to the directory Caddy serves
rsync -a --delete out/ /usr/local/var/satoshicore/web/`}
          </pre>
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
              Seeds are generated in the browser, encrypted with PBKDF2-SHA256
              (600k) + AES-GCM and stored only as ciphertext. Signing happens
              client-side; the gateway receives signed envelopes only.
            </li>
            <li>
              A signature is refused unless the gateway reports the exact network
              identity <span className="mono">{NSAT.network}</span>.
            </li>
            <li>
              Shielded operations need the native prover and are desktop-only; this
              site states that instead of faking the feature.
            </li>
            <li>See <code>SECURITY.md</code> in the repository for the full review.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
