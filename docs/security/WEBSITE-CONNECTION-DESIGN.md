# Website Connection (dApp Provider) — Design Before Code

**Status: DESIGN ONLY — no provider, content script, background handler, or new permission is implemented.**

Date: 2026-11-14  
Scope: future connection between an HTTPS website and the existing NSAT browser-extension wallet.  
Network: the existing NSAT Mainnet only. This design does not alter the PWA, key format, transaction codec, gateway, chain, or monetary rules.

## 1. Decision summary

1. Keep the extension popup as the wallet UI and authority. A connected page receives public, explicitly granted information and may ask the extension to prepare a transaction; it never receives a seed, private key, decrypted keystore, signature primitive, or ability to submit silently.
2. A connection is an **exact-origin, revocable grant**, recorded in extension-owned storage. Do not grant by eTLD+1, wildcard subdomain, URL path, or referrer text.
3. Browser-derived sender origin and active tab identity are authoritative. Every message body from a page is untrusted, even when the extension injected the page bridge itself.
4. Each signing request opens an extension-owned approval page/window with a complete human-readable transaction review. The final approval is a fresh, explicit click in extension UI; the provider cannot approve itself.
5. Reuse the existing `lib/nsatWallet.js`, `lib/nsatCodec.js`, `lib/nsatClient.js` and `components/WalletPanel.js` contract. Accept typed NSAT transaction intent, not arbitrary bytes/XDR for blind signing. Re-read Mainnet identity, fee, source account/sequence and balance before signing; fail closed on disagreement.
6. **Do not use `externally_connectable` as the shared Chrome/Firefox transport.** Chrome supports web-page messaging through it; Mozilla documents that the corresponding web-page API is unsupported in Firefox. The cross-browser candidate is a minimal MAIN-world `window.nsat` shim plus an isolated content-script relay to the extension service worker. Treat DOM events as attacker-controlled. Validate compatibility and review the bridge before code.
7. The existing Firefox manifest minimum is 121; MAIN-world injection is available in Firefox from 128 according to MDN compatibility data. A provider release must either set a higher minimum (at least 128) or ship a separately tested alternative. Do not silently claim support on Firefox 121–127.

## 2. Product boundary and non-goals

### In scope for a later, separately reviewed implementation

- Explicitly connect an exact website origin to one chosen extension wallet.
- Read the authorized public account address and exact network identity.
- Receive a typed transfer proposal, show the exact NSAT review, and sign/submit only after approval.
- List, inspect, and revoke stored origin grants from extension UI.
- Persist grant state in extension storage, separate from the encrypted wallet vault.

### Explicitly out of scope

- PWA webpage access to the extension's or browser's private-key store.
- Any key export, seed phrase, password, decrypted keystore, raw signing method, arbitrary message signing, or blind XDR signing API.
- Auto-approval, remembered transaction approvals, background signing, auto-submit, fee substitution, or account creation on behalf of a site.
- Wildcard origins, automatic permission on install, ambient global provider that reveals an address before consent, or treating a browser connection grant as transaction approval.
- Mainnet test transactions, real funds for development, a new chain/devnet, gateway signing, or changes to Core/consensus/fees.
- Claiming browser support until each target has been built, reviewed, and manually tested.

## 3. Assets and trust boundaries

| Asset / capability | Classification | Must never cross into the website context |
|---|---|---|
| Seed/private key, password, decrypted keystore | Critical secret | Always |
| Encrypted extension vault | Sensitive ciphertext | Always |
| Account address, transaction hash, balance | Public chain data; privacy-sensitive when linked to an origin | Only after explicit `accounts` grant; request only when needed |
| Typed transfer proposal | Untrusted intent | It may cross into extension code only as validated fields; extension reconstructs the transaction itself |
| Signature / signed envelope | Spend capability | Never returned to the page; extension submits its own locally built envelope after user approval |
| Origin grant and selected account | User permission state | Extension-owned storage only; never accept a page-supplied grant flag |
| Active tab, frame, browser origin | Browser security context | Derived from trusted browser APIs, not from the message body or `window.location` string sent by the page |

