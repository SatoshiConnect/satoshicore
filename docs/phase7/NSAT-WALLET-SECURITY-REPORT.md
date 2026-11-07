# NSAT Wallet — Security Report (Phase 7)

| รายการ | ค่า |
|---|---|
| ขอบเขต | Web Wallet (PR #7), Desktop Wallet engine/CLI (PR #1), การเชื่อม gateway/indexer |
| วันที่ | 2026-11-07 |
| ระดับความเสี่ยงรวม | Web = ปานกลาง (ยังไม่ปล่อย), Desktop packaged = **สูง/บล็อก** (unsigned) |
| หลักการ | fail-closed, ไม่มี key ออกจากอุปกรณ์, ยืนยันด้วย ledger result เท่านั้น |

---

## 1. ทรัพย์สินที่ต้องป้องกัน

| ทรัพย์สิน | ที่อยู่ | การป้องกัน |
|---|---|---|
| Seed / private key | เบราว์เซอร์ (เข้ารหัส) / keyfile (เข้ารหัส) | ไม่พิมพ์ ไม่ส่งออก ไม่ log |
| Keystore | `localStorage['scw-web-keystore-v1']` / ไฟล์ `.json` | PBKDF2-HMAC-SHA256 600k + AES-GCM-256 |
| คำสั่งเซ็น | client-side | gateway เห็นเฉพาะ envelope ที่เซ็นแล้ว |
| Network identity | gateway `/api/v1/network/status` | ต้องตรง byte-for-byte ก่อนเซ็น |
| Ledger truth | indexer `/v1/confirmations` | ใช้เฉพาะผลของ hash นั้น |

## 2. การควบคุมที่ตรวจแล้ว (มีหลักฐาน)

| # | การควบคุม | หลักฐาน |
|---|---|---|
| 1 | Seed ไม่ถูกแสดง/ส่งออก | สร้างกระเป๋าแล้วเห็นเฉพาะ address; keyfile มีแต่ `ciphertext_b64` |
| 2 | เข้ารหัสด้วย KDF ที่แรง | keystore ระบุ `PBKDF2-HMAC-SHA256`, 600,000 รอบ, `AES-GCM-256` |
| 3 | เซ็นในเครื่องเท่านั้น | ไม่มี REST call ใดส่ง seed/key; gateway รับ `envelope_xdr` |
| 4 | Network gate ก่อนเซ็น | offline → Review disabled; CLI devnet passphrase → refuse |
| 5 | Mainnet submit guard | ต้องมี `NSAT_WALLET_ALLOW_MAINNET=1` เฉพาะ invocation; ทดสอบแล้วว่าปฏิเสธ |
| 6 | Loopback-only CLI | `--url` ที่ไม่ใช่ 127.0.0.1/localhost ถูกปฏิเสธ |
| 7 | รหัสผ่านผิดไม่รั่วข้อมูล | `wrong password or corrupted keyfile` (ไม่บอกว่า key ผิดหรือ pass ผิด) |
| 8 | รหัสผ่านขั้นต่ำ 8 ตัว | ทดสอบแล้ว exit 2 |
| 9 | ยืนยันด้วย hash + ledger เท่านั้น | ดู `NSAT-TRANSACTION-STATE-VALIDATION.md` |
| 10 | ไม่มี secret ใน build output | test `no obvious secrets or key material in output` ผ่าน |
| 11 | Address validation ก่อน network I/O | CLI `decode_g_address` ก่อนยิง request; Web ตรวจ `ACCOUNT_RE` ก่อน lookup |
| 12 | Read-only lookup เท่านั้น | Activity lookup ใช้ GET, ไม่ส่งธุรกรรม, ไม่แตะ key |

## 3. การทดสอบเชิงรุก (Negative tests)

| การทดสอบ | ผล |
|---|---|
| เปิด wallet ด้วย upstream ตาย (offline) | ปิดการส่ง, fee แสดง `…`, identity = "Offline / identity mismatch" |
| CLI ชี้ core mode ไป gateway | fail-closed, ไม่พิมพ์ค่าปลอม |
| CLI ชี้ไป non-JSON endpoint | `Node returned a non-JSON response.` |
| passphrase ผิด network | refuse (fail-closed) |
| ส่ง Mainnet โดยไม่มี env อนุญาต | refuse ก่อนเซ็น |
| hash ปลอม | `pending` ไม่ confirmed |
| wrong password | error, exit 2 |
| password สั้น | error, exit 2 |
| mobile layout | หลังแก้ไม่มี horizontal overflow (ลดโอกาส UI หลอก/ปุ่มถูกบัง) |

## 4. ช่องโหว่/ความเสี่ยงที่ยังเหลือ

| ระดับ | ความเสี่ยง | รายละเอียด | ข้อเสนอ |
|---|---|---|---|
| **สูง** | Desktop app ที่ติดตั้งไม่ได้ code sign | `/Applications/SatoshiCore Wallet.app` → `spctl: rejected / no usable signature`, เป็น Python shell + devnet | ห้ามปล่อยจนมี Developer ID signature + notarization + hardened runtime |
| **สูง** | Desktop app ไม่ใช่บิลด์จาก PR #1 | ผู้ใช้อาจเข้าใจผิดว่าเป็นผลิตภัณฑ์จริง | ระบุชัดใน release notes; สร้าง pipeline build/sign จาก PR head |
| กลาง | Keystore ของ Web อยู่ใน `localStorage` | ถ้ามี XSS ใน origin เดียวกัน จะเข้าถึง ciphertext ได้ (ยังต้องถอดรหัสด้วยรหัสผ่าน) | ตรวจ CSP เข้มงวด, หลีกเลี่ยง innerHTML, พิจารณา IndexedDB + non-extractable key |
| กลาง | ยังไม่มี CSP/HSTS ที่ตรวจใน production | ตรวจได้เฉพาะ staging loopback | ตั้ง header ที่ edge/CDN และทดสอบซ้ำ |
| กลาง | ไม่มี CI ใน PR #1 | ความเสี่ยง regression หลุด | เพิ่ม workflow `cargo test` + clippy + fmt |
| กลาง | SSE reconnect ยังไม่ทดสอบ | อาจค้างสถานะเมื่อเน็ตหลุด | ทดสอบ disconnect/replay + polling fallback |
| ต่ำ | QR code ไม่มี | ผู้ใช้อาจคัดลอก address ผิด | เพิ่ม QR (address เท่านั้น ไม่ใส่ amount ถ้าไม่จำเป็น) |
| ต่ำ | CLI จำกัด loopback | ปลอดภัย แต่ยังใช้กับ gateway สาธารณะไม่ได้ตรง ๆ | เพิ่ม allowlist + TLS pinning เมื่อเปิดใช้ remote |
| ต่ำ | ไม่มีการทดสอบ replay/duplicate envelope | อาจกดส่งซ้ำ | เพิ่ม test ที่ระดับ engine + gateway |

## 5. สิ่งที่ **ไม่ได้** ทำ (และไม่ควรถือว่าทำแล้ว)

- ไม่ได้อ่าน/พิมพ์ private key จริงใด ๆ
- ไม่ได้ทดสอบ penetration test เต็มรูปแบบ
- ไม่ได้ทดสอบ TLS/DNS สาธารณะ หรือ CORS ของโดเมนจริง
- ไม่ได้ทดสอบ concurrent access หลายแท็บ/หลายโปรเซส
- ไม่ได้ทดสอบ dependency supply chain (SBOM, audit)

## 6. Classification

| ส่วน | สถานะ |
|---|---|
| Web key handling & network gate | **TESTED** |
| Desktop engine/CLI key handling & guards | **TESTED** |
| Web keystore/XSS hardening (CSP ฯลฯ) | **PARTIAL** |
| Desktop package integrity/signing | **BLOCKED** |
| ภาพรวมความปลอดภัยก่อนปล่อย | **ยังไม่ผ่าน** — ติด signing + CSP + live transaction proof |
