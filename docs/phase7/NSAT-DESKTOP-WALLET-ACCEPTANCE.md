# NSAT Desktop Wallet — Acceptance Report (Phase 7)

| รายการ | ค่า |
|---|---|
| Repo / PR | `SatoshiConnect/satoshicore-wallet` PR #1 |
| Branch / head | `feat/latency-exact-hash-confirmation` @ `3402d70` |
| สิ่งที่ทดสอบ | (ก) engine + CLI ที่ build จาก PR head (ข) ตัวติดตั้งที่อยู่ในเครื่อง `/Applications/SatoshiCore Wallet.app` |
| วันที่ | 2026-11-07 |
| ผลรวม | Engine/CLI = **READY FOR REVIEW**; Packaged app = **BLOCKED** |

> ทดสอบกับ Mainnet จริงแบบอ่านเท่านั้น (gateway loopback + indexer จริง)
> ใช้ keystore ทดสอบที่สร้างใหม่ใน `/tmp` (disposable) — ไม่แตะ wallet ที่มีเงินจริง
> ไม่มีการส่งธุรกรรม Mainnet: guard ปฏิเสธก่อนเซ็น (ดูข้อ 3)

---

## 1. สิ่งที่แก้ในรอบนี้ (commit `3402d70`)

CLI เดิมคุยได้เฉพาะ CommandHandler ของโนด (`/info`, `/account`, `/tx?blob=`) แต่เมื่อชี้ไปที่ **production API Gateway** กลับพิมพ์ network ว่าง, ledger 0 และ netid = `e3b0c442…` (sha256 ของสตริงว่าง) เพราะ field ที่หายไปถูก `unwrap_or` เป็นค่า default — เป็นการ "รายงานค่าเป็นศูนย์" ที่อันตราย

การแก้:

1. เพิ่ม `--gateway` ใช้ `/api/v1/network/status`, `/api/v1/account`, `POST /api/v1/tx` (สัญญาเดียวกับ Web Wallet)
2. **fail-closed**: ถ้า endpoint ไม่ได้คืน network identity หรือ ledger head จริง → error และ exit 2 (ไม่พิมพ์ค่าปลอม)
3. base fee ที่อ่านไม่ได้ → รายงานว่า "unavailable" แต่ยังปักหมุด fee invariant 10 (ไม่บอกเป็น 0)
4. เพิ่มคำสั่ง `confirm --hash` สำหรับอ่านคำตัดสินจาก ledger แบบไม่ใช้ key

## 2. ผลทดสอบ CLI (ของจริงกับ Mainnet)

| การทดสอบ | ผล | หลักฐาน |
|---|---|---|
| สร้างกระเป๋าใหม่ (disposable) | PASS | `new` → `GDO2VFUU3UZG2RDTZM6XBQWCHMEFMLMOSOQ5GEZBOT4WOR4EOJB6FLOQ`, seed ไม่ถูกพิมพ์ |
| keyfile เก็บ seed แบบเข้ารหัส | PASS | ฟิลด์ที่มี: `scheme, kdf, iterations, salt_b64, nonce_b64, ciphertext_b64, aad` — ไม่มี plaintext seed |
| ปลดล็อก + derive address | PASS | `address` คืน address เดิม |
| รหัสผ่านผิด | PASS | `error: wrong password or corrupted keyfile`, exit 2 |
| รหัสผ่านสั้นกว่า 8 | PASS | `error: password must be at least 8 characters`, exit 2 |
| ก๊อป keyfile ไป path ใหม่แล้วปลดล็อก | PASS | ได้ address เดิม (พิสูจน์ว่า restore/backup ใช้ได้) |
| `info --gateway` กับ gateway จริง | PASS | network `NSAT Mainnet ; October 2026 ; bc3098829fffc717`, netid `0efd442e…`, ledger head ตรงกับ core |
| `info` (core mode) ชี้ไป gateway | PASS (fail-closed) | `error: http://127.0.0.1:8787 did not report a network identity — not an NSAT node endpoint`, exit 2 |
| `info` ชี้ไป static server (ไม่ใช่ JSON) | PASS | `error: Node returned a non-JSON response.` |
| network passphrase ผิด (devnet file vs Mainnet node) | PASS | `network identity mismatch … refusing (fail-closed)`, exit 2 |
| balance ของกระเป๋าว่าง | PASS | `state not on-chain (unfunded)` |
| `send --dry-run` | PASS | ปฏิเสธ `insufficient source balance (amount+fee)`; หมายเหตุ fee: `live base fee unavailable (…)`, ปักหมุด 10 |
| `send` จริง (ไม่มี env อนุญาต) | PASS | `refusing: the verified network identity is a MAINNET passphrase… requires NSAT_WALLET_ALLOW_MAINNET=1`, exit 2 |
| `confirm --hash` (historical) | PASS | `confirmed / ledger 201491 / txSUCCESS / fee 10` |
| `confirm --hash` (hash ที่ไม่มีจริง) | PASS | `pending`, reason `not_yet_observed` — **ไม่ยืนยันผิด** |

