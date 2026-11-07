# NSAT Mainnet — Read-only End-to-End Verification (Level A)

| รายการ | ค่า |
|---|---|
| วันที่ | 2026-11-07 |
| ระดับ | **LEVEL A — READ-ONLY** (ไม่เซ็น ไม่ส่ง ไม่มี key จริง) |
| ระดับ B | **MAINNET LIVE TRANSFER TEST — NOT EXECUTED** |
| ผลรวม | ห่วงโซ่หลักฐาน Gateway → Indexer → Confirmation API → Ledger ตรงกันทุกจุด |

---

## 1. ห่วงโซ่หลักฐาน (Chain of Evidence)

ธุรกรรมอ้างอิง (มีอยู่จริงบน Mainnet ก่อน Phase 7):

```text
tx hash    ca077fce84c91ed03257b2d53a6c02c5ad269370947ff0e6d693a195101cda18
source     GDAILW75CM6I6OJHOM242PSB2NOHNBONZKOQCBTVSMHJTMYHU77LQB55
destination GAHS2RVHB7PFWMHTRSYUI2AT5TGLPUOLQQUAYJUWUN5JH6DZE2WWHK3W
amount     88,888 NSAT (ledger units, exact integer)
fee        10 NSAT
ledger     201,491
ledger hash 763c611578ca9707e98a88d320cab823ec676cf8679688d8ef34dffec51d6048
result     txSUCCESS
evidence   archival_checkpoint
```

### 1.1 API Gateway

```text
GET http://127.0.0.1:8787/v1/health              → 200 {ok:true, indexed_head:209335, open_conflicts:0}
GET http://127.0.0.1:8787/api/v1/network/status  → 200 {gateway:ok, core:ok, ledger:209336,
                                                        network:"NSAT Mainnet ; October 2026 ; bc3098829fffc717"}
GET http://127.0.0.1:8787/v1/tx/{hash}           → 200 (รายละเอียดธุรกรรมจาก indexer)
GET http://127.0.0.1:8787/v1/confirmations/{hash}→ 200 (คำตัดสินจาก ledger)
```

### 1.2 Exact-hash confirmation (หัวใจของงาน)

```json
{
  "hash": "ca077fce84c91ed03257b2d53a6c02c5ad269370947ff0e6d693a195101cda18",
  "status": "confirmed",
  "success": true,
  "result_code": "txSUCCESS",
  "ledger": 201491,
  "ledger_hash": "763c611578ca9707e98a88d320cab823ec676cf8679688d8ef34dffec51d6048",
  "close_time": 1794012905,
  "fee_charged": 10,
  "source": "GDAILW75CM6I6OJHOM242PSB2NOHNBONZKOQCBTVSMHJTMYHU77LQB55",
  "evidence": "archival_checkpoint",
  "ops": [{ "kind": "payment", "destination": "GAHS2RVH…HK3W",
            "amount_stroops": "88888", "asset": "native" }],
  "indexed_head": 209318
}
```

### 1.3 Ledger result ที่อ้างอิง

- ledger 201,491 ปิดแล้วและมี ledger hash ของตัวเอง (`763c61…`) — คำตอบ `confirmed` มาจาก **ผลของ ledger นั้น** ไม่ใช่จาก HTTP 200
- `fee_charged = 10` ตรงกับ fee invariant ที่ wallet ปักหมุด
- จำนวนเงิน `88888` เป็น integer ของ ledger unit (1 unit = 1 NSAT, ไม่มีทศนิยม)

## 2. ยืนยันข้ามช่องทาง (Independent cross-checks)

| ช่องทาง | ผลลัพธ์ |
|---|---|
| HTTP API (`/v1/confirmations`) | `confirmed / txSUCCESS / ledger 201491` |
| Web Wallet (เบราว์เซอร์จริง) | Activity 25 แถว, แถวแรก ledger 201491 88,888 NSAT, กด "Check ledger" → `Ledger 201491: txSUCCESS.` |
| Desktop CLI (`confirm --hash`) | `status confirmed / ledger 201491 / result txSUCCESS / fee 10` |
| Indexer account history | `/v1/accounts/{G}/transactions` คืน 25 รายการของ `GDAILW…` และมี hash นี้อยู่จริง |

ทั้งสามช่องทางอ่านจากแหล่งเดียวกัน (indexer ที่ index จาก finalized ledger) และให้คำตอบตรงกัน

## 3. ทดสอบเชิงลบ — ต้องไม่ยืนยันผิด

| กรณี | ผล |
|---|---|
| hash ที่ไม่เคยมีอยู่ `1111…1111` | `status: pending`, `reason: not_yet_observed`, `timeout: true` — **ไม่กลายเป็น confirmed** |
| hash ที่ยังไม่ finalized | API คืน `pending` พร้อม `pending_ledger`, ไม่เดา |
| balance เปลี่ยน / sequence เปลี่ยน | ไม่ถูกใช้เป็นหลักฐานยืนยันเลย (ทั้ง engine และ UI) |
| HTTP 200 แต่ body ไม่ใช่ verdict | wallet ถือว่า "ยังไม่ยืนยัน" |

