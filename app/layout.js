import './globals.css';
import Header from '../components/Header';
import Footer from '../components/Footer';

export const metadata = {
  title: 'SatoshiCore — Web Platform',
  description:
    'SatoshiCore Web Platform v24.0. Static web platform for the SatoshiCore ecosystem.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Header />
        <main className="container site-main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
