# Zerker observer for Hermes

This user plugin maps Hermes' native read-only observer hooks to `zerker.agent-event.v1`. It also provides the `zerker_status` tool so Hermes can explain its own Zerker enrollment and reporting evidence.

## Install

From the Gateway repository root:

```bash
mkdir -p ~/.hermes/plugins
ln -s "$PWD/integrations/hermes/zerker-observer" \
  ~/.hermes/plugins/zerker-observer
hermes plugins enable zerker-observer
```

The plugin takes effect in the next Hermes session.

## Data boundary

The plugin sends only:

- hashed session identity and lifecycle;
- tool name, coarse outcome, and duration;
- provider and model identifiers;
- input, output, and cache token counts;
- adapter name and version.

It does not access or export Hermes hook fields containing prompts, conversation history, tool arguments, tool results, commands, paths, API request bodies, API response bodies, or error messages.

Network export runs on a bounded background queue and fails open. Gateway unavailability never blocks Hermes. Plain HTTP is allowed only for numeric loopback addresses, redirects are refused, and rotated development tokens are reloaded after a `401`.

## Verify

```bash
hermes plugins list | grep zerker-observer
hermes chat -q "Use zerker_status and tell me whether you are reporting to Zerker Gateway."
make -C gateway today
```

`zerker_status` returns the evidence state, last event time, observe mode, and privacy boundary. `hermes gateway status` checks Slack and other messaging platforms; it does not check Zerker Gateway.
