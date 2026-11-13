# NSAT Universal Wallet — Project Status

อัปเดต: 2026-11-13 · Repo: `SatoshiConnect/satoshicore` (โฟลเดอร์ `satoshicore-web`) · Branch: `feat/sponsored-accounts-wallet`
Commit ล่าสุดของรอบนี้: `e4952520f7fc0cf8a96371c65a63447f1b8daed2`

สถานะที่ใช้: **IMPLEMENTED → VERIFIED → REVIEWED → MERGED → RELEASE-READY → DEPLOYED**
สถานะการตรวจ: IMPLEMENTED / VERIFIED / BROKEN / MISSING / BLOCKED / NOT INSPECTED

---

## 1. ผลตรวจสภาพปัจจุบัน (§3)

| # | หัวข้อ | สถานะ | หลักฐาน / หมายเหตุ |
|---|---|---|---|
| 1 | Web Wallet (`/wallet`) | **VERIFIED** | เปิดในเบราว์เซอร์จริงกับ mainnet: `Mainnet verified`, ledger สด, สร้างกระเป๋าใหม่ได้, ยอด `0 NSAT` exact 128-bit, base fee 10 |
| 2 | Shared wallet logic | **VERIFIED** | `lib/nsatClient.js`, `lib/nsatWallet.js`, `lib/nsatCodec.js`, `lib/nsatSendPreflight.js` ถูกใช้ร่วมกันทั้งเว็บและ extension (ไฟล์เดียวกัน ไม่ได้ fork) |
| 3 | Extension (Chromium MV3) | **BUILD_PRODUCED** | `extension/dist` + zip; artifact suite 10/10; ยังไม่มีคนโหลดเข้า Chrome จริง |
| 4 | Extension (Firefox) | **BUILD_PRODUCED** | `extension/dist-firefox` + zip; manifest มี `browser_specific_settings.gecko.id = wallet@satoshicore.org`; ยังไม่ทดสอบใน Firefox |
| 5 | PWA (manifest + SW + offline) | **VERIFIED (build)** | `public/manifest.webmanifest`, `public/sw.js`, `public/offline.html`, ไอคอน 192/512/180; static-export suite 8/8 |
| 6 | Homepage wallet-first | **IMPLEMENTED** | `/` = Open NSAT Wallet + Install Browser Extension + Network/Explorer/Docs |
| 7 | `/download` | **IMPLEMENTED** | แสดงขนาด/sha256/permissions/endpoints จริง และสถานะต่อเบราว์เซอร์ (ยังไม่ขึ้น store ใด ๆ) |
| 8 | Gateway production | **VERIFIED** | `https://gateway.satoshicore.org/health` 200, `/api/v1/chain/info` 200 (ledger สด) |
| 9 | Indexer production | **VERIFIED** | `https://satoshicore.org/v1/health` 200, `/v1/accounts/<G>/transactions` 200 |
| 10 | `https://www.satoshicore.org/` | **BROKEN** | DNS ไม่ resolve (curl 000) — ยังไม่มี www |
| 11 | `https://satoshicore.org/` | **VERIFIED (deployed, build เก่า)** | 200 แต่ไม่มี `manifest.webmanifest` (404) และ homepage ยังเป็นหน้าโปรโมตเดิม |
| 17 | Hosting จริงของ satoshicore.org | **VERIFIED: Caddy ที่ 87.124.102.86** | `server: Caddy`, Let's Encrypt, HTTP/3, HSTS — **ไม่ใช่ GitHub Pages** (ดู `docs/DOMAINS.md`) |
| 18 | Publish pipeline ตาม host จริง | **IMPLEMENTED (ยังไม่รัน)** | `publish-static.yml`: build → test → tar.gz + sha256 → artifact; upload เข้า `releases/<sha>/` เฉพาะเมื่อมี secrets + `publish=true`; ยังไม่ activate |
| 19 | Release artifact ตรงกับ release.json | **VERIFIED** | `scripts/extension-release.mjs`: ตรวจ zip ↔ release.json ↔ manifest ใน zip; จับ sha ปลอมได้ (exit 1) |
| 20 | Offline shell (precache list) | **VERIFIED (static)** | เทสต์ใหม่: ทุก entry ของ `SHELL` ต้องมีไฟล์จริงใน `out/` และต้อง relative |
| 12 | `https://wallet.satoshicore.org/` | **BROKEN / NOT RESOLVING** | 000 — ต้องตัดสินใจว่าจะคงโดเมนนี้หรือย้ายไป `/wallet` |
| 13 | Website connection (dApp provider) | **MISSING (โดยเจตนา)** | ยังไม่มี `window.nsat` provider / connected sites — อยู่นอก Release 1; ต้องมี security review แยก |
| 14 | Legal / compliance review | **BLOCKED** | ต้องให้เจ้าของ/ที่ปรึกษากฎหมายตรวจ (Thai digital asset / PDPA) ก่อนขึ้น public messaging |
| 15 | Deployment รอบใหม่ | **BLOCKED** | CI เตรียมเสร็จแล้ว (`main` / `workflow_dispatch`) แต่ยังไม่รันจริง — ต้องอนุมัติเจ้าของ |
| 16 | Post-deploy verification | **VERIFIED** | `scripts/verify-deployed-site.mjs`: ผ่าน 8/8 กับ build ท้องถิ่น, ตรวจเจอ build เก่าบน production (6 FAIL, exit 1) |

