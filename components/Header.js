import Link from 'next/link';

export default function Header() {
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href="/" className="brand">
          Satoshi<span>Core</span>
        </Link>
        <nav className="main-nav" aria-label="Main navigation">
          <Link href="/">Home</Link>
          <Link href="/wallet">Web Wallet</Link>
          <Link href="/docs">Docs</Link>
          <Link href="/status">Status</Link>
        </nav>
      </div>
    </header>
  );
}
