import release from '../../extension/release.json';

export const metadata = {
  title: 'Download — NSAT Wallet',
  description:
    'Install the NSAT wallet as an app in your browser, or load the browser extension build. Non-custodial, keys stay on your device.',
};

const STATUS_LABEL = {
  BUILD_PRODUCED: 'Build produced',
  NOT_BUILT: 'Not built yet',
  NOT_TESTED: 'Not tested',
  NOT_SUPPORTED: 'Not supported',
};

function statusTone(status) {
  // Use the design tokens; there is no --err token, and a fallback hex here
  // silently broke light-mode contrast.
  if (status === 'BUILD_PRODUCED') return { color: 'var(--ok)' };
  if (status === 'NOT_SUPPORTED') return { color: 'var(--danger)' };
  return { color: 'var(--warn)' };
}

export default function DownloadPage() {
  return (
    <section>
      <h1>Download</h1>
      <p className="lead">
        Install the wallet as an app, or load the extension build. Neither needs an
        app store; keys stay on your device.
      </p>

      <div className="grid-2" style={{ marginTop: '2rem' }}>
        <article className="card">
          <h3>1. Install the web app (PWA)</h3>
          <p style={{ color: 'var(--muted)' }}>
            Opens standalone with an offline shell; balances and fees still need the
            network.
          </p>
          <ul style={{ color: 'var(--muted)', lineHeight: 1.7, paddingLeft: '1.1rem' }}>
            <li><strong>iPhone / iPad:</strong> open the wallet in Safari → Share → Add to Home Screen.</li>
            <li><strong>Android:</strong> open in Chrome → menu → Install app (or &quot;Add to Home screen&quot;).</li>
            <li><strong>Windows / macOS:</strong> open in Chrome or Edge → install icon in the address bar.</li>
          </ul>
          <a className="button" href="/wallet/" style={{ marginTop: '.5rem' }}>Open the wallet</a>
        </article>

        <article className="card">
          <h3>2. Load the browser extension</h3>
          <p style={{ color: 'var(--muted)' }}>
            Manifest V{release.manifestVersion}, version {release.version}, built{' '}
            {release.builtAt} · {release.permissions.join(', ')} · talks only to the
            gateway and indexer.
          </p>
          <p style={{ color: 'var(--muted)' }}>
            <strong>Not published to any extension store.</strong> Load{' '}
            <code>extension/{release.file}</code> ({release.bytes.toLocaleString()}{' '}
            bytes) with <em>Load unpacked</em> in <code>chrome://extensions</code>.
          </p>
          <p className="mono" style={{ fontSize: '.78rem', color: 'var(--muted)', wordBreak: 'break-all' }}>
            sha256 {release.sha256}
          </p>
          <p style={{ color: 'var(--muted)', fontSize: '.85rem' }}>
            Verify before loading: <code>shasum -a 256 {release.file}</code>
          </p>
          <p style={{ color: 'var(--muted)', fontSize: '.85rem' }}>
            Firefox package: <code>{release.firefoxFile}</code>
            {' '}({release.firefoxBytes.toLocaleString()} bytes)
          </p>
          <p className="mono" style={{ fontSize: '.78rem', color: 'var(--muted)', wordBreak: 'break-all' }}>
            sha256 {release.firefoxSha256}
          </p>
          <a className="button secondary" href="/docs/">Read the security model</a>
        </article>
      </div>

      <h2 style={{ marginTop: '2.5rem' }}>Browser support</h2>
      <p style={{ color: 'var(--muted)' }}>
        &quot;Build produced&quot; means a package exists — not that a person has run it in
        that browser.
      </p>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.92rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
              <th style={{ padding: '.5rem .4rem' }}>Browser</th>
              <th style={{ padding: '.5rem .4rem' }}>Status</th>
              <th style={{ padding: '.5rem .4rem' }}>Note</th>
            </tr>
          </thead>
          <tbody>
            {release.browsers.map((b) => (
              <tr key={b.name} style={{ borderTop: '1px solid rgba(148,163,184,.18)' }}>
                <td style={{ padding: '.55rem .4rem' }}>{b.name}</td>
                <td style={{ padding: '.55rem .4rem', ...statusTone(b.status) }}>
                  {STATUS_LABEL[b.status] || b.status}
                </td>
                <td style={{ padding: '.55rem .4rem', color: 'var(--muted)' }}>{b.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </section>
  );
}
