# rooms

Rooms is a separate deployable, not part of the gateway: a substrate where
agents with persistent memory join a shared, membership-scoped space and
cowork a task over time. It owns membership and shared task state; it
deliberately owns no policy engine and no payment logic. Agent-to-agent calls
are issued through the gateway's public proxy API, so they inherit policy
enforcement, payment metering, and invocation capture rather than
reimplementing any of it.

Rooms has no central config loader — settings are read as `os.Getenv` calls at
boot (`cmd/rooms/main.go`). A misconfigured or missing required variable fails
startup, never a partially-working server.

## Configuration

### Server

| Variable | Default | Description |
|---|---|---|
| `ROOMS_ADDR` | `:8090` | TCP address the HTTP server listens on. |

### Authentication (OIDC)

Required — Rooms refuses to start without an issuer and audience configured;
there is no unauthenticated path to bring it up.

| Variable | Default | Description |
|---|---|---|
| `ROOMS_OIDC_ISSUER` | — (required) | OIDC issuer base URL used for provider discovery. |
| `ROOMS_OIDC_AUDIENCE` | — (required) | Expected value of the JWT `aud` claim. |
| `ROOMS_OIDC_TENANT_CLAIM` | — (required) | JWT claim carrying the tenant identifier. |
| `ROOMS_OIDC_USER_CLAIM` | `sub` | JWT claim carrying the acting user's subject. |

### Gateway (addressed messaging)

Required — every agent-to-agent call a room makes goes through the gateway's
proxy, never direct.

| Variable | Default | Description |
|---|---|---|
| `ROOMS_GATEWAY_BASE_URL` | — (required) | The gateway's base URL. |
| `ROOMS_GATEWAY_CREDENTIAL` | — (required) | Credential the gateway proxy calls authenticate with. Never logged. |
| `ROOMS_GATEWAY_TENANT` | — (required) | The gateway tenant `ROOMS_GATEWAY_CREDENTIAL` authenticates as. One Rooms deployment serves one gateway tenant. |
| `ROOMS_GATEWAY_TIMEOUT` | `30s` | Bounds a single proxy HTTP request. |
| `ROOMS_GATEWAY_CONFIRM_TIMEOUT` | `60s` | Bounds how long Rooms polls an accepted invocation for a terminal state before reporting the outcome as unknown. |

### Database (persistence)

Rooms supports two deployment modes, selected by whether `ROOMS_DATABASE_URL`
is set — there is no separate mode flag, and no path from a database failure
back to the in-memory store:

- **Ephemeral** (`ROOMS_DATABASE_URL` unset) — the in-memory store. Zero
  dependencies, nothing to configure, and every room, member, and message is
  lost on restart. This is the right way to evaluate Rooms in ten minutes; it
  is **not** a production mode. Starting in this mode logs an explicit warning
  at boot.
- **Durable** (`ROOMS_DATABASE_URL` set) — the Postgres store. Rooms opens a
  connection pool, applies any pending migrations from `db/migrations`
  automatically, and verifies connectivity before serving traffic. Starting in
  this mode logs which mode it is in — never the connection string, which may
  carry credentials.

A malformed or unreachable `ROOMS_DATABASE_URL` fails startup rather than
falling back to the in-memory store: a self-hoster who configured a database
and got an ephemeral one instead would lose data believing it was safe.

Migrations live in `db/migrations` as numbered `*.sql` files and are applied
by `db.Migrate`, the same convention `gateway/db` and `facilitator/db` use —
idempotent, tracked in a `schema_migrations` table, and safe to run on every
startup. There is no separate migrate command; running the `rooms` binary
against a configured database applies them.

| Variable | Default | Description |
|---|---|---|
| `ROOMS_DATABASE_URL` | — (unset selects the in-memory store) | Postgres connection string. Never logged. |
| `ROOMS_DATABASE_MAX_CONNS` | `10` | Maximum size of the connection pool. |
| `ROOMS_DATABASE_MIN_CONNS` | `2` | Minimum size of the connection pool. |
| `ROOMS_DATABASE_MAX_CONN_IDLE_TIME` | `5m` | How long an idle pooled connection is kept before it is closed. |

The pool is closed on graceful shutdown along with the HTTP server.

### Memory backend

