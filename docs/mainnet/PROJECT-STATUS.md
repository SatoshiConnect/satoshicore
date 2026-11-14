# NSAT Universal Wallet — Project Status

อัปเดต: 2026-11-13 · Repo: `SatoshiConnect/satoshicore` (โฟลเดอร์ `satoshicore-web`) · Branch: `feat/sponsored-accounts-wallet`
Commit ล่าสุดของรอบนี้: `7e34e42` (deployed) · ก่อนหน้า: `14691d6`, `c3769b9`, `d336bde`, `e495252`

สถานะที่ใช้: **IMPLEMENTED → VERIFIED → REVIEWED → MERGED → RELEASE-READY → DEPLOYED**
สถานะการตรวจ: IMPLEMENTED / VERIFIED / BROKEN / MISSING / BLOCKED / NOT INSPECTED

---

## 0. Deployment log — ขึ้น production แล้ว

| รายการ | ค่า |
|---|---|
| เวลาที่ deploy | 2026-11-13 (local 2026-11-14 02:52) |
| Commit ที่ build | `29b1f60` + การแก้ manifest/DOMAINS ในรอบนี้ (commit ถัดไป) |
| โหมด build | `NEXT_PUBLIC_API_SAME_ORIGIN=1` (same-origin `/api/v1/*`, `/v1/*`) |
| Caddy root | `NSAT_WEB_ROOT` จาก `/Library/LaunchDaemons/com.satoshicore.caddy-standard-ports.plist` → `/Users/migssa-ngakhaonu/nsat-ops/satoshicore-webroot` |
| Backup ก่อน deploy | `satoshicore-webroot.bak-20261114-025324` และ `.bak` รอบที่สอง (rollback = copy กลับ) |
| หลักฐาน | `verify-deployed-site` 8 passed / 0 failed; `index.html` sha256 ตรงระหว่าง `out/` กับ root ที่เสิร์ฟ; security scan 45 ไฟล์สะอาด; mainnet identity 4 chunks |
| ไม่ได้แตะ | DNS, Caddy config, mainnet/genesis/mint, ไม่มีธุรกรรมใด ๆ |

## 1. ผลตรวจสภาพปัจจุบัน (§3)

