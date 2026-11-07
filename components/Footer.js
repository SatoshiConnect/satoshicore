import Link from 'next/link';
import { NSAT } from '../lib/nsatToken';

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <p>
          SatoshiCore · NSAT Mainnet — an independent study project, not a sale
          and not an investment offer. {NSAT.decimals} decimals,{' '}
          {NSAT.baseFee} NSAT per operation; the same account as the iPhone and
          desktop wallets.
        </p>
        <p className="footer-links">
          <Link href="/dashboard">Explorer</Link> · <Link href="/explorer">Search</Link> ·{' '}
          <Link href="/wallet">Wallet</Link> · <Link href="/docs">Docs</Link> ·{' '}
          <Link href="/status">Status</Link>
        </p>
        <p className="mono muted">{NSAT.network}</p>
      </div>
    </footer>
  );
}
