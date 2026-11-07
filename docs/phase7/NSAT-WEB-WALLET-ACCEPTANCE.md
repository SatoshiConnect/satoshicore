# NSAT Web Wallet — Acceptance Report (Phase 7)

| รายการ | ค่า |
|---|---|
| Repo / PR | `SatoshiConnect/satoshicore` PR #7 |
| Branch / head | `integrate/wallet-exact-hash` @ `848fc54` |
| วิธีทดสอบ | static export (`out/`) เสิร์ฟบน loopback 18800 + proxy `/api/*`, `/v1/*` ไป gateway จริง 8787 |
| วันที่ | 2026-11-07 |
| ผลรวม | **READY FOR REVIEW** (ยังไม่ READY FOR RELEASE — ดูข้อ 7) |

> ทดสอบบนเบราว์เซอร์จริง (Chromium) กับ Mainnet จริง — ไม่ใช่แค่ unit test
> กระเป๋าที่ใช้ทดสอบเป็นกระเป๋าใหม่ที่สร้างในเบราว์เซอร์ (`phase7-acceptance`) ไม่มีเงินจริง
> ไม่มีการเซ็นหรือส่งธุรกรรม Mainnet

---

## 1. ผลการทดสอบตามรายการที่ mission กำหนด

| # | รายการ | ผล | หลักฐาน / หมายเหตุ |
|---|---|---|---|
| 1 | Create wallet | **PASS** | สร้าง `phase7-acceptance` → `GCC6R7WHT4VLS5KQS535ZS6EG55TNENSKSJZGYROZABOZZ6PUEFZPZ5F`, keystore เข้ารหัสใน localStorage, seed ไม่ถูกแสดง |
| 2 | Import / restore | **PASS** | export keystore (เข้ารหัส) แล้ว restore ใน origin ใหม่ (18801) → ปลดล็อกได้ address เดิม `GCC6R7WH…PZ5F` |
| 3 | Display address | **PASS** | Receive page แสดง address เต็ม + ปุ่ม Copy |
| 4 | Display balance | **PASS** | แสดง 0 NSAT และ "No / not funded"; สถานะ "Funded on network: unknown" เมื่อ offline (ไม่เดา) |
| 5 | Send NSAT | **PASS (validation/gating)** | address ผิด → `Address format is invalid.`; เงินไม่พอ → `0 NSAT available; amount + fee = 15 exceeds it.`; การส่งจริงไม่ได้ทำ (Level B) |
| 6 | Receive NSAT | **PASS (address)** | address + Copy ทำงาน; **QR code: ไม่มีในหน้านี้ (NOT SUPPORTED)** |
| 7 | Transaction history | **PASS (เพิ่มใหม่ในรอบนี้)** | Activity แสดง 25 รายการจริงของ `GDAILW…QB55` จาก indexer (ledger, จำนวน, fee, ผล, hash) |
| 8 | Confirmation status | **PASS** | ปุ่ม "Check ledger" ต่อแถว → toast `Ledger 201491: txSUCCESS.` |
| 9 | Fee before signing | **PASS** | แสดง fee 10 NSAT/operation จาก network ที่ยืนยัน identity แล้ว; offline แสดง `…` ไม่เดาเลข |
| 10 | Copy address | **PASS** | ปุ่ม Copy บน Receive |
| 11 | QR (scan/display) | **NOT SUPPORTED** | ไม่มี library/หน้าจอ QR — ต้องเพิ่มก่อน release ถ้าต้องการ |
| 12 | Network unavailable state | **PASS** | เปิดด้วย proxy ที่ชี้ upstream ตาย: `● Offline / identity mismatch`, fee `…`, Review disabled พร้อมเหตุผล `Network identity not verified…` |
| 13 | Insufficient balance | **PASS** | บล็อกก่อน Review (รวมกรณี CREATE ที่เคยหลุด — ดูข้อ 3) |
| 14 | Pending transaction state | **NOT TESTED (live)** | ไม่มีธุรกรรมจริงให้ดูสถานะ pending; UI/สเตตเครื่องพร้อมแต่ยังไม่มีหลักฐานจาก chain จริง |
| 15 | Failed transaction state | **NOT TESTED (live)** | เช่นเดียวกัน — โค้ดแสดงผลลัพธ์จาก ledger ได้ แต่ยังไม่เห็นเคสจริง |
| 16 | Retry read-only confirmation | **PASS** | กด "Check ledger" ซ้ำได้ ไม่ผูกกับ sequence/balance |
| 17 | Gateway unavailable | **PASS** | ดูข้อ 12 (เป็นกรณีเดียวกันในทางปฏิบัติ: upstream ตาย) |
| 18 | Indexer unavailable (แยกเฉพาะ) | **NOT TESTED** | ไม่ได้ปิด indexer production (ห้ามแตะ) และยังไม่มี proxy ที่จำลอง `/v1/*` ล่มแยกจาก gateway |
| 19 | SSE reconnect / Last-Event-ID | **NOT TESTED** | โค้ดมี SSE + polling fallback แต่ยังไม่ได้ทดสอบตัดconnection/ replay |
| 20 | Concurrent tabs | **NOT TESTED** | ยังไม่ได้เปิดสองแท็บยิงธุรกรรมพร้อมกัน |
| 21 | Mobile layout (390×844) | **PASS หลังแก้** | ก่อนแก้ `scrollWidth = 638` (ล้นจอ) → หลังแก้ `390` เท่ากับ viewport |
| 22 | Desktop layout (1440×900) | **PASS** | ไม่มี horizontal overflow, ตาราง 25 แถวแสดงครบ |
| 23 | Browser security checks | **PASS (partial)** | ไม่มี private key ออกจากเบราว์เซอร์, ไม่มี secret ใน build output (มี test เฉพาะ), keystore เข้ารหัส; CSP/header ระดับ production ต้องตรวจตอน deploy |

