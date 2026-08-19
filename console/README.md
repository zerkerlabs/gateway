# Zerker Gateway console preview

A static, fixture-backed product prototype for the future Zerker Gateway operator console. It maps the current catalog, proxy, MCP, policy, credential, invocation, analytics, payment, settlement, identity, deployment, health/build, facilitator-readiness, SDK, and REST contract surfaces, plus separately labeled Zerker integration paths.

Analytics uses fixed 1-hour, 24-hour, 7-day, and 31-day fixture windows with count, safe error taxonomy, latency percentiles, streaming TTFT, MCP method/tool aggregates, and explicit empty/partial/unavailable/error scenarios. Stack & health separates one captured fixture probe from configuration, support, readiness, rollout, KMS, migration, backup, replica, and signer posture. All 23 REST operation IDs are inventory only and cannot be called.

It is intentionally separate from:

- the Gateway API;
- the Gateway documentation website in `www/`;
- the Treeship product preview;
- any live agent or customer environment.

## Run locally

```bash
npm install
npm run dev
```

Vite serves the preview at `http://127.0.0.1:5173` by default.

## Quality gate

```bash
npm run check
```

## Bounded improvement loop

The repository includes a resumable Pi RPC campaign runner. It plans one safe backlog slice, implements it, runs deterministic checks, performs browser QA and rubric review, then creates a local checkpoint commit.

```bash
npm run improve:check
npm run improve -- --cycles 6 --minutes 240 --repairs 2 --max-cost 25
npm run improve:status
npm run improve:stop
```

The durable contract lives in `PRODUCT_GOAL.md`, `CAPABILITY_COVERAGE.md`, `BACKLOG.md`, and `UX_RUBRIC.md`. The completed Safe campaign maps every ledger row and all 23 Gateway REST operations to an honest operator destination or explicit non-console rationale. `AUTH_ARCHITECTURE.md` compares browser-auth approaches and keeps implementation blocked on its human approval checklist. Runtime state and logs stay under ignored `.loop/`. The runner is restricted to `console/`, cancels extension dialogs, stops on out-of-scope changes or repeated verification failures, and never pushes, merges, deploys, or accesses production.

For an unattended terminal on macOS, keep the process awake:

```bash
caffeinate -dimsu npm run improve -- --cycles 6 --minutes 240 --max-cost 25
```

The console has `noindex,nofollow` metadata. Delivery states are part of the product contract:

- **Available** for current OSS Gateway and facilitator capabilities;
- **In review** for local agent onboarding and activity in PR #46;
- **Commercial** for managed-tier capabilities;
- **Standalone** for Reason;
- **Integration path** for ZMem, Rooms, Treeship, and Guard work;
- **Docs/repository discrepancy · not evidenced** for the absent TypeScript SDK;
- **Planned** for portals, hosted billing, remote pairing, and missions.

No fixture row implies a live connection. Every write, pairing, product, or mission interaction is explicitly non-operational.
