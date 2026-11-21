# NSAT — Transaction State Validation (Phase 7)

| รายการ | ค่า |
|---|---|
| ขอบเขต | สถานะธุรกรรมตั้งแต่สร้างจนถึงผลจาก ledger ใน Web Wallet และ Desktop Wallet |
| วันที่ | 2026-11-07 |
| ผลรวม | สถานะ conform กับข้อกำหนด; การยืนยันผูกกับ exact hash + finalized ledger เท่านั้น |
| ข้อจำกัด | ยังไม่มีธุรกรรมสดให้ทดสอบยืนยันจริง (Level B = NOT EXECUTED) |

---

## 1. สถานะที่กำหนด และสิ่งที่โค้ดทำจริง

| สถานะ | ความหมาย | เงื่อนไขเข้า | หลักฐานในโค้ด/การทดสอบ |
|---|---|---|---|
| `CREATED` | ประกอบธุรกรรมในเครื่องแล้ว | ผู้ใช้กด Review/Confirm และ preflight ผ่าน (address, ยอด, fee, network identity) | `lib/nsatSendPreflight.js` + `WalletPanel`; ทดสอบ: address ผิด/เงินไม่พอ → ไม่ผ่าน |
| `SIGNED` | เซ็นในเครื่องด้วย key ที่ปลดล็อก | ต้องผ่าน network identity gate และมี seed ในหน่วยความจำ | เซ็นเฉพาะ client-side; gateway ไม่เคยเห็น key |
| `SUBMITTED` | ส่ง envelope เข้า node/gateway แล้ว | node ตอบ `PENDING` หรือ `FUTURE` เท่านั้น | Desktop: `SUBMIT_OK = ["PENDING","FUTURE"]`; อย่างอื่น = error |
| `PENDING` | ยังไม่มีผลใน ledger ที่ finalize | confirmation คืน `pending`/`unknown` | ทดสอบ: hash ที่ไม่มีจริง → `pending`, `not_yet_observed` |
| `CONFIRMED` | ledger ที่ finalize แล้วมีผลของ **hash นี้** และสำเร็จ | `status = confirmed` + `result_code = txSUCCESS` | ทดสอบ: `ca077fce…` → confirmed/201491/txSUCCESS |
| `FAILED` | ledger มีผลของ hash นี้แต่ล้มเหลว | `status = failed` (มี result_code เช่น op failure) — ยังจ่าย fee | โค้ดแยก `failed` ออกจาก `pending`; ยังไม่มีเคสจริง |
| `UNKNOWN` | บอกไม่ได้ (index ยังไม่เห็น/ข้อมูลไม่พอ) | `unknown` หรืออ่านคำตอบไม่ได้ 3 ครั้ง | ต้องรายงานตามจริง ห้ามเลื่อนเป็น confirmed |

## 2. กติกา "ห้ามอนุมาน CONFIRMED" — ตรวจแล้วทีละข้อ

