import Link from 'next/link';
import PageHeader from '../../components/PageHeader';

// DRAFT status is deliberately part of the page: the disclosure text is
// engineering-complete but NOT approved by the owner or a Thai legal advisor
// (NSAT UNIVERSAL WALLET DIRECTIVE §11). Nothing here may be read as advice,
// an offer, or a certified legal notice.

export const metadata = {
  title: 'Terms — NSAT Wallet (draft)',
  description:
    'Draft terms for the non-custodial NSAT wallet: no custody, no investment offer, no warranty. Awaiting legal review.'
};

const SECTIONS = [
  {
    title: 'What this software is',
    body: [
      'An independent, non-commercial study project. The wallet is non-custodial: it generates and encrypts keys on your device and signs locally. No company, operator or developer holds your keys, funds, or the ability to move them. Optional Google sign-in identifies a website session only; it does not unlock, sync or recover a wallet. There is no wallet login or recovery service.'
    ]
  },
  {
    title: 'Not an offer, not advice, no custody',
    body: [
      'Nothing here is a sale, presale, token offering, investment solicitation, guaranteed return, or financial, legal or tax advice. The wallet does not exchange or swap NSAT for any currency, process merchant payments, or hold funds on your behalf.'
    ]
  },
  {
    title: 'Your responsibility',
    body: [
      'You alone hold the wallet seed and password. Google website sign-in is a separate website identity session and cannot recover wallet access. If the seed/password are lost, or a device is lost, reset or compromised, nobody — including the project — can recover the funds at that address.',
      'A signed transaction is final: the ledger records it whether or not the recipient was correct. Verify address and amount on the confirmation screen before signing.'
    ]
  },
  {
    title: 'Fees and network rules',
    body: [
      'Every operation costs the network base fee read from the live ledger at signing time (currently 10 NSAT), and a new account must meet the ledger reserve on its first deposit. Fee and reserve values belong to Mainnet: this software reports them, it does not set them.'
    ]
  },
  {
    title: 'No warranty',
    body: [
      'Provided as-is. Bugs, outages, browser restrictions and chain conditions can prevent a transfer; when the wallet cannot read a ledger result it says so rather than showing the transfer as complete.',
      'To the extent permitted by law, the project is not liable for lost funds, lost access, or losses from use of this software.'
    ]
  },
  {
    title: 'Changes and governing law',
    body: [
      'These terms may change with the software; the version published here is current.',
      'Governing law, jurisdiction and consumer-rights wording must be completed by the owner with Thai counsel before this page is final.'
    ]
  }
];

export default function TermsPage() {
  return (
    <div className="stack">
      <PageHeader
        eyebrow="NSAT · legal"
        title="Terms of use"
        lead="Draft disclosure for the non-custodial wallet. Not yet reviewed by a lawyer."
        actions={
          <>
            <Link href="/privacy/" className="button secondary">Privacy</Link>
            <Link href="/security/" className="button secondary">Security model</Link>
          </>
        }
      />

      <section className="panel" style={{ borderColor: 'var(--warn, #f0b90b)' }}>
        <div className="panel-head">
          <h2 className="panel-title">Status of this document</h2>
          <span className="panel-meta">draft · pending legal review</span>
        </div>
        <div className="panel-body">
          <p>
            <strong>Draft.</strong> The behaviour described is accurate, but this text has not
            been reviewed against Thai digital-asset, payment-services or consumer-protection
            law. Do not rely on it as a legal notice until counsel approves it.
          </p>
        </div>
      </section>

      {SECTIONS.map((s) => (
        <section className="panel" key={s.title}>
          <div className="panel-head">
            <h2 className="panel-title">{s.title}</h2>
          </div>
          <div className="panel-body">
            {s.body.map((p) => <p key={p.slice(0, 40)}>{p}</p>)}
          </div>
        </section>
      ))}

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Where to check the facts</h2>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            <li>
              Keys and signing: <Link href="/security/">security model</Link> ·{' '}
              <code>SECURITY.md</code>.
            </li>
            <li>
              What is stored and sent: <Link href="/privacy/">privacy</Link>.
            </li>
            <li>
              Live chain facts: <Link href="/status/">status</Link>.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
