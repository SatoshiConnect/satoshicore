# Screenshots — what the listing needs and how to take them

The Chrome Web Store requires at least one **1280×800** screenshot (up to
five). 640×400 is also accepted. The popup itself is 400 px wide, so a raw
capture is padded on a brand background — never stretched.

## Status

**Not produced yet, and deliberately not faked.** The extension has never been
loaded into a real Chrome profile in this project (its status is
`BUILD_PRODUCED`, not `TESTED_IN_BROWSER`), so there is no authentic screenshot
to take from. Generating a mock-up of a screen nobody has seen would misrepresent
the item to reviewers and users. The owner captures these on a machine where the
extension is loaded.

## Capture recipe

1. `npm run build:extension`, then load `extension/dist` via
   `chrome://extensions` → Developer mode → **Load unpacked**.
2. Click the toolbar icon. Set the window to a 1280×800 viewport (or capture at
   2× and downscale).
3. Put the 400 px popup on a plain background using the site's own colours:
   `#0a0c11` (dark) or `#f6f7f9` (light), with `#4464f2` as the only accent.
   Keep at least 64 px of padding; do not add marketing claims, ratings, or
   browser chrome that implies an endorsement.
4. Export PNG at exactly 1280×800. No rounded-corner collage, no text overlays
   that claim features the build does not have.

## The five shots worth having, in priority order

| # | Screen | Why it earns the slot |
|---|---|---|
| 1 | Unlocked wallet: address, balance, live base fee, Send button | Shows the core value in one glance, with a real fee read from the ledger |
| 2 | Review-before-sign sheet with recipient, amount, fee, total debit | The safety story: nothing signs without explicit review |
| 3 | Create / import screen | Explains that the key is made (or restored) on the device |
| 4 | Locked state with unlock field | Shows the password gate and the "keys stay here" claim visually |
| 5 | Settings: lock, backup export, account switch | Shows it is a wallet, not a one-screen demo |

## Honesty rules for these images

- A zero balance is fine and truthful; do not stage a balance the build cannot
  show.
- If a reviewer sees a "confirmed" state in a screenshot, the build must be able
  to reach it with a real ledger result — it can, once a transaction confirms.
- Do not screenshot another wallet's UI or a browser feature the extension does
  not have.
- Screenshots must match v24.0.0; re-capture after any visual change rather than
  shipping stale images (the theme audit in `scripts/theme-audit.mjs` shows the
  current palette for both themes).