Trust boundaries:

1. **Web page → MAIN-world shim:** completely controlled by the site; page can replace, wrap, call, or forge all JavaScript objects/events in its realm.
2. **MAIN-world shim → isolated content-script relay:** DOM/custom-event transport is observable and forgeable by the page. It is a carrier, not an authentication boundary.
3. **Content script → extension service worker:** privileged boundary; validate browser-supplied `sender.tab`, `sender.frameId`, `sender.url`/origin and current tab URL for every request; reject missing/opaque/changed context.
4. **Service worker → approval UI:** extension-origin-only, schema-validated, one-use request ID; service worker is authority for origin, account, expiry, and request state.
5. **Extension → Mainnet gateway:** only public reads and the approved, already-signed transaction envelope; the gateway remains keyless.

## 4. Threat model (STRIDE)

| ID | Threat / abuse case | Impact | Required controls | Verification gate |
|---|---|---|---|---|
| W1 | Malicious site asks for address without user intent | Address correlation / privacy loss | No provider before explicit Connect; origin-specific request screen; no auto-connect; address disclosed only after grant and a fresh `accounts` request | Browser test: no grant → zero account data; grant another origin → still zero |
| W2 | Page spoofs origin in a message field | Confused-deputy spend | Never trust `message.origin`; derive origin from browser sender metadata; exact origin match against grant; require top-level frame by default | Forged-origin, iframe and missing-sender tests all reject |
| W3 | Page sends an approval-shaped/fake response over DOM bridge | Unauthorized signing | The DOM bridge can only submit *requests*; no page event can approve. Approval comes only from trusted extension UI and a matching one-use request record | Forge approve/response events and assert no signature or submit |
| W4 | XSS compromises an already-connected site | Silent spend / address theft | Connection does not equal spend consent; every transfer shows recipient, amount, live fee, total debit, network/account in extension UI; no remembered spend approvals | XSS simulation: repeated proposals require separate explicit approvals |
| W5 | TOCTOU: top-level navigation, iframe, redirect, or tab reuse after prompt opened | Approval from site A applied to site B | Bind pending request to origin + tabId + frameId + documentId when available + requestId + expiry; re-check active sender/current tab at approval; invalidate on navigation, revoke, lock, worker restart or timeout | Navigate/switch-origin with prompt open; approval must refuse |
| W6 | Replay or duplicate message / double click | Duplicate signed transfers | Unpredictable unique request IDs, one-use pending state, short expiry, idempotent response cache for the same request; disable while signing; never blind-retry submitted envelope; check exact hash/sequence under existing wallet rules | Duplicate/reordered/late request cases; confirm at most one gateway submit |
| W7 | Malformed amount/address/network/fee or UI deception | Loss of funds | Strict schema/size bounds; destination decoded by existing codec; amounts canonical unsigned integer strings parsed as BigInt; fee fetched live; exact network identity verified immediately before signing; extension renders normalized values | Bad strkey, overflow, float, leading ambiguity, fee/identity change fixtures fail closed |
| W8 | Arbitrary XDR or message-sign request smuggled as a transfer | Spend or signature misuse | No raw sign method in provider API; accept one narrow typed payment intent; extension builds XDR locally through existing `buildSignedTx`; unsupported operation rejected | Fuzz unknown fields/op types and raw XDR; all reject |
| W9 | Malicious iframe requests connection under a trusted top-level site | Origin laundering / address leak | Default top-level-only. If iframe support is ever added, require explicit frame-origin permission and show both top and frame origins; no inherited top-level grant | Cross-origin frame and sandboxed/opaque origin tests reject by default |
| W10 | Optional host permission is broad or silently expanded | Extension compromise has broad browsing access | Request one canonical `https://host[:port]/*` only after a direct user gesture; no `*://*/*`, no `activeTab` fallback that changes saved origin semantics; permission removed on revoke | Inspect generated manifests and permission UI in all target browsers |
| W11 | MAIN-world provider is monkey-patched/replaced by the website | Request spoofing, false UI | MAIN shim carries no secrets or authority; isolated relay/service worker treats every event as hostile; extension UI obtains canonical intent from privileged request state and independently renders it | Replace shim methods, forge events, inject same-name object; no bypass |
| W12 | Permission revoked while requests are pending | Stale spend authority | Revocation atomically deletes origin grant, unregisters its dynamic content script, cancels its pending prompts and rejects subsequent messages | Revoke with open prompt; no later approval allowed |
| W13 | Extension lock / idle timeout during pending approval | Signing with stale secret | Re-check wallet-unlocked state at final approval; if locked/closed, reject and require unlock/review again | Lock while prompt open and wait idle timeout; no sign |
| W14 | Compromised extension update or browser/OS malware | Total wallet compromise | Minimize permissions/code, reproducible build/digest, review/release gates; acknowledge this cannot be eliminated by provider protocol | External security review; no absolute-security claims |
| W15 | Malicious/replayed gateway response | False confirmation / altered fee | Existing exact identity, live fee, exact-hash confirmation and response validation remain authoritative; provider result never upgrades state without the existing exact ledger verdict | Mock stale identity/fee and unknown hash; no false confirmed result |

