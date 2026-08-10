-- 001_create_rooms.sql
-- Creates the rooms, room_members, and room_events tables.
--
-- There is deliberately no messages table: a room's transcript is replayed
-- from room_events rather than stored separately, so persisting the event
-- log persists the transcript and there is no second structure that can
-- drift from it.
--
-- tenant_id is denormalized onto room_members and room_events from their
-- parent room (it never varies independently of the room it belongs to), so
-- every query filters on tenant_id directly instead of joining back through
-- room_id to enforce cross-tenant isolation.

CREATE TABLE IF NOT EXISTS rooms (
    id            TEXT        NOT NULL PRIMARY KEY, -- rom_-prefixed
    tenant_id     TEXT        NOT NULL,
    goal          TEXT        NOT NULL,
    state         TEXT        NOT NULL, -- open | completed | abandoned
    turn_budget   INTEGER     NOT NULL CHECK (turn_budget > 0),
    next_sequence INTEGER     NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS rooms_tenant_created_idx ON rooms (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS room_members (
    id         TEXT        NOT NULL PRIMARY KEY, -- mem_-prefixed
    room_id    TEXT        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    tenant_id  TEXT        NOT NULL,
    agent_id   TEXT        NOT NULL,
    joined_at  TIMESTAMPTZ NOT NULL,
    UNIQUE (room_id, agent_id)
);

CREATE INDEX IF NOT EXISTS room_members_tenant_id_idx ON room_members (tenant_id);

CREATE TABLE IF NOT EXISTS room_events (
    room_id     TEXT        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    tenant_id   TEXT        NOT NULL,
    sequence    INTEGER     NOT NULL,
    kind        TEXT        NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    payload     JSONB       NOT NULL,
    -- A room's events are sequenced 1, 2, 3, ... with no gaps, and replay
    -- relies on that. Making (room_id, sequence) the primary key turns any
    -- bug that would break contiguity -- two writers allocating the same
    -- sequence, or one skipped -- into a constraint violation at insert
    -- time instead of a silent gap replay would never detect.
    PRIMARY KEY (room_id, sequence)
);

CREATE INDEX IF NOT EXISTS room_events_tenant_id_idx ON room_events (tenant_id);