Rooms onboards a member with the room's actual, policy-approved memory,
prepared by a real [Zmem](https://github.com/zerkerlabs/zmem) service — never
a fake in production. `ROOMS_ZMEM_BASE_URL`, a service token, and
`ROOMS_ZMEM_TENANT_ID` are required; a missing or malformed one fails startup
rather than letting Rooms come up unable to reach its memory backend. A real
deployment is a tenant-local sidecar, typically loopback-bound — see
[Running a local backend](#running-a-local-backend-for-the-integration-test)
below.

| Variable | Default | Description |
|---|---|---|
| `ROOMS_ZMEM_BASE_URL` | — (required) | The backend's base URL, e.g. `http://127.0.0.1:8766`. |
| `ROOMS_ZMEM_SERVICE_TOKEN` | — (required, unless `_FILE` is set) | Bearer service token the client authenticates with. Never logged. |
| `ROOMS_ZMEM_SERVICE_TOKEN_FILE` | — | Path to a file containing the service token, read instead of `ROOMS_ZMEM_SERVICE_TOKEN`. Prefer this in production — a token passed as `ROOMS_ZMEM_SERVICE_TOKEN` is only an environment variable, but a token passed as a flag would be visible in a process listing, which is exactly what this variable's file form avoids needing. |
| `ROOMS_ZMEM_TENANT_ID` | — (required) | The tenant this deployment expects the backend to be serving. Every response is checked against it, and a mismatch refuses the call rather than trusting whatever the backend answered with — a cheap guard against a misconfigured deployment pointed at the wrong sidecar. |
| `ROOMS_ZMEM_TIMEOUT` | `2s` | Bounds a single HTTP request to the backend. |
| `ROOMS_ZMEM_CONTEXT_BUDGET_TOKENS` | `2000` | Caps how much admitted memory content a context-preparation call may return, 1–64000 (the backend's own cap). Sent on every context-preparation call rather than left to the backend's default, because the backend records it in the commitment it returns. |
| `ROOMS_ZMEM_RISK` | `medium` | The room or tenant's configured risk level: `low`, `medium`, or `high`. Sent on every context-preparation call, for the same reason as the budget above — a deployment set to `high` that sent nothing would get commitments attesting the backend's default instead. |

## Build & test

```bash
make -C rooms check              # tidy, format, vet, lint, race-tested tests
make -C rooms integration-test   # needs TEST_DATABASE_URL + a Postgres, and a real memory backend (below)
```

### Running a local backend for the integration test

The room-persistence suite and the memory-client suite both run behind the
`integration` build tag, so `make check` skips them; `make integration-test`
needs a real Postgres (`TEST_DATABASE_URL`) and a real Zmem backend
(`ZMEM_TEST_BASE_URL`, `ZMEM_TEST_SERVICE_TOKEN`, `ZMEM_TEST_TENANT_ID`).
Locally, the memory-client suite skips when those three are unset; in CI it
fails instead — see `internal/memory/zmem_integration_test.go` and
`internal/httpapi/members_zmem_integration_test.go`.

To stand up a backend locally (see `.github/workflows/ci.yml` for exactly
what CI does):

```bash
pip install "zerker-memory @ https://github.com/zerkerlabs/zmem/releases/download/v0.1.12/zerker_memory-0.1.12-py3-none-any.whl#sha256=ae75cb6e6018cd86edc247384e43c99d5c07a5968db674bfd62948b97b61dbe2"

export ZMEM_SERVICE_TOKEN="$(openssl rand -hex 32)"
zmem --db /tmp/zmem-control.sqlite serve \
  --tenant-id tnt_rooms_dev --storage-root /tmp/zmem-rooms \
  --host 127.0.0.1 --port 8766 &

# wait for it to come up
until curl -sf http://127.0.0.1:8766/readyz >/dev/null; do sleep 1; done

export ZMEM_TEST_BASE_URL=http://127.0.0.1:8766
export ZMEM_TEST_SERVICE_TOKEN="$ZMEM_SERVICE_TOKEN"
export ZMEM_TEST_TENANT_ID=tnt_rooms_dev

TEST_DATABASE_URL="postgres://zerker:zerker@localhost:5432/zerker_test" \
  make -C rooms integration-test
```

The same `ROOMS_ZMEM_BASE_URL` / `ROOMS_ZMEM_SERVICE_TOKEN` /
`ROOMS_ZMEM_TENANT_ID` variables (see [Configuration](#configuration) above)
point a running `rooms` binary at this same backend for manual testing.

Once `ZMEM_TEST_BASE_URL` / `ZMEM_TEST_SERVICE_TOKEN` / `ZMEM_TEST_TENANT_ID`
are exported, `make -C rooms zmem-integration-test` (or
`bash rooms/run_local_skip_check.sh` directly) reruns just the ZMem httpapi
integration test — no `TEST_DATABASE_URL`/Postgres needed — which is faster
to iterate on than the full `integration-test` target.
