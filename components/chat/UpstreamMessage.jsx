'use client';

// Adapted from SaeedNix/telegram-clone `src/components/middleBar/Message.tsx`
// (MIT, commit 618e4164e623086883deceada713e302e9a648f3).
//
// What was kept from upstream: the row/avatar + bubble shape, the sender name
// above a received bubble, the quoted-reply block with its accent bar, and the
// footer line (time, queued/failed mark, read receipt) pinned bottom-right.
//
// What was removed, because it belongs to that project's own data layer rather
// than to presentation: Mongoose models (`MessageModel`, `Voice`), the Zustand
// stores (`useSockets`, `useModalStore`, `useGlobalStore`), Socket.io emits and
// the message action menu. This component is presentational only: the caller
// supplies the already-decrypted text, time and receipt, and any wallet-specific
// card stays as children so payment messages keep working.
//
// Styling was translated from Tailwind/daisyUI utility classes to the app's
// `nw-` tokens in `app/wallet/wallet.css`; no Tailwind is added to the bundle.
export default function UpstreamMessage({
  own = false,
  author = '',
  time = '',
  status = '',
  receipt = '',
  showAvatar = false,
  avatarLabel = '',
  children,
}) {
  return (
    <li className={`nw-msg${own ? ' is-own' : ''}`}>
      {showAvatar ? (
        <span className="nw-msg-avatar" aria-hidden="true">{avatarLabel}</span>
      ) : (
        <span className="nw-msg-avatar is-empty" aria-hidden="true" />
      )}
      <div className="nw-msg-bubble">
        {author ? <p className="nw-msg-author">{author}</p> : null}
        <div className="nw-msg-body">{children}</div>
        {time || status || receipt ? (
          <span className="nw-msg-meta">
            {time ? <span>{time}</span> : null}
            {status === 'pending' ? <span aria-label="Queued">◷</span> : null}
            {status === 'failed' ? <span className="is-failed" aria-label="Not sent">!</span> : null}
            {receipt ? <span>{receipt}</span> : null}
          </span>
        ) : null}
      </div>
    </li>
  );
}
