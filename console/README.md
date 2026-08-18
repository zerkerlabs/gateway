# Zerker Gateway console preview

A static, fixture-backed product prototype for the future Zerker Gateway operator console. It maps the current catalog, proxy, MCP, policy, credential, invocation, analytics, payment, settlement, identity, and deployment surfaces, plus separately labeled Zerker integration paths.

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

The durable contract lives in `PRODUCT_GOAL.md`, `BACKLOG.md`, and `UX_RUBRIC.md`. Runtime state and logs stay under ignored `.loop/`. The runner is restricted to `console/`, cancels extension dialogs, stops on out-of-scope changes or repeated verification failures, and never pushes, merges, deploys, or accesses production.

For an unattended terminal on macOS, keep the process awake:

```bash
caffeinate -dimsu npm run improve -- --cycles 6 --minutes 240 --max-cost 25
```

The console has `noindex,nofollow` metadata. Delivery states are part of the product contract:

- **Available** for current OSS Gateway and facilitator capabilities;
- **In review** for local agent onboarding and activity in PR #46;
- **Standalone** for Reason;
- **Integration path** for ZMem, Rooms, Treeship, and Guard work;
- **Planned** for portals, hosted billing, remote pairing, and missions.

No fixture row implies a live connection. Every write, pairing, product, or mission interaction is explicitly non-operational.
