-- Persist independently verified Reason commitments on exact MCP tools/call
-- invocations. The partial tenant-unique index is the durable one-shot replay
-- reservation; ordinary invocations remain NULL and unaffected.
ALTER TABLE invocations
    ADD COLUMN reason_request_digest TEXT,
    ADD COLUMN reasoning_result_digest TEXT;

CREATE UNIQUE INDEX invocations_tenant_reason_request_digest_unique
    ON invocations (tenant_id, reason_request_digest)
    WHERE reason_request_digest IS NOT NULL;
