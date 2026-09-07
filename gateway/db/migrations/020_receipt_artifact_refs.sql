-- Record which Treeship artifact was signed for a call, on the row the call
-- produced.
--
-- Receipts were emit-only: the gateway signed an artifact, logged nothing but
-- failures, and kept no reference. Every claim the product makes about proof
-- ("every call leaves a trusted receipt") was therefore unverifiable through
-- the API that made it — an operator could be told a receipt existed but never
-- shown which one, and an auditor had to be handed the gateway's filesystem.
--
-- Two tables because a call can end in two places. An allowed call becomes an
-- invocation; a denied one returns before invocations.Create and exists only as
-- a policy decision. Attesting the first and not the second would attest the
-- routine half and drop the interesting one.
--
-- Both columns stay NULL when receipts are disabled, when an agent has
-- emit_receipts off, and when emission failed. NULL means "no artifact
-- recorded", which is not "no artifact exists" — emission is fail-open and
-- off the request path, so a receipt can be signed and its reference lost.
-- Nothing here may be read as proof of absence.
ALTER TABLE invocations
    ADD COLUMN IF NOT EXISTS receipt_artifact_id TEXT,
    ADD COLUMN IF NOT EXISTS receipt_signed_at   TIMESTAMPTZ;

ALTER TABLE policy_decisions
    ADD COLUMN IF NOT EXISTS receipt_artifact_id TEXT,
    ADD COLUMN IF NOT EXISTS receipt_signed_at   TIMESTAMPTZ;