## 2. Unit / build tests

```text
npm run build                      → OK (static export, 31 ไฟล์ใน out/)
node --test tests/                 → tests 24, pass 19, fail 0, skipped 5
                                     (5 ตัวที่ skip คือ static-export checks ที่ต้องมี out/ ก่อน แล้วผ่าน)
services/api-gateway: npm test     → 37 pass / 0 fail
```

## 3. ข้อบกพร่องที่พบและแก้ในรอบนี้ (พร้อม commit)

1. **CREATE หลุด balance gate** — `lib/nsatSendPreflight.js` คืนค่าก่อนถึงบล็อกเงินไม่พอ ทำให้กระเป๋าว่างกด Review ได้
   → แก้ให้ CREATE ยังคง `warn` แต่ไหลต่อไปยังการตรวจยอด; test อัปเดตเป็น 7/7
2. **ไม่มีประวัติ on-chain** — Activity เดิมแสดงเฉพาะรายการที่แอปนี้เซ็นเอง ผู้รับจึงไม่เห็นเงินเข้า
   → เพิ่ม "On-chain history" จาก `/v1/accounts/{G}/transactions`, lookup address แบบ read-only (ตรวจรูปแบบ G-address ก่อนยิง), ปุ่ม Check ledger ต่อแถว, refresh ตาม SSE
3. **หน้าจอล้นบนมือถือ** — hash 64 ตัวดัน layout เป็น 638 px บนจอ 390 px
   → `.nw-tx-row > div { min-width:0 }` + ตัดคำ hash + wrap แถวเมื่อ < 560 px (วัดซ้ำได้ 390)

## 4. หลักฐานว่า exact-hash confirmation ทำงานถูก

- แถวแรกของ `GDAILW…QB55`: ledger 201491, 88,888 NSAT, `txSUCCESS`, fee 10, hash `ca077fce84c91ed03257b2d53a6c02c5ad269370947ff0e6d693a195101cda18`
- กด "Check ledger" → `Ledger 201491: txSUCCESS.`
- ค่าที่ได้ตรงกับ `/v1/confirmations/{hash}` และกับ CLI ของ Desktop Wallet (ดู `NSAT-MAINNET-READONLY-E2E.md`)

## 5. สิ่งที่ยืนยันแล้วว่า "ไม่หลอกตัวเอง"

- ไม่มีการใช้ HTTP 200 เป็นการยืนยัน
- ไม่มีการใช้การเปลี่ยน sequence หรือยอดเงินเป็นการยืนยัน
- offline/identity mismatch → ปุ่มส่งถูกปิด ไม่ใช่ส่งไปแล้ว error ทีหลัง
- fee ที่ยังอ่านไม่ได้แสดงเป็น `…` ไม่ใช่ 0

## 6. ข้อจำกัดที่ต้องรายงานตามจริง

- ยังไม่มีการทดสอบธุรกรรมจริง (สร้าง → เซ็น → ส่ง → confirmed) บน Mainnet เพราะต้องรอการอนุมัติ Level B
- จึงยัง **ไม่มีตัวเลข latency จริง** ของการยืนยัน และยังไม่เห็นสถานะ pending/failed จาก chain จริง
- SSE reconnect, indexer-down แยกส่วน, concurrent tabs ยังไม่ได้ทดสอบ
- QR code ยังไม่มี

## 7. Classification

| ส่วน | สถานะ |
|---|---|
| Web wallet core flow (create/import/restore/lock/address/balance/send gating/receive) | **TESTED** |
| On-chain history + exact-hash confirmation UI | **TESTED** |
| Responsive layout | **TESTED** (390 / 1440) |
| SSE reconnect, pending/failed live states, QR | **IMPLEMENTED บางส่วน / ยังไม่ครบ** |
| รวมทั้ง PR #7 | **READY FOR REVIEW** |
| ปล่อยเป็น production web wallet | **ยังไม่ควร** — เหลือ QR (ถ้าต้องการ), live transaction proof, และ deploy approval |