## 4. Network identity

- ค่าที่ทุกノดและ gateway รายงาน: `NSAT Mainnet ; October 2026 ; bc3098829fffc717`
- Web Wallet: ต้องเท่ากับ `FULL_MAINNET_IDENTITY` แบบ byte-for-byte ก่อนอนุญาตให้เซ็น (ทดสอบโดยเปิดหน้าเว็บที่ต่อ upstream ตาย → Review ถูกปิดด้วยเหตุผล identity)
- Desktop CLI: ต้องมี `--passphrase-file` ที่ตรงกับที่ノดรายงาน; ไฟล์ devnet ถูกปฏิเสธ (`network identity mismatch … refusing (fail-closed)`)
- netid ที่ใช้ใน envelope digest = `sha256(passphrase)` = `0efd442e49bfb656ab396e915cf63a8d300da8237d8513646eb9f264b2881a53`

## 5. Balance query (read-only)

- `/api/v1/account?acc=G…` ผ่าน gateway → proxied ไป core (busy-retry; ไม่คืน 0 เมื่อ core ไม่ว่าง)
- กระเป๋าทดสอบใหม่ `GDO2VFUU…FLOQ` → `not on-chain (unfunded)` ตามจริง
- ไม่มีการใช้ยอดเงินเพื่อยืนยันธุรกรรม

## 6. Level B — MAINNET LIVE TRANSFER TEST: **NOT EXECUTED**

ไม่มีการเซ็นหรือส่งธุรกรรม Mainnet ใน Phase 7 เพราะยังไม่ได้รับการอนุมัติจากเจ้าของเป็นลายลักษณ์อักษร

### สิ่งที่ต้องได้รับอนุมัติก่อนทำ Level B

1. **บัญชีทดสอบต้นทาง** (disposable, owner-controlled) — address ที่จะใช้
2. **บัญชีปลายทาง** — address ผู้รับที่ยอมให้ทดสอบ
3. **จำนวนเงินที่แน่นอน** (ledger units) และเหตุผลว่ายอดนี้ยอมเสียได้
4. **ค่าธรรมเนียมสูงสุด** ที่ยอมจ่าย (fee invariant ปัจจุบัน = 10 NSAT/operation)
5. ช่วงเวลาที่อนุญาต และผู้เฝ้าดู (operator on-call)
6. ยืนยันว่าจะไม่ใช้ key ของกระเป๋าที่มีเงินจริง

### ขั้นตอนที่จะทำเมื่อได้อนุมัติ (ยังไม่ทำ)

```text
1) สร้าง/เตรียมกระเป๋าทดสอบ (key ใหม่, เก็บใน /tmp หรือเครื่องแยก)
2) ตรวจ network identity + ledger head + fee ก่อนเซ็น (fail-closed)
3) เซ็นด้วย CLI: send --gateway … --nsat <อนุมัติ> --dry-run   (ตรวจ seq/fee/ยอด)
4) ส่งจริงด้วย NSAT_WALLET_ALLOW_MAINNET=1 เฉพาะ invocation นั้น
5) บันทึก submitted_at + tx hash ทันที
6) รอ exact-hash confirmation (ไม่ใช้ sequence/balance)
7) บันทึก ledger ที่ยืนยัน, fee_charged, และ latency จริงเป็นวินาที
8) ตรวจว่าผู้รับเห็นเงินเข้าใน Activity (indexer) และยอดตรง
9) เก็บหลักฐานทั้งหมดลง NSAT-TRANSACTION-STATE-VALIDATION.md
```

**ข้อห้ามที่ยังคงอยู่:** ไม่ดึง private key จริง, ไม่ส่งเกินวงเงินที่อนุมัติ, ไม่ retry แบบส่งซ้ำเมื่อไม่แน่ใจผล, ไม่ถือว่า pending = สำเร็จ

## 7. ข้อจำกัด

- ไม่มีธุรกรรมใหม่บน Mainnet ตั้งแต่ ledger 201,491 → **วัด latency ของธุรกรรมใหม่ไม่ได้** และไม่มีการแต่งตัวเลขขึ้นมา
- การตรวจทั้งหมดทำจาก loopback; TLS/DNS สาธารณะยังต้องตรวจตอน deploy จริง
- Ledger ที่อ้างอิงเป็นการอ่าน ณ เวลาหนึ่ง ไม่ใช่การติดตามต่อเนื่อง

## 8. Classification

| รายการ | สถานะ |
|---|---|
| Gateway read paths | **TESTED** |
| Indexer + confirmation API | **TESTED** |
| Ledger-result correctness (positive) | **TESTED** |
| No-false-confirmation (negative) | **TESTED** |
| Wallet read-only display | **TESTED** |
| Level B live transfer | **BLOCKED — NOT EXECUTED (รออนุมัติ)** |
