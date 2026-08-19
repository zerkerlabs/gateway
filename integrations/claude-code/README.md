# Claude Code observer

This adapter maps Claude Code's native hooks to `zerker.agent-event.v1`.

It records:

- hashed session start and end;
- tool name, coarse outcome, and duration.

It does not record prompts, assistant messages, tool inputs, tool outputs, commands, paths, transcripts, environment values, or credentials. The hook sanitizes locally and hands network work to a detached emitter before returning, so Claude Code does not wait for Gateway.

## Install

From the Gateway repository root:

```bash
python3 integrations/claude-code/install.py
```

Restart Claude Code after installation. Gateway must be running and Claude Code must already be enrolled through `zerker-onboard --observe-all`.

The development adapter reads the rotating bearer token from `/tmp/zerker-dev-token`. `ZERKER_TOKEN` and an HTTPS `ZERKER_GATEWAY_URL` may be used only in a controlled dogfood environment. Do not place a broad user token on a remote production agent; the scoped pairing flow in `gateway/REMOTE_ENROLLMENT.md` must land first.

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
