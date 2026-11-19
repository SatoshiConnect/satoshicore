# Third-party notices

This project ships code adapted from, or packages published by, the projects
below. Each entry names the exact source and what was changed.

## SaeedNix/telegram-clone — MIT

- Repository: https://github.com/SaeedNix/telegram-clone
- Commit inspected: `618e4164e623086883deceada713e302e9a648f3`
- Licence: MIT (Copyright (c) 2025 Saeed Abedini), read from the repository's
  `LICENSE` file.
- Upstream file adapted: `src/components/middleBar/Message.tsx`
- Destination: `components/chat/UpstreamMessage.jsx`, styles in
  `app/wallet/wallet.css` (`.nw-msg*`)
- What was kept: the row + avatar column, the sender name above a received
  bubble, the bubble shape and tail direction, and the footer line (time, queued
  mark, read receipt).
- What was removed: `MessageModel`/`Voice` Mongoose models, the Zustand stores
  (`useSockets`, `useModalStore`, `useGlobalStore`), Socket.io emits, the
  message action menu and the Tailwind/daisyUI utility classes.
- What was added: props for already-decrypted content, time, status and receipt;
  wallet-specific cards stay as children so NSAT payment messages are unchanged.
- The upstream project is not bundled, not forked in-tree, and no other file from
  it is copied.

## emoji-picker-react — MIT

- Package: `emoji-picker-react@4.14.1` (dependency, not vendored).
- Used in `components/ChatPanel.js` as a lazily loaded chunk.
- Same picker the inspected `telegram-clone` depends on.

## Colyseus — MIT

- Packages: `colyseus@0.18.12`, `@colyseus/schema@5.0.50` (world server) and
  `@colyseus/sdk@0.18.10` (browser world client).
- Used as published packages; no upstream source is vendored.

## Not used

- `TelegramOrg/Telegram-web-z` and `-k` — GPL-3.0; linking them into this bundle
  would relicense the combined work.
- `cashubtc/cashu.me` — MIT, but a Quasar/Vue app speaking the Cashu protocol.
- `RSamaium/RPG-JS` — MIT, but it needs its own Vite pipeline and room server.
- `PhatBanhGH/TheGathering` — no licence file, therefore all rights reserved.
