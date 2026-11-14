'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from './ThemeToggle';

// One navigation for the whole site. "Explorer" is the live dashboard, and
// "Search" is the account/transaction lookup that used to be called Explorer
// too — two pages under one name is what made the site feel like two sites.
const NAV = [
  { href: '/', label: 'Home' },
  { href: '/dashboard', label: 'Explorer' },
  { href: '/explorer', label: 'Search' },
  { href: '/wallet', label: 'Wallet' },
  { href: '/download', label: 'Download' },
  { href: '/docs', label: 'Docs' },
  { href: '/status', label: 'Status' }
];

// The mark is the same gem as the iPhone app icon (flat table, brilliant
// crown, pointed pavilion) drawn once so header and favicon stay in sync.
export function GemMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4.2 9.4 8.8 4h6.4l4.6 5.4L12 20.4Z" fill="#fff" />
      <path d="M12 20.4 8.8 4H12Z" fill="#fff" opacity="0.82" />
      <path d="M4.2 9.4h15.6L12 20.4Z" fill="#fff" opacity="0.9" />
      <path d="M8.8 4h6.4l-3.2 5.4Z" fill="#fff" />
    </svg>
  );
}

export default function Header() {
  const pathname = usePathname();
  // /explorer renders the "Search" entry; /dashboard is "Explorer". Both are
  // prefix matches, so keep them explicit instead of startsWith on either.
  const isActive = (href) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href="/" className="brand">
          <span className="brand-mark">
            <GemMark />
          </span>
          SatoshiCore <span className="brand-sub">NSAT</span>
        </Link>
        <div className="header-tools">
          <nav className="main-nav" aria-label="Main navigation">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive(item.href) ? 'page' : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
