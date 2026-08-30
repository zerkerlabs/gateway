# ZERKER GATEWAY — CONTRIBUTOR & AGENT GUIDE

> Read this first. It is the single source of truth for how Zerker Gateway is built —
> architecture, security invariants, and conventions. It applies equally to human
> contributors and coding agents.

---

## 1. WHAT ZERKER GATEWAY IS

Zerker Gateway is an open gateway to **manage, analyze, and productize agents and
agentic workflows**. It is the control plane that sits in front of agent traffic:
routing, policy, observability, payment metering, and the surfaces that turn raw
agent activity into a product. It is a single Go binary you can self-host — own
your gateway, own your keys.

It composes with the rest of the Zerker stack as **external systems, integrated
over their public interfaces — never vendored as code**:

- **[Treeship](https://github.com/zerkerlabs/treeship)** — portable,
  cryptographically-signed trust receipts for agent workflows. The gateway is a
  natural emitter.
- **[Zmem](https://github.com/zerkerlabs/zmem)** — verifiable memory for AI
  agents. The gateway is a natural consumer.

_The naming_: Zerker Gateway, after Zerker Labs. (Formerly "Farcaster" — a Hyperion farcaster is an instantaneous gateway between worlds — renamed to avoid colliding with the Farcaster social protocol.)

---

## 2. LAYOUT

A **Go workspace monorepo** (`go.work`) of independent modules:

| Module | What it is |
|--------|-----------|
| `gateway/` | The gateway service — catalog, MCP-native transport, routing proxy, auth, SSRF protection, per-tenant credential isolation, x402 payment gate |
| `rooms/` | The agent-collaboration substrate — membership, turn reservation, governed memory |
| `facilitator/` | The self-hostable x402 `/settle` server — independently re-verifies a payment and submits it on-chain with your own gas key |
| `x402types/` | The shared x402 wire contract, generated from its OpenAPI schema |
| `sdk/go/` | Go client SDK |

Within a module, standard Go: `cmd/<binary>` for entrypoints, `internal/` for
non-exported packages. Keep packages small and single-purpose. Cross-module wire
types live only in `x402types/` — never duplicated.

Two surfaces in this repo are **not** Go modules. They are not part of the Go
workspace, `make check` does not cover them, and each has its own gate:

| Surface | What it is | Its gate |
|---------|-----------|----------|
| `console/` | The operator console — a Vite/vanilla-JS single-page app (`console/src/`) plus its backend-for-frontend (`console/server/`), the Node service that runs the OIDC login and proxies same-origin `/api` calls to the gateway with a bearer the browser never sees | `make console-check` |
| `www/` | The documentation and product website | `make -C www check` |

If your change touches either directory, running `make check` proves nothing
about it. See §4.

---

## 3. ARCHITECTURE & CONVENTIONS

- **Language:** Go 1.26.
- **Dependencies:** standard library first. Every external dependency on a
  gateway is part of the attack surface — justify it in the PR. Keep `gateway/`
  especially lean: chain/crypto-heavy deps (go-ethereum, etc.) belong in
  `facilitator/`, never in `gateway/go.mod`.
- **HTTP:** Go 1.22+ `net/http` method-based routing (`"GET /path"`); no router
  dependency until a concrete need demands one.
- **Errors:** wrap with `%w`; never discard an error silently except where the
  type guarantees none (document why).
- **Logging:** `log/slog`, JSON handler.
- **Tests:** table-driven where it fits; everything runs under `-race`.

### Security invariants

A gateway routing and recording agent traffic has a wide blast radius if
compromised. These invariants apply to every change. Violations are grounds to
reject a PR regardless of other quality signals.

1. **Authenticate before acting.** Every endpoint that touches agent data must
   authenticate the caller. The only exemptions are `/healthz` and `/version`.
   New unauthenticated endpoints must be explicitly called out in the PR; silence
   means auth required.

2. **Authorise per caller.** Each authenticated caller may read and mutate only
   its own resources. No cross-tenant data may appear in list results, read
   responses, or error bodies — including in error messages that reference
   resource IDs the caller does not own.

3. **Validate at the system boundary.** All inbound payloads are parsed and
   validated before any processing. Validation failures return 4xx, never 5xx.
   Internal state — stack traces, internal IDs, config values — is never returned
   in error responses to callers.

4. **Credentials never leave the server.** API keys, signing keys, and tokens
   must never appear in log lines, HTTP response bodies, or error messages. Log
   the fact that a credential was used; never log its value.

5. **TLS-only externally.** All external-facing listeners use TLS in production.
   Plaintext HTTP is acceptable only for loopback health probes.

6. **Verify Treeship receipts; never forge.** The gateway emits and consumes
   Treeship trust receipts. It must verify cryptographic signatures on receipts
   it consumes, and never accept an unsigned or self-signed receipt as
   authoritative. Signing keys are secrets, not compiled-in constants.

7. **Minimise the dependency surface.** Every external Go module is a potential
   supply-chain vector. New dependencies require explicit justification in the
   PR. Prefer stdlib; reach for a dependency only when the alternative is
   re-implementing a significant security primitive.

8. **Rate-limit per caller.** No single caller may exhaust gateway capacity.
   Per-caller rate limiting is a required concern before any endpoint is exposed
   in production.

9. **Operational routes stay lean.** `/healthz` returns subsystem health only;
   `/version` returns deliberate build metadata only. Neither surfaces internal
   addresses, full dependency trees, or configuration values.

---

## 4. THE BUILD CONTRACT

`make check` = tidy-check + fmt-check + vet + lint + test(-race). It must be
green before every PR, and CI runs the identical gate. Never weaken the gate to
pass a change — fix the change.

On a fresh checkout, run `make tools` once to install the pinned versions of
`gofumpt` and `golangci-lint` that `make check` requires. (`make run` / `go test`
only need Go.)

**`make check` fans out over the Go modules only** — it does not build, lint, or
test `console/` or `www/`. A change to either one can leave `make check`
completely green while the surface you edited is broken. Run that surface's own
gate as well, and treat it as the same hard requirement:

| You touched | Also run |
|-------------|----------|
| `console/` | `make console-check` — installs from `console/package-lock.json`, runs the unit tests and the Vite build. The BFF has its own suite: `npm ci && npm test` in `console/server/`, plus `npm audit --audit-level=high`. |
| `www/` | `make -C www check` |

CI enforces all of these as separate required contexts (`check console`,
`check www`), so skipping one does not get the change merged — it just finds
out later.

### Working in `console/`

It is JavaScript, not Go, and §3's conventions do not apply. Match the
surrounding code and read these first:

- `console/UX_RUBRIC.md` — the contract for how this console is allowed to
  present data. The load-bearing rule: **an unknown value is never rendered as
  zero.** "No data yet", "unavailable", and "0" are three different statements
  and the console must not collapse them.
- `console/PRODUCT_GOAL.md` — what the console is for.
- `console/README.md` — how to run it, and which views read live gateway data
  versus which are still fixture-backed.

No dependency may be added to `console/` or `console/server/` without saying why
in the PR. The BFF holds the gateway bearer token, so its dependency tree is
part of the attack surface in the same way `gateway/`'s is.

---

## 5. REVIEW

PRs are reviewed for **correctness, safety, test coverage, and conformance to the
change's stated acceptance criteria** — the security invariants above are a hard
gate. Keep changes focused and their intent legible; a PR that states what it
does and why, and stays inside its scope, is far easier to accept.