### Residual risk (cannot be solved by this design)

A site can display a fake UI, instruct the user to approve, or exfiltrate an address after permission. A compromised site can propose a legitimate but harmful transfer. The wallet can prevent silent signing and show an independent confirmation; it cannot infer the user's intent or make an approved address safe. A compromised browser/OS or malicious extension update remains outside this boundary.

## 5. Permission model

### Grant levels

| Capability | Default | User action | Data/API surface |
|---|---|---|---|
| `connect` (recognize an origin) | Denied | Click “Connect NSAT Wallet” in extension UI/extension-origin approval window after browser user gesture | Store canonical origin; no address disclosure until `accounts` request is separately approved |
| `accounts` (read selected public address) | Denied | Explicit checkbox/action on the connect screen | Return one selected G-address, never seed or key; grant is scoped to that origin and selected account |
| `requestTransfer` | Denied until connected; each call still asks | Fresh explicit user approval for every request, with extension screen | Typed transparent payment only; returns a non-sensitive request/transaction status, never signature or envelope |
| `network` | Public value, available on request | No spend permission; answer only to an active, connected origin | Exact public network identity and read-only chain status; do not use as proof that the page can sign |
| `disconnect` / revoke | Always available | User action in extension → Connected Sites | Deletes the exact origin grant, unregisters script/permission when possible, cancels pending requests |

### Origin rules

- Canonicalize to `new URL(sender.url).origin`; permit only `https:` by default.
- Reject `http:` except a separately designed development-only flow that is disabled in production; reject `file:`, `chrome:`, `moz-extension:`, `about:`, `data:`, `blob:`, opaque origins, credentials in URL, and `null` origin.
- Include non-default port in the origin. `https://app.example` is not `https://sub.app.example`, `https://example`, or `https://app.example:8443`.
- Do not trust `document.referrer`, a body `origin`, a site-provided title, or the visible DOM as origin evidence. Display the punycode/canonical hostname and scheme in the grant and approval UI to make look-alike domains visible.
- A top-level-origin grant does not include child frames. Default policy: reject subframes (`frameId !== 0`). Do not derive an origin grant from a top frame if the sender is an iframe.
- Permission request is one exact optional host pattern, after a direct user gesture and before dynamic script registration. If either permission or script registration fails, show disconnected; never silently fall back to a global provider.

### Persistence and revocation

