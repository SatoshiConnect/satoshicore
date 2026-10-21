# SatoshiCore Web Wallet API Gateway

Production backend service connecting browser clients to the `nsat-core`
node. **Separate deployment from the static website. Holds no keys.**

## What it does

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Liveness probe (used by CI, Docker, and the website's status page) |
| `/api/v1/chain/info` | GET | Read-only proxy of nsat-core `/info` (ledger number, network) |
| `/api/v1/tx` | POST | Relay of **already-signed** transaction envelopes (`{ "envelope_xdr": "<base64>" }`) to nsat-core |

There is no wildcard proxying: only these three routes exist. nsat-core
administrative endpoints are unreachable through the gateway by design.

## Configuration (environment variables only — no secrets)

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `NSAT_CORE_HTTP_URL` | `http://127.0.0.1:11626` | nsat-core node HTTP endpoint; run the gateway on the same host/private network as the node |
| `ALLOWED_ORIGINS` | *(none)* | Comma-separated origin allowlist, e.g. `https://satoshicore.org,https://www.satoshicore.org`. Empty = no CORS (non-browser clients only) |
| `RATE_WINDOW_MS` / `RATE_MAX_REQUESTS` | `60000` / `120` | Per-IP rate limit |
| `MAX_BODY_BYTES` | `65536` | Request body cap |
| `CORE_TIMEOUT_MS` | `10000` | Upstream timeout |

## Run locally

```bash
cd services/api-gateway
npm test                                   # unit + integration (mock core node)
NSAT_CORE_HTTP_URL=http://127.0.0.1:11626 \
ALLOWED_ORIGINS=http://localhost:3000 \
npm start
```

## Run in Docker (production)

```bash
docker build -t satoshicore-api-gateway services/api-gateway
docker run -d --name nsat-gateway \
  -p 8787:8787 \
  -e NSAT_CORE_HTTP_URL=http://172.17.0.1:11626 \
  -e ALLOWED_ORIGINS=https://satoshicore.org,https://www.satoshicore.org \
  satoshicore-api-gateway
```

The container runs as a non-root user with a built-in healthcheck.

## Connecting the website

Set `NEXT_PUBLIC_API_GATEWAY_URL` at the website's build time (e.g.
`https://gateway.satoshicore.org`). The status page and wallet then probe the
gateway automatically and drop out of offline/experimental mode when it is
reachable. Until then they render the offline state.

## Security posture

- Zero npm runtime dependencies (supply-chain minimal).
- Transaction signing is client-side; envelopes arrive already signed.
- Origin allowlist, per-IP rate limiting, body-size caps, upstream timeouts.
- Structured JSON logs contain no key material or envelope contents.