## 3. Unit / integration tests

```text
cargo test -p gem_nsat --features cli --offline   → 10 unit + 5 golden, 0 failed
cargo test -p gem_stellar --features rpc,signer   → 36 passed (รันก่อนหน้าใน Phase 7)
cargo build -p gem_nsat --features cli --release  → OK
binary: target/release/nsat-wallet 7,055,840 B
```

## 4. ตัวติดตั้งที่อยู่ในเครื่อง — BLOCKED

ตรวจ `/Applications/SatoshiCore Wallet.app` แบบอ่านเท่านั้น (ไม่เปิด ไม่แทนที่):

| หัวข้อ | ค่าที่พบ |
|---|---|
| Version | `0.1.0 (Milestone A)` / build `0.1.0-a` |
| Bundle id | `com.satoshicore.wallet` |
| ขนาด | 272 KB |
| Code signature | **ไม่มีลายเซ็นที่ใช้ได้** (`codesign` ไม่คืนข้อมูล, `spctl` = `rejected / no usable signature`) |
| โครงสร้าง | launcher shell → `python3 -m satoshicore_wallet.app`, start **devnet** ที่ port 11731, อ้าง binary dev path `…/dev/nsat-core/src/satoshicore` |
| ติดตั้งเมื่อ | 2026-11-06 |
| ตรงกับ PR #1 ไหม | **ไม่ตรง** — PR #1 คือ Rust engine `gem_nsat` + CLI ไม่ใช่ Python Milestone A |

**สรุป:** ยังไม่มี "packaged Desktop Wallet" ที่ build จาก PR #1, ที่ sign/notarize แล้ว และมี embedded core ที่ชี้ Mainnet อย่างถูกต้อง
จึงไม่สามารถยืนยัน upgrade-over-existing-install, migration, GUI send/receive หรือ package integrity ได้ → **BLOCKED**
และตามข้อห้ามของ mission จะไม่แทนที่แอปที่ติดตั้งอยู่ (อาจมีข้อมูลกระเป๋าจริง)

## 5. ตารางทดสอบที่ mission ขอ (สถานะจริง)

| รายการ | สถานะ |
|---|---|
| Existing wallet migration compatibility | **NOT TESTED** (ไม่มีบิลด์ GUI; keystore ของ CLI ตรวจแล้วว่าเปิด/ก๊อป/ย้ายได้) |
| Existing encrypted keystore | **PARTIAL** — CLI keystore: create/unlock/copy/restore ผ่าน; keystore ของแอป Milestone A ไม่ได้แตะ |
| Correct NSAT account identity | **PASS** — address format G…, network identity ตรง byte-for-byte |
| Send/receive flow | **PARTIAL** — CLI: preflight + guard + dry-run ผ่าน; GUI: NOT TESTED |
| Exact-hash confirmation | **PASS** — CLI `confirm` + engine ไม่ใช้ sequence/balance |
| Balance reconciliation | **PASS (CLI, read-only)** — ยอดจาก `/api/v1/account`; ไม่มี tx จริงให้กระทบยอด |
| Offline / reconnect | **NOT TESTED (GUI)**; CLI: endpoint ตาย → error ชัดเจน |
| Pending transaction recovery | **NOT TESTED** — ต้องมี tx จริงก่อน |
| Error messages | **PASS (CLI)** — ข้อความระบุสาเหตุและไม่หลอกว่า success |
| Upgrade over existing install | **BLOCKED** — ต้องมี signed build + backup + การอนุมัติ |
| Backup and restore compatibility | **PARTIAL** — CLI backup ใช้ได้; ยังไม่มี GUI |
| Package integrity / signing | **BLOCKED** — แอปปัจจุบัน unsigned |

## 6. Classification

| ส่วน | สถานะ |
|---|---|
| `gem_nsat` engine (envelope/signing/strkey/fee/state) | **TESTED** |
| CLI (gateway mode, guard, confirm, keystore) | **TESTED** |
| PR #1 รวม | **READY FOR REVIEW** |
| Packaged macOS app | **BLOCKED** — unsigned Milestone A, ไม่ใช่บิลด์จาก PR #1 |
| ปล่อยให้ผู้ใช้ทั่วไปติดตั้ง | **ยังไม่ได้** — ต้องมี signed/notarized build, GUI acceptance, และ backup plan |