| # | หัวข้อ | สถานะ | หลักฐาน / หมายเหตุ |
|---|---|---|---|
| 1 | Web Wallet (`/wallet`) | **VERIFIED** | เปิดในเบราว์เซอร์จริงกับ mainnet: `Mainnet verified`, ledger สด, สร้างกระเป๋าใหม่ได้, ยอด `0 NSAT` exact 128-bit, base fee 10 |
| 2 | Shared wallet logic | **VERIFIED** | `lib/nsatClient.js`, `lib/nsatWallet.js`, `lib/nsatCodec.js`, `lib/nsatSendPreflight.js` ถูกใช้ร่วมกันทั้งเว็บและ extension (ไฟล์เดียวกัน ไม่ได้ fork) |
| 3 | Extension (Chromium MV3) | **BUILD_PRODUCED** | `extension/dist` + zip; artifact suite 10/10; ยังไม่มีคนโหลดเข้า Chrome จริง |
| 4 | Extension (Firefox) | **BUILD_PRODUCED** | `extension/dist-firefox` + zip; manifest มี `browser_specific_settings.gecko.id = wallet@satoshicore.org`; ยังไม่ทดสอบใน Firefox |
| 5 | PWA (manifest + SW + offline) | **VERIFIED (live)** | `public/manifest.json` (`.json` เพราะ host ไม่มี MIME ของ `.webmanifest`), `public/sw.js` v2, `public/offline.html`, ไอคอน 192/512/180; static-export 9/9; ตรวจบน `https://satoshicore.org` จริง: manifest `application/json`, SW `activated`, cache มีเฉพาะ `nsat-pwa-v2` |
| 6 | Homepage wallet-first | **IMPLEMENTED** | `/` = Open NSAT Wallet + Install Browser Extension + Network/Explorer/Docs |
| 7 | `/download` | **IMPLEMENTED** | แสดงขนาด/sha256/permissions/endpoints จริง และสถานะต่อเบราว์เซอร์ (ยังไม่ขึ้น store ใด ๆ) |
| 8 | Gateway production | **VERIFIED** | `https://gateway.satoshicore.org/health` 200, `/api/v1/chain/info` 200 (ledger สด) |
| 9 | Indexer production | **VERIFIED** | `https://satoshicore.org/v1/health` 200, `/v1/accounts/<G>/transactions` 200 |
| 10 | `https://www.satoshicore.org/` | **BROKEN** | DNS ไม่ resolve (curl 000) — ยังไม่มี www |
| 11 | `https://satoshicore.org/` | **DEPLOYED (2026-11-13)** | build ปัจจุบันขึ้นจริง: homepage wallet-first, `/download/` 200, manifest/SW/offline 200, `verify-deployed-site` 8/8; same-origin `/api/v1/chain/info` + `/v1/health` 200; wallet แสดง `Mainnet verified · ledger 328,791` |
| 17 | Hosting จริงของ satoshicore.org | **VERIFIED: Caddy ที่ 87.124.102.86** | `server: Caddy`, Let's Encrypt, HTTP/3, HSTS — **ไม่ใช่ GitHub Pages** (ดู `docs/DOMAINS.md`) |
| 18 | Publish pipeline ตาม host จริง | **IMPLEMENTED (ยังไม่รัน)** | `publish-static.yml`: build → test → tar.gz + sha256 → artifact; upload เข้า `releases/<sha>/` เฉพาะเมื่อมี secrets + `publish=true`; ยังไม่ activate |
| 19 | Release artifact ตรงกับ release.json | **VERIFIED** | `scripts/extension-release.mjs`: ตรวจ zip ↔ release.json ↔ manifest ใน zip; จับ sha ปลอมได้ (exit 1) |
| 20 | Offline shell (precache list) | **VERIFIED (static)** | เทสต์ใหม่: ทุก entry ของ `SHELL` ต้องมีไฟล์จริงใน `out/` และต้อง relative |
| 12 | `https://wallet.satoshicore.org/` | **BROKEN / NOT RESOLVING** | 000 — ต้องตัดสินใจว่าจะคงโดเมนนี้หรือย้ายไป `/wallet` |
| 13 | Website connection (dApp provider) | **DESIGN ONLY → BLOCKED BEFORE IMPLEMENTATION** | Threat model + permission model อยู่ที่ `docs/security/WEBSITE-CONNECTION-DESIGN.md`; ยังไม่มี provider code/permissions ใหม่. Firefox webpage `externally_connectable` messaging ไม่รองรับ; design candidate ต้องตรวจ runtime และ Firefox floor ≥128 ก่อนทำ |
| 14 | Legal disclosures | **IMPLEMENTED (draft) → BLOCKED (review)** | `/terms/` `/privacy/` `/security/` ขึ้นจริงและติดป้าย `draft · pending legal review`; ยังต้องให้เจ้าของ/ที่ปรึกษากฎหมายไทยตรวจก่อนถือเป็นฉบับจริง |
| 15 | Deployment รอบใหม่ | **BLOCKED** | CI เตรียมเสร็จแล้ว (`main` / `workflow_dispatch`) แต่ยังไม่รันจริง — ต้องอนุมัติเจ้าของ |
| 16 | Post-deploy verification | **VERIFIED** | `scripts/verify-deployed-site.mjs`: ผ่าน 8/8 กับ build ท้องถิ่น, ตรวจเจอ build เก่าบน production (6 FAIL, exit 1) |

---

## 2. งานที่เสร็จในรอบนี้

### Workstream C — PWA (§5)
- `public/manifest.json`: `display: standalone`, `start_url: ./wallet/`, `scope: ./` (relative → ใช้ได้ทั้งโดเมนจริงและ subpath), ไอคอน 192/512 (any + maskable) — ใช้ `.json` เพราะ Caddy ไม่มี MIME mapping ของ `.webmanifest` และเสิร์ฟเป็น `text/plain`
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
| Deploy build ใหม่ | **DONE (2026-11-13)** | deploy ผ่าน Caddy root จริง 2 รอบ (manifest fix + security/legal/SW v3) พร้อม backup ทุกรอบ |
| `extension/release.json` | AUTOMATED | `npm run release:extension` เขียน bytes/sha256 จาก zip จริง; `npm run test:extension` ตรวจซ้ำให้ |
| Legal disclosures | DRAFT SHIPPED | เนื้อหาตรงกับพฤติกรรมจริงของโค้ด; ต้องให้เจ้าของ/ที่ปรึกษาตรวจก่อนเปลี่ยนป้ายเป็นฉบับจริง |
| Service worker cache ของ chain state | **FIXED + VERIFIED** | พบว่า same-origin `/api/v1/chain/info` ถูกเก็บใน Cache API (1 entry); แก้เป็น bypass `/api`, `/v1`, `/health`, `/info`, `/account`, `/tx`, `/peers`, `/quorum`, `/metrics` แล้ว bump `nsat-pwa-v3`; ตรวจบน production: 0 API entries แม้หลังยิง fetch |

---

## 4. รอบ directive ปัจจุบัน (2026-11-13) — workstreams

