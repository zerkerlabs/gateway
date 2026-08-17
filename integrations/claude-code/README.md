# Claude Code observer

This adapter maps Claude Code's native hooks to `zerker.agent-event.v1`.

It records:

- hashed session start and end;
- tool name, coarse outcome, and duration.

It does not record prompts, assistant messages, tool inputs, tool outputs, commands, paths, transcripts, environment values, or credentials. Network emission runs through asynchronous hooks, so Claude Code continues normally if Gateway is slow or unavailable.

## Install

From the Gateway repository root:

```bash
python3 integrations/claude-code/install.py
```

Restart Claude Code after installation. Gateway must be running and Claude Code must already be enrolled through `zerker-onboard --observe-all`.

The development adapter reads the rotating bearer token from `/tmp/zerker-dev-token`. For another environment, provide `ZERKER_TOKEN` and an HTTPS `ZERKER_GATEWAY_URL` to the Claude Code process.

## Verify

Use Claude Code normally, then run:

```bash
make -C gateway today
```

The expected summary lists Claude Code as active rather than waiting to connect.

## Remove

```bash
python3 integrations/claude-code/install.py --uninstall
```

The installer preserves unrelated Claude Code settings and hooks.

## Test

```bash
python3 -m unittest integrations/claude-code/test_observer.py
```
