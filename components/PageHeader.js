// One header block for every content page (Search, Docs, Status, Wallet).
// Eyebrow + title + lead come from the same neon design system the home page
// and the explorer use, so a page never looks like it belongs to another site.
export default function PageHeader({ eyebrow, title, lead, actions, meta }) {
  return (
    <header className="page-head">
      {eyebrow ? <p className="page-eyebrow">{eyebrow}</p> : null}
      <h1>{title}</h1>
      {lead ? <p className="page-lead">{lead}</p> : null}
      {actions ? <div className="page-actions">{actions}</div> : null}
      {meta ? <p className="page-meta">{meta}</p> : null}
    </header>
  );
}
