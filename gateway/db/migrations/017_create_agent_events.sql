-- 017_create_agent_events.sql
-- Metadata-only telemetry emitted by enrolled agent adapters. The schema has no
-- columns for prompts, tool arguments, tool output, command lines, or file paths.

CREATE TABLE IF NOT EXISTS agent_events (
    id              TEXT             NOT NULL PRIMARY KEY,
    tenant_id       TEXT             NOT NULL,
    agent_id        TEXT             NOT NULL,
    client_event_id TEXT             NOT NULL,
    schema_name     TEXT             NOT NULL CHECK (schema_name = 'zerker.agent-event.v1'),
    event_type      TEXT             NOT NULL CHECK (event_type IN (
        'session.started', 'session.ended', 'tool.completed', 'model.usage'
    )),
    session_ref     TEXT             NOT NULL,
    occurred_at     TIMESTAMPTZ      NOT NULL,
    received_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    tool_name       TEXT,
    outcome         TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'cancelled')),
    duration_ms     BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
    provider        TEXT,
    model           TEXT,
    input_tokens    BIGINT CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens   BIGINT CHECK (output_tokens IS NULL OR output_tokens >= 0),
    cache_read_tokens BIGINT CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
    cache_write_tokens BIGINT CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
    cost_usd        DOUBLE PRECISION CHECK (cost_usd IS NULL OR cost_usd >= 0),
    source          TEXT             NOT NULL,
    source_version  TEXT             NOT NULL,
    CONSTRAINT agent_events_agent_fk FOREIGN KEY (agent_id) REFERENCES agents(id),
    CONSTRAINT agent_events_tenant_client_unique UNIQUE (tenant_id, client_event_id)
);

CREATE INDEX IF NOT EXISTS agent_events_tenant_agent_time_idx
    ON agent_events (tenant_id, agent_id, occurred_at DESC);
