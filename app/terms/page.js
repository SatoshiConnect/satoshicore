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
      'SatoshiCore and the NSAT wallet are an independent, non-commercial study project. The wallet is non-custodial software: it generates keys on your device, encrypts them on your device, and signs transactions locally.',
      'No company, operator or developer ever holds your keys, your funds or the ability to move them. There is no account, no login and no recovery service.'
    ]
  },
  {
    title: 'Not an offer, not advice, no custody',
    body: [
      'Nothing on this site is a sale, presale, token offering, investment solicitation, guaranteed return or financial, legal or tax advice. NSAT is not presented as an investment product.',
      'This wallet does not exchange, swap, buy or sell NSAT for any currency, does not process merchant payments, and does not hold funds on your behalf.'
    ]
  },
  {
    title: 'Your responsibility',
    body: [
      'You are the only holder of your seed and password. If you lose them, or if a device is lost, reset or compromised, the funds at that address cannot be recovered by anyone — including the project.',
      'A transaction signed by your device is final. The ledger records it whether or not the recipient was correct, so verify the address and the amount on the confirmation screen before signing.'
    ]
  },
  {
    title: 'Fees and network rules',
    body: [
      'Every operation costs the network base fee read from the live ledger header at signing time (currently 10 NSAT). A new account also has to meet the ledger reserve rule on its first deposit; the wallet refuses an amount the chain would reject.',
      'Fee and reserve values are properties of the running Mainnet. This software reports them, it does not set them.'
    ]
  },
  {
    title: 'No warranty',
    body: [
      'The software is provided as-is, without warranty of any kind. Bugs, outages, browser restrictions and chain conditions can prevent a transfer from completing. When the wallet cannot read a ledger result it says so instead of showing a transfer as complete.',
      'To the extent permitted by applicable law, the project is not liable for lost funds, lost access, or losses arising from use of this software.'
    ]
  },
  {
    title: 'Changes and governing law',
    body: [
      'These terms may change as the software changes; the version published here is the current one.',
      'Governing law, jurisdiction and any consumer-rights wording must be completed by the owner with Thai counsel before this page is presented as final.'
    ]
  }
];

export default function TermsPage() {
  return (
    <div className="stack">
      <PageHeader
        eyebrow="NSAT · legal"
        title="Terms of use"
        lead="Draft disclosure for the non-custodial NSAT wallet. Written to be accurate about what the software does; it is not yet reviewed by a lawyer and is not legal advice."
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
            <strong>Draft.</strong> This page states the project&apos;s actual behaviour, but it
            has not been reviewed against Thai digital-asset, payment-services or
            consumer-protection law, and it must not be relied on as a legal notice until
            the owner and counsel approve it. Placeholders that require that review are
            marked as such below rather than filled with invented wording.
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
              Key handling and signing: <Link href="/security/">security model</Link> and{' '}
              <code>SECURITY.md</code> in the repository.
            </li>
            <li>
              What is stored in your browser and what is sent to the network:{' '}
              <Link href="/privacy/">privacy</Link>.
            </li>
            <li>
              Live chain facts (fee, ledger height, network identity):{' '}
              <Link href="/status/">status</Link>.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
