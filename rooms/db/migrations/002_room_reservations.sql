-- 002_room_reservations.sql
-- Creates room_reservations: durable turn reservations.
--
-- A reservation is written here before the proxied call it protects is made,
-- and removed by whichever of CommitTurn/ReleaseTurn resolves it. A row still
-- present at startup is one a crash left unresolved; invocation_id, when set,
-- is the gateway's identifier for the call that reservation was accepted
-- under, attached as soon as it is known (before the confirmation wait) so a
-- crash during that wait can still be reconciled against the gateway's own
-- invocation record.
--
-- tenant_id is denormalized from the parent room, matching room_members and
-- room_events (see 001_create_rooms.sql).

CREATE TABLE IF NOT EXISTS room_reservations (
    id            TEXT        NOT NULL PRIMARY KEY, -- msg_-prefixed; doubles as the eventual message ID
    room_id       TEXT        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    tenant_id     TEXT        NOT NULL,
    member_id     TEXT        NOT NULL,
    to_member_id  TEXT        NOT NULL,
    body          TEXT        NOT NULL,
    invocation_id TEXT        NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS room_reservations_tenant_id_idx ON room_reservations (tenant_id);
