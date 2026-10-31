import './globals.css';
import Header from '../components/Header';
import Footer from '../components/Footer';

export const metadata = {
  title: 'SatoshiCore — Web Platform',
  description:
    'SatoshiCore Web Platform v24.0. Static web platform for the SatoshiCore ecosystem.'
};

// Site-wide Content-Security-Policy (<meta http-equiv> is honored only when
// it is a DIRECT child of <head>; GitHub Pages cannot add response headers,
// so this is the available layer for the static deployment).
//  - script-src keeps 'unsafe-inline' because the Next.js static export
//    relies on inline bootstrap/hydration scripts. Dev additionally needs
//    'unsafe-eval' (react-refresh) — production never receives it.
//  - frame-ancestors is header-only (ignored in meta delivery) and belongs
//    to the gateway's HTTP responses, not here.
const DEV_EVAL = process.env.NODE_ENV === 'development' ? "'unsafe-eval'" : '';
const SITE_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${DEV_EVAL}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https: http://127.0.0.1:8790 http://localhost:8790 http://127.0.0.1:8787",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta httpEquiv="Content-Security-Policy" content={SITE_CSP} />
      </head>
      <body>
        <Header />
        <main className="container site-main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
