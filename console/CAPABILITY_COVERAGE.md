# Gateway Capability Coverage

This is the console's parity ledger against the current Gateway product contract. It prevents the admin application from collapsing Gateway into only agent discovery or presenting planned Zerker products as shipped Gateway features.

## Source of truth reviewed

Reviewed on 2026-08-18:

- the public navigation and product overview at `https://docs.zerker.ai`;
- every authored page under `www/src/content/docs/`;
- `gateway/openapi.yaml`, containing 23 operations across 17 paths;
- `x402types/openapi.yaml` and the facilitator documentation;
- PR #46's agent onboarding and privacy-safe activity contract;
- the current Gateway console fixtures and delivery-state model.

When documentation, OpenAPI, and implementation disagree, the console must not silently choose the strongest claim. It must label the discrepancy and prefer implemented evidence.

## Coverage rules

- **Operator surface** means an authenticated admin can understand or investigate the capability. It does not imply the fixture performs a write.
- **Available** means shipped OSS Gateway or facilitator behavior evidenced by the repository contract.
- **In review** means PR #46 behavior that is not on `main` yet.
- **Commercial** means the managed-tier capability described by the docs.
- **Planned / integration path / standalone** never renders as available Gateway functionality.
- Developer-only wire types and SDKs belong in system inventory, not primary operator navigation.

## Core Gateway

| Documented capability | Required console surface | Delivery truth | Campaign coverage |
|---|---|---|---|
| Tenant-scoped agent catalog | Agent catalog | Available OSS | C04 |
| Catalog pending / active / inactive status | Agent catalog | Available OSS; status is derived | C04 |
| Suspension independent of catalog status | Agent catalog and attention | Available OSS | C04 |
| HTTP and MCP protocols | Agent catalog and invocation evidence | Available OSS | C03, C04 |
| MCP Streamable HTTP only; no stdio | Agent configuration detail | Available OSS with explicit limitation | C04 |
| MCP method and tool observability | Invocations and analytics | Available OSS | C03, C07 |
| Transactional invoke, `202`, and polling | Invocations | Available OSS | C03 |
| Streaming invoke and TTFT | Invocations and analytics | Available OSS | C03, C07 |
| Credential injection with caller auth stripped | Credentials and request trace | Available OSS | C03, C04, C05 |
| Retries and circuit breaking | Invocation trace, agents, attention | Available OSS | C03, C04 |
| MCP `tools/call` never automatically retried | Invocation detail | Available OSS | C03, C04 |
| SSRF checks at write and dial time | Stack/security posture | Available OSS | C04, C07 |
| Per-agent and process rate boundaries | Agent configuration and stack caveat | Available OSS; per-process when replicated | C04, C07 |
| Policy allow / warn / deny | Policies and invocation trace | Available OSS | C03, C05 |
| Policy default and `on_error` posture | Policies | Available OSS | C05 |
| Policy-store outage fails closed today | Policies and stack limitations | Available OSS limitation | C05, C07 |
| Chunked streaming `max_body_bytes` limitation | Policy detail | Available OSS limitation | C05 |
| Invocation metadata capture | Invocations | Available OSS | C03 |
| Optional body capture | Invocations privacy boundary | Available OSS; off by default | C03 |
| `invocations:read_body` scope and 1 MiB cap | Invocation authorization explanation | Available OSS | C03, C06 |
| Invocation filters and pagination | Invocations | Available OSS | C03 |
| Error taxonomy | Invocations and analytics | Available OSS | C03, C07 |
| Aggregate count, errors, p50/p95/p99, TTFT | Analytics | Available OSS | C07 |
| Analytics required window, 31-day cap, dedicated limiter | Analytics | Available OSS | C07 |
| OIDC bearer authentication | Authenticated shell architecture | Available OSS API; console login not implemented | C06 + human gate |
| Client/tenant and acting-user identity | Workspace/account context | Available OSS API | C06 + human gate |
| Cross-tenant resources return 404 | Auth architecture and security posture | Available OSS invariant | C06, C07 |
| Health and build metadata | Stack & health | Available OSS, unauthenticated probes | C07 |

## Credentials and secrets

| Documented capability | Required console surface | Delivery truth | Campaign coverage |
|---|---|---|---|
| Credential CRUD metadata | Credentials | Available OSS | C05 |
| Secret write-only, masked last four | Credentials | Available OSS | C05 |
| Referenced credential delete returns conflict | Credential detail | Available OSS | C05 |
| Envelope encryption and tenant KEKs | Credentials and stack posture | Available OSS | C05, C07 |
| Stable 32-byte `ZERKER_KMS_KEY` required for durable production | Stack posture | Available OSS | C07 |
| Ephemeral key is development-only | Stack warning | Available OSS | C07 |
| Master-key rotation unsupported | Stack limitation | Available OSS limitation | C07 |
| Tenant KEK rotation supported internally | Credentials | Available implementation seam; no public REST operation | C05 |

