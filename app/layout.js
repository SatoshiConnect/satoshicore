import './globals.css';
import Header from '../components/Header';
import Footer from '../components/Footer';
import SwRegister from '../components/SwRegister';

export const metadata = {
  title: 'SatoshiCore — NSAT wallet & explorer',
  description:
    'NSAT, the coin of the SatoshiCore chain — a working, non-commercial study '
    + 'project with 0 decimals and 10 NSAT per operation. Web wallet, block '
    + 'explorer and live network status.'
};

// Same chrome colors as the iPhone app: #F2F2F7 light, #1C1C1E dark.
export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f2f2f7' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1c1e' }
  ],
  // An installed PWA should fill the screen like the native apps do.
  viewportFit: 'cover'
};

// The manifest and icons are static files in public/, so their URLs follow the
// base path of the deployment (domain root or a GitHub Pages project subpath).
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || '';

// Site-wide Content-Security-Policy (<meta http-equiv> is honored only when
// it is a DIRECT child of <head>; GitHub Pages cannot add response headers,
// so this is the available layer for the static deployment).
//  - script-src keeps 'unsafe-inline' because the Next.js static export
//    relies on inline bootstrap/hydration scripts. Dev additionally needs
//    'unsafe-eval' (react-refresh) — production never receives it.
//  - frame-ancestors is header-only (ignored in meta delivery) and belongs
//    to the gateway's HTTP responses, not here.
const DEV_EVAL = process.env.NODE_ENV === 'development' ? "'unsafe-eval'" : '';

// https: covers any TLS origin (the production gateway included). Plain-HTTP
// endpoints are listed explicitly, so a LAN or loopback gateway works in dev
// without widening the policy to every http origin.
function originOf(value) {
  try {
    return new URL(value || '').origin;
  } catch {
    return null;
  }
}
const PLAIN_HTTP_ORIGINS = [
  originOf(process.env.NEXT_PUBLIC_API_GATEWAY_URL),
  originOf(process.env.NEXT_PUBLIC_INDEXER_URL),
  'http://127.0.0.1:8787',
  'http://127.0.0.1:8789',
  'http://localhost:8787',
  'http://localhost:8789'
]
  .filter((origin) => origin && origin.startsWith('http://'))
  .join(' ');

const SITE_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${DEV_EVAL}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' https: ${PLAIN_HTTP_ORIGINS}`.trim(),
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta httpEquiv="Content-Security-Policy" content={SITE_CSP} />
        {/* PWA: installable, standalone, offline shell (public/sw.js). */}
        {/* .json, not .webmanifest: the static host has no manifest+json MIME
            mapping, so a .webmanifest file was served as text/plain. */}
        <link rel="manifest" href={`${BASE}/manifest.json`} />
        <link rel="apple-touch-icon" href={`${BASE}/icons/apple-touch-icon.png`} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="NSAT Wallet" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body>
        <Header />
        <main className="container site-main">{children}</main>
        <Footer />
        <SwRegister />
      </body>
    </html>
  );
}
