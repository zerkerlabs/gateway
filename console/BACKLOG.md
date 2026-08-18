# Gateway Console Improvement Backlog

The autonomous loop completes one safe vertical slice per cycle, in order. It may split an item when the acceptance criteria cannot fit safely in one cycle. `CAPABILITY_COVERAGE.md` is the parity ledger for the current `docs.zerker.ai` and OpenAPI surface.

## Safe campaign

- [x] **C01 — Operationalize the overview**
  - Remove remaining homepage-style presentation from the authenticated surface.
  - Lead with freshness, environment, attention, traffic, failures, decisions, and cost.
  - Keep capability education outside the first operational viewport.
  - Preserve explicit preview-data labeling.

- [x] **C02 — Model trustworthy application states**
  - Add reusable loading, empty, stale, unavailable, partial, and error states.
  - Distinguish unknown cost from zero cost.
  - Show source and last-refresh evidence for operational metrics.
  - Add deterministic tests for state derivation.

- [x] **C03 — Strengthen the traffic explorer**
  - Make filters, status, mode, agent, policy, payment, and time range legible.
  - Improve invocation trace and failure diagnosis.
  - Keep request and response body capture clearly separate and off by default.
  - Verify keyboard and narrow-screen behavior.

- [ ] **C04 — Strengthen agent and environment operations**
  - Make catalog configuration, protocol, suspension, rates, credential reference, pricing, and evidence easy to scan.
  - Separate catalog status from activity evidence.
  - Improve environment health and onboarding-state presentation.
  - Never imply persistent connectivity.

- [ ] **C05 — Strengthen governance and revenue operations**
  - Improve policy posture, ordered rules, decisions, credential metadata, payment gating, and settlement diagnosis.
  - Keep secrets masked and writes non-operational.
  - Keep x402 an adapter rather than the product identity.
  - Keep planned payment rails and portals visually subordinate.

- [ ] **C06 — Accessibility, responsive QA, and architecture handoff**
  - Test all admin surfaces at desktop and 375px.
  - Fix keyboard, focus, overflow, contrast, and reduced-motion defects.
  - Run the full console quality gate and browser-console checks.
  - Produce `AUTH_ARCHITECTURE.md` comparing same-origin BFF sessions with SPA PKCE and stop before implementation.

- [ ] **C07 — Close documentation and OpenAPI parity**
  - Reconcile every row in `CAPABILITY_COVERAGE.md` with an operator surface or an explicit non-console rationale.
  - Strengthen analytics with count, errors, latency percentiles, TTFT, fixed windows, limits, and truthful empty states.
  - Strengthen Stack & health with health/version, Postgres, OIDC, KMS, migrations, replicas, rate-limit caveats, facilitator posture, and known limitations.
  - Map all 23 current Gateway REST operations to their destination without making fixture writes operational.
  - Surface the documented TypeScript SDK discrepancy rather than claiming an absent `sdk/ts/` is shipped.
  - Run final desktop/mobile/browser-console QA across every navigation surface.

## Human-gated follow-up

These items are intentionally outside the autonomous campaign:

- [ ] Approve the authentication architecture.
- [ ] Implement OIDC login, logout, callback, sessions, and CSRF posture.
- [ ] Connect a read-only console to real tenant-scoped Gateway data.
- [ ] Land PR #46 and connect agent activity summaries.
- [ ] Add safe mutations with authorization, confirmation, and audit evidence.
- [ ] Deploy and verify an authenticated environment.
