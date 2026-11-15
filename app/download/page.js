import Link from 'next/link';
import InstallApp from '../../components/InstallApp';

export const metadata = {
  title: 'Install — NSAT Wallet',
  description:
    'Install the NSAT wallet as an app on your phone, tablet or computer. No app store, no extension, no zip: it opens standalone and keeps keys on your device.',
};

export default function DownloadPage() {
  return (
    <section>
      <h1>Install the wallet</h1>
      <p className="lead">
        Adds to your home screen or dock and opens standalone. No app store, no extension, no
        file to unzip — and keys stay on your device.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.6rem', margin: '1.25rem 0 2rem' }}>
        <Link className="button" href="/">Open the wallet</Link>
        <InstallApp />
      </div>

      <div className="grid-2">
        <article className="card">
          <h3>On a phone or tablet</h3>
          <ul style={{ color: 'var(--muted)', lineHeight: 1.7, paddingLeft: '1.1rem' }}>
            <li><strong>iPhone / iPad:</strong> open the wallet in Safari → Share → Add to Home Screen.</li>
            <li><strong>Android:</strong> open in Chrome → menu → Install app (or &quot;Add to Home screen&quot;).</li>
          </ul>
        </article>
        <article className="card">
          <h3>On a computer</h3>
          <ul style={{ color: 'var(--muted)', lineHeight: 1.7, paddingLeft: '1.1rem' }}>
            <li><strong>Chrome, Edge, Brave:</strong> install icon in the address bar, or menu → Install.</li>
            <li>It then opens in its own window, without the browser toolbar.</li>
            <li>Firefox does not install web apps; open the site in your browser there.</li>
          </ul>
        </article>
      </div>

      <section className="panel" style={{ marginTop: '1.5rem' }}>
        <div className="panel-head">
          <h2 className="panel-title">Why there is no browser extension</h2>
          <span className="panel-meta">one install path</span>
        </div>
        <div className="panel-body">
          <p>
            Chrome and Firefox only install extensions from their own stores. Publishing there
            means a paid developer account, a review queue and a listing to keep current, so this
            project ships the installable web app instead: the same wallet code, one click, no
            zip file and no developer mode.
          </p>
          <p className="nw-extras-note" style={{ marginTop: '.5rem' }}>
            The installed app and the website share one encrypted store in this browser — there is
            no second copy of your keys, and neither can read the other&apos;s origin.
          </p>
        </div>
      </section>

      <p style={{ color: 'var(--muted)', marginTop: '1.5rem' }}>
        Before you install, read the <Link href="/security/">security model</Link> and the{' '}
        <Link href="/privacy/">privacy disclosure</Link>.
      </p>
    </section>
  );
}
