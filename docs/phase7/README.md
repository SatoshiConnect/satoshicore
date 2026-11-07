# NSAT Phase 7 — รายงานการเชื่อม Wallet กับ Mainnet (ภาษาไทย)

ชุดเอกสารนี้บันทึกผลการทำงาน Phase 7: เชื่อม Web Wallet (PR #7) และ Desktop Wallet (PR #1)
เข้ากับ Mainnet Live Indexer และ Exact-Hash Confirmation API ที่ทำงานอยู่จริง
โดยไม่แตะ validator, consensus, กุญแจ, เงิน หรือ production ledger ใด ๆ

## ลำดับการอ่าน

| # | เอกสาร | ตอบคำถาม |
|---|---|---|
| 1 | [NSAT-PHASE7-PRODUCTION-STATUS.md](./NSAT-PHASE7-PRODUCTION-STATUS.md) | ตอนนี้มีอะไรทำงานบน Mainnet |
| 2 | [NSAT-WEB-WALLET-ACCEPTANCE.md](./NSAT-WEB-WALLET-ACCEPTANCE.md) | Web Wallet พร้อมแค่ไหน ทดสอบอะไรไปแล้ว |
| 3 | [NSAT-DESKTOP-WALLET-ACCEPTANCE.md](./NSAT-DESKTOP-WALLET-ACCEPTANCE.md) | Desktop Wallet พร้อมแค่ไหน ติดอะไร |
| 4 | [NSAT-MAINNET-READONLY-E2E.md](./NSAT-MAINNET-READONLY-E2E.md) | หลักฐาน read-only กับ Mainnet และแผน Level B |
| 5 | [NSAT-TRANSACTION-STATE-VALIDATION.md](./NSAT-TRANSACTION-STATE-VALIDATION.md) | สถานะธุรกรรมถูกต้องและไม่ยืนยันผิดหรือไม่ |
| 6 | [NSAT-WALLET-SECURITY-REPORT.md](./NSAT-WALLET-SECURITY-REPORT.md) | ความปลอดภัยของ key, network gate, ความเสี่ยงที่เหลือ |
| 7 | [NSAT-WALLET-RELEASE-MANIFEST.md](./NSAT-WALLET-RELEASE-MANIFEST.md) | อะไรพร้อม/ไม่พร้อมปล่อย พร้อม commit |
| 8 | [NSAT-WALLET-ROLLBACK-PLAN.md](./NSAT-WALLET-ROLLBACK-PLAN.md) | ย้อนกลับอย่างไร และ drill ที่รันจริง |

## สรุปสั้น

- **Mainnet backend:** validator A/B/C + observer `Synced!` ที่ ledger เดียวกัน, indexer ตามหลัง 1 ledger, conflict 0, gateway ตอบครบ
- **Exact-hash confirmation:** ถูกต้อง — `ca077fce…` → `confirmed / txSUCCESS / ledger 201491`; hash ปลอม → `pending` (ไม่ยืนยันผิด)
- **Web Wallet:** READY FOR REVIEW (ยังขาด QR, live tx proof, SSE reconnect test)
- **Desktop Wallet:** engine/CLI READY FOR REVIEW; packaged app **BLOCKED** (unsigned Milestone A)
- **Live transfer (Level B):** NOT EXECUTED — รออนุมัติจากเจ้าของ

## หลักการที่ยึดตลอดPhase 7

1. ไม่ restart/แก้ validator, consensus, genesis, fee, supply
2. ไม่ส่งธุรกรรม Mainnet โดยไม่ได้รับอนุมัติเป็นลายลักษณ์อักษร
3. CONFIRMED มาจากผลของ finalized ledger ที่ตรงกับ hash เท่านั้น
4. รายงานสิ่งที่ยังไม่ได้ทดสอบตามจริง ไม่แต่งตัวเลข latency
