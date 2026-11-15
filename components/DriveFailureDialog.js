'use client';

// The single dialog every Drive failure opens: what went wrong, the page that
// fixes it, and the way out that needs no Google API at all.
//
// It is portalled to <body> because the phone frame is transformed, which would
// make a fixed-position dialog position against the frame instead of the screen
// and land off-view on a tall page.
import { createPortal } from 'react-dom';

export default function DriveFailureDialog({ dialog, onClose, onDownload, canDownload }) {
  if (!dialog || typeof document === 'undefined') return null;
  return createPortal(
    <div className="nw-modal-back" role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="nw-modal nw-modal-alert" role="alertdialog" aria-modal="true"
        aria-labelledby="nw-drive-dialog-title" tabIndex={-1} autoFocus
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <div className="nw-step">WALLET BACKUP · GOOGLE DRIVE</div>
        <h3 id="nw-drive-dialog-title" style={{ color: 'var(--text)' }}>{dialog.title}</h3>
        <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>{dialog.message}</p>
        <div className="nw-btn-row" style={{ margin: '14px 0 0' }}>
          {dialog.fix ? (
            <a className="nw-chip-btn" href={dialog.fix.url} target="_blank" rel="noreferrer">
              {dialog.fix.label}
            </a>
          ) : null}
          {canDownload && onDownload ? (
            <button type="button" className="nw-chip-btn" onClick={onDownload}>
              Download backup file
            </button>
          ) : null}
          <button type="button" className="nw-send-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