- Store `{origin, accountPubkey, capabilities, createdAt, lastUsedAt, schemaVersion}` in extension-owned storage, distinct from the encrypted keystore.
- Never store seed, password, signature, transaction envelope, or a pending approval in the origin-grant table.
- Pending intents are volatile, one-use, short-lived, bound to origin/tab/frame/request ID, and discarded on worker/service restart or wallet lock.
- Revoke deletes the record, clears all pending requests from that origin, unregisters that origin's dynamic script and removes the optional host permission only if the browser confirms it is no longer needed. Revoke is immediate even if cleanup APIs fail.

## 6. Proposed provider protocol (design only)

### Page surface

- Single namespaced provider `window.nsat` with a read-only `isNSATWallet` marker and a Promise request method; no private properties, no generic `sign`, no `sendRawTransaction`.
- Candidate versioned methods: `connect`, `disconnect`, `requestAccounts`, `getNetwork`, `requestTransfer`. The public names are provisional and must be reviewed for ecosystem collisions before implementation.
- The page bridge uses a narrow, versioned, JSON-only envelope (`protocol`, `requestId`, `method`, `params`). Reject unknown top-level keys, unknown methods, payloads above a small documented cap, cyclic/non-JSON values, and duplicate IDs. Do not support a generic RPC method dispatcher.

### Request lifecycle

1. Page requests `connect`; if no exact-origin grant exists, extension asks the browser for the one-origin optional host permission only in a direct user gesture and opens extension-owned approval UI. No address is returned yet.
2. User chooses an existing wallet/account inside extension UI and explicitly approves `connect` and separately `accounts`. If wallet is locked, unlock occurs in extension UI, never the page.
3. Subsequent page requests enter the isolated relay. The extension service worker re-derives origin/tab/frame context from browser metadata, checks the exact stored grant and selected account, validates the schema and rate-limits per origin/tab.
4. For `requestTransfer`, parse only `{to: string, amount: canonical integer string}` plus optional user-facing dApp label (untrusted, escaped, never authoritative). Reject `fee`, `total`, `network`, `account`, `seq`, `signature`, `envelope`, `rawTx`, and unknown fields from the dApp; the extension obtains those values itself.
5. Open a new extension-origin approval page/window (not a DOM modal). Show origin, selected account, current verified NSAT Mainnet identity, recipient address in full with copy/check affordance, amount, fresh ledger fee, exact total debit, reserve warning, and “Reject” / “Approve and send”. No prechecked approval, no timeout auto-approve.
6. On the final click, re-check grant, tab/origin binding, wallet unlock, identity, fee/reserve and balance; build/sign through the existing audited wallet core. Submit the already-signed envelope through the existing keyless gateway path. No signature/envelope returns to the page.
7. Return a narrow result (`rejected`, `submitted` plus public hash, `pending`, `confirmed`, `failed`, `unknown`) only after using the existing exact-hash confirmation path. On timeout/unknown, tell the page to query the same request/hash status; never silently resubmit.

### User interface obligations

- Connect screen says exactly which origin requests access, what public information it receives, and that connecting is not spending approval.
- Pending transfer screen repeats the requesting origin and keeps its window visible until explicit decision; a page title/favicon are untrusted and secondary to the canonical origin.
- Connected Sites screen shows origin, account, capabilities and last-used timestamp; revoke is one action and immediately effective.
- Every UI action has loading, reject, error and completion states; keyboard accessible; no button implies approval when disabled.
- No transaction approval in a browser-action popup that can close while a request is being confirmed; use extension-owned full page/tab or a tested persistent approval surface.

## 7. Browser compatibility and transport decision