| Workstream | สถานะ | หลักฐาน |
|---|---|---|
| A — Audit | **VERIFIED** | ตรวจ repo ทั้ง 4 (HEAD ต่อ repo), branch จริง, hosting (Caddy ไม่ใช่ Pages), routes ที่มี/ไม่มี |
| B — Shared Wallet Core | **VERIFIED (ไม่ต้องแก้)** | `lib/nsatWallet.js` + `lib/nsatClient.js` + `lib/nsatCodec.js` ใช้ร่วมเว็บ/extension; keystore injectable, BigInt ตลอด, identity gate แบบ exact-match, sanity check ว่า pubkey ที่เซ็นตรงกับ address ที่แสดงตอน unlock |
| C — PWA | **DEPLOYED** | manifest.json, SW v3 ที่ไม่ cache chain state, offline.html, idle auto-lock 15 นาที |
| D — Extension | **BUILD_PRODUCED (ยังไม่ทดสอบโดยคน)** | Chromium + Firefox zip, artifact 10/10; website-connection ยังไม่ทำ (ประกาศชัด) |
| E — Security/Compliance | **IMPLEMENTED (draft) + 1 fix** | หน้า `/security/` `/terms/` `/privacy/`; SW cache bug แก้แล้ว; threat-model/audit เดิมใน `docs/security/` |
| F — Website | **DEPLOYED** | wallet-first homepage + secondary Security/Terms/Privacy; footer มีลิงก์ครบ |
| G — Release verification | **PARTIAL** | static 11/11, SW behavioural 3/3, extension 10/10, security scan 54 ไฟล์สะอาด, live verify 8/8 |

### หลักฐานรอบนี้
```
npm run build (NEXT_PUBLIC_API_SAME_ORIGIN=1)   ✓ Compiled successfully
tests/static-export.test.mjs                    11 / 11 pass
tests/service-worker.test.mjs (vm + fake caches) 3 / 3 pass
nextension suite + release artifacts             10 / 10 pass, OK
security-scan                                    54 files, no findings
verify-deployed-site https://satoshicore.org     8 passed / 0 failed
browser: cache keys = [nsat-pwa-v3], API entries = 0 (even after an /api fetch)
```

## 5. Website-connection design milestone (2026-11-14)

- เอกสาร: `docs/security/WEBSITE-CONNECTION-DESIGN.md` — trust boundaries, STRIDE threats 15 รายการ, grant levels, exact-origin rules, storage/revocation, typed request lifecycle, browser compatibility และ release gates
- ผลตรวจ source: extension ปัจจุบันเป็น popup-only; manifest มี `storage`/`downloads` + host permissions ของ backend เท่านั้น; ไม่มี content scripts, background message broker, `externally_connectable`, `window.nsat` หรือ connected-sites UI
- ตัดสินใจ: ไม่คืน private key/signature/envelope ให้หน้าเว็บ; connect แยกจาก `accounts`; ทุก transfer ต้องผ่าน extension-owned approval UI; page/DOM bridge เป็น untrusted; ไม่ใช้ wildcard host permission
- Firefox gate: Mozilla ระบุ webpage messaging ผ่าน `externally_connectable` ไม่รองรับ; MAIN-world injection ตั้งแต่ Firefox 128 — ไม่อ้าง provider support สำหรับ 121–127
- สถานะ: **DESIGN ONLY** — ยังไม่ลงโค้ด, ไม่เพิ่ม permission, ไม่มี Mainnet/API/key change. ก่อน implementation ต้อง review design และเลือก local HTTP / grant duration / Firefox floor / account selection
- Research sources และ URLs บันทึกท้าย design doc; ไม่ใช่ security certification

## 6. Next action

1. โหลด `extension/dist` (Chromium) และ `dist-firefox` เข้าเบราว์เซอร์จริง ทดสอบ create → receive → send ด้วยกระเป๋า synthetic ที่ไม่มียอด (checklist: `docs/EXTENSION-TESTING.md`)
2. เจ้าของ/ที่ปรึกษากฎหมายตรวจ `/terms/` `/privacy/` แล้วให้แก้ข้อความ + เติม governing law/ผู้ควบคุมข้อมูล
3. ตัดสินใจเรื่อง `www` + `wallet.satoshicore.org` (redirect หรือคงไว้) — ยังไม่มี DNS record ทั้งคู่
4. เริ่ม security review ของ website-connection (dApp provider) ก่อนเปิดเป็นฟีเจอร์; ระหว่างนี้หน้า `/security/` ประกาศว่าไม่มี provider
5. ทดสอบ offline shell แบบตัดเน็ตจริง (ระบุไว้ใน risks — ยังไม่ได้ทำ)
