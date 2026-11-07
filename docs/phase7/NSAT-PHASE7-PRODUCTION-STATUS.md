# NSAT Phase 7 — สถานะระบบ Production (Read-only Inspection)

| รายการ | ค่า |
|---|---|
| วันที่ตรวจ | 2026-11-07 |
| ผู้จัดทำ | Principal Blockchain Engineer / Production Release Manager (Phase 7) |
| ขอบเขต | ตรวจอ่านเท่านั้น (read-only) — ไม่ restart ไม่แก้ validator ไม่แตะ consensus/ledger |
| ผลรวม | Backend สมบูรณ์ดี, Web Wallet พร้อมรีวิว, Desktop Wallet ยัง BLOCKED ที่ตัว packaged app |

> เอกสารนี้ตอบคำถามข้อ 1 ของ mission: **"ตอนนี้มีอะไรทำงานอยู่บน Mainnet จริง ๆ"**
> ตัวเลขทั้งหมดอ่านจาก process ที่รันอยู่จริงในเครื่อง iMac ผ่าน HTTP แบบอ่านเท่านั้น
> ไม่มีการเขียน ไม่มีการส่งธุรกรรม ไม่มีการ restart service ใด ๆ

---

## 1. สรุปผู้บริหาร (ภาษาไทย)

เครือข่าย NSAT Mainnet กำลังทำงานปกติและสอดคล้องกันทั้งสี่โนด:

- validator A/B/C ทั้งสามตัวอยู่ในสถานะ `Synced!` และมี **finalized hash เดียวกันเป๊ะ** → quorum ตรงกัน ไม่มี fork
- observer ตามหลัง/ตรงกับ validator และรายงานเลข ledger เดียวกัน
- production live tail (indexer) ตามหลัง core **หนึ่ง ledger** ตาม finality gate ที่ออกแบบไว้ (indexer head 209,335 ขณะที่ core head 209,336) และ **ไม่มี conflict ค้าง** (`open_conflicts = 0`)
- API Gateway ตอบทุก route ที่ wallet ใช้: health, network status, account, tx by hash, confirmations
- พื้นที่ดิสก์เหลือ 176 GiB จาก 931 GiB (ใช้ 82%) — เพียงพอสำหรับการเติบโตระยะสั้น

สิ่งที่ **ยังไม่พร้อม**: ตัวติดตั้ง Desktop Wallet บนเครื่อง (`/Applications/SatoshiCore Wallet.app`) เป็นบิลด์ Milestone A เวอร์ชัน 0.1.0 แบบ **ไม่ได้ code sign** และเป็น Python shell ที่ไปสั่ง devnet (port 11731) ไม่ใช่ผลิตภัณฑ์ Rust จาก PR #1 จึงจัดเป็น **BLOCKED** และห้ามแทนที่ของเดิมโดยไม่มีการอนุมัติและ backup

---

## 2. หลักฐานจาก validator / observer (อ่านด้วย `GET /info`)

| Endpoint | Network identity | Ledger | Finalized hash (16 ตัวแรก) | State |
|---|---|---|---|---|
| `127.0.0.1:11626` (validator A) | `NSAT Mainnet ; October 2026 ; bc3098829fffc717` | 209,336 | `38fb4b17a5526acc` | `Synced!` |
| `127.0.0.1:11628` (validator B) | เดียวกัน | 209,336 | `38fb4b17a5526acc` | `Synced!` |
| `127.0.0.1:11630` (validator C) | เดียวกัน | 209,336 | `38fb4b17a5526acc` | `Synced!` |
| `127.0.0.1:11634` (observer) | เดียวกัน | 209,336 | `38fb4b17a5526acc` | `Synced!` |

**การตีความ:** ทั้งสี่ノดรายงาน network passphrase ตรงกันทุกไบต์ และ hash ของ ledger ปิดล่าสุดตรงกันทั้งหมด → ไม่มีหลักฐานของ ledger divergence หรือ quorum split ในขณะตรวจ

## 3. Indexer / Live Tail / Gateway

```text
GET http://127.0.0.1:8787/v1/health
{ "ok": true, "indexed_head": 209335, "ledgers": 209335, "txs": 1153,
  "ops": 1153, "accounts": 6,
  "live_tail": { "pending_ledger": 209336,
                 "last_commit": "209275 5a9fa67b…",
                 "open_conflicts": 0 } }

GET http://127.0.0.1:8787/api/v1/network/status
{ "gateway": "ok", "core": "ok", "ledger": 209336,
  "network": "NSAT Mainnet ; October 2026 ; bc3098829fffc717" }
```