| Target | Relevant documented support | Design consequence |
|---|---|---|
| Chrome / Edge / Brave | `externally_connectable` allows matching web pages to call `runtime.sendMessage`/`connect`; `scripting` supports isolated and main world; optional host permissions are user-granted | Still do not make external messaging the only API because Firefox differs. Host permission remains exact-origin and user-granted. |
| Firefox | Mozilla MDN says webpage-to-extension `runtime.sendMessage` via `externally_connectable` is unsupported. Dynamic content-script registration is available in MV3; `MAIN` execution world from Firefox 128 | Candidate shim/isolated relay is possible from 128, not from current manifest floor 121. Set floor ≥128 for provider release or don't ship provider there. Verify exact APIs against actual supported version. |
| Opera / Vivaldi | Chromium-family is not evidence of provider compatibility; optional permission UX, runtime and policy differ | Do not claim until loaded and tested, including permission grant/revoke and origin spoof cases. |
| Safari | Separate packaging and app-extension messaging model; no equivalent assumed here | Out of scope until a Safari app-extension proof of concept and security review. |

**Hard constraint:** no wildcard `optional_host_permissions` as a shortcut. If Firefox-compatible dynamic injection cannot request one exact host under current policy, block that target rather than install a broad `https://*/*` grant.

## 8. Implementation gates (must all pass before enabling provider)

1. **Review** this design with wallet security and an independent reviewer; settle API names, exact Firefox floor, HTTP localhost policy and whether address access persists.
2. **Permission prototype** with no wallet key operations: grant exact origin, verify no other origin/frame sees the provider, revoke, restart browser, and confirm revoked site remains disconnected on Chrome/Edge/Brave/Firefox.
3. **Protocol tests**: bad schema, oversized payload, forged origin field, wrong sender URL, opaque origin, subframe, navigation race, duplicate ID, replay, expired request, revoked grant and locked-wallet requests all reject.
4. **UI tests** with synthetic key only: site cannot approve; each transaction opens independent extension UI; changed amount/recipient after proposal has no effect; only approved intent is built; every approval shows live Mainnet identity/fee; cancellation causes zero gateway POST.
5. **Signing tests** only against mocks and deterministic fixtures until separate authorization for any live-fund test. Use existing transaction builder; byte vectors remain identical; no raw signing API is added.
6. **Secret/capability scan**: no seed/password/signature/envelope crossing bridge, no runtime eval/remote executable code, no unexpected host permission, no `externally_connectable` wildcard, no new storage of secrets.
7. **Browser runtime acceptance**: install unpacked in each target and record browser version, grant/revoke behavior, tab/frame cases, lock/idle cases and transaction rejection. Artifact/unit tests do not substitute for this.
8. **Publish/release**: update the browser permission UX and this status matrix; store submission/public release only after owner approval and external review.

## 9. Open questions for the owner/reviewer (block implementation, not this design)

- Require HTTPS-only origins, or allow loopback HTTP for local developer dApps under a build-time-off production policy?
- Should `accounts` remain granted until manual revocation, or prompt each new site session?
- Should one site be able to select multiple wallet accounts, or only one selected public account per origin?
- Which minimum Firefox version is acceptable: 128+ for MAIN-world injection, or no Firefox provider until a better cross-browser transport exists?
- Who is the named privacy/data controller for access logs, and what is the retention period? This must be answered in the legal notice before publishing any provider feature.

No response is required to complete the design document. These are blockers before implementation choices are frozen.

## 10. Sources and provenance

Official browser documentation checked 2026-11-13:

- Chrome message passing / webpage origins: <https://developer.chrome.com/docs/extensions/develop/concepts/messaging>
- Chrome permission minimization and externally connectable: <https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure>
- Chrome scripting and isolated/main worlds: <https://developer.chrome.com/docs/extensions/reference/api/scripting>
- Chrome optional permissions: <https://developer.chrome.com/docs/extensions/reference/api/permissions>
- Mozilla `externally_connectable` compatibility (web-page messages unsupported in Firefox): <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/externally_connectable>
- Mozilla dynamic content-script registration: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/registerContentScripts>
- Mozilla execution worlds and MAIN-world warning: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/ExecutionWorld>
- Mozilla Firefox 128 MAIN-world release notes: <https://blog.mozilla.org/addons/2024/07/10/manifest-v3-updates-landed-in-firefox-128>

These sources establish API shape/version facts, not a security certification. The actual installed browser versions and extension behavior still require local manual verification.
