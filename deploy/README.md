# Deploying Zerker Gateway

Container images and a Compose stack for running the gateway — and, optionally,
Rooms and its ZMem memory backend — on your own infrastructure.

Nothing here is Zerker-operated infrastructure: this is the self-host path, and
it is deliberately complete. A sovereign operator can run the full path with no
Zerker dependency.

## What's here

| File | What it builds |
|---|---|
| `Dockerfile.gateway` | The gateway — static Go binary on distroless |
| `Dockerfile.rooms` | Rooms — separate deployable, same shape |
| `Dockerfile.zmem` | The ZMem sidecar Rooms onboards members from (a published wheel, packaged) |
| `Dockerfile.mock-oidc` | **Dev only.** A throwaway OIDC issuer so the stack boots without an IdP account |
| `compose.yaml` | The stack, in three profiles |

All four build from the **repo root**, not from `deploy/` — `gateway/go.mod`
replaces `x402types` with `../x402types`, so the module can't resolve its own
dependency from inside its own directory:

```bash
docker build -f deploy/Dockerfile.gateway -t zerker-gateway .
```

Compose already passes the right context; this only matters if you build by hand.

## Ten-minute evaluation

Auth is enforced — the gateway refuses to start without an OIDC issuer, and
there is no bypass. The `dev-auth` profile supplies a throwaway one:

```bash
cd deploy
cp .env.example .env
sed -i '' "s/^ZERKER_KMS_KEY=.*/ZERKER_KMS_KEY=$(openssl rand -hex 32)/" .env
sed -i '' "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env
sed -i '' "s|^ZERKER_OIDC_ISSUER=.*|ZERKER_OIDC_ISSUER=http://mock-oidc:9099|" .env

docker compose --profile dev-auth up -d --build

curl localhost:8080/healthz                      # {"status":"ok"}
TOKEN=$(cat .dev/token)
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/agents
```

The mock issuer mints a token for one fixed identity and serves discovery and
JWKS over plain HTTP. It is dev-only and is never published to a registry.

### Adding Rooms

Rooms authenticates its own callers *and* calls the gateway's proxy as a client,
so it needs a bearer the gateway accepts. Rooms holds that credential as-is and
never refreshes it — which is why this is a second step rather than something
Compose can wire on its own:

```bash
export ROOMS_GATEWAY_CREDENTIAL=$(cat .dev/token)
export ROOMS_GATEWAY_TENANT=acme            # must match the token's tenant claim
docker compose --profile dev-auth --profile rooms up -d --build

curl localhost:8090/healthz
```

In production, mint a long-lived token for the Rooms service identity and rotate
it on your own schedule; a short-lived one will strand Rooms when it expires.

## Production notes

- **TLS is not in this file.** The gateway serves plain HTTP and expects to be
  fronted. Terminate TLS at a reverse proxy or load balancer.
- **Give containers 60 seconds to stop.** The gateway drains in-flight HTTP for
  up to 30s, then in-flight transactional proxy calls for a further 30s.
  `compose.yaml` sets `stop_grace_period: 60s`; match it wherever you deploy.
- **Probe `/healthz`.** It needs no auth and is the one route intended for it.
  The images have no shell, so the probe belongs to the orchestrator, not to a
  `HEALTHCHECK` inside the container.
- **Back up `ZERKER_KMS_KEY`.** It wraps every stored upstream credential. Unset,
  the gateway generates a random ephemeral key at boot — and every credential
  stored before the last restart silently stops decrypting.
- **Rate limiting is per-process.** Behind _N_ replicas a caller's effective
  limit is _N_ times the per-instance limit.
- **Don't publish ZMem's port.** It binds `0.0.0.0` so a sibling container can
  reach it, and refuses to do so without a bearer token — but the container
  network is the trust boundary. Nothing outside it should be able to route to
  8766.
- **One Rooms deployment serves one gateway tenant.** `ROOMS_GATEWAY_TENANT` and
  `ZMEM_TENANT_ID` are server configuration. Two tenants that each need Rooms
  means two Rooms + ZMem pairs.

## Published images

`.github/workflows/ci-images.yml` builds all three on every pull request and publishes them from
`main` and from tags, for `linux/amd64` and `linux/arm64`:

| Image | Tags |
|---|---|
| `ghcr.io/zerkerlabs/gateway` | `main`, `sha-<commit>`, `vX.Y.Z` on a tag |
| `ghcr.io/zerkerlabs/rooms` | same |
| `ghcr.io/zerkerlabs/zmem-sidecar` | same — the packaged wheel version is pinned in `Dockerfile.zmem`, not in the tag |

Point `GATEWAY_IMAGE` / `ROOMS_IMAGE` / `ZMEM_IMAGE` at a published tag — or,
better, at a digest — to pull instead of build.