---

## 2. งานที่เสร็จในรอบนี้

### Workstream C — PWA (§5)
- `public/manifest.webmanifest`: `display: standalone`, `start_url: ./wallet/`, `scope: ./` (relative → ใช้ได้ทั้งโดเมนจริงและ GitHub Pages subpath), ไอคอน 192/512 (any + maskable)
- `public/sw.js`: offline shell เท่านั้น — **ไม่แตะ cross-origin** (gateway/indexer) และ **ไม่แตะ non-GET** เพื่อไม่ให้ยอดเงิน/ผล ledger ถูกเสิร์ฟจาก cache
- `public/offline.html`: บอกตรง ๆ ว่าต้องมีเน็ตเวิร์กสำหรับยอดเงิน/ค่าธรรมเนียม/การยืนยัน
- `components/SwRegister.js`: ลงทะเบียน SW เฉพาะ production + secure context, base-path-safe
- `app/layout.js`: ผูก manifest, apple-touch-icon, theme/viewport ของ PWA

### Workstream F — Website (§7)
- `components/HomeWallet.js` + `app/page.js`: homepage = ทางเข้ากระเป๋า (2 primary actions)
- `app/download/page.js` + `extension/release.json`: หน้าดาวน์โหลดที่รายงานข้อเท็จจริงของ artifact (เวอร์ชัน/ไบต์/sha256/permissions) และสถานะต่อเบราว์เซอร์
- `components/Header.js`: เพิ่มเมนู Download

### Workstream D — Cross-browser (§6)
- `scripts/build-extension.mjs`: shared bundle + adapter ต่อเบราว์เซอร์; `NSAT_EXT_TARGET=firefox` → `dist-firefox` พร้อม gecko id
- default endpoint เป็นโดเมนเท่านั้น + guard ปฏิเสธ IP/loopback
- `tests/extension.test.mjs`: 10/10 (รวมเทสต์ Firefox manifest + domain-only)

### หลักฐานการทดสอบ
```
next build (production endpoints)      ✓ Compiled successfully
tests/static-export.test.mjs           tests 8 / pass 8 / fail 0
npm run test:extension (2 targets)     tests 10 / pass 10 / fail 0
เบราว์เซอร์จริง (127.0.0.1:3000)        homepage wallet-first, SW registered, /download แสดงข้อมูลจริง
```

---

## 3. สิ่งที่ยังไม่ทำ / ความเสี่ยง

| หัวข้อ | สถานะ | ต้องทำต่อ |
|---|---|---|
| โหลด extension เข้า Chrome/Firefox จริง | NOT INSPECTED | โหลด unpacked จาก `extension/dist(-firefox)` แล้วทดสอบ create/import/send บน mainnet แบบไม่ใช้เงินจริง |
| Firefox/Edge/Brave runtime | NOT TESTED | ทดสอบจริงก่อนประกาศว่ารองรับ |
| Opera / Vivaldi | NOT TESTED | ใช้ Chromium build แต่ยังไม่ยืนยัน |
| Safari (macOS) | NOT SUPPORTED | ต้องมี Xcode project + การกระจายแยก |
| Offline shell end-to-end | NOT TESTED | ตัดเน็ตแล้วเปิด `/wallet/` เพื่อยืนยัน behavior |
| www / DNS / TLS | BLOCKED | ตั้ง CNAME `www` + redirect ไป apex หรือตัดสินใจไม่ใช้ www |
| Deploy build ใหม่ | BLOCKED | ต้องอนุมัติ (Pages/CI) — ยังไม่มีการ deploy |
| `extension/release.json` | AUTOMATED | `npm run release:extension` เขียน bytes/sha256 จาก zip จริง; `npm run test:extension` ตรวจซ้ำให้ |
| Legal disclosures | BLOCKED | ร่างข้อความ + ให้เจ้าของ/ที่ปรึกษาตรวจ |

---

## 4. Next action

1. เจ้าของอนุมัติ deploy → merge เข้า `main` (หรือ Actions → Run workflow ด้วย `custom_domain=true`, `custom_domain_name=satoshicore.org`) แล้ว job `verify` จะยืนยันด้วยหลักฐานจาก URL จริง
2. โหลด `extension/dist` (Chromium) และ `dist-firefox` เข้าเบราว์เซอร์จริง ทดสอบ create → receive → send ด้วยกระเป๋า synthetic ที่ไม่มียอด
3. ตัดสินใจเรื่อง `www` + `wallet.satoshicore.org` (redirect หรือคงไว้)
4. เริ่ม security review ของ website-connection (dApp provider) ก่อนเปิดเป็นฟีเจอร์
