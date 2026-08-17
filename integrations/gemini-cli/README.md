# Gemini CLI observer

This adapter maps Gemini CLI's native hooks to `zerker.agent-event.v1`.

It records:

- hashed session start and end;
- tool name, coarse outcome, and duration.

It does not record prompts, model responses, tool inputs, tool outputs, commands, paths, transcripts, environment values, or credentials. The hook sanitizes each event before handing it to a detached background emitter, so Gemini CLI does not wait for Gateway.

## Requirement

Gemini CLI `0.55.1` or later is required for native hooks:

```bash
gemini --version
```

## Install

From the Gateway repository root:

```bash
python3 integrations/gemini-cli/install.py
```

Restart Gemini CLI after installation. Gateway must be running and Gemini CLI must already be enrolled through `zerker-onboard --observe-all`.

The development adapter reads the rotating bearer token from `/tmp/zerker-dev-token`. For another environment, provide `ZERKER_TOKEN` and an HTTPS `ZERKER_GATEWAY_URL` to the Gemini CLI process.

## Verify

Use Gemini CLI normally, then run:

```bash
make -C gateway today
```

## Remove

```bash
python3 integrations/gemini-cli/install.py --uninstall
```

The installer preserves unrelated Gemini CLI settings and hooks.

## Test

```bash
python3 -m unittest integrations/gemini-cli/test_observer.py
```
