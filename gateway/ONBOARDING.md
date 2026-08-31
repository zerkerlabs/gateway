# Agent onboarding

Zerker onboarding starts with value, not policy configuration.

## Step 1: find agents

```bash
make onboard
```

The scan is read-only. It reports supported agents when it finds a known executable or configuration location. It may count MCP server entries, but it never returns their names, commands, URLs, environment values, or credentials.

The scanner does not inspect:

- conversations or session history;
- prompts or memory;
- environment variables;
- process command arguments;
- API keys or credential values;
- project source files.

Absolute home and executable paths are not included in output. Configuration evidence uses home-relative display paths such as `~/.claude`.

## Machine contract

```bash
make build-onboard
./bin/zerker-onboard --json
```

Output uses `zerker.agent-discovery.v1`:

```json
{
  "schema": "zerker.agent-discovery.v1",
  "host": {
    "host_id": "9f2c1e0b7a4d6f38c02e1b9a7d4f6c1e0b7a4d6f38c02e1b9a7d4f6c1e0b7a4d"
  },
  "agents": [
    {
      "key": "claude-code",
      "name": "Claude Code",
      "provider": "Anthropic",
      "installed": true,
      "configured": true,
      "mcp_server_count": 3,
      "evidence": [
        {"kind": "executable", "detail": "claude command available"},
        {"kind": "configuration", "detail": "~/.claude"},
        {"kind": "mcp", "detail": "3 MCP servers configured"}
      ]
    }
  ]
}
```

`host.host_id` is a randomly generated identifier, persisted the first time the scan runs (under `~/.zerker/host-id`) and reused on every later run. It is stable across runs on the same machine and, unlike a hash of the hostname, carries no information that could be recovered by guessing plausible hostnames: it discloses nothing about the machine itself. The readable hostname is omitted by default; pass `--include-hostname` to add `host.hostname` to the report. A hostname often contains a person's name (`alexs-macbook-pro.local`), so only opt in when you intend to identify the machine, not just distinguish it.

This version reports only discovery evidence. It does not claim a cryptographic identity binding or authority relationship.

## Observe discovered agents

Start an authenticated Gateway, then enroll all discovered agents:

```bash
# Terminal 1
make dev-auth

# Terminal 2
make observe-agents
```

The command reads the development bearer token from `/tmp/zerker-dev-token`. The mock issuer rotates this file before expiry, and connected adapters reload it after an authentication failure. For another environment, use `ZERKER_TOKEN` and an HTTPS Gateway URL:

```bash
ZERKER_TOKEN="$TOKEN" ./bin/zerker-onboard \
  --observe-all \
  --gateway https://gateway.example.com
```

Enrollment is idempotent. Rerunning it does not create duplicates. Enrollment creates the internal inventory entry; it does not claim that agent activity is flowing yet. Each agent must be connected before Zerker can measure its work.

It registers each agent with these defaults:

- internal exposure;
- discovered identity status, not verified identity;
- no upstream invocation route;
- no blocking;
- no body capture;
- no payment;
- no external publication.

Each enrollment also records the machine it came from: `zerker_host_id` (always) and `zerker_hostname` (only with `--include-hostname`). This is what lets two people enrolling the same tool from two different laptops land as two distinct agents instead of colliding on name. If a name conflict is detected against an agent enrolled from a different machine, the error says so instead of asking the operator to review a record on a machine they cannot see.

Plain HTTP is accepted only for numeric loopback addresses. The client refuses redirects so a bearer token cannot be forwarded elsewhere.

## Connect Pi measurement

The repository includes a metadata-only Pi extension:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/../.pi/extensions/zerker-observer.ts" \
  ~/.pi/agent/extensions/zerker-observer.ts
```

Run `/reload` in an existing Pi session or start a new session. `/zerker-status` reports whether events are reaching Gateway. `/zerker-today` shows a one-line Pi summary.

The extension sends session lifecycle, tool name/outcome/duration, model identity, token counts, and reported cost. It hashes the Pi session ID before sending it. It never sends prompts, tool arguments, tool output, command lines, file paths, or conversation content. Measurement fails open when Gateway is unavailable.

## Check connection status

Build the local operator CLI and ask for evidence-based status:

```bash
make build-cli
./bin/zerker status
./bin/zerker status --agent hermes
```

The stable JSON contract is `zerker.agent-status.v1`:

```bash
./bin/zerker status --json
```

Every row states enrollment explicitly. `reporting` means Gateway received an event within five minutes. `quiet` means older event evidence exists. `no_recent_events` means the inventory entry exists without event evidence in the last 31 days. `not_enrolled` means the discovered local agent has no matching inventory entry. The command deliberately does not call enrollment a persistent connection.

`hermes gateway status` checks Hermes messaging platforms; it does not check Zerker Gateway. Use `zerker status --agent hermes` for the Zerker relationship.

The one-line remote pairing design is documented in [`REMOTE_ENROLLMENT.md`](REMOTE_ENROLLMENT.md). Device approval and `zerker connect` are not implemented yet.

## See today

From the Gateway module:

```bash
make today
```

The default view shows only agents with measured activity. Connected agents with no activity today and agents that have never connected are collapsed into separate calm counts. Use `go run ./cmd/zerker-onboard --today --json` for the stable `zerker.agent-today.v1` machine contract.

## Connect Claude Code measurement

The Claude Code adapter uses native lifecycle and tool hooks:

```bash
python3 integrations/claude-code/install.py
```

Restart Claude Code after installation. The adapter sends hashed session lifecycle plus tool name, coarse outcome, and duration. It discards prompts, assistant messages, tool inputs, tool outputs, commands, paths, and transcript locations. See [`../integrations/claude-code/README.md`](../integrations/claude-code/README.md).

## Connect Codex measurement

Codex uses the same privacy-bounded native hook model:

```bash
python3 integrations/codex/install.py
```

Restart Codex and approve the new user hook when its hook-trust prompt appears. The adapter records hashed session lifecycle plus tool name, coarse outcome, and duration. See [`../integrations/codex/README.md`](../integrations/codex/README.md).

## Connect Gemini CLI measurement

Gemini CLI 0.55.1 or later exposes native lifecycle and tool hooks. Install the adapter with:

```bash
python3 integrations/gemini-cli/install.py
```

The hook sanitizes each event before handing it to a detached emitter, so Gemini CLI does not wait for Gateway. See [`../integrations/gemini-cli/README.md`](../integrations/gemini-cli/README.md).

## Connect Hermes measurement

The Hermes adapter uses native read-only observer hooks rather than scraping session files:

```bash
mkdir -p ~/.hermes/plugins
ln -s "$PWD/../integrations/hermes/zerker-observer" \
  ~/.hermes/plugins/zerker-observer
hermes plugins enable zerker-observer
```

It emits hashed session lifecycle, tool name/outcome/duration, model identity, and token counts. It deliberately ignores prompts, history, tool arguments, tool results, commands, paths, and provider payloads. See [`../integrations/hermes/zerker-observer/README.md`](../integrations/hermes/zerker-observer/README.md).

## Next dogfood slice

Use Pi, Claude Code, Codex, Gemini CLI, and Hermes during normal work, then evaluate Cursor's available extension boundary.
