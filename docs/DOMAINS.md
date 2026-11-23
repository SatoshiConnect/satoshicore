# Domains and hosting — verified state

Checked 2026-11-23 from this iMac and its configured resolver. Everything
below is observed, not planned.

## What is actually serving

| Name | DNS | Server | Notes |
|---|---|---|---|
| `satoshicore.org` | A → `87.124.102.86` | `server: Caddy` | Let's Encrypt certificate (`CN=satoshicore.org`), `alt-svc: h3`, `strict-transport-security: max-age=31536000; includeSubDomains`, `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`. 404s are the static export's own Next.js page. |
| `www.satoshicore.org` | **no A, no CNAME** | — | Does not resolve at all (`curl` exit 6). |
| `wallet.satoshicore.org` | A → `87.124.102.86` | iMac Caddy | DNS reaches this iMac, but its active Caddy config had no `wallet.satoshicore.org` site block. A local TLS request returned an internal TLS alert and an external browser request timed out. The static web root and Caddy host route still need to be installed. |
| `gateway.satoshicore.org` | resolves | `via: 1.1 Caddy` | `/health` 200; CORS preflight already allowed `https://satoshicore.org`. |

**GitHub Pages is not in the serving path.** There is no `185.199.*` address, no
`server: GitHub.com`, and the apex points at the owner's own host. Any document
that says the site "is deployed by GitHub Pages" describes the intended
pipeline, not the live one.

## Wallet domain — keep Caddy (no DNS change)

The build is a plain static export, so publishing is copying files.

Caddy is a launchd job on this machine, configured by
`/usr/local/etc/satoshicore/Caddyfile.all`. It currently imports
`Caddyfile.site` for `satoshicore.org` and `Caddyfile.nsat-messenger` for
`chat.satoshicore.org`; neither handles `wallet.satoshicore.org`. Keep the
existing chat/site root intact and give Wallet its own static root at
`/Users/migssa-ngakhaonu/nsat-ops/wallet-webroot`. The web build must use
`NEXT_PUBLIC_API_SAME_ORIGIN=1`; the Wallet host block imports
`ops/Caddyfile.wallet` so API requests stay on the Wallet origin.

The current `satoshicore.org` root is **not** the Wallet root — it comes from
`NSAT_WEB_ROOT` in `/Library/LaunchDaemons/com.satoshicore.caddy-standard-ports.plist`:

```bash
plutil -p /Library/LaunchDaemons/com.satoshicore.caddy-standard-ports.plist | grep NSAT_WEB_ROOT
```

At the time of writing that value is
`/Users/migssa-ngakhaonu/nsat-ops/satoshicore-webroot`. The publish itself:

```bash
# Build for production: same-origin API keeps Wallet requests on this hostname.
NEXT_PUBLIC_API_SAME_ORIGIN=1 npm run build
mkdir -p /Users/migssa-ngakhaonu/nsat-ops/wallet-webroot
rsync -a --delete out/ /Users/migssa-ngakhaonu/nsat-ops/wallet-webroot/

# Install the Wallet host route. The script backs up the host config,
# validates it, restores it if validation/restart fails, then restarts Caddy.
sudo ./ops/install-wallet-host.sh

# Verify the Wallet host after Caddy has obtained its TLS certificate.
curl -sI https://wallet.satoshicore.org/
curl -s https://wallet.satoshicore.org/build-manifest.json

# Rollback: use the timestamped backup path printed by the installer.
sudo cp /usr/local/etc/satoshicore/Caddyfile.all.bak-wallet-TIMESTAMP \
  /usr/local/etc/satoshicore/Caddyfile.all
sudo rm -f /usr/local/etc/satoshicore/Caddyfile.wallet
sudo launchctl kickstart -k system/com.satoshicore.caddy-standard-ports
```

The static file copy is reversible by restoring the previous `wallet-webroot`
directory. The virtual-host change is reversible with the saved Caddyfile and
restart command shown above. This operation does not change DNS, the existing
chat/site root, or the gateway service.

CI equivalent: Actions → **Publish static export (build, package, optional
rsync)** → run with `publish=false` for a downloadable, checksummed archive, or
`publish=true` once `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH` and
`DEPLOY_SSH_KEY` exist in Settings → Secrets. Even then the job only uploads
`releases/<sha>/` — it never switches the live symlink.

## Path B — move to GitHub Pages (needs DNS + owner decision)

Only worth doing if hosting should leave the owner's host. Required, in order:

1. **Apex A records** → `185.199.108.153`, `185.199.109.153`,
   `185.199.110.153`, `185.199.111.153`. This replaces `87.124.102.86`, so the
   Caddy site stops being reachable as soon as DNS propagates (TTL first).
2. **`www` CNAME** → `SatoshiConnect.github.io` (or an apex redirect).
3. Repository → Settings → Pages → Source **GitHub Actions**, custom domain
   `satoshicore.org`.
4. Run **Build, test and deploy static site to GitHub Pages** with
   `custom_domain=true`, `custom_domain_name=satoshicore.org`. The `verify` job
   fetches the live URLs afterwards and fails on a stale artifact.
5. Enable **Enforce HTTPS** once the certificate is issued.

Do not do step 1 and step 4 in different orders: an apex pointing at Pages
before the first custom-domain deploy serves a 404, and a deploy before the DNS
change leaves the site on the old host.

## `www` — what to decide

`www` has no record, so `https://www.satoshicore.org` fails for any user who
types it. Two honest options:

- **Add `www` as a CNAME to the apex's host and 301 it to the apex.** With
  Caddy this is two lines in the site block; no DNS work beyond the CNAME.
- **Leave it unset and never print `www.` in product copy.** Acceptable only if
  every link — homepage, README, extension store listings — uses the apex.

Whichever is chosen, the check is the same:

```bash
dig +short www.satoshicore.org
curl -sI https://www.satoshicore.org/ | head -3   # expect 301 → https://satoshicore.org/
```

## Verification checklist per change

```bash
dig +short satoshicore.org A                    # apex address unchanged / intended
dig +short www.satoshicore.org                  # a record, once configured
curl -sI https://satoshicore.org/manifest.json | head -3
node scripts/verify-deployed-site.mjs https://satoshicore.org
```

`scripts/verify-deployed-site.mjs` fails on an old landing page, a missing
manifest/service worker/icons, or HTML served with the wrong content type — the
exact symptoms of a deploy that did not actually replace the live files.