## Payments and facilitator

| Documented capability | Required console surface | Delivery truth | Campaign coverage |
|---|---|---|---|
| x402 `exact`, USDC on Base gate | Agent pricing, invocation trace, payments | Available OSS | C03, C04, C05 |
| `402` challenge and `X-PAYMENT` verification | Payments and invocation trace | Available OSS | C03, C05 |
| Gate-only means verified, not collected | Payments | Available OSS | C03, C05 |
| Gate-only replay protection is best effort | Payments limitation | Available OSS limitation | C05 |
| Tenant facilitator configuration | Payments | Available OSS | C05 |
| Verify → settle → forward ordering | Payment and invocation trace | Available OSS | C05 |
| Settlement failure prevents upstream execution | Payments and failures | Available OSS | C05 |
| Settlement sub-record and filtering | Payments and invocations | Available OSS | C05 |
| Self-hosted facilitator | Payments and stack | Available OSS | C05, C07 |
| Managed facilitator | Payments | Commercial | C05 |
| Facilitator mTLS and account mapping | Stack/security posture | Available OSS | C07 |
| Independent facilitator re-verification | Payments and stack | Available OSS | C05, C07 |
| Per-transaction and daily guardrails | Payments | Available OSS | C05 |
| Nonce dedupe and single-flight | Settlement detail | Available OSS | C05 |
| `/supported` and facilitator readiness/gas checks | Stack & health | Available OSS | C07 |
| Local encrypted-keystore signer | Stack | Available OSS | C07 |
| AWS KMS signer adapter | Stack | Implementation exists but is not wired into startup | C07 |
| Facilitator relays gas; never custodies payer/operator funds | Payments security posture | Available OSS | C05 |

## Self-hosting and operations

| Documented capability | Required console surface | Delivery truth | Campaign coverage |
|---|---|---|---|
| Single statically linked Go binary | Stack | Available OSS | C07 |
| Optional Postgres; memory fallback is development-only | Stack | Available OSS | C07 |
| Automatic migrations on boot | Stack | Available OSS | C07 |
| Horizontal replicas | Stack | Available OSS | C07 |
| Per-process rate-limit multiplication caveat | Stack limitation | Available OSS limitation | C07 |
| 60-second graceful rollout allowance | Stack deployment posture | Available OSS | C07 |
| Version/commit rollout confirmation | Stack | Available OSS | C07 |
| Adjacent rolling upgrades and database backup | Stack deployment posture | Documented operation | C07 |
| Configuration comes from environment at boot | Stack | Available OSS | C07 |
| Sovereign/no-call-home posture | Stack | Available OSS | C07 |

## Managed and wider Zerker product

| Documented or discussed capability | Required console treatment | Delivery truth |
|---|---|---|
| Usage and revenue metering dashboard | Revenue analytics | Commercial; raw OSS data remains available |
| Usage-based billing, quotas, invoicing, spend limits | Products and revenue | Commercial/planned, not OSS Gateway |
| Fleet-wide multi-tenant governance | Workspace/control-plane framing | Commercial; this fixture must not imply it is connected |
| Products and custom portals | Products & portals | Planned |
| Remote pairing and missions | Environments/mission concept | Planned; observe and operate credentials remain separate |
| Reason | Stack | Standalone |
| ZMem, Rooms, Treeship, Guard | Stack | Integration paths with their own delivery labels |
| Agent activity onboarding | Agent activity and environments | In review in PR #46 |

## SDK and contract discrepancies

The docs state that Go and TypeScript SDKs ship from `sdk/go/` and `sdk/ts/`. The audited repository contains `sdk/go/` but no `sdk/ts/`. The console must therefore show the Go SDK as present and the TypeScript SDK as a documentation/repository discrepancy or planned surface, not as available evidence.

## REST operation map

Every current operation has an operator destination even when writes remain disabled in the fixture:

| Operations | Console destination |
|---|---|
| `getHealthz`, `getVersion` | Stack & health |
| `createAgent`, `listAgents`, `getAgent`, `updateAgent`, `deleteAgent` | Agent catalog |
| `createCredential`, `listCredentials`, `getCredential`, `putCredential`, `deleteCredential` | Credentials |
| `transactInvocation`, `streamInvocation`, `pollInvocation` | Invocations |
| `listInvocations`, `getInvocation` | Invocations |
| `getAnalytics` | Analytics |
| `getSettlementConfig`, `patchSettlementConfig` | Payments |
| `getPolicy`, `putPolicy`, `listPolicyDecisions` | Policies |

The fixture may preview the shape of a write workflow, but must say that no mutation, credential issuance, payment, settlement, proxy call, or production request occurred.
