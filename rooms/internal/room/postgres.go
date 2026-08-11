package room

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zerkerlabs/gateway/rooms/internal/resource"
)

// PostgresStore is a PostgreSQL-backed, tenant-scoped implementation of most
// of Store: the full read half (GetRoom, ListRooms, Messages, Events,
// MemberAgentID) plus CreateRoom, CreateRoomWithBudget, AddMember,
// AppendMessage, CompleteRoom, RecordDeliveryFailure, and RecordDelivery.
// Turn reservations (ReserveTurn, CommitTurn, ReleaseTurn) are a separate
// implementation effort; a PostgresStore does not satisfy the full Store
// interface on its own.
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

// ---------------------------------------------------------------- writes ---

// CreateRoom implements the write half of Store.
func (s *PostgresStore) CreateRoom(ctx context.Context, tenantID, goal string) (*Room, error) {
	return s.createRoom(ctx, tenantID, goal, DefaultTurnBudget)
}

// CreateRoomWithBudget implements the write half of Store.
func (s *PostgresStore) CreateRoomWithBudget(ctx context.Context, tenantID, goal string, turnBudget int) (*Room, error) {
	if turnBudget <= 0 {
		return nil, fmt.Errorf("turn budget must be positive, got %d", turnBudget)
	}
	return s.createRoom(ctx, tenantID, goal, turnBudget)
}

func (s *PostgresStore) createRoom(ctx context.Context, tenantID, goal string, turnBudget int) (*Room, error) {
	id, err := resource.New("rom")
	if err != nil {
		return nil, err
	}

	r := &Room{
		ID:         id,
		TenantID:   tenantID,
		Goal:       goal,
		State:      StateOpen,
		CreatedAt:  time.Now().UTC(),
		TurnBudget: turnBudget,
	}
	if _, err := s.pool.Exec(
		ctx, `
		INSERT INTO rooms (id, tenant_id, goal, state, turn_budget, next_sequence, created_at)
		VALUES ($1, $2, $3, $4, $5, 1, $6)`,
		r.ID, r.TenantID, r.Goal, string(r.State), r.TurnBudget, r.CreatedAt,
	); err != nil {
		return nil, fmt.Errorf("room: create room: %w", err)
	}
	return r, nil
}

// AddMember implements the write half of Store.
func (s *PostgresStore) AddMember(ctx context.Context, tenantID, roomID, agentID, agentTenantID string, startingContext []string) (*Member, error) {
	id, err := resource.New("mem")
	if err != nil {
		return nil, err
	}

	m := &Member{
		ID:              id,
		AgentID:         agentID,
		JoinedAt:        time.Now().UTC(),
		StartingContext: append([]string(nil), startingContext...),
	}

	err = s.withTx(ctx, func(tx pgx.Tx) error {
		rl, err := s.lockRoom(ctx, tx, tenantID, roomID)
		if err != nil {
			return err
		}
		if rl.state != StateOpen {
			return ErrRoomTerminated
		}
		// The room row is already scoped to tenantID by lockRoom's WHERE
		// clause, so a room found under tenantID necessarily belongs to it —
		// this is purely the agent-tenant check.
		if agentTenantID != tenantID {
			return ErrTenantMismatch
		}

		if _, err := tx.Exec(
			ctx,
			`INSERT INTO room_members (id, room_id, tenant_id, agent_id, joined_at) VALUES ($1, $2, $3, $4, $5)`,
			m.ID, roomID, tenantID, m.AgentID, m.JoinedAt,
		); err != nil {
			return fmt.Errorf("room: insert member: %w", err)
		}

		return s.appendEventTx(ctx, tx, tenantID, roomID, rl.nextSequence, EventMemberJoined, MemberJoinedPayload{Member: m})
	})
	if err != nil {
		return nil, err
	}
	return cloneMember(m), nil
}

// AppendMessage implements the write half of Store.
func (s *PostgresStore) AppendMessage(ctx context.Context, tenantID, roomID, memberID, body string) (*Message, error) {
	id, err := resource.New("msg")
	if err != nil {
		return nil, err
	}

	m := &Message{ID: id, MemberID: memberID, Body: body, CreatedAt: time.Now().UTC()}

	// budgetErr carries ErrTurnBudgetExceeded out of the transaction below.
	// It is handled separately from the transaction's own return value
	// because that one case must still commit — the room's transition to
	// StateAbandoned has to be durable even though this particular message is
	// rejected — while every other rejection has written nothing and simply
	// rolls back.
	var budgetErr error
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		rl, err := s.lockRoom(ctx, tx, tenantID, roomID)
		if err != nil {
			return err
		}
		if postErr := s.canPostTx(ctx, tx, tenantID, roomID, rl, memberID); postErr != nil {
			if !errors.Is(postErr, ErrTurnBudgetExceeded) {
				return postErr
			}
			if err := s.abandonTx(ctx, tx, tenantID, roomID, rl); err != nil {
				return err
			}
			budgetErr = postErr
			return nil
		}

		return s.appendEventTx(ctx, tx, tenantID, roomID, rl.nextSequence, EventMessagePosted, MessagePostedPayload{Message: m})
	})
	if err != nil {
		return nil, err
	}
	if budgetErr != nil {
		return nil, budgetErr
	}
	return cloneMessage(m), nil
}

