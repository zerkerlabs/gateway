# Gateway Console Product Goal

Turn the Zerker Gateway console into a production-grade authenticated operator application for founders and infrastructure teams managing agents.

## North star

Within 30 seconds, an operator should be able to answer:

1. What is running?
2. What is failing?
3. What changed?
4. What costs money?
5. What needs my approval?

## Product rules

- The logged-in console is operational software, not a marketing page.
- The logged-out website explains capabilities. The console helps operate them.
- Prefer compact hierarchy, tables, filters, timestamps, provenance, and evidence over large promotional copy.
- Treat `CAPABILITY_COVERAGE.md` as the parity ledger for current `docs.zerker.ai`, authored repository docs, and Gateway OpenAPI capabilities.
- Unknown, stale, unavailable, and zero are different states.
- Every number must have a source and freshness state before live mode ships.
- Available, in-review, standalone, integration-path, and planned capabilities remain visibly distinct.
- Enrollment evidence never implies a permanent connection.
- Agent activity never collects prompts, messages, arguments, outputs, commands, paths, files, environment values, or credentials.
- Proxy body capture is a separate, off-by-default Gateway feature and must not be confused with agent activity.
- Credentials never enter browser storage or rendered output.
- Mutations require explicit authorization, confirmation, and audit evidence.
- Mobile remains usable, but desktop operations are the primary information-density target.

## Current campaign scope

This autonomous campaign may improve only the fixture-backed console and its live-readiness seams inside `console/`.

It may:

- make the application shell denser and more operational;
- improve information architecture and interaction design;
- add deterministic view-model logic and tests;
- add loading, empty, stale, unavailable, and error-state prototypes;
- add non-secret data-source interfaces and same-origin read-only seams;
- improve accessibility and responsive behavior;
- produce authentication architecture documentation.

It must not:

- implement authentication or session security without human review;
- modify Gateway Go code, migrations, APIs, or production configuration;
- connect to production or send mutations to any Gateway;
- accept, persist, print, or transmit credentials;
- push, merge, deploy, release, or modify GitHub configuration;
- install global software or dependencies outside this repository;
- present fixtures as live data.

## Completion definition

The campaign is complete when all safe items in `BACKLOG.md` are checked, every `CAPABILITY_COVERAGE.md` row has an honest operator destination or explicit rationale, `npm run check` passes, desktop and mobile browser QA are clean, and `AUTH_ARCHITECTURE.md` clearly identifies decisions requiring human approval.