| องค์ประกอบ | หลักฐาน | สถานะ |
|---|---|---|
| Production live tail | launchd `org.satoshicore.nsat-indexer.tail` PID 91698 (running) | ACTIVE |
| Production indexer serve | launchd `org.satoshicore.nsat-indexer.serve` PID 69569, bind 8789 | ACTIVE |
| Indexer sync + watchdog | `org.satoshicore.nsat-indexer.sync`, `…watchdog` โหลดอยู่ (exit 0) | ACTIVE |
| Observer | `org.satoshicore.nsat-observer` PID 54516 | ACTIVE |
| Shadow indexer (แยกวง) | `org.satoshicore.nsat-shadow-tail` PID 56515 + serve 8796 | ACTIVE (ไม่ผูกกับ wallet) |
| Gateway | `org.satoshicore.gateway` PID 60039, listen 127.0.0.1:8787 | ACTIVE |

## 4. Finality gate และ conflict

- core head = **209,336**; indexer `indexed_head` = **209,335**; `pending_ledger` = **209,336**
- ส่วนต่าง = 1 ledger → **ตรงตาม finality gate ที่ออกแบบ** (indexer จะ index ledger ที่ปิดแล้วเท่านั้น)
- `open_conflicts = 0` → ไม่มี ledger range ที่ขาดหรือชนกันระหว่าง archive sync กับ live tail
- จำนวนธุรกรรมที่ index แล้ว 1,153 รายการ, บัญชี 6 บัญชี (ตัวเลข production จริง ไม่ได้แต่งขึ้น)

## 5. Disk / metadata

```text
/dev/disk7s1   931Gi   755Gi   176Gi   82%   /Volumes/SatoshiCore
```

เหลือ 176 GiB — เพียงพอ แต่ควรเฝ้าดูเพราะ metadata ของ live tail โตต่อเนื่อง (ไฟล์ stream `meta.xdr` ถูกอ่านซ้ำทุก poll)

## 6. การป้องกันที่ยืนยันแล้วระหว่างตรวจ

- ไม่มีการ restart validator A/B/C, observer, indexer, gateway
- ไม่มีการเขียน ledger database, ไม่แตะ `meta.xdr`, ไม่แตะ genesis/consensus/monetary rules
- ไม่มีการส่งธุรกรรม Mainnet (Level B = NOT EXECUTED)
- ไม่มีการอ่าน/พิมพ์ private key จริง — ใช้เฉพาะ keystore ทดสอบที่สร้างใหม่ (disposable)

## 7. สรุปการจัดชั้น (Classification)

| องค์ประกอบ | สถานะ |
|---|---|
| Validators A/B/C + observer (Mainnet) | **TESTED** — synced, hash ตรงกัน |
| Production live tail + indexer | **TESTED** — ตามหลัง 1 ledger, conflict 0 |
| API Gateway (read paths) | **TESTED** — health / network / account / tx / confirmations |
| Exact-hash confirmation | **TESTED** — confirmed เฉพาะ hash ที่อยู่ใน ledger จริง |
| Web Wallet (PR #7) | **READY FOR REVIEW** |
| Desktop Wallet engine + CLI (PR #1) | **READY FOR REVIEW** |
| Desktop packaged app | **BLOCKED** — บิลด์ติดตั้งเป็น Milestone A, ไม่ได้ sign |
| Mainnet live transfer (Level B) | **BLOCKED** — รอการอนุมัติจากเจ้าของ |

## 8. ข้อจำกัดของรายงานนี้

- เป็น snapshot ณ เวลาที่ตรวจ ไม่ใช่ SLA monitoring ต่อเนื่อง
- ไม่ได้ทดสอบ TLS/DNS สาธารณะ (เป็นงานฝั่ง deploy/owner) — gateway ที่ตรวจเป็น loopback
- ไม่ได้วัด latency ของธุรกรรมใหม่ เพราะ **ไม่มีธุรกรรมใหม่บน Mainnet ตั้งแต่ ledger 201,491** (`max(txs.ledger) = 201491`)

ถัดไป: ดู `NSAT-MAINNET-READONLY-E2E.md` สำหรับห่วงโซ่หลักฐานแบบ read-only และ `NSAT-WALLET-RELEASE-MANIFEST.md` สำหรับสิ่งที่พร้อม/ไม่พร้อมปล่อย
