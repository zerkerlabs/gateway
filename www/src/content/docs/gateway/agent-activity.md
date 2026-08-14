---
title: Agent activity
description: Metadata-only measurement for locally enrolled and remotely connected agents.
---

Agent activity measures work that does not pass through the Gateway proxy. A local adapter, such as the Pi extension, emits the stable `zerker.agent-event.v1` contract to `POST /v1/agent-events`.

## Privacy boundary

The contract accepts only:

- session start and end;
- tool name, coarse outcome, and duration;
- model and provider identifiers;
- token counts and reported cost;
- a SHA-256 session reference;
- source adapter and version.

It has no fields for prompts, tool arguments, tool output, shell commands, file paths, conversation text, or credentials. The endpoint rejects unknown fields rather than silently discarding them.

## Pi adapter

The repository includes `.pi/extensions/zerker-observer.ts`. Install it globally for dogfooding:

```bash
ln -s "$PWD/.pi/extensions/zerker-observer.ts" \
  ~/.pi/agent/extensions/zerker-observer.ts
```

The adapter reads `ZERKER_TOKEN`, or falls back to `/tmp/zerker-dev-token`. It resolves the enrolled Pi agent by its discovery key and fails open when Gateway is unavailable. Agent work continues without delay or blocking.

Use `/zerker-status` inside Pi to see whether measurement is connected. Reload Pi after installing the extension, or start a new session.

## Summary

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8080/v1/agent-events/summary?agent_id=$PI_AGENT_ID"
```

The summary returns sessions, tool calls, tool outcomes, tool duration, model tokens, and reported cost for the last 24 hours. `since` and `until` can select an explicit RFC3339 window of up to 31 days.

The full wire contract is in the [Gateway API reference](/api-reference/gateway/).
