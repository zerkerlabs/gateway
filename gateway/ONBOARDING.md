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

## Next dogfood slice

The next onboarding step will let the operator review one found agent at a time and explicitly choose **Observe** or **Skip**. Observe will register the agent in Gateway monitor mode without enabling blocking, body capture, external exposure, or payment.
