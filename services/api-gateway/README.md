# SatoshiCore Web Wallet API Gateway

Production backend service connecting browser clients to the `nsat-core`
node. **Separate deployment from the static website. Holds no keys.**

## What it does

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Liveness probe (used by CI, Docker, and the website's status page) |
| `/api/v1/chain/info` | GET | Read-only proxy of nsat-core `/info` (ledger number, network) |
| `/api/v1/network/status` | GET | Gateway + core liveness, ledger number, network name (identity check) |
| `/api/v1/account?acc=<G-strkey>` | GET | Read-only account lookup — exact `balance128` decimal + seqnum; validated strkey |
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
| `CORE_BUSY_RETRIES` / `CORE_BUSY_DELAY_MS` | `4` / `150` | Bounded backoff for core `{status:"busy"}` ledger-close windows (busy is retried, never answered as a success/zero balance) |
| `NSAT_NETWORK_NAME` | `NSAT` | Network name reported by `/api/v1/network/status` |
| `GATEWAY_VERSION` | `24.0.0` | Reported by `/health` |

## API contract

`openapi.yaml` is the normative OpenAPI 3.0 contract for the `/api/v1` routes,
including the typed error bodies (`{error, upstream_status}`, busy `{error, status:"busy"}`).
`lib/nsatClient.js` (the web wallet SDK) is contract-tested against this exact
server in `tests/sdk-contract.test.mjs`, covering chain info, strict network
identity verification, exact `balance128` lookups, fee estimation and
signed-envelope relay — plus a read-only integration example in `examples/sdk-ping.mjs`.

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
