# NSAT Wallet — Release Manifest (Phase 7)

| รายการ | ค่า |
|---|---|
| วันที่ | 2026-11-07 |
| วัตถุประสงค์ | ระบุสิ่งที่พร้อม/ไม่พร้อมปล่อย พร้อม commit และหลักฐานทดสอบ |
| ขอบเขตการอนุมัติ | isolated staging + local verification เท่านั้น |
| ผลรวม | Web/Desktop engine = READY FOR REVIEW; ยังไม่มีอะไร READY FOR RELEASE |

---

## 1. Commit ที่ใช้ (clean worktree, pinned)

| Repo | PR | Branch | Head commit | สถานะ |
|---|---|---|---|---|
| `SatoshiConnect/satoshicore` | #7 | `integrate/wallet-exact-hash` | `848fc54` | OPEN, MERGEABLE |
| `SatoshiConnect/satoshicore-wallet` | #1 | `feat/latency-exact-hash-confirmation` | `3402d70` | OPEN |
| `SatoshiConnect/satoshicore` | (ใหม่) | `docs/phase7-acceptance` | เอกสารชุดนี้ | เปิด PR เพื่อรีวิว |
| `SatoshiConnect/nsat-core` | #19 | `feat/read-only-verification-*` (ตาม Phase ก่อน) | `b93fbbbd1` | ไม่แตะในรอบนี้ |

Worktrees ที่ใช้ build (สะอาด ไม่มีไฟล์ค้าง):

```text
~/nsat-ops/phase7/web     → PR #7 head 848fc54   (static export)
~/nsat-ops/phase7/wallet  → PR #1 head 3402d70   (cargo build/test)
~/nsat-ops/phase7/docs    → origin/main + เอกสาร Phase 7
```

## 2. การเปลี่ยนแปลงในรอบนี้

### Web (PR #7 — commit `848fc54`)
- `components/WalletPanel.js`: On-chain history จาก indexer, read-only address lookup, ปุ่ม Check ledger ต่อแถว, refresh ตาม SSE
- `lib/nsatSendPreflight.js`: แก้บั๊ก CREATE ข้าม balance gate
- `tests/send-preflight.test.mjs`: เพิ่มเคส CREATE (มีเงิน = warn/ผ่าน, ไม่มีเงิน = บล็อก)
- `app/wallet/wallet.css`: กัน layout ล้นจาก hash 64 ตัวบนมือถือ

### Desktop (PR #1 — commit `3402d70`)
- `gem_nsat/src/node_client.rs`: gateway mode, fail-closed network identity/ledger head, baseFee ที่ไม่เดา, POST `/api/v1/tx`
- `gem_nsat/src/bin/nsat-wallet.rs`: `--gateway`, `confirm --hash`, ข้อความ fee ที่ตรงจริง

### ก่อนหน้าใน PR เดียวกัน
- `3b11684`: นิยาม `MIN_CREATE_ACCOUNT_NSAT` (แก้ build break `E0425`)
- `3258593`: exact-hash confirmation + ตัด sequence fallback

## 3. Artifact

| Artifact | ที่มา | หมายเหตุ |
|---|---|---|
| Static web build | `NEXT_PUBLIC_API_SAME_ORIGIN=1 npm run build` | 31 ไฟล์ใน `out/`; checksum manifest เก็บที่ `/tmp/p7-A.sha` (ชั่วคราว) |
| `nsat-wallet` binary | `cargo build -p gem_nsat --features cli --release` | 7,055,840 B; **ยังไม่ sign/notarize** |
| Desktop `.app` | — | **ไม่มี** บิลด์จาก PR #1 |

> ไม่มี artifact ใดถูก deploy ขึ้น production ในรอบนี้ และไม่มี DNS/HTTPS ใดถูกแก้

## 4. ผลทดสอบที่แนบมากับ PR

### Web
```text
npm run build                      OK
node --test tests/                 24 tests: 19 pass, 0 fail, 5 skipped (ต้องมี out/ ก่อน)
services/api-gateway npm test      37 pass / 0 fail
browser (Chromium, live Mainnet)   create/restore/lock, address, balance, send gating,
                                   receive+copy, 25-row history, Check ledger,
                                   offline state, 390px & 1440px layout
```

### Desktop
```text
cargo test -p gem_nsat --features cli   15 pass / 0 fail (10 unit + 5 golden)
cargo test -p gem_stellar --features rpc,signer   36 pass
CLI live checks: gateway info, wrong endpoint, wrong network, guard, dry-run,
                 keystore copy/restore, wrong password, confirm (positive+negative)
```

## 5. สิ่งที่ **ไม่** รวมอยู่ในรีลีสนี้

- ไม่มี production deployment ของ Web Wallet
- ไม่มีการแทนที่ `/Applications/SatoshiCore Wallet.app`
- ไม่มีการเปลี่ยน validator/consensus/genesis/fee/supply
- ไม่มีการส่งธุรกรรม Mainnet (Level B)
- ไม่มี private key จริงใด ๆ ใน repo/ไฟล์/บันทึก

## 6. Checklist ก่อนปล่อยจริง (ยังไม่ผ่านทั้งหมด)

| # | เงื่อนไข | สถานะ |
|---|---|---|
| 1 | PR #7 เขียวครบ + review ผ่าน | PASS (CI: Build static export, Test API Gateway; Pages deploy owner-gated = skipped) |
| 2 | PR #1 มี CI + review | ❌ ยังไม่มี CI |
| 3 | Desktop build sign + notarize (Developer ID) | ❌ |
| 4 | GUI acceptance ของ Desktop | ❌ |
| 5 | Level B live transfer พร้อมตัวเลขจริง | ❌ รออนุมัติ |
| 6 | CSP/HSTS/TLS บนโดเมนจริง | ❌ ยังไม่ตรวจ |
| 7 | QR code (ถ้าต้องการใน release แรก) | ❌ |
| 8 | Rollback drill ผ่าน | ✅ (staging, ดูเอกสาร rollback) |
| 9 | Backup/restore ของผู้ใช้เดิม | ⚠️ CLI ผ่าน; GUI ยังไม่ทดสอบ |
| 10 | ประกาศข้อจำกัดให้ผู้ใช้ทราบ | ⚠️ ต้องทำตอนปล่อย |

## 7. Classification

| องค์ประกอบ | สถานะ |
|---|---|
| Web Wallet (PR #7) | **READY FOR REVIEW** |
| Web Wallet (production) | **BLOCKED** — รอ checklist ข้อ 5–7 และการอนุมัติ deploy |
| Desktop engine + CLI (PR #1) | **READY FOR REVIEW** |
| Desktop packaged app | **BLOCKED** |
| Mainnet live transaction | **BLOCKED** (NOT EXECUTED) |
| เอกสาร Phase 7 | **READY FOR REVIEW** |
