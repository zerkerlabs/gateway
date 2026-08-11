//go:build integration

package room_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	roomsdb "github.com/zerkerlabs/gateway/rooms/db"
	"github.com/zerkerlabs/gateway/rooms/internal/resource"
	"github.com/zerkerlabs/gateway/rooms/internal/room"
)

const (
	tenantA = "tenant-alpha"
	tenantB = "tenant-beta"
)

// openTestPool opens a connection pool from TEST_DATABASE_URL and runs
// migrations. It returns the pool and registers cleanup via t.Cleanup.
func openTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration tests")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping postgres: %v", err)
	}
	if err := roomsdb.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	if _, err := pool.Exec(ctx, `TRUNCATE TABLE rooms CASCADE`); err != nil {
		t.Fatalf("truncate rooms: %v", err)
	}

	return pool
}

// newPGStore returns a PostgresStore backed by a freshly migrated database.
func newPGStore(t *testing.T) (*room.PostgresStore, *pgxpool.Pool) {
	t.Helper()
	pool := openTestPool(t)
	return room.NewPostgresStore(pool), pool
}

// The write half of Store (CreateRoom, AddMember, AppendMessage, ...) is a
// separate, not-yet-implemented piece of work, so these tests seed rooms,
// members, and events with direct SQL rather than through a Store. That is
// also what makes them a faithful read-path test: they prove PostgresStore
// reconstructs a room from exactly the rows a writer would have left behind,
// not from some shortcut only its own writer would produce.

// seedRoom inserts a room row directly and returns the *room.Room the row
// describes.
func seedRoom(t *testing.T, pool *pgxpool.Pool, tenantID, goal string, turnBudget int) *room.Room {
	t.Helper()

	id, err := resource.New("rom")
	if err != nil {
		t.Fatalf("resource.New(rom): %v", err)
	}
	createdAt := time.Now().UTC()

	_, err = pool.Exec(
		context.Background(), `
		INSERT INTO rooms (id, tenant_id, goal, state, turn_budget, next_sequence, created_at)
		VALUES ($1, $2, $3, 'open', $4, 1, $5)`,
		id, tenantID, goal, turnBudget, createdAt,
	)
	if err != nil {
		t.Fatalf("insert room: %v", err)
	}

	return &room.Room{
		ID:         id,
		TenantID:   tenantID,
		Goal:       goal,
		State:      room.StateOpen,
		TurnBudget: turnBudget,
		CreatedAt:  createdAt,
	}
}

// seedMember inserts a room_members row directly and returns the resulting
// *room.Member.
func seedMember(t *testing.T, pool *pgxpool.Pool, tenantID, roomID, agentID string) *room.Member {
	t.Helper()

	id, err := resource.New("mem")
	if err != nil {
		t.Fatalf("resource.New(mem): %v", err)
	}
	joinedAt := time.Now().UTC()

	_, err = pool.Exec(
		context.Background(), `
		INSERT INTO room_members (id, room_id, tenant_id, agent_id, joined_at)
		VALUES ($1, $2, $3, $4, $5)`,
		id, roomID, tenantID, agentID, joinedAt,
	)
	if err != nil {
		t.Fatalf("insert member: %v", err)
	}

	return &room.Member{ID: id, AgentID: agentID, JoinedAt: joinedAt}
}

// seedEvent inserts a room_events row directly, encoding ev the same way a
// writer would with room.MarshalEvent.
func seedEvent(t *testing.T, pool *pgxpool.Pool, tenantID, roomID string, ev *room.Event) {
	t.Helper()

	payload, err := room.MarshalEvent(ev)
	if err != nil {
		t.Fatalf("MarshalEvent: %v", err)
	}

	_, err = pool.Exec(
		context.Background(), `
		INSERT INTO room_events (room_id, tenant_id, sequence, kind, occurred_at, payload)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		roomID, tenantID, ev.Sequence, string(ev.Kind), ev.Timestamp, payload,
	)
	if err != nil {
		t.Fatalf("insert event: %v", err)
	}
}

// seedRawEvent inserts a room_events row with a raw, pre-encoded payload —
// used to plant a row from a future writer this build does not understand.
func seedRawEvent(t *testing.T, pool *pgxpool.Pool, tenantID, roomID string, sequence int, kind string, payload []byte) {
	t.Helper()

	_, err := pool.Exec(
		context.Background(), `
		INSERT INTO room_events (room_id, tenant_id, sequence, kind, occurred_at, payload)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		roomID, tenantID, sequence, kind, time.Now().UTC(), payload,
	)
	if err != nil {
		t.Fatalf("insert raw event: %v", err)
	}
}

