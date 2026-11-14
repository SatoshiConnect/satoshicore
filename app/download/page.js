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
          <h3>2. Add the browser extension</h3>
          <p style={{ color: 'var(--muted)' }}>
            Manifest V{release.manifestVersion} · v{release.version} · built {release.builtAt} ·{' '}
            {release.permissions.join(', ')} · talks only to the gateway and indexer.
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.6rem', margin: '1rem 0 .4rem' }}>
            <a className="button" href={`/extension/${release.file}`} download>
              Download for Chrome, Edge, Brave
            </a>
            <a className="button secondary" href={`/extension/${release.firefoxFile}`} download>
              Download for Firefox
            </a>
          </div>
          <p style={{ color: 'var(--muted)', fontSize: '.85rem', margin: '0 0 1rem' }}>
            {release.bytes.toLocaleString()} bytes · {release.firefoxBytes.toLocaleString()} bytes.
            Both are the same wallet; only the manifest differs.
          </p>

          <p style={{ color: 'var(--fg)' }}>
            <strong>Chrome, Edge, Brave</strong>
          </p>
          <ol style={{ color: 'var(--muted)', lineHeight: 1.7, paddingLeft: '1.2rem', margin: '0 0 1rem' }}>
            <li>Unzip the downloaded file.</li>
            <li>Open <code>chrome://extensions</code> and turn on <strong>Developer mode</strong> (top right).</li>
            <li>Click <strong>Load unpacked</strong> and select the unzipped folder.</li>
          </ol>

          <p style={{ color: 'var(--fg)' }}>
            <strong>Firefox</strong>
          </p>
          <ol style={{ color: 'var(--muted)', lineHeight: 1.7, paddingLeft: '1.2rem', margin: '0 0 1rem' }}>
            <li>Unzip the file.</li>
            <li>
              Open <code>about:debugging#/runtime/this-firefox</code> →{' '}
              <strong>Load Temporary Add-on…</strong> → select <code>manifest.json</code>.
            </li>
            <li>A permanent install needs a signed build from addons.mozilla.org; this one lasts until Firefox restarts.</li>
          </ol>

          <p style={{ color: 'var(--muted)', fontSize: '.9rem' }}>
            <strong>Why there is no one-click install:</strong> Chrome and Firefox only install
            extensions from their own stores, and this build is not published to one yet. The steps
            above are the supported route — the download gives you a zip, not an install prompt.
            The web app in section 1 needs no unzip and no developer mode.
          </p>

          <details style={{ marginTop: '.75rem' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: '.9rem' }}>
              Verify the download (sha256)
            </summary>
            <p className="mono" style={{ fontSize: '.75rem', color: 'var(--muted)', wordBreak: 'break-all' }}>
              Chrome/Edge/Brave<br />{release.file}<br />sha256 {release.sha256}
            </p>
            <p className="mono" style={{ fontSize: '.75rem', color: 'var(--muted)', wordBreak: 'break-all' }}>
              Firefox<br />{release.firefoxFile}<br />sha256 {release.firefoxSha256}
            </p>
            <p style={{ color: 'var(--muted)', fontSize: '.85rem' }}>
              Compare with <code>shasum -a 256 &lt;file&gt;</code> before loading. A mismatch means the
              file is not the build this page describes.
            </p>
          </details>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.6rem', marginTop: '1rem' }}>
            <a className="button secondary" href="/docs/">Read the security model</a>
            <a className="button secondary" href="/extension/privacy/">Extension privacy</a>
          </div>
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
