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

This version reports only discovery evidence. It does not claim a cryptographic identity binding or authority relationship.

## Observe discovered agents

Start an authenticated Gateway, then enroll all discovered agents:

```bash
# Terminal 1
make dev-auth

# Terminal 2
make observe-agents
```

The command reads the development bearer token from `/tmp/zerker-dev-token`. For another environment, use `ZERKER_TOKEN` and an HTTPS Gateway URL:

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

Plain HTTP is accepted only for numeric loopback addresses. The client refuses redirects so a bearer token cannot be forwarded elsewhere.

## Next dogfood slice

The next onboarding surface will present one found agent at a time with **Observe** and **Skip**, then show the internal inventory and the first measurement Zerker can collect.
