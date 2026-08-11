package room

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStore is a PostgreSQL-backed, tenant-scoped implementation of the
// read half of Store: GetRoom, ListRooms, Messages, Events, and
// MemberAgentID. The write methods are a separate implementation effort; a
// PostgresStore does not satisfy the full Store interface on its own.
//
// A room's transcript and turn accounting are never stored separately — they
// are derived by replaying room_events in sequence order through the same
// logic MemoryStore uses (transcript), so the two implementations can never
// disagree about what a room's history means.
//
// Use NewPostgresStore to construct one; do not copy by value.
type PostgresStore struct {
	pool *pgxpool.Pool
}

// NewPostgresStore returns a PostgresStore that uses pool for all queries.
// pool must already be open and migrated; the caller is responsible for
// closing it.
func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{pool: pool}
}

// roomSelectCols is the canonical column list for SELECTs against rooms.
const roomSelectCols = `id, tenant_id, goal, state, turn_budget, created_at`

// rowScanner abstracts pgx.Row and pgx.Rows so scanRoom can be used in both
// QueryRow and rows.Next contexts without duplicating scan logic.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanRoom reads one row (id, tenant_id, goal, state, turn_budget,
// created_at) into a Room. Members and Events are not part of this scan —
// loadRoom fills them in separately.
func scanRoom(row rowScanner) (*Room, error) {
	var (
		r     Room
		state string
	)
	if err := row.Scan(&r.ID, &r.TenantID, &r.Goal, &state, &r.TurnBudget, &r.CreatedAt); err != nil {
		return nil, err
	}
	r.State = State(state)
	return &r, nil
}

// GetRoom implements the read half of Store.
func (s *PostgresStore) GetRoom(ctx context.Context, tenantID, roomID string) (*Room, error) {
	return s.loadRoom(ctx, tenantID, roomID)
}

// ListRooms implements the read half of Store. It uses the
// (tenant_id, created_at DESC) index (see rooms/db/migrations) to return
// tenantID's rooms newest first.
func (s *PostgresStore) ListRooms(ctx context.Context, tenantID string) ([]*Room, error) {
	rooms, err := s.queryRooms(ctx, tenantID)
	if err != nil {
		return nil, err
	}

	for _, r := range rooms {
		if err := s.hydrate(ctx, r); err != nil {
			return nil, err
		}
	}

	if rooms == nil {
		rooms = []*Room{}
	}
	return rooms, nil
}

// queryRooms fetches tenantID's room rows, newest first, without hydrating
// Members or Events — closing its rows before the caller issues any further
// query, rather than holding a pool connection open across them.
func (s *PostgresStore) queryRooms(ctx context.Context, tenantID string) ([]*Room, error) {
	rows, err := s.pool.Query(
		ctx,
		`SELECT `+roomSelectCols+` FROM rooms WHERE tenant_id=$1 ORDER BY created_at DESC`,
		tenantID,
	)
	if err != nil {
		return nil, fmt.Errorf("room: list rooms: %w", err)
	}
	defer rows.Close()

	var rooms []*Room
	for rows.Next() {
		r, err := scanRoom(rows)
		if err != nil {
			return nil, fmt.Errorf("room: scan room: %w", err)
		}
		rooms = append(rooms, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("room: list rooms: %w", err)
	}
	return rooms, nil
}

// Messages implements the read half of Store: a room's transcript, replayed
// from room_events rather than read from a second, separately-maintained
// table — there is no message table.
func (s *PostgresStore) Messages(ctx context.Context, tenantID, roomID string) ([]*Message, error) {
	if err := s.requireRoom(ctx, tenantID, roomID); err != nil {
		return nil, err
	}
	events, err := s.loadEvents(ctx, tenantID, roomID)
	if err != nil {
		return nil, err
	}
	return transcript(events), nil
}

// Events implements the read half of Store: a room's full event log, in
// sequence order.
func (s *PostgresStore) Events(ctx context.Context, tenantID, roomID string) ([]*Event, error) {
	if err := s.requireRoom(ctx, tenantID, roomID); err != nil {
		return nil, err
	}
	return s.loadEvents(ctx, tenantID, roomID)
}

// MemberAgentID implements the read half of Store.
func (s *PostgresStore) MemberAgentID(ctx context.Context, tenantID, roomID, memberID string) (string, error) {
	if err := s.requireRoom(ctx, tenantID, roomID); err != nil {
		return "", err
	}

	var agentID string
	err := s.pool.QueryRow(
		ctx,
		`SELECT agent_id FROM room_members WHERE id=$1 AND room_id=$2 AND tenant_id=$3`,
		memberID, roomID, tenantID,
	).Scan(&agentID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrMemberNotFound
		}
		return "", fmt.Errorf("room: member agent id: %w", err)
	}
	return agentID, nil
}

