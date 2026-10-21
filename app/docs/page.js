export const metadata = {
  title: 'Docs — SatoshiCore'
};

export default function DocsPage() {
  return (
    <div>
      <h1>Documentation</h1>
      <h2>Deployment architecture</h2>
      <ul>
        <li>Static export via Next.js <code>output: &apos;export&apos;</code>, deployed to GitHub Pages by GitHub Actions.</li>
        <li>Production domain: <code>satoshicore.org</code> and <code>www.satoshicore.org</code> (DNS setup pending owner approval — see <code>docs/DEPLOYMENT.md</code>).</li>
        <li>Web Wallet API Gateway and Blockchain Indexer are separate backend services; this site consumes them from the browser only.</li>
        <li>Features that depend on unavailable backends render an explicit offline/experimental state.</li>
      </ul>
      <h2>Security</h2>
      <p>
        See <code>SECURITY.md</code>. In short: no secrets in the repository or
        static output, no public administrative APIs, and no publication of
        the production Web Wallet without owner approval.
      </p>
    </div>
  );
}
