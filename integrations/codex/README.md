# Codex observer

This adapter maps Codex's native hooks to `zerker.agent-event.v1`.

It records:

- hashed session start and end;
- tool name, coarse outcome, and duration.

It does not record prompts, assistant messages, tool inputs, tool outputs, commands, paths, transcripts, environment values, or credentials. Network emission runs through asynchronous hooks, so Codex continues normally if Gateway is slow or unavailable.

## Install

From the Gateway repository root:

```bash
python3 integrations/codex/install.py
```

Restart Codex after installation. Gateway must be running and Codex must already be enrolled through `zerker-onboard --observe-all`.

The development adapter reads the rotating bearer token from `/tmp/zerker-dev-token`. For another environment, provide `ZERKER_TOKEN` and an HTTPS `ZERKER_GATEWAY_URL` to the Codex process.

## Verify

Use Codex normally, then run:

```bash
make -C gateway today
```

The expected summary lists Codex as active rather than waiting to connect.

## Remove

```bash
python3 integrations/codex/install.py --uninstall
```

The installer preserves unrelated Codex hooks.

## Test

```bash
python3 -m unittest integrations/codex/test_observer.py
```
