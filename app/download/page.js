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
  if (status === 'BUILD_PRODUCED') return { color: 'var(--ok, #22c55e)' };
  if (status === 'NOT_SUPPORTED') return { color: 'var(--err, #f87171)' };
  return { color: 'var(--warn, #f0b90b)' };
}

export default function DownloadPage() {
  return (
    <section>
      <p className="mono" style={{ color: 'var(--muted)', letterSpacing: '.18em', marginBottom: '.75rem' }}>
        NSAT · WALLET
      </p>
      <h1>Download</h1>
      <p className="lead">
        Two ways to use the same wallet. Both are non-custodial: the seed is generated
        and encrypted on your device, and only a signed transaction envelope ever
        reaches the gateway. Neither needs an app store.
      </p>

      <div className="grid-2" style={{ marginTop: '2rem' }}>
        <article className="card">
          <h3>1. Install the web app (PWA)</h3>
          <p style={{ color: 'var(--muted)' }}>
            The wallet at <code>/wallet</code> is installable and opens standalone, with
            an offline shell. It still needs the network for balances, fees and
            confirmation.
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
            Manifest V{release.manifestVersion} build, version {release.version}, built
            {' '}{release.builtAt}. It talks only to {release.endpoints.gateway} and
            {' '}{release.endpoints.indexer}, and asks for exactly two permissions
            ({release.permissions.join(', ')}).
          </p>
          <p style={{ color: 'var(--muted)' }}>
            <strong>Not published to any extension store yet.</strong> The packaged
            artifact ships inside the repository as
            {' '}<code>satoshicore-web/extension/{release.file}</code>
            {' '}({release.bytes.toLocaleString()} bytes) and is loaded with
            <em> Load unpacked</em> in <code>chrome://extensions</code>.
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
        Claims below describe what was actually produced and tested — not what is
        planned. A browser listed as &quot;build produced&quot; still has to be exercised by
        a person before it is called supported.
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

      <p style={{ color: 'var(--muted)', marginTop: '1.5rem', fontSize: '.85rem' }}>
        Artifact test evidence: {release.tests.passed} passed, {release.tests.failed} failed
        (manifest, CSP, no secrets, domain-only endpoints, vault round-trip).
      </p>
    </section>
  );
}