| สิ่งที่ห้ามใช้ | สถานะในโค้ด |
|---|---|
| การเปลี่ยน account sequence | ไม่ถูกอ่านในพาธยืนยันเลย (ลบ sequence fallback ออกแล้วใน PR #1) |
| การเปลี่ยนยอดเงิน | ใช้ได้เฉพาะเป็น **การตรวจซ้ำหลัง confirmed** (conservation cross-check) และถ้าไม่ตรงจะ fail ไม่ใช่ upgrade สถานะ |
| Gateway ตอบรับ (200/PENDING) | ถือเป็น `SUBMITTED` เท่านั้น |
| HTTP 200 เฉย ๆ | ไม่ใช่คำตัดสิน; ต้องมี `status` + `result_code` จาก ledger |
| เวลาผ่านไปนาน | ไม่ทำให้ confirmed; ได้ `pending`/`unknown` ตามจริง |
| hash ซ้ำ/คนละ hash | ใช้ hash ที่เซ็นแล้วเท่านั้น; hash ต้องเป็น 64 hex |

## 3. หลักฐานการทดสอบ (จริง)

### 3.1 Positive — hash ที่อยู่ใน finalized ledger

```text
$ nsat-wallet confirm --hash ca077fce84c91ed03257b2d53a6c02c5ad269370947ff0e6d693a195101cda18 \
    --submitted-at 1794044500        # NSAT_INDEXER_URL=http://127.0.0.1:8789
hash     ca077fce84c91ed03257b2d53a6c02c5ad269370947ff0e6d693a195101cda18
status   confirmed
ledger   201491
result   txSUCCESS
fee      10
```

### 3.2 Negative — hash ที่ไม่มีอยู่

```text
$ nsat-wallet confirm --hash 1111111111111111111111111111111111111111111111111111111111111111 --timeout 5
hash     1111…1111
status   pending
verdict  {"status":"pending","success":null,"result_code":null,"ledger":null,
          "reason":"not_yet_observed","evidence":"none","timeout":true}
```

→ ไม่มีการยืนยันผิดแม้จะรอจนหมดเวลา

### 3.3 Negative — ชี้ผิด endpoint

```text
$ nsat-wallet info --url http://127.0.0.1:8787      # core mode ไปที่ gateway
error: http://127.0.0.1:8787 did not report a network identity — not an NSAT node endpoint
exit=2
```

→ ก่อนแก้ ระบบพิมพ์ network ว่าง + ledger 0 + netid ของสตริงว่าง (อันตราย) ตอนนี้ fail-closed

### 3.4 Negative — network ผิด

```text
error: network identity mismatch: node reports "NSAT Mainnet ; October 2026 ; bc3098829fffc717",
       file has "NSAT Devnet ; January 2026 ; deadbeefdeadbeef" — refusing (fail-closed)
```

### 3.5 Negative — เงินไม่พอ / fee

```text
error: insufficient source balance (amount+fee)
note: live base fee unavailable (this endpoint does not expose node ledger facts (core /info));
      wallet pins the verified invariant fee 10
```

→ ไม่เซ็น ไม่ส่ง และไม่รายงาน fee เป็น 0

## 4. Fee ที่ถูกหักแม้ธุรกรรมล้มเหลว

- ข้อกำหนด: ธุรกรรมที่ล้มเหลวอาจยังถูกหัก fee — ต้องแสดงตามจริง
- API confirmation คืน `fee_charged` แยกจาก `success`/`result_code` ดังนั้น UI จึงสามารถแสดง "ล้มเหลวแต่จ่าย fee" ได้
- **ยังไม่มีเคส failed จริงบน Mainnet ให้ตรวจ** ในช่วง Phase 7 → จัดเป็น **IMPLEMENTED, NOT TESTED WITH LIVE DATA**
- ห้ามตีความว่า fee ถูกหัก = ธุรกรรมสำเร็จ (โค้ดไม่ทำเช่นนั้น)

## 5. Delayed indexing / disconnect / unknown outcome

| สถานการณ์ | พฤติกรรมที่กำหนด | สถานะทดสอบ |
|---|---|---|
| indexer ตามหลัง (pending ledger) | คืน `pending` พร้อม `pending_ledger`, wallet ไม่สรุป | **TESTED** ผ่าน API (indexed_head 209,335 vs core 209,336) |
| hash ยังไม่ถูก index | `pending / not_yet_observed` | **TESTED** |
| gateway อ่านไม่ได้ | Web: ปิดการส่ง, แสดง offline; CLI: error ชัดเจน | **TESTED** |
| indexer ล่มแยกจาก gateway | ต้องคงสถานะเดิม ไม่ resend | **NOT TESTED** (ยังไม่มี proxy จำลองเฉพาะ `/v1/*`) |
| ผลไม่ชัดเจน (unknown) | รายงาน unknown, ห้าม resend อัตโนมัติ | **IMPLEMENTED**; ยังไม่ทดสอบด้วย tx จริง |
| ผู้ใช้กดส่งซ้ำ | ต้องไม่สร้างธุรกรรมซ้ำโดยไม่ตั้งใจ | **NOT TESTED** (concurrent/replay ยังไม่ทดสอบ) |

## 6. Duplicate / replay

- Desktop: ส่งได้ครั้งเดียวต่อ invocation; หลังส่งจะรอ confirmation ของ hash ที่เพิ่งเซ็น
- Gateway/core ปฏิเสธ envelope ซ้ำตาม seqnum ของบัญชี (ระดับโปรโตคอล) — **ยังไม่ได้ทดสอบ replay ด้วย envelope จริง** ใน Phase 7
- Web: ไม่มี auto-resend เมื่อไม่แน่ใจผล (ไม่มีการ retry การส่ง); มีแค่ read-only re-check

## 7. สรุปสถานะตามรัฐ

| สถานะ | Implemented | Tested (live) |
|---|---|---|
| CREATED | ✅ | ✅ (gating) |
| SIGNED | ✅ | ⚠️ อ้อม (dry-run/preflight) — ยังไม่เซ็นส่งจริง |
| SUBMITTED | ✅ | ❌ (Level B ยังไม่อนุมัติ) |
| PENDING | ✅ | ✅ (API + hash ปลอม) |
| CONFIRMED | ✅ | ✅ (hash จริงในอดีต) |
| FAILED | ✅ | ❌ ยังไม่มีข้อมูลจริง |
| UNKNOWN | ✅ | ⚠️ บางส่วน (timeout path) |

## 8. Classification

| รายการ | สถานะ |
|---|---|
| State machine + no-false-confirmation logic | **TESTED** |
| Exact-hash confirmation กับ ledger จริง | **TESTED** |
| Live SUBMITTED→CONFIRMED ของ tx ใหม่ | **BLOCKED (Level B)** |
| Failed-op fee accounting | **IMPLEMENTED, NOT TESTED** |
| Replay/duplicate envelope | **NOT TESTED** |
