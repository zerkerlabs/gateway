//go:build integration

package room_test

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"sync"
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

// These read-path tests seed rooms, members, and events with direct SQL
// rather than through a Store, even though the write half of Store
// (CreateRoom, AddMember, AppendMessage, ...) is implemented further down in
// this file. That is deliberate, not an oversight: seeding independently of
// PostgresStore's own writer is what makes this a faithful read-path test —
// it proves PostgresStore reconstructs a room from exactly the rows *any*
// writer would have left behind, not from some shortcut only its own writer
// produces.

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
	return seedMemberAt(t, pool, tenantID, roomID, agentID, time.Now().UTC())
}

// seedMemberAt is seedMember with an explicit joined_at, so a test can insert
// members in an order that differs from the order they joined in.
func seedMemberAt(t *testing.T, pool *pgxpool.Pool, tenantID, roomID, agentID string, joinedAt time.Time) *room.Member {
	t.Helper()

	id, err := resource.New("mem")
	if err != nil {
		t.Fatalf("resource.New(mem): %v", err)
	}

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

// TestPG_GetRoom_MembersInJoinOrder proves loadMembers' ORDER BY actually
// orders, rather than the rows happening to come back the way they went in.
// The three members are INSERTed in an order deliberately unrelated to their
// joined_at, so a query with no ORDER BY — or one ordering by id — would fail
// this.
func TestPG_GetRoom_MembersInJoinOrder(t *testing.T) {
	s, pool := newPGStore(t)
	r := seedRoom(t, pool, tenantA, "goal", 10)

	base := time.Now().UTC().Truncate(time.Millisecond)

	// Insert middle, then last, then first.
	second := seedMemberAt(t, pool, tenantA, r.ID, "agt_second", base.Add(2*time.Second))
	third := seedMemberAt(t, pool, tenantA, r.ID, "agt_third", base.Add(3*time.Second))
	first := seedMemberAt(t, pool, tenantA, r.ID, "agt_first", base.Add(1*time.Second))

	got, err := s.GetRoom(context.Background(), tenantA, r.ID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if len(got.Members) != 3 {
		t.Fatalf("len(Members) = %d, want 3", len(got.Members))
	}

	want := []string{first.ID, second.ID, third.ID}
	for i, wantID := range want {
		if got.Members[i].ID != wantID {
			gotIDs := make([]string, len(got.Members))
			for j, m := range got.Members {
				gotIDs[j] = m.AgentID
			}
			t.Fatalf("Members in %v, want join order [agt_first agt_second agt_third]", gotIDs)
		}
	}
}

// -------------------------------------------------------------- Messages ---

func TestPG_Messages_ReplaysTranscriptFromEvents(t *testing.T) {
	s, pool := newPGStore(t)
	r := seedRoom(t, pool, tenantA, "goal", 10)
	member := seedMember(t, pool, tenantA, r.ID, "agt_1")

	seedEvent(t, pool, tenantA, r.ID, memberJoinedEvent(1, member))
	m1 := messagePostedEvent(t, 2, member, "first")
	m2 := messagePostedEvent(t, 3, member, "second")
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
	seedEvent(t, pool, tenantA, r.ID, messagePostedEvent(t, 2, member, "hello"))

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
	seedEvent(t, pool, tenantA, r.ID, messagePostedEvent(t, 3, member, "still here"))

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
	memMember, err := mem.AddMember(ctx, tenantA, memRoom.ID, "agt_1", tenantA, nil, nil, room.ContextCommitment{})
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

// ============================================================================
// Write path. Unlike the read-path tests above, these exercise PostgresStore
// through the Store methods themselves rather than seeding rows with direct
// SQL — CreateRoom, AddMember, AppendMessage, CompleteRoom,
// RecordDeliveryFailure, and RecordDelivery are what this file now proves.
// These tests call PostgresStore's concrete methods directly rather than
// running roomtest.RunContract. That is no longer because it cannot satisfy
// room.Store — ReserveTurn/CommitTurn/ReleaseTurn are implemented above and
// the compile-time assertion in zz_iface_check_test.go passes. It is because
// the shared suite calls newStore() per behaviour expecting a clean store,
// across subtests that run in parallel, while every test here isolates by
// TRUNCATE-ing shared tables in one database. Pointing the suite at Postgres
// as-is would have parallel subtests truncating rows out from under each
// other — not flakiness, guaranteed mutual destruction.
//
// Closing that gap needs real per-call isolation (a schema per store, in
// which case the suite's parallelism can stay untouched), which is a change
// to how this package's tests get a database and is tracked as its own piece
// of work. Until then, interface conformance is proven but behavioural
// equivalence with MemoryStore is not.
// ============================================================================

// -------------------------------------------------------------- CreateRoom ---

func TestPG_CreateRoom_RoundTrip(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()

	r, err := s.CreateRoom(ctx, tenantA, "ship the thing")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	if !strings.HasPrefix(r.ID, "rom_") {
		t.Errorf("ID %q does not start with rom_", r.ID)
	}
	if r.State != room.StateOpen {
		t.Errorf("State = %q, want %q", r.State, room.StateOpen)
	}
	if r.TurnBudget != room.DefaultTurnBudget {
		t.Errorf("TurnBudget = %d, want default %d", r.TurnBudget, room.DefaultTurnBudget)
	}

	got, err := s.GetRoom(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if got.ID != r.ID || got.Goal != r.Goal || len(got.Members) != 0 || len(got.Events) != 0 {
		t.Errorf("got %+v, want a freshly created room matching %+v", got, r)
	}
}

func TestPG_CreateRoomWithBudget_RejectsNonPositive(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()

	for _, budget := range []int{0, -1} {
		if _, err := s.CreateRoomWithBudget(ctx, tenantA, "goal", budget); err == nil {
			t.Errorf("CreateRoomWithBudget(%d): err = nil, want error for non-positive turn budget", budget)
		}
	}
}

// -------------------------------------------------------------- AddMember ---

func TestPG_AddMember_RoundTrip(t *testing.T) {
	s, pool := newPGStore(t)
	ctx := context.Background()

	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}

	m, err := s.AddMember(ctx, tenantA, r.ID, "agt_1", tenantA, []string{"admitted memory"}, []string{"onboarding doc"}, room.ContextCommitment{})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if !strings.HasPrefix(m.ID, "mem_") {
		t.Errorf("ID %q does not start with mem_", m.ID)
	}

	got, err := s.GetRoom(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if len(got.Members) != 1 || got.Members[0].ID != m.ID {
		t.Fatalf("Members = %+v, want [%s]", got.Members, m.ID)
	}
	if len(got.Events) != 1 || got.Events[0].Kind != room.EventMemberJoined {
		t.Fatalf("Events = %+v, want a single member_joined event", got.Events)
	}

	// tenant_id must be copied onto the child row from the parent room, not
	// merely enforced by the query that reads it back.
	var tenantID string
	if err := pool.QueryRow(ctx, `SELECT tenant_id FROM room_members WHERE id=$1`, m.ID).Scan(&tenantID); err != nil {
		t.Fatalf("select room_members.tenant_id: %v", err)
	}
	if tenantID != tenantA {
		t.Errorf("room_members.tenant_id = %q, want %q", tenantID, tenantA)
	}
}

// TestPG_AddMember_ContextCommitmentPersistedNotContent is the acceptance
// check for the member_joined payload shape end to end against Postgres: a
// member's onboarding content — admitted memory and caller documents alike —
// stays live in the process that added it, but only its commitment — a
// digest, a state, and admitted/withheld/dropped counts — is ever written to
// room_events. Replaying the room afterward (a fresh GetRoom, which reloads
// from room_members and room_events rather than any in-process state) must
// reproduce that commitment without the content, and must mark the reloaded
// member's context as not replayable rather than leaving it indistinguishable
// from a member who joined with none. It also asserts the two kinds of
// onboarding content stay distinguishable through every layer they pass
// through, not just combined into one dropped blob.
func TestPG_AddMember_ContextCommitmentPersistedNotContent(t *testing.T) {
	s, pool := newPGStore(t)
	ctx := context.Background()

	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}

	commitment := room.ContextCommitment{
		Digest:        "sha256:" + strings.Repeat("ab", 32),
		State:         "partial",
		Retrieved:     4,
		Admitted:      2,
		Withheld:      1,
		BudgetDropped: 3,
		Reasons:       []string{"policy_withheld", "budget"},
	}
	m, err := s.AddMember(ctx, tenantA, r.ID, "agt_1", tenantA,
		[]string{sentinelOnboardingContext}, []string{sentinelCallerDocument}, commitment)
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	// Live, in-process: the member returned by AddMember itself still carries
	// its real onboarding content, admitted memory and caller documents kept
	// apart in their own fields.
	if len(m.AdmittedMemory) != 1 || m.AdmittedMemory[0] != sentinelOnboardingContext {
		t.Fatalf("live AdmittedMemory = %v, want [%q]", m.AdmittedMemory, sentinelOnboardingContext)
	}
	if len(m.CallerDocuments) != 1 || m.CallerDocuments[0] != sentinelCallerDocument {
		t.Fatalf("live CallerDocuments = %v, want [%q]", m.CallerDocuments, sentinelCallerDocument)
	}
	if !m.ContextReplayable {
		t.Error("live member ContextReplayable = false, want true")
	}

	// The raw persisted payload must never contain either sentinel, only the
	// commitment.
	var payload []byte
	if err := pool.QueryRow(ctx, `SELECT payload FROM room_events WHERE room_id=$1 AND kind='member_joined'`, r.ID).Scan(&payload); err != nil {
		t.Fatalf("select room_events.payload: %v", err)
	}
	if strings.Contains(string(payload), sentinelOnboardingContext) {
		t.Fatalf("room_events.payload contains the admitted-memory sentinel: %s", payload)
	}
	if strings.Contains(string(payload), sentinelCallerDocument) {
		t.Fatalf("room_events.payload contains the caller-document sentinel: %s", payload)
	}
	if !strings.Contains(string(payload), commitment.Digest) {
		t.Errorf("room_events.payload missing the commitment digest: %s", payload)
	}

	// Replaying the room — a fresh GetRoom, sourced from room_members and
	// room_events rather than any in-process state — must reproduce the
	// commitment counts without the content, and mark the context as not
	// replayable.
	got, err := s.GetRoom(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if len(got.Members) != 1 {
		t.Fatalf("Members = %+v, want 1", got.Members)
	}
	replayed := got.Members[0]
	if len(replayed.AdmittedMemory) != 0 {
		t.Errorf("replayed AdmittedMemory = %v, want empty", replayed.AdmittedMemory)
	}
	if len(replayed.CallerDocuments) != 0 {
		t.Errorf("replayed CallerDocuments = %v, want empty", replayed.CallerDocuments)
	}
	if replayed.ContextReplayable {
		t.Error("replayed member ContextReplayable = true, want false")
	}
	if !reflect.DeepEqual(replayed.Context, commitment) {
		t.Errorf("replayed Context = %+v, want %+v", replayed.Context, commitment)
	}
}

func TestPG_AddMember_CrossTenantAgentRejected(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}

	if _, err := s.AddMember(ctx, tenantA, r.ID, "agt_1", tenantB, nil, nil, room.ContextCommitment{}); !errors.Is(err, room.ErrTenantMismatch) {
		t.Errorf("err = %v, want ErrTenantMismatch", err)
	}

	got, err := s.GetRoom(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if len(got.Members) != 0 {
		t.Errorf("Members = %v, want empty after rejected add", got.Members)
	}
}

func TestPG_AddMember_CrossTenantRoomNotFound(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}

	if _, err := s.AddMember(ctx, tenantB, r.ID, "agt_1", tenantB, nil, nil, room.ContextCommitment{}); !errors.Is(err, room.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestPG_AddMember_TerminatedRoomRejected(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	if _, err := s.CompleteRoom(ctx, tenantA, r.ID); err != nil {
		t.Fatalf("CompleteRoom: %v", err)
	}

	if _, err := s.AddMember(ctx, tenantA, r.ID, "agt_late", tenantA, nil, nil, room.ContextCommitment{}); !errors.Is(err, room.ErrRoomTerminated) {
		t.Errorf("err = %v, want ErrRoomTerminated", err)
	}
}

func TestPG_AddMember_DuplicateAgentRejected(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}

	if _, err := s.AddMember(ctx, tenantA, r.ID, "agt_1", tenantA, nil, nil, room.ContextCommitment{}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	if _, err := s.AddMember(ctx, tenantA, r.ID, "agt_1", tenantA, nil, nil, room.ContextCommitment{}); !errors.Is(err, room.ErrAlreadyMember) {
		t.Errorf("err = %v, want ErrAlreadyMember", err)
	}

	got, err := s.GetRoom(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if len(got.Members) != 1 {
		t.Errorf("Members = %v, want exactly 1 after rejected duplicate add", got.Members)
	}
}

// ----------------------------------------------------------- AppendMessage ---

func TestPG_AppendMessage_RoundTrip(t *testing.T) {
	s, pool := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	member, err := s.AddMember(ctx, tenantA, r.ID, "agt_1", tenantA, nil, nil, room.ContextCommitment{})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	msg, err := s.AppendMessage(ctx, tenantA, r.ID, member.ID, "hello")
	if err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}
	if !strings.HasPrefix(msg.ID, "msg_") || msg.MemberID != member.ID || msg.Body != "hello" {
		t.Errorf("msg = %+v, want ID prefix msg_, MemberID %q, Body %q", msg, member.ID, "hello")
	}

	msgs, err := s.Messages(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 1 || msgs[0].ID != msg.ID {
		t.Fatalf("Messages = %+v, want [%s]", msgs, msg.ID)
	}

	var tenantID string
	var seq int
	if err := pool.QueryRow(ctx, `SELECT tenant_id, sequence FROM room_events WHERE room_id=$1 AND kind='message_posted'`, r.ID).Scan(&tenantID, &seq); err != nil {
		t.Fatalf("select room_events row: %v", err)
	}
	if tenantID != tenantA {
		t.Errorf("room_events.tenant_id = %q, want %q", tenantID, tenantA)
	}
	if seq != 2 { // 1 is the member_joined event
		t.Errorf("room_events.sequence = %d, want 2", seq)
	}
}

func TestPG_AppendMessage_CrossTenantBlocked(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}

	if _, err := s.AppendMessage(ctx, tenantB, r.ID, "mem_1", "hello"); !errors.Is(err, room.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestPG_AppendMessage_UnknownMemberRejected(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}

	if _, err := s.AppendMessage(ctx, tenantA, r.ID, "mem_nope", "hello"); !errors.Is(err, room.ErrMemberNotFound) {
		t.Errorf("err = %v, want ErrMemberNotFound", err)
	}
}

func TestPG_AppendMessage_MemberFromAnotherRoomRejected(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r1, err := s.CreateRoom(ctx, tenantA, "first")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	r2, err := s.CreateRoom(ctx, tenantA, "second")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	member, err := s.AddMember(ctx, tenantA, r1.ID, "agt_1", tenantA, nil, nil, room.ContextCommitment{})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	if _, err := s.AppendMessage(ctx, tenantA, r2.ID, member.ID, "hello"); !errors.Is(err, room.ErrMemberNotFound) {
		t.Errorf("err = %v, want ErrMemberNotFound", err)
	}
}

func TestPG_AppendMessage_TerminatedRoomRejected(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	if _, err := s.CompleteRoom(ctx, tenantA, r.ID); err != nil {
		t.Fatalf("CompleteRoom: %v", err)
	}

	if _, err := s.AppendMessage(ctx, tenantA, r.ID, "mem_whoever", "too late"); !errors.Is(err, room.ErrRoomTerminated) {
		t.Errorf("err = %v, want ErrRoomTerminated", err)
	}
}

// TestPG_AppendMessage_TurnBudgetExhaustionAbandonsRoom proves the
// turn-budget invariant survives the move from an in-process mutex to a
// Postgres transaction: exceeding the budget rejects the message, transitions
// the room to abandoned, and records that transition as an event — matching
// MemoryStore's behavior exactly (roomtest.testAppendMessageTurnBudgetExhaustionAbandonsRoom).
func TestPG_AppendMessage_TurnBudgetExhaustionAbandonsRoom(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	const budget = 2

	r, err := s.CreateRoomWithBudget(ctx, tenantA, "goal", budget)
	if err != nil {
		t.Fatalf("CreateRoomWithBudget: %v", err)
	}
	member, err := s.AddMember(ctx, tenantA, r.ID, "agt_1", tenantA, nil, nil, room.ContextCommitment{})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	for i := range budget {
		if _, err := s.AppendMessage(ctx, tenantA, r.ID, member.ID, "msg"); err != nil {
			t.Fatalf("AppendMessage %d: %v", i, err)
		}
	}

	_, err = s.AppendMessage(ctx, tenantA, r.ID, member.ID, "one too many")
	if !errors.Is(err, room.ErrTurnBudgetExceeded) {
		t.Fatalf("err = %v, want ErrTurnBudgetExceeded", err)
	}

	got, err := s.GetRoom(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if got.State != room.StateAbandoned {
		t.Fatalf("State = %q, want %q", got.State, room.StateAbandoned)
	}

	msgs, err := s.Messages(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != budget {
		t.Fatalf("len(msgs) = %d, want %d (the over-budget message must not be recorded)", len(msgs), budget)
	}

	last := got.Events[len(got.Events)-1]
	if last.Kind != room.EventRoomTerminated {
		t.Fatalf("last event kind = %q, want %q", last.Kind, room.EventRoomTerminated)
	}
	payload, ok := last.Payload.(room.RoomTerminatedPayload)
	if !ok || payload.State != room.StateAbandoned {
		t.Errorf("last event payload = %+v, want RoomTerminatedPayload{State: abandoned}", last.Payload)
	}
}

// TestPG_AppendMessage_ConcurrentSequencesContiguous races N concurrent
// AppendMessage calls against one room and asserts the resulting event
// sequence numbers are exactly 1..N+1 (the member-joined event plus N
// messages) with no gaps and no duplicates — proof that allocating a room's
// next_sequence from a row lock inside the same transaction as the insert
// serializes concurrent writers correctly. Run with -race (integration-test
// does).
func TestPG_AppendMessage_ConcurrentSequencesContiguous(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	const n = 25

	r, err := s.CreateRoomWithBudget(ctx, tenantA, "goal", n)
	if err != nil {
		t.Fatalf("CreateRoomWithBudget: %v", err)
	}
	member, err := s.AddMember(ctx, tenantA, r.ID, "agt_1", tenantA, nil, nil, room.ContextCommitment{})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	var wg sync.WaitGroup
	wg.Add(n)
	for i := range n {
		go func(i int) {
			defer wg.Done()
			if _, err := s.AppendMessage(ctx, tenantA, r.ID, member.ID, "msg"); err != nil {
				t.Errorf("AppendMessage %d: %v", i, err)
			}
		}(i)
	}
	wg.Wait()

	events, err := s.Events(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	want := n + 1 // 1 member_joined + n message_posted
	if len(events) != want {
		t.Fatalf("len(events) = %d, want %d", len(events), want)
	}

	seqs := make(map[int]bool, len(events))
	for _, ev := range events {
		if seqs[ev.Sequence] {
			t.Fatalf("duplicate sequence number: %d", ev.Sequence)
		}
		seqs[ev.Sequence] = true
	}
	for i := 1; i <= want; i++ {
		if !seqs[i] {
			t.Errorf("missing sequence number %d", i)
		}
	}
}

// TestPG_AppendMessage_ConcurrentPostsWithOneTurnLeft races concurrent posts
// against a room with exactly one turn left and asserts exactly one succeeds
// — the turn-budget invariant, which store.go's doc comment states as "a
// reserved turn counts against its room's budget exactly like a posted
// message does, so two concurrent posts can never spend the same last turn",
// translated from an in-process mutex to a transactional row lock.
func TestPG_AppendMessage_ConcurrentPostsWithOneTurnLeft(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	const n = 8

	r, err := s.CreateRoomWithBudget(ctx, tenantA, "goal", 1)
	if err != nil {
		t.Fatalf("CreateRoomWithBudget: %v", err)
	}
	member, err := s.AddMember(ctx, tenantA, r.ID, "agt_1", tenantA, nil, nil, room.ContextCommitment{})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	var wg sync.WaitGroup
	results := make([]error, n)
	wg.Add(n)
	for i := range n {
		go func(i int) {
			defer wg.Done()
			_, results[i] = s.AppendMessage(ctx, tenantA, r.ID, member.ID, "msg")
		}(i)
	}
	wg.Wait()

	successes := 0
	for i, err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, room.ErrTurnBudgetExceeded), errors.Is(err, room.ErrRoomTerminated):
			// Expected losers: the first to lose the race abandons the room
			// (ErrTurnBudgetExceeded); everything after that sees the room
			// already terminated (ErrRoomTerminated).
		default:
			t.Errorf("AppendMessage %d: unexpected err = %v", i, err)
		}
	}
	if successes != 1 {
		t.Fatalf("successes = %d, want exactly 1 — the turn-budget invariant let two posts spend the same last turn", successes)
	}

	got, err := s.GetRoom(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if got.State != room.StateAbandoned {
		t.Errorf("State = %q, want %q", got.State, room.StateAbandoned)
	}

	msgs, err := s.Messages(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 1 {
		t.Errorf("len(msgs) = %d, want 1", len(msgs))
	}
}

// TestPG_AppendMessage_RolledBackTransactionLeavesNoGap proves a transaction
// that locks a room's row, reads next_sequence, and then rolls back without
// ever writing an event or advancing next_sequence — modelling a crash or an
// aborted write between BEGIN and COMMIT — leaves no gap behind: the next
// successful append reuses the sequence number the failed one would have
// taken, because next_sequence only ever advances on commit.
func TestPG_AppendMessage_RolledBackTransactionLeavesNoGap(t *testing.T) {
	s, pool := newPGStore(t)
	ctx := context.Background()

	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	member, err := s.AddMember(ctx, tenantA, r.ID, "agt_1", tenantA, nil, nil, room.ContextCommitment{})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	var nextSeq int
	if err := tx.QueryRow(ctx, `SELECT next_sequence FROM rooms WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, r.ID, tenantA).Scan(&nextSeq); err != nil {
		t.Fatalf("lock room: %v", err)
	}
	if nextSeq != 2 { // 1 was taken by the member_joined event above
		t.Fatalf("nextSeq = %d, want 2", nextSeq)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("Rollback: %v", err)
	}

	if _, err := s.AppendMessage(ctx, tenantA, r.ID, member.ID, "first real append"); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}

	events, err := s.Events(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("len(events) = %d, want 2", len(events))
	}
	if events[1].Sequence != 2 {
		t.Errorf("events[1].Sequence = %d, want 2 (the rolled-back attempt's number, reused)", events[1].Sequence)
	}
}

// -------------------------------------------------------------- terminal ---

func TestPG_CompleteRoom_RoundTrip(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}

	got, err := s.CompleteRoom(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("CompleteRoom: %v", err)
	}
	if got.State != room.StateCompleted {
		t.Errorf("State = %q, want %q", got.State, room.StateCompleted)
	}

	events, err := s.Events(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	if len(events) != 1 || events[0].Kind != room.EventRoomTerminated {
		t.Fatalf("events = %+v, want a single EventRoomTerminated", events)
	}
}

func TestPG_CompleteRoom_CrossTenantBlocked(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}

	if _, err := s.CompleteRoom(ctx, tenantB, r.ID); !errors.Is(err, room.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestPG_CompleteRoom_TerminatedRoomRejected(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	if _, err := s.CompleteRoom(ctx, tenantA, r.ID); err != nil {
		t.Fatalf("CompleteRoom: %v", err)
	}

	if _, err := s.CompleteRoom(ctx, tenantA, r.ID); !errors.Is(err, room.ErrRoomTerminated) {
		t.Errorf("err = %v, want ErrRoomTerminated", err)
	}
}

// ----------------------------------------------------- delivery bookkeeping ---

func TestPG_RecordDeliveryFailure_RoundTrip(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	sender, err := s.AddMember(ctx, tenantA, r.ID, "agt_sender", tenantA, nil, nil, room.ContextCommitment{})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	recipient, err := s.AddMember(ctx, tenantA, r.ID, "agt_recipient", tenantA, nil, nil, room.ContextCommitment{})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	if err := s.RecordDeliveryFailure(ctx, tenantA, r.ID, sender.ID, recipient.ID, "agt_recipient", "upstream_failure"); err != nil {
		t.Fatalf("RecordDeliveryFailure: %v", err)
	}

	events, err := s.Events(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	last := events[len(events)-1]
	if last.Kind != room.EventDeliveryFailed {
		t.Fatalf("last event kind = %q, want %q", last.Kind, room.EventDeliveryFailed)
	}
	payload, ok := last.Payload.(room.DeliveryFailedPayload)
	if !ok || payload.FromMemberID != sender.ID || payload.ToMemberID != recipient.ID || payload.ToAgentID != "agt_recipient" || payload.Class != "upstream_failure" {
		t.Errorf("payload = %+v, unexpected fields", last.Payload)
	}

	// A failed delivery must never be recorded as (or mistaken for) a posted
	// message: it consumes no turn and leaves the transcript untouched.
	msgs, err := s.Messages(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 0 {
		t.Errorf("Messages = %v, want empty after a failed delivery", msgs)
	}
}

func TestPG_RecordDeliveryFailure_CrossTenantBlocked(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}

	if err := s.RecordDeliveryFailure(ctx, tenantB, r.ID, "mem_1", "mem_2", "agt_2", "caller_error"); !errors.Is(err, room.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestPG_RecordDelivery_RoundTrip(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	sender, err := s.AddMember(ctx, tenantA, r.ID, "agt_sender", tenantA, nil, nil, room.ContextCommitment{})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	recipient, err := s.AddMember(ctx, tenantA, r.ID, "agt_recipient", tenantA, nil, nil, room.ContextCommitment{})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	if err := s.RecordDelivery(ctx, tenantA, r.ID, sender.ID, recipient.ID, "agt_recipient", "inv_123"); err != nil {
		t.Fatalf("RecordDelivery: %v", err)
	}

	events, err := s.Events(ctx, tenantA, r.ID)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	last := events[len(events)-1]
	if last.Kind != room.EventMessageDelivered {
		t.Fatalf("last event kind = %q, want %q", last.Kind, room.EventMessageDelivered)
	}
	payload, ok := last.Payload.(room.MessageDeliveredPayload)
	if !ok || payload.FromMemberID != sender.ID || payload.ToMemberID != recipient.ID || payload.ToAgentID != "agt_recipient" || payload.InvocationID != "inv_123" {
		t.Errorf("payload = %+v, unexpected fields", last.Payload)
	}
}

func TestPG_RecordDelivery_CrossTenantBlocked(t *testing.T) {
	s, _ := newPGStore(t)
	ctx := context.Background()
	r, err := s.CreateRoom(ctx, tenantA, "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}

	if err := s.RecordDelivery(ctx, tenantB, r.ID, "mem_1", "mem_2", "agt_2", "inv_1"); !errors.Is(err, room.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}
