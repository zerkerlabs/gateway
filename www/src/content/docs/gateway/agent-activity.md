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

The adapter reads `ZERKER_TOKEN`, or falls back to `/tmp/zerker-dev-token`. The development issuer rotates that file before expiry; the adapter reloads it and retries once after an authentication failure. It resolves the enrolled Pi agent by its discovery key and fails open when Gateway is unavailable. Agent work continues without blocking.

Use `/zerker-status` inside Pi to see whether measurement is connected. `/zerker-today` shows the current 24-hour summary in one line. Reload Pi after installing the extension, or start a new session.

## Claude Code adapter

`integrations/claude-code/zerker_observer.py` uses Claude Code's native lifecycle and tool hooks. It records hashed session boundaries plus tool name, coarse outcome, and duration. It ignores prompts, assistant messages, tool inputs, tool outputs, commands, paths, transcripts, environment values, and credentials.

```bash
python3 integrations/claude-code/install.py
```

The installer preserves unrelated Claude Code settings and hooks. Restart Claude Code after installation. See the [Claude Code adapter README](https://github.com/zerkerlabs/gateway/tree/main/integrations/claude-code) for setup and removal instructions.

## Codex adapter

`integrations/codex/zerker_observer.py` uses Codex's native lifecycle and tool hooks with the same privacy boundary. Install it without replacing existing user hooks:

```bash
python3 integrations/codex/install.py
```

Restart Codex and approve the new user hook when prompted. See the [Codex adapter README](https://github.com/zerkerlabs/gateway/tree/main/integrations/codex) for setup and removal instructions.

## Hermes adapter

`integrations/hermes/zerker-observer` uses Hermes' native, fail-open observer hooks. It subscribes only to session boundaries, completed tools, and provider usage. Hook fields containing prompts, arguments, results, commands, paths, and provider payloads are ignored.

```bash
mkdir -p ~/.hermes/plugins
ln -s "$PWD/integrations/hermes/zerker-observer" \
  ~/.hermes/plugins/zerker-observer
hermes plugins enable zerker-observer
```

See the [Hermes adapter README](https://github.com/zerkerlabs/gateway/tree/main/integrations/hermes/zerker-observer) for its exact data boundary.

## Summary

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8080/v1/agent-events/summary?agent_id=$PI_AGENT_ID"
```

The summary returns sessions, tool calls, tool outcomes, tool duration, model tokens, and reported cost for the last 24 hours. Cost is marked unavailable when an adapter supplies token usage without a cost value; zero is never used to imply “free.” `since` and `until` can select an explicit RFC3339 window of up to 31 days.

For the inventory-wide calm view:

```bash
make -C gateway today
```

Connected agents with no activity today and agents that have never connected are collapsed into separate counts instead of rows of zeroes.

The full wire contract is in the [Gateway API reference](/api-reference/gateway/).
