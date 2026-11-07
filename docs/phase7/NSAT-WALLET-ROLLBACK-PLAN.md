# NSAT Wallet — Rollback Plan & Drill (Phase 7)

| รายการ | ค่า |
|---|---|
| ขอบเขต | Web Wallet static artifact (staging) + แผนย้อนกลับ Desktop |
| วันที่ | 2026-11-07 |
| Drill ที่รันจริง | ✅ ผ่าน (staging loopback 18800) |
| Production rollback | ยังไม่ทำ (ไม่มีการ deploy production ในเฟสนี้) |

---

## 1. หลักการ

1. **เก็บ artifact เดิมไว้เสมอ** พร้อม checksum manifest ก่อนสลับของใหม่
2. การสลับต้องทำแบบ atomic (rename/symlink) ไม่ใช่เขียนทับทีละไฟล์
3. ทุกครั้งที่ปล่อยต้องมี **smoke test ที่จับของเสียได้จริง** ไม่ใช่แค่ HTTP 200
4. ย้อนกลับได้ภายในไม่กี่วินาที และต้องได้ไฟล์ **byte-identical** กับของเดิม
5. ฝั่ง Desktop: ไม่ถอน/แทนที่แอปของผู้ใช้ระหว่าง rollback — ติดตั้งทับเฉพาะเมื่อมี signed build และ backup keystore แล้ว

## 2. Drill ที่รันจริงใน staging (2026-11-07)

### 2.1 เตรียม Release A

```text
A files: 31
wallet/index.html sha256 (16) 345eeddea91e697f
/  wallet asset  /_next/static/chunks/fd9d1056-…js  = 172,831 B  (HTTP 200)
```

### 2.2 จำลอง Release B ที่เสีย

ทำให้ JS chunk หลักเสียหาย (แทนที่ด้วย `throw new Error("release B regression")`, 40 B):

```text
B html  → HTTP 200        ← จุดอันตราย: HTTP 200 ไม่ได้แปลว่าดี
B asset → 40 B (stub)
SMOKE   → release B DETECTED AS BAD   ✅
```

### 2.3 Rollback

```text
rollback seconds: 0.087
CHECKSUM: byte-identical to release A (31 files)
A html after rollback: HTTP 200
asset restored: 172,831 B, stub gone
```

**สรุป drill:** ตรวจจับรีลีสที่เสียได้ด้วย smoke test และย้อนกลับได้ใน 0.087 วินาที โดยไฟล์กลับมาเหมือนเดิมทุกไบต์

## 3. Smoke test ที่ต้องผ่านก่อน/หลังสลับ (Web)

```text
1) GET /wallet                          → 200 และ HTML มี <title>NSAT Wallet
2) GET /_next/static/chunks/<main>.js   → 200 และขนาดตรงกับ manifest (±0)
3) หน้าโหลดแล้วเห็น nav: Overview/Send/Receive/Activity/Settings
4) badge network = "Mainnet verified · ledger <n>" (หรือ offline อย่างชัดเจน)
5) Activity lookup address จริง → เห็นแถว และ "Check ledger" คืน txSUCCESS
6) ไม่มี console error ระดับ uncaught ระหว่างโหลด
```

> ข้อ 2 สำคัญที่สุด: drill พิสูจน์แล้วว่า HTML 200 อย่างเดียวตรวจของเสียไม่ได้

## 4. ขั้นตอน rollback บน production (เมื่อมีการ deploy จริง)

```text
# เตรียม (ก่อนปล่อย)
1. rsync -a current/ releases/<timestamp>/          # เก็บของเดิม
2. (cd releases/<timestamp> && find . -type f | sort | xargs shasum -a 256) > releases/<timestamp>.sha
3. ปล่อยของใหม่ไปที่ releases/<new>/ + smoke test ก่อนสลับ symlink

# ปล่อย
4. ln -sfn releases/<new> current.new && mv -T current.new current
5. รัน smoke test §3 ทั้งหมด

# ย้อนกลับ (ถ้า smoke ไม่ผ่าน)
6. ln -sfn releases/<timestamp> current.new && mv -T current.new current
7. shasum -c releases/<timestamp>.sha
8. รัน smoke test §3 ซ้ำ แล้วประกาศสถานะ
```

ห้าม: แก้ไฟล์ใน release เดิม, ลบ release เก่าก่อนยืนยันว่าใหม่เสถียร, หรือ rollback โดยไม่เก็บ log หลักฐาน

## 5. Desktop — แผนย้อนกลับ

สถานะปัจจุบัน: **ยังไม่มีบิลด์จาก PR #1 ที่ติดตั้งได้** จึงยังไม่มีอะไรให้ rollback ใน production

เมื่อจะมีรีลีสจริง:

```text
1. ผู้ใช้ export encrypted keystore + เก็บนอกเครื่อง (บังคับ)
2. เก็บ .app เดิมไว้ที่ ~/Library/Application Support/<app>/backups/<version>/
3. บันทึกเวอร์ชัน + bundle id + signature ก่อนติดตั้งทับ
4. ติดตั้ง signed build ใหม่
5. ตรวจ: เปิดได้, ปลดล็อก keystore เดิมได้, address เดิม, balance ตรง, confirm by hash ทำงาน
6. ถ้าล้มเหลว: คืน .app เดิม + คืน keystore ที่ export ไว้ (ไม่เขียนทับไฟล์ผู้ใช้)
```

**ห้าม** ลบหรือเขียนทับ wallet data ของผู้ใช้ระหว่าง rollback

## 6. สิ่งที่ rollback plan นี้ยังไม่ครอบคลุม

- Rollback ของตัว indexer/gateway/validator — อยู่นอกขอบเขต wallet และห้ามแตะในเฟสนี้
- Rollback ของ DNS/CDN (ต้องทำผ่านผู้ให้บริการ + TTL plan)
- Rollback khi keystore เปลี่ยน format (ยังไม่มี migration ใหม่ จึงยังไม่มีความเสี่ยงนี้)

## 7. Classification

| รายการ | สถานะ |
|---|---|
| Staging rollback drill (web static) | **TESTED — PASS** |
| Smoke test ที่จับ artifact เสีย | **TESTED — PASS** |
| Production rollback procedure | **READY (ยังไม่ใช้)** |
| Desktop rollback | **BLOCKED** — ยังไม่มี signed build |