func messagePostedEvent(t *testing.T, seq int, member *room.Member, body string) *room.Event {
	t.Helper()

	msgID, err := resource.New("msg")
	if err != nil {
		t.Fatalf("resource.New(msg): %v", err)
	}
	return &room.Event{
		Sequence:  seq,
		Kind:      room.EventMessagePosted,
		Timestamp: time.Now().UTC(),
		Payload: room.MessagePostedPayload{
			Message: &room.Message{
				ID:        msgID,
				MemberID:  member.ID,
				Body:      body,
				CreatedAt: time.Now().UTC(),
			},
		},
	}
}

func memberJoinedEvent(seq int, member *room.Member) *room.Event {
	return &room.Event{
		Sequence:  seq,
		Kind:      room.EventMemberJoined,
		Timestamp: member.JoinedAt,
		Payload:   room.MemberJoinedPayload{Member: member},
	}
}

// ---------------------------------------------------------------- GetRoom ---

func TestPG_GetRoom_RoundTrip(t *testing.T) {
	s, pool := newPGStore(t)
	r := seedRoom(t, pool, tenantA, "ship the thing", 10)
	member := seedMember(t, pool, tenantA, r.ID, "agt_1")
	seedEvent(t, pool, tenantA, r.ID, memberJoinedEvent(1, member))

	got, err := s.GetRoom(context.Background(), tenantA, r.ID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if got.ID != r.ID || got.TenantID != tenantA || got.Goal != r.Goal {
		t.Errorf("got %+v, want fields matching %+v", got, r)
	}
	if got.State != room.StateOpen {
		t.Errorf("State = %q, want %q", got.State, room.StateOpen)
	}
	if got.TurnBudget != 10 {
		t.Errorf("TurnBudget = %d, want 10", got.TurnBudget)
	}
	if len(got.Members) != 1 || got.Members[0].ID != member.ID {
		t.Fatalf("Members = %+v, want [%s]", got.Members, member.ID)
	}
	if len(got.Events) != 1 || got.Events[0].Kind != room.EventMemberJoined {
		t.Fatalf("Events = %+v, want one member_joined event", got.Events)
	}
}

func TestPG_GetRoom_UnknownID(t *testing.T) {
	s, _ := newPGStore(t)

	_, err := s.GetRoom(context.Background(), tenantA, "rom_nonexistent")
	if !errors.Is(err, room.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestPG_GetRoom_CrossTenantBlocked(t *testing.T) {
	s, pool := newPGStore(t)
	r := seedRoom(t, pool, tenantA, "secret", 10)

	_, err := s.GetRoom(context.Background(), tenantB, r.ID)
	if !errors.Is(err, room.ErrNotFound) {
		t.Errorf("cross-tenant GetRoom: err = %v, want ErrNotFound", err)
	}
}

// -------------------------------------------------------------- ListRooms ---

func TestPG_ListRooms_TenantScopedNewestFirst(t *testing.T) {
	s, pool := newPGStore(t)

	a1 := seedRoom(t, pool, tenantA, "a1", 10)
	time.Sleep(2 * time.Millisecond) // created_at must strictly increase between rows
	a2 := seedRoom(t, pool, tenantA, "a2", 10)
	seedRoom(t, pool, tenantB, "b1", 10)

	got, err := s.ListRooms(context.Background(), tenantA)
	if err != nil {
		t.Fatalf("ListRooms: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(got) = %d, want 2", len(got))
	}
	if got[0].ID != a2.ID || got[1].ID != a1.ID {
		t.Errorf("got = [%s, %s], want newest first [%s, %s]", got[0].ID, got[1].ID, a2.ID, a1.ID)
	}
}

func TestPG_ListRooms_Empty(t *testing.T) {
	s, _ := newPGStore(t)

	got, err := s.ListRooms(context.Background(), tenantA)
	if err != nil {
		t.Fatalf("ListRooms: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("len(got) = %d, want 0", len(got))
	}
}

// -------------------------------------------------------------- Messages ---

func TestPG_Messages_ReplaysTranscriptFromEvents(t *testing.T) {
	s, pool := newPGStore(t)
	r := seedRoom(t, pool, tenantA, "goal", 10)
	member := seedMember(t, pool, tenantA, r.ID, "agt_1")

	seedEvent(t, pool, tenantA, r.ID, memberJoinedEvent(1, member))
	m1 := messagePostedEvent(2, member, "first")
	m2 := messagePostedEvent(3, member, "second")
	seedEvent(t, pool, tenantA, r.ID, m1)
	seedEvent(t, pool, tenantA, r.ID, m2)

	got, err := s.Messages(context.Background(), tenantA, r.ID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(got) = %d, want 2", len(got))
	}
	if got[0].Body != "first" || got[1].Body != "second" {
		t.Errorf("got bodies = [%q, %q], want [first, second]", got[0].Body, got[1].Body)
	}
}

func TestPG_Messages_CrossTenantBlocked(t *testing.T) {
	s, pool := newPGStore(t)
	r := seedRoom(t, pool, tenantA, "goal", 10)

	_, err := s.Messages(context.Background(), tenantB, r.ID)
	if !errors.Is(err, room.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

// ----------------------------------------------------------------- Events ---

func TestPG_Events_SequenceOrder(t *testing.T) {
	s, pool := newPGStore(t)
	r := seedRoom(t, pool, tenantA, "goal", 10)
	member := seedMember(t, pool, tenantA, r.ID, "agt_1")

	seedEvent(t, pool, tenantA, r.ID, memberJoinedEvent(1, member))
	seedEvent(t, pool, tenantA, r.ID, messagePostedEvent(2, member, "hello"))

	got, err := s.Events(context.Background(), tenantA, r.ID)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(got) = %d, want 2", len(got))
	}
	if got[0].Sequence != 1 || got[0].Kind != room.EventMemberJoined {
		t.Errorf("got[0] = %+v, want sequence 1 member_joined", got[0])
	}
	if got[1].Sequence != 2 || got[1].Kind != room.EventMessagePosted {
		t.Errorf("got[1] = %+v, want sequence 2 message_posted", got[1])
	}
}

// TestPG_Events_UnknownKindSkippedNotFatal proves an unrecognized event row —
// the kind a newer writer left behind — is skipped during replay instead of
// failing the whole room, per the serialization layer's forward-compatibility
// guarantee (event_codec.go).
func TestPG_Events_UnknownKindSkippedNotFatal(t *testing.T) {
	s, pool := newPGStore(t)
	r := seedRoom(t, pool, tenantA, "goal", 10)
	member := seedMember(t, pool, tenantA, r.ID, "agt_1")

	seedEvent(t, pool, tenantA, r.ID, memberJoinedEvent(1, member))
	seedRawEvent(t, pool, tenantA, r.ID, 2, "member_teleported",
		[]byte(`{"sequence":2,"kind":"member_teleported","timestamp":"2026-08-10T12:00:00Z","payload_version":1,"payload":{}}`))
	seedEvent(t, pool, tenantA, r.ID, messagePostedEvent(3, member, "still here"))

	got, err := s.Events(context.Background(), tenantA, r.ID)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(got) = %d, want 2 (unknown kind skipped)", len(got))
	}
	if got[0].Kind != room.EventMemberJoined || got[1].Kind != room.EventMessagePosted {
		t.Errorf("got kinds = [%q, %q], want [member_joined, message_posted]", got[0].Kind, got[1].Kind)
	}

	msgs, err := s.Messages(context.Background(), tenantA, r.ID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 1 || msgs[0].Body != "still here" {
		t.Fatalf("Messages = %+v, want one message despite the unknown row", msgs)
	}
}

func TestPG_Events_CrossTenantBlocked(t *testing.T) {
	s, pool := newPGStore(t)
	r := seedRoom(t, pool, tenantA, "goal", 10)

	_, err := s.Events(context.Background(), tenantB, r.ID)
	if !errors.Is(err, room.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

// ---------------------------------------------------------- MemberAgentID ---

func TestPG_MemberAgentID_ResolvesSeatedMember(t *testing.T) {
	s, pool := newPGStore(t)
	r := seedRoom(t, pool, tenantA, "goal", 10)
	member := seedMember(t, pool, tenantA, r.ID, "agt_1")

	got, err := s.MemberAgentID(context.Background(), tenantA, r.ID, member.ID)
	if err != nil {
		t.Fatalf("MemberAgentID: %v", err)
	}
	if got != "agt_1" {
		t.Errorf("got = %q, want agt_1", got)
	}
}

func TestPG_MemberAgentID_UnknownMember(t *testing.T) {
	s, pool := newPGStore(t)
	r := seedRoom(t, pool, tenantA, "goal", 10)

	_, err := s.MemberAgentID(context.Background(), tenantA, r.ID, "mem_nope")
	if !errors.Is(err, room.ErrMemberNotFound) {
		t.Errorf("err = %v, want ErrMemberNotFound", err)
	}
}

func TestPG_MemberAgentID_CrossTenantBlocked(t *testing.T) {
	s, pool := newPGStore(t)
	r := seedRoom(t, pool, tenantA, "goal", 10)
	member := seedMember(t, pool, tenantA, r.ID, "agt_1")

	_, err := s.MemberAgentID(context.Background(), tenantB, r.ID, member.ID)
	if !errors.Is(err, room.ErrNotFound) {
		t.Errorf("cross-tenant MemberAgentID: err = %v, want ErrNotFound", err)
	}
}

// ------------------------------------------------------------ turn budget ---

// TestPG_TurnAccountingMatchesMemoryStore builds the identical room, member,
// and event log through MemoryStore, persists that exact log directly (the
// write path is a separate ticket), and asserts PostgresStore's replay
// reproduces the same transcript and the same count of turns spent — the
// acceptance bar for "a room with N turns spent reports N turns spent after
// being loaded from Postgres."
func TestPG_TurnAccountingMatchesMemoryStore(t *testing.T) {
	ctx := context.Background()
	s, pool := newPGStore(t)

	mem := room.NewMemoryStore()
	const turnBudget = 5
	const turnsSpent = 3

	memRoom, err := mem.CreateRoomWithBudget(ctx, tenantA, "goal", turnBudget)
	if err != nil {
		t.Fatalf("CreateRoomWithBudget: %v", err)
	}
	memMember, err := mem.AddMember(ctx, tenantA, memRoom.ID, "agt_1", tenantA, nil)
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	for i := range turnsSpent {
		if _, err := mem.AppendMessage(ctx, tenantA, memRoom.ID, memMember.ID, "msg"); err != nil {
			t.Fatalf("AppendMessage %d: %v", i, err)
		}
	}

	wantMessages, err := mem.Messages(ctx, tenantA, memRoom.ID)
	if err != nil {
		t.Fatalf("mem.Messages: %v", err)
	}
	wantEvents, err := mem.Events(ctx, tenantA, memRoom.ID)
	if err != nil {
		t.Fatalf("mem.Events: %v", err)
	}

	// Persist the identical room, member, and event log directly — memRoom's
	// own ID and fields, not a freshly minted seedRoom row.
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO rooms (id, tenant_id, goal, state, turn_budget, next_sequence, created_at)
		 VALUES ($1, $2, $3, $4, $5, 1, $6)`,
		memRoom.ID, tenantA, memRoom.Goal, string(memRoom.State), turnBudget, memRoom.CreatedAt,
	); err != nil {
		t.Fatalf("insert room: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO room_members (id, room_id, tenant_id, agent_id, joined_at) VALUES ($1, $2, $3, $4, $5)`,
		memMember.ID, memRoom.ID, tenantA, memMember.AgentID, memMember.JoinedAt,
	); err != nil {
		t.Fatalf("insert member: %v", err)
	}
	for _, ev := range wantEvents {
		seedEvent(t, pool, tenantA, memRoom.ID, ev)
	}

	gotRoom, err := s.GetRoom(ctx, tenantA, memRoom.ID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if gotRoom.TurnBudget != turnBudget {
		t.Errorf("TurnBudget = %d, want %d", gotRoom.TurnBudget, turnBudget)
	}

	gotMessages, err := s.Messages(ctx, tenantA, memRoom.ID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(gotMessages) != len(wantMessages) {
		t.Fatalf("len(gotMessages) = %d, want %d", len(gotMessages), len(wantMessages))
	}
	if len(gotMessages) != turnsSpent {
		t.Fatalf("len(gotMessages) = %d, want %d turns spent", len(gotMessages), turnsSpent)
	}

	gotEvents, err := s.Events(ctx, tenantA, memRoom.ID)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	spent := 0
	for _, ev := range gotEvents {
		if ev.Kind == room.EventMessagePosted {
			spent++
		}
	}
	if spent != turnsSpent {
		t.Errorf("turns spent (from replayed Events) = %d, want %d", spent, turnsSpent)
	}
}
