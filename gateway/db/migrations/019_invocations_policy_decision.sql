-- Record the policy decision on the invocation it decided.
--
-- The decision is already computed immediately before the invocation row is
-- created; it was simply discarded. Copying it here rather than referencing
-- the policy_decisions table is deliberate: decisions are recorded
-- asynchronously (so no id exists at insert time) and that log is read
-- newest-first with a bounded limit, so a joined invocation would lose its
-- policy history as the log rolled over. A self-describing row keeps its own.
--
-- Both columns stay NULL for invocations written before this, and for tenants
-- with no policy configured. NULL means "no policy decision applies", which is
-- a different fact from "allowed" and must not be backfilled into one.
--
-- Note there is no 'deny' value to expect: an enforcePolicy deny returns
-- before invocations.Create, so a denied call never becomes a row at all.
ALTER TABLE invocations
    ADD COLUMN IF NOT EXISTS policy_action TEXT,
    ADD COLUMN IF NOT EXISTS policy_matched_rule TEXT;