// CompleteRoom implements the write half of Store.
func (s *PostgresStore) CompleteRoom(ctx context.Context, tenantID, roomID string) (*Room, error) {
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		rl, err := s.lockRoom(ctx, tx, tenantID, roomID)
		if err != nil {
			return err
		}
		if rl.state != StateOpen {
			return ErrRoomTerminated
		}
		if _, err := tx.Exec(ctx, `UPDATE rooms SET state=$1 WHERE id=$2 AND tenant_id=$3`, string(StateCompleted), roomID, tenantID); err != nil {
			return fmt.Errorf("room: complete room: %w", err)
		}
		return s.appendEventTx(ctx, tx, tenantID, roomID, rl.nextSequence, EventRoomTerminated, RoomTerminatedPayload{State: StateCompleted})
	})
	if err != nil {
		return nil, err
	}
	return s.loadRoom(ctx, tenantID, roomID)
}

// RecordDeliveryFailure implements the write half of Store.
func (s *PostgresStore) RecordDeliveryFailure(ctx context.Context, tenantID, roomID, fromMemberID, toMemberID, toAgentID, class string) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		rl, err := s.lockRoom(ctx, tx, tenantID, roomID)
		if err != nil {
			return err
		}
		return s.appendEventTx(ctx, tx, tenantID, roomID, rl.nextSequence, EventDeliveryFailed, DeliveryFailedPayload{
			FromMemberID: fromMemberID,
			ToMemberID:   toMemberID,
			ToAgentID:    toAgentID,
			Class:        class,
		})
	})
}

// RecordDelivery implements the write half of Store.
func (s *PostgresStore) RecordDelivery(ctx context.Context, tenantID, roomID, fromMemberID, toMemberID, toAgentID, invocationID string) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		rl, err := s.lockRoom(ctx, tx, tenantID, roomID)
		if err != nil {
			return err
		}
		return s.appendEventTx(ctx, tx, tenantID, roomID, rl.nextSequence, EventMessageDelivered, MessageDeliveredPayload{
			FromMemberID: fromMemberID,
			ToMemberID:   toMemberID,
			ToAgentID:    toAgentID,
			InvocationID: invocationID,
		})
	})
}

// roomLock is what a write transaction reads from a rooms row locked FOR
// UPDATE: everything it needs to decide whether the write may proceed and
// where its event's sequence number comes from. Holding this lock for the
// rest of the transaction is what makes the turn-budget check and the
// sequence allocation atomic with respect to any other writer touching the
// same room — see appendEventTx.
type roomLock struct {
	state        State
	turnBudget   int
	nextSequence int
}

