# Chrome Web Store submission pack — NSAT Wallet v24.0.0

> **SHELVED (2026-11-14).** The owner decided against publishing the browser
> extension, because store publication needs a paid developer account and an
> ongoing listing. The product surface is the installable web app only: the
> extension is no longer offered or served from the site, and
> `/extension/privacy/` was removed. This pack is kept because the text is still
> accurate for the packaged build and would be needed if that decision changes;
> it must not be used to describe the site as it ships today.

Everything a reviewer asks for, written against the code that ships in
`extension/nsat-wallet-v24.0.0-production.zip` (80,478 bytes,
sha256 `945d58a2bb80…`). Nothing here claims a store listing exists: the
artifact is `storePublished: false` and stays that way until the owner
submits it.

| File | Use |
|---|---|
| [`listing.md`](./listing.md) | Store listing tab: name, short + detailed description, category, links, required graphics |
| [`privacy-practices.md`](./privacy-practices.md) | Privacy tab: single purpose, permission justifications, remote-code answer, data-usage form |
| [`privacy-policy.md`](./privacy-policy.md) | Policy text, also published at <https://satoshicore.org/extension/privacy/> |
| [`screenshots.md`](./screenshots.md) | The 1280×800 captures the listing needs, and how to take them honestly |

## What only the owner can do (in this order)

These steps need a Google account, a payment, and a legal declaration. They
cannot be scripted from the repository.

1. **Register** at <https://chrome.google.com/webstore/devconsole/> and pay the
   one-time **$5** registration fee. Enable 2-Step Verification on that account.
2. **Create the item** and upload `extension/nsat-wallet-v24.0.0-production.zip`
   (not the Firefox zip — the two manifests differ).
3. **Store listing**: paste `listing.md`; upload the 128×128 icon
   (`extension/icons/icon-128.png`) and at least one 1280×800 screenshot.
4. **Privacy**: paste `privacy-practices.md`; set the privacy-policy URL to
   <https://satoshicore.org/extension/privacy/>.
5. **Distribution**: public, all regions. **Trader status**: the project is an
   independent, non-commercial study project with no revenue, which suggests
   "non-trader" under the EU DSA — but this is a legal declaration about the
   owner, so the owner makes it, not the repository.
6. **Test instructions**: paste the block at the end of `listing.md` so a
   reviewer can reach the wallet UI without funds or credentials.
7. **Submit for review.** Google's own guidance: most reviews finish in a few
   days, worst case a few weeks; contact developer support after three weeks.

## Facts a reviewer will check against the package

- Manifest V3, `minimum_chrome_version` 114, permissions `storage` + `downloads`.
- Host permissions are exactly two origins:
  `https://gateway.satoshicore.org/*` and `https://satoshicore.org/*`.
  No `<all_urls>`, no `tabs`, no `scripting`, no content scripts, no background
  worker, no `web_accessible_resources`.
- No remote code: everything is bundled by esbuild at build time
  (`scripts/build-extension.mjs`); the popup executes only packaged files.
- The keystore is AES-GCM-256 ciphertext over PBKDF2-HMAC-SHA256 (600,000
  iterations) in `chrome.storage.local`; plaintext seeds exist only in the
  popup's memory while unlocked, and closing the popup destroys that context.

## What this pack deliberately does not say

It does not call the wallet "audited" (there is no external audit), does not
promise profit, and does not claim the extension is available anywhere yet.
Overstating any of those is a rejection risk and, more importantly, untrue.

## Thai summary (สำหรับเจ้าของ)

ชุดเอกสารนี้เขียนจากโค้ดที่ build จริงในรอบนี้ ครบทั้ง 4 ส่วนที่ Chrome ต้องใช้:
คำอธิบายร้านค้า, คำชี้แจงสิทธิ์ทีละรายการ, นโยบายความเป็นส่วนตัว (มีหน้าเว็บจริงให้ใช้เป็น URL),
และสเปกภาพหน้าจอ สิ่งที่ผมทำแทนไม่ได้มีอย่างเดียว: สมัครบัญชีนักพัฒนา จ่าย $5 เปิด 2FA
ประกาศสถานะ trader และกดส่งตรวจ รวมถึงถ่ายภาพหน้าจอจากส่วนเสริมที่โหลดจริงบนเครื่องของเจ้าของ