// loadRoom fetches a room row scoped to tenantID and hydrates its Members and
// Events. Returns ErrNotFound if roomID does not exist or belongs to a
// different tenant — the row's own WHERE clause is what enforces that, not a
// join back through room_id (AGENTS.md invariant #2).
func (s *PostgresStore) loadRoom(ctx context.Context, tenantID, roomID string) (*Room, error) {
	row := s.pool.QueryRow(
		ctx,
		`SELECT `+roomSelectCols+` FROM rooms WHERE id=$1 AND tenant_id=$2`,
		roomID, tenantID,
	)
	r, err := scanRoom(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("room: get room: %w", err)
	}
	if err := s.hydrate(ctx, r); err != nil {
		return nil, err
	}
	return r, nil
}

// hydrate populates r.Members (in join order) and r.Events (the full log, in
// sequence order) from Postgres.
func (s *PostgresStore) hydrate(ctx context.Context, r *Room) error {
	members, err := s.loadMembers(ctx, r.TenantID, r.ID)
	if err != nil {
		return err
	}
	r.Members = members

	events, err := s.loadEvents(ctx, r.TenantID, r.ID)
	if err != nil {
		return err
	}
	r.Events = events
	return nil
}

// requireRoom reports whether roomID exists under tenantID, returning
// ErrNotFound otherwise. It is used by the read methods that do not need the
// room's full row — Messages, Events, MemberAgentID — but still must not
// distinguish "does not exist" from "belongs to another tenant".
func (s *PostgresStore) requireRoom(ctx context.Context, tenantID, roomID string) error {
	var exists bool
	if err := s.pool.QueryRow(
		ctx,
		`SELECT EXISTS(SELECT 1 FROM rooms WHERE id=$1 AND tenant_id=$2)`,
		roomID, tenantID,
	).Scan(&exists); err != nil {
		return fmt.Errorf("room: check room: %w", err)
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

// loadMembers returns roomID's members in join order.
func (s *PostgresStore) loadMembers(ctx context.Context, tenantID, roomID string) ([]*Member, error) {
	rows, err := s.pool.Query(
		ctx,
		`SELECT id, agent_id, joined_at FROM room_members WHERE room_id=$1 AND tenant_id=$2 ORDER BY joined_at ASC, id ASC`,
		roomID, tenantID,
	)
	if err != nil {
		return nil, fmt.Errorf("room: list members: %w", err)
	}
	defer rows.Close()

	var members []*Member
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.ID, &m.AgentID, &m.JoinedAt); err != nil {
			return nil, fmt.Errorf("room: scan member: %w", err)
		}
		members = append(members, &m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("room: list members: %w", err)
	}
	return members, nil
}

// loadEvents returns roomID's event log in sequence order, decoded through
// DecodeEventLog — which is what makes an unknown event kind or payload
// version a skipped-with-a-warning row rather than a fatal replay (see
// event_codec.go).
func (s *PostgresStore) loadEvents(ctx context.Context, tenantID, roomID string) ([]*Event, error) {
	rows, err := s.pool.Query(
		ctx,
		`SELECT payload FROM room_events WHERE room_id=$1 AND tenant_id=$2 ORDER BY sequence ASC`,
		roomID, tenantID,
	)
	if err != nil {
		return nil, fmt.Errorf("room: query events: %w", err)
	}
	defer rows.Close()

	var records [][]byte
	for rows.Next() {
		var payload []byte
		if err := rows.Scan(&payload); err != nil {
			return nil, fmt.Errorf("room: scan event: %w", err)
		}
		records = append(records, payload)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("room: query events: %w", err)
	}

	return DecodeEventLog(slog.Default(), records), nil
}
