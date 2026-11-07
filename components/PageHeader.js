// Shared page header: eyebrow + title + lead, plus an optional action slot and a
// metadata line. Kept presentational and dependency-free so any page can use it.
// (PR #6 imported this component but the file was never committed, which made
// the branch fail to build.)
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
