# Zerker Gateway console

The operator console for one live Gateway tenant. Eight pages, every number read
from the gateway at page load, no fixtures.

```
src/
  app.js         router, window control, session gate wiring
  shell.js       shell state and the detail panel (importable without a DOM)
  ui.js          rendering primitives: status vocabulary, charts, the three absent states
  styles.css     the design system
  live/          api.js (the BFF client), format.js, gate.js (sign-in)
  pages/         overview, agents, traffic, policy, payments, receipts, activity, system
server/          the backend-for-frontend: OIDC login, server-side session, /api proxy
```

## What each page reads

| Page | Reads |
|---|---|
| Overview | `/v1/me`, `/v1/capabilities`, `/v1/analytics`, `/v1/invocations`, `/v1/policy/decisions`, `/v1/settlement/config` |
| Agents | `/v1/agents`, `/v1/analytics`, `/v1/credentials` |
| Traffic | `/v1/invocations`, `/v1/invocations/{id}`, `/v1/invocations/{id}/receipt`, `/v1/analytics` |
| Policy | `/v1/policy`, `/v1/policy/decisions` |
| Payments | `/v1/invocations`, `/v1/agents`, `/v1/settlement/config` |
| Receipts | `/v1/invocations`, `/v1/policy/decisions`, `/v1/agents` |
| Activity | `/v1/agent-events/summary` per agent |
| System | `/v1/capabilities`, `/v1/credentials`, `/v1/agents`, `/healthz`, `/version` |

Identity and capabilities are read once per session; everything else is read per
page, per window.

## The rule the code is built around

**An unknown is never rendered as a zero, and neither is a value still being
read.** They are three different statements:

- a skeleton means the read is in flight;
- `Unknown` in grey means the gateway could not answer;
- a plain `0` means the gateway answered zero.

`ui.js` exposes those three as `skeleton()`, `big(..., { state: 'unknown' })`
and an ordinary value, and `src/ui.test.js` holds the line. The same rule
governs prose: a page says "this Gateway does not report window totals" rather
than showing a total of nothing.

Two consequences worth knowing:

- **Percentiles are never merged.** A p95 cannot be combined across buckets, so
  a per-agent p95 is shown only when the window is a single bucket. The
  window-wide figure comes from the gateway's own `totals`.
- **Coverage figures name their sample.** There is no server-side count of
  attested invocations, so receipt coverage is computed over the rows actually
  fetched and labelled that way rather than presented as a window figure.

## Constraints

- **No inline styles.** The BFF serves a CSP without `unsafe-inline` for
  `style-src`, so every size and colour lives in `styles.css`; dynamic bar
  widths are SVG presentation attributes, not style attributes.
- **No token in the browser.** Every call is same-origin to `/api/*`, which the
  BFF proxies with a bearer this code never sees. See `server/` and
  `AUTH_ARCHITECTURE.md`.
- **Reads only.** Nothing in the console writes to the gateway yet.

## Run it

```bash
npm install
npm run dev          # Vite, fixture-free — needs a BFF at /api
npm run check        # unit tests + build; the gate CI runs
```

The BFF has its own suite:

```bash
cd server && npm ci && npm test
```
