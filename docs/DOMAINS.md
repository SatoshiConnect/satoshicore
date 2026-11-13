# Domains and hosting — verified state and the two deploy paths

Checked 2026-11-13 from a clean resolver and HTTP client. Everything below is
observed, not planned.

## What is actually serving

| Name | DNS | Server | Notes |
|---|---|---|---|
| `satoshicore.org` | A → `87.124.102.86` | `server: Caddy` | Let's Encrypt certificate (`CN=satoshicore.org`), `alt-svc: h3`, `strict-transport-security: max-age=31536000; includeSubDomains`, `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`. 404s are the static export's own Next.js page. |
| `www.satoshicore.org` | **no A, no CNAME** | — | Does not resolve at all (`curl` exit 6). |
| `wallet.satoshicore.org` | **no A, no CNAME** | — | Does not resolve, although `CNAME` in this repo names it and older notes called it the production origin. |
| `gateway.satoshicore.org` | resolves | `via: 1.1 Caddy` | `/health` 200; CORS preflight already allowed `https://satoshicore.org`. |

**GitHub Pages is not in the serving path.** There is no `185.199.*` address, no
`server: GitHub.com`, and the apex points at the owner's own host. Any document
that says the site "is deployed by GitHub Pages" describes the intended
pipeline, not the live one.

## Path A — keep Caddy (no DNS change, recommended)

The build is a plain static export, so publishing is copying files.

```bash
# 1. Build + verify locally
npm ci && npm run build && npm test
node tests/security-scan.mjs out

# 2. Package (CI does this in .github/workflows/publish-static.yml)
tar -czf satoshicore-web-$(git rev-parse --short=12 HEAD).tar.gz -C out .

# 3. Copy into a NEW release directory, never over the live one
scp satoshicore-web-*.tar.gz deploy@87.124.102.86:/srv/satoshicore/releases/<sha>/
ssh deploy@87.124.102.86 'cd /srv/satoshicore/releases/<sha> && tar -xzf *.tar.gz && rm *.tar.gz'

# 4. Activate (owner action) — the old directory stays for rollback
ssh deploy@87.124.102.86 'ln -sfn /srv/satoshicore/releases/<sha> /srv/satoshicore/current'

# 5. Prove what is live
node scripts/verify-deployed-site.mjs https://satoshicore.org
```

Rollback is one command: point `current` back at the previous release
directory. Nothing is deleted, so a bad build costs seconds, not data.

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
curl -sI https://satoshicore.org/manifest.webmanifest | head -3
node scripts/verify-deployed-site.mjs https://satoshicore.org
```

`scripts/verify-deployed-site.mjs` fails on an old landing page, a missing
manifest/service worker/icons, or HTML served with the wrong content type — the
exact symptoms of a deploy that did not actually replace the live files.