// lockRoom locks roomID's row FOR UPDATE inside tx, scoped to tenantID —
// enforcing tenant isolation the same way loadRoom's SELECT does — and
// returns the fields a write needs from it. It must be the first thing every
// write method does inside its transaction: canPostTx, appendEventTx, and
// the state checks in this file all depend on that lock being held for the
// rest of the transaction's life.
func (s *PostgresStore) lockRoom(ctx context.Context, tx pgx.Tx, tenantID, roomID string) (*roomLock, error) {
	var (
		rl    roomLock
		state string
	)
	err := tx.QueryRow(
		ctx,
		`SELECT state, turn_budget, next_sequence FROM rooms WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
		roomID, tenantID,
	).Scan(&state, &rl.turnBudget, &rl.nextSequence)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("room: lock room: %w", err)
	}
	rl.state = State(state)
	return &rl, nil
}

// canPostTx mirrors MemoryStore.canPost: memberID may post to roomID right
// now only if the room (already locked via rl) is open, memberID is seated
// in it, and the budget has room for one more turn. It reads inside the same
// transaction that holds the row lock rl came from, so nothing else can
// change the turn count between this check and the caller acting on it.
func (s *PostgresStore) canPostTx(ctx context.Context, tx pgx.Tx, tenantID, roomID string, rl *roomLock, memberID string) error {
	if rl.state != StateOpen {
		return ErrRoomTerminated
	}

	seated, err := s.memberSeatedTx(ctx, tx, tenantID, roomID, memberID)
	if err != nil {
		return err
	}
	if !seated {
		return ErrMemberNotFound
	}

	spent, err := s.turnsConsumedTx(ctx, tx, tenantID, roomID)
	if err != nil {
		return err
	}
	if spent+1 > rl.turnBudget {
		return ErrTurnBudgetExceeded
	}
	return nil
}

// abandonTx transitions the room to StateAbandoned and appends the
// terminating event, mirroring MemoryStore.abandonIfOutOfTurns. Caller must
// already hold the row lock rl came from.
func (s *PostgresStore) abandonTx(ctx context.Context, tx pgx.Tx, tenantID, roomID string, rl *roomLock) error {
	if _, err := tx.Exec(ctx, `UPDATE rooms SET state=$1 WHERE id=$2 AND tenant_id=$3`, string(StateAbandoned), roomID, tenantID); err != nil {
		return fmt.Errorf("room: abandon room: %w", err)
	}
	return s.appendEventTx(ctx, tx, tenantID, roomID, rl.nextSequence, EventRoomTerminated, RoomTerminatedPayload{State: StateAbandoned})
}

// memberSeatedTx reports whether memberID is seated in roomID under tenantID.
func (s *PostgresStore) memberSeatedTx(ctx context.Context, tx pgx.Tx, tenantID, roomID, memberID string) (bool, error) {
	var exists bool
	if err := tx.QueryRow(
		ctx,
		`SELECT EXISTS(SELECT 1 FROM room_members WHERE id=$1 AND room_id=$2 AND tenant_id=$3)`,
		memberID, roomID, tenantID,
	).Scan(&exists); err != nil {
		return false, fmt.Errorf("room: check member: %w", err)
	}
	return exists, nil
}

// turnsConsumedTx counts how many of roomID's turns its event log has already
// spent — posting a message is the only turn-consuming action, matching
// turnsConsumed in store.go.
func (s *PostgresStore) turnsConsumedTx(ctx context.Context, tx pgx.Tx, tenantID, roomID string) (int, error) {
	var n int
	if err := tx.QueryRow(
		ctx,
		`SELECT count(*) FROM room_events WHERE room_id=$1 AND tenant_id=$2 AND kind=$3`,
		roomID, tenantID, string(EventMessagePosted),
	).Scan(&n); err != nil {
		return 0, fmt.Errorf("room: count turns spent: %w", err)
	}
	return n, nil
}

// appendEventTx appends one event to roomID's log inside tx and advances
// rooms.next_sequence past it, using nextSeq — the value lockRoom read under
// the row lock — as the sequence number. Because that lock is held for the
// whole transaction, no concurrent writer can also be inserting at nextSeq:
// it is either still blocked waiting for the lock, or it already committed
// and this transaction would have read a higher next_sequence. That is what
// keeps sequence numbers contiguous across concurrent appends with no gaps
// and no duplicates, and what makes a rolled-back transaction leave no gap
// behind — the number it would have taken was never handed out, because
// next_sequence only advances on commit.
//
// The (room_id, sequence) primary key is the backstop if this invariant is
// ever violated by a bug: the insert fails with a unique-violation error
// rather than silently creating a duplicate or a gap. That error is returned
// to the caller unchanged — never swallowed — since the correct response to
// it is to retry the whole transaction, not to paper over it here.
func (s *PostgresStore) appendEventTx(ctx context.Context, tx pgx.Tx, tenantID, roomID string, nextSeq int, kind EventKind, payload any) error {
	ev := &Event{
		Sequence:  nextSeq,
		Kind:      kind,
		Timestamp: time.Now().UTC(),
		Payload:   payload,
	}
	data, err := MarshalEvent(ev)
	if err != nil {
		return fmt.Errorf("room: marshal event: %w", err)
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO room_events (room_id, tenant_id, sequence, kind, occurred_at, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
		roomID, tenantID, ev.Sequence, string(ev.Kind), ev.Timestamp, data,
	); err != nil {
		return fmt.Errorf("room: insert event: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE rooms SET next_sequence=$1 WHERE id=$2 AND tenant_id=$3`, nextSeq+1, roomID, tenantID); err != nil {
		return fmt.Errorf("room: advance sequence: %w", err)
	}
	return nil
}

// withTx runs fn inside a transaction: fn returning nil commits, fn
// returning an error rolls back and that error propagates to the caller of
// withTx unchanged.
func (s *PostgresStore) withTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("room: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op once committed

	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("room: commit: %w", err)
	}
	return nil
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
