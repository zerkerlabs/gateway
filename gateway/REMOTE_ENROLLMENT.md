# Remote agent enrollment design

## Goal

Connect an agent running on another machine, container, CI runner, or messaging gateway without putting a permanent Gateway credential in a command, prompt, shell history, or configuration file.

The operator experience is one command:

```bash
zerker connect https://gateway.example.com
```

This document defines the contract. The current implementation ships `zerker status`; `zerker connect`, device approval, and the operator console remain follow-up work.

## Principles

- Discovery is read-only.
- Enrollment starts in internal observe mode.
- A human approves new environments.
- Pairing codes and enrollment tokens are short-lived and single-use.
- Agent credentials are scoped to one tenant, agent instance, and event-ingestion capability.
- Prompts, messages, arguments, outputs, commands, paths, files, environment values, and credentials are outside the event contract.
- Enrollment is not described as a persistent connection. `reporting`, `quiet`, `enrolled`, and `not_enrolled` are evidence states.

## Interactive flow

```text
$ zerker connect https://gateway.example.com

Found Hermes in this environment.

Zerker will collect:
  session lifecycle · tool name and outcome · duration
  model identity · token counts · reported cost

Zerker will never collect:
  prompts · messages · arguments · outputs · commands · paths
  files · environment values · credentials

Pairing code: ZK-7H4P
Approve at: https://gateway.example.com/connect/ZK-7H4P

Waiting for approval…
Connected as Hermes · Slack
Mode: observe · internal only · no blocking
```

The CLI opens the approval URL when a browser is available but always prints both the URL and code.

## Protocol

1. `POST /v1/enrollment-requests` creates a five-minute request containing only:
   - random request ID;
   - hashed pairing secret;
   - proposed display name;
   - adapter and version;
   - platform and architecture;
   - requested capability set;
   - privacy contract version.
2. Gateway returns a human-readable code and approval URL.
3. An authenticated operator reviews and approves or rejects the request.
4. The CLI polls with the unexposed pairing secret.
5. Approval returns a single-use exchange token.
6. The CLI exchanges it for an agent credential scoped to:
   - one tenant;
   - one agent instance;
   - `POST /v1/agent-events` for that agent;
   - optional self-status read access;
   - no catalog, policy, proxy, credential, payment, or cross-agent access.
7. The credential is stored in the operating-system keychain where available. Headless environments use a root-readable file or injected secret selected by the operator.
8. The native adapter is installed only after approval.

Raw pairing secrets and issued credentials must never be logged or returned by status commands.

## Automation

Headless use requires an administrator-created, short-lived bootstrap token:

```bash
zerker connect https://gateway.example.com \
  --name "Hermes · Slack" \
  --mode observe \
  --enrollment-token-file /run/secrets/zerker-enrollment
```

Tokens are single-use, expire within ten minutes, and may constrain the expected adapter, environment label, and tenant. Passing a token directly on the command line is intentionally unsupported.

## Status contract

`zerker status` returns `zerker.agent-status.v1` and uses evidence-based states:

- `reporting`: Gateway received an event in the last five minutes.
- `quiet`: Gateway has event evidence in the last 31 days, but not recently.
- `no_recent_events`: the inventory entry exists without event evidence in the last 31 days.
- `not_enrolled`: the local discovery key has no matching inventory entry.

Every agent row also carries an explicit `enrolled` boolean so “Am I enrolled?” never has to be inferred from reporting activity.

This avoids confusing an agent's own messaging gateway with Zerker Gateway and avoids claiming a live socket where none exists.

## Console

The first authenticated operator console should show:

- agents reporting now;
- quiet, enrolled, and not-enrolled agents;
- last event time;
- current observe or govern mode;
- the metadata privacy boundary;
- a **Connect another environment** action;
- pending pairing approvals.

The existing static product preview is not this console and must not be presented as connected to a live Gateway.

## Deferred decisions

- OIDC device authorization versus a Gateway-native pairing protocol;
- keychain implementations by platform;
- credential rotation and revocation UX;
- remote environment identity attestation;
- whether a messaging surface shares an agent identity with its runtime or receives a separate instance identity.
