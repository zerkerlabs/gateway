// Package roomtest holds the contract test suite every room.Store
// implementation must satisfy. It is written against the room.Store
// interface, not any concrete implementation, so it runs unchanged against
// room.NewMemoryStore today and a durable implementation later without
// modification.
package roomtest

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/zerkerlabs/gateway/rooms/internal/room"
)

const (
	tenantA = "tenant-alpha"
	tenantB = "tenant-beta"
)

// RunContract runs the full contract suite against implementations returned
// by newStore, calling it once per behaviour so each case starts from a
// clean store.
func RunContract(t *testing.T, newStore func() room.Store) {
	t.Helper()

	testCreateRoomAssignsServerFields(t, newStore)
	testGetRoom(t, newStore)
	testGetRoomUnknownID(t, newStore)
	testListRoomsCrossTenantIsolation(t, newStore)
	testListRoomsEmpty(t, newStore)
	testAddMember(t, newStore)
	testReturnedValuesAreIsolated(t, newStore)
	testAppendMessageRoundTrip(t, newStore)
	testAppendMessageCrossTenantBlocked(t, newStore)
	testAppendMessageUnknownMemberRejected(t, newStore)
	testAppendMessageMemberFromAnotherRoomRejected(t, newStore)
	testAppendMessageConcurrentDoNotRace(t, newStore)
	testEventsSequenceNumbering(t, newStore)
	testMessagesReplaysTranscriptFromEvents(t, newStore)
	testAppendMessageTurnBudgetExhaustionAbandonsRoom(t, newStore)
	testCreateRoomWithBudgetRejectsNonPositive(t, newStore)
	testMemberAgentID(t, newStore)
	testRecordDeliveryFailure(t, newStore)
	testCompleteRoom(t, newStore)
	testTerminatedRoomRejectsAppends(t, newStore)
	testReserveTurnRunsTheSameChecksAsAppendMessage(t, newStore)
	testReserveTurnOutOfTurnsAbandonsTheRoomLikeAppendMessage(t, newStore)
	testReserveTurnHoldsTheTurnUntilResolved(t, newStore)
	testCommitTurnRecordsTheMessageEvenIfTheRoomTerminatedMeanwhile(t, newStore)
	testReservationResolvesOnlyOnce(t, newStore)
}

func mustCreateRoom(t *testing.T, s room.Store, tenantID, goal string) *room.Room {
	t.Helper()
	r, err := s.CreateRoom(context.Background(), tenantID, goal)
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	return r
}

// ------------------------------------------------------------- CreateRoom ---

func testCreateRoomAssignsServerFields(t *testing.T, newStore func() room.Store) {
	t.Run("CreateRoom_AssignsServerFields", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r := mustCreateRoom(t, s, tenantA, "ship the thing")

		if !strings.HasPrefix(r.ID, "rom_") {
			t.Errorf("ID %q does not start with rom_", r.ID)
		}
		if r.TenantID != tenantA {
			t.Errorf("TenantID = %q, want %q", r.TenantID, tenantA)
		}
		if r.Goal != "ship the thing" {
			t.Errorf("Goal = %q, want %q", r.Goal, "ship the thing")
		}
		if r.State != room.StateOpen {
			t.Errorf("State = %q, want %q", r.State, room.StateOpen)
		}
		if r.CreatedAt.IsZero() {
			t.Error("CreatedAt is zero")
		}
		if len(r.Members) != 0 {
			t.Errorf("Members = %v, want empty", r.Members)
		}
	})
}

// ---------------------------------------------------------------- GetRoom ---

func testGetRoom(t *testing.T, newStore func() room.Store) {
	t.Run("GetRoom", func(t *testing.T) {
		t.Parallel()

		tests := []struct {
			name      string
			lookupAs  string
			wantFound bool
		}{
			{"round-trip in owning tenant", tenantA, true},
			{"cross-tenant read returns not-found", tenantB, false},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				t.Parallel()

				s := newStore()
				created := mustCreateRoom(t, s, tenantA, "goal")

				got, err := s.GetRoom(context.Background(), tt.lookupAs, created.ID)
				if tt.wantFound {
					if err != nil {
						t.Fatalf("GetRoom: %v", err)
					}
					if got.ID != created.ID || got.Goal != created.Goal {
						t.Errorf("got %+v, want fields matching %+v", got, created)
					}
					return
				}
				if !errors.Is(err, room.ErrNotFound) {
					t.Errorf("err = %v, want ErrNotFound", err)
				}
				if got != nil {
					t.Errorf("got = %+v, want nil", got)
				}
			})
		}
	})
}

func testGetRoomUnknownID(t *testing.T, newStore func() room.Store) {
	t.Run("GetRoom_UnknownID", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		_, err := s.GetRoom(context.Background(), tenantA, "rom_nonexistent")
		if !errors.Is(err, room.ErrNotFound) {
			t.Errorf("err = %v, want ErrNotFound", err)
		}
	})
}

// -------------------------------------------------------------- ListRooms ---

func testListRoomsCrossTenantIsolation(t *testing.T, newStore func() room.Store) {
	t.Run("ListRooms_CrossTenantIsolation", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		a1 := mustCreateRoom(t, s, tenantA, "a1")
		a2 := mustCreateRoom(t, s, tenantA, "a2")
		mustCreateRoom(t, s, tenantB, "b1")

		got, err := s.ListRooms(context.Background(), tenantA)
		if err != nil {
			t.Fatalf("ListRooms: %v", err)
		}
		if len(got) != 2 {
			t.Fatalf("len(got) = %d, want 2", len(got))
		}

		ids := map[string]bool{got[0].ID: true, got[1].ID: true}
		if !ids[a1.ID] || !ids[a2.ID] {
			t.Errorf("got = %v, want ids %q and %q", got, a1.ID, a2.ID)
		}
	})
}

func testListRoomsEmpty(t *testing.T, newStore func() room.Store) {
	t.Run("ListRooms_Empty", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		got, err := s.ListRooms(context.Background(), tenantA)
		if err != nil {
			t.Fatalf("ListRooms: %v", err)
		}
		if len(got) != 0 {
			t.Errorf("len(got) = %d, want 0", len(got))
		}
	})
}

// -------------------------------------------------------------- AddMember ---

func testAddMember(t *testing.T, newStore func() room.Store) {
	t.Run("AddMember", func(t *testing.T) {
		t.Parallel()

		t.Run("seats a same-tenant agent", func(t *testing.T) {
			t.Parallel()

			s := newStore()
			r := mustCreateRoom(t, s, tenantA, "goal")

			m, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_1", tenantA, nil, room.ContextCommitment{})
			if err != nil {
				t.Fatalf("AddMember: %v", err)
			}
			if !strings.HasPrefix(m.ID, "mem_") {
				t.Errorf("ID %q does not start with mem_", m.ID)
			}
			if m.AgentID != "agt_1" {
				t.Errorf("AgentID = %q, want %q", m.AgentID, "agt_1")
			}
			if m.JoinedAt.IsZero() {
				t.Error("JoinedAt is zero")
			}

			got, err := s.GetRoom(context.Background(), tenantA, r.ID)
			if err != nil {
				t.Fatalf("GetRoom: %v", err)
			}
			if len(got.Members) != 1 || got.Members[0].ID != m.ID {
				t.Errorf("Members = %v, want [%s]", got.Members, m.ID)
			}
		})

		t.Run("cross-tenant member add is rejected", func(t *testing.T) {
			t.Parallel()

			s := newStore()
			r := mustCreateRoom(t, s, tenantA, "goal")

			_, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_1", tenantB, nil, room.ContextCommitment{})
			if !errors.Is(err, room.ErrTenantMismatch) {
				t.Errorf("err = %v, want ErrTenantMismatch", err)
			}

			got, err := s.GetRoom(context.Background(), tenantA, r.ID)
			if err != nil {
				t.Fatalf("GetRoom: %v", err)
			}
			if len(got.Members) != 0 {
				t.Errorf("Members = %v, want empty after rejected add", got.Members)
			}
		})

		t.Run("room in another tenant is not found", func(t *testing.T) {
			t.Parallel()

			s := newStore()
			r := mustCreateRoom(t, s, tenantA, "goal")

			_, err := s.AddMember(context.Background(), tenantB, r.ID, "agt_1", tenantB, nil, room.ContextCommitment{})
			if !errors.Is(err, room.ErrNotFound) {
				t.Errorf("err = %v, want ErrNotFound", err)
			}
		})

		t.Run("carries the context commitment and marks it live", func(t *testing.T) {
			t.Parallel()

			s := newStore()
			r := mustCreateRoom(t, s, tenantA, "goal")
			commitment := room.ContextCommitment{
				Digest:        "sha256:" + strings.Repeat("ab", 32),
				State:         "partial",
				Retrieved:     3,
				Admitted:      2,
				Withheld:      1,
				BudgetDropped: 3,
				Reasons:       []string{"policy_withheld"},
			}

			m, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_1", tenantA, nil, commitment)
			if err != nil {
				t.Fatalf("AddMember: %v", err)
			}
			if !reflect.DeepEqual(m.Context, commitment) {
				t.Errorf("Context = %+v, want %+v", m.Context, commitment)
			}
			if !m.ContextReplayable {
				t.Error("ContextReplayable = false for a live, just-added member, want true")
			}
		})

		t.Run("carries the caller-supplied starting context", func(t *testing.T) {
			t.Parallel()

			s := newStore()
			r := mustCreateRoom(t, s, tenantA, "goal")
			startingContext := []string{"memory entry", "onboarding doc"}

			m, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_1", tenantA, startingContext, room.ContextCommitment{})
			if err != nil {
				t.Fatalf("AddMember: %v", err)
			}
			if !slices.Equal(m.StartingContext, startingContext) {
				t.Errorf("StartingContext = %v, want %v", m.StartingContext, startingContext)
			}

			// Mutating the caller's slice after the call must not leak into the
			// store (same isolation guarantee as testReturnedValuesAreIsolated).
			startingContext[0] = "mutated"
			got, err := s.GetRoom(context.Background(), tenantA, r.ID)
			if err != nil {
				t.Fatalf("GetRoom: %v", err)
			}
			if got.Members[0].StartingContext[0] != "memory entry" {
				t.Errorf("stored StartingContext[0] = %q, want %q (caller mutation leaked into store)", got.Members[0].StartingContext[0], "memory entry")
			}
		})
	})
}

// -------------------------------------------------------------- clonation ---

// testReturnedValuesAreIsolated verifies that mutating a returned *Room does
// not corrupt the stored record.
func testReturnedValuesAreIsolated(t *testing.T, newStore func() room.Store) {
	t.Run("ReturnedValuesAreIsolated", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r := mustCreateRoom(t, s, tenantA, "goal")
		if _, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_1", tenantA, nil, room.ContextCommitment{}); err != nil {
			t.Fatalf("AddMember: %v", err)
		}

		got, err := s.GetRoom(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("GetRoom: %v", err)
		}
		got.Members[0].AgentID = "mutated"

		again, err := s.GetRoom(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("GetRoom again: %v", err)
		}
		if again.Members[0].AgentID != "agt_1" {
			t.Errorf("stored AgentID = %q, want %q (caller mutation leaked into store)", again.Members[0].AgentID, "agt_1")
		}
	})
}

// ----------------------------------------------------------- AppendMessage ---

func testAppendMessageRoundTrip(t *testing.T, newStore func() room.Store) {
	t.Run("AppendMessage_RoundTrip", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r := mustCreateRoom(t, s, tenantA, "goal")
		member, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_1", tenantA, nil, room.ContextCommitment{})
		if err != nil {
			t.Fatalf("AddMember: %v", err)
		}

		msg, err := s.AppendMessage(context.Background(), tenantA, r.ID, member.ID, "hello")
		if err != nil {
			t.Fatalf("AppendMessage: %v", err)
		}
		if !strings.HasPrefix(msg.ID, "msg_") {
			t.Errorf("ID %q does not start with msg_", msg.ID)
		}
		if msg.MemberID != member.ID {
			t.Errorf("MemberID = %q, want %q", msg.MemberID, member.ID)
		}
		if msg.Body != "hello" {
			t.Errorf("Body = %q, want %q", msg.Body, "hello")
		}

		msgs, err := s.Messages(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("Messages: %v", err)
		}
		if len(msgs) != 1 || msgs[0].ID != msg.ID {
			t.Errorf("Messages = %v, want [%s]", msgs, msg.ID)
		}
	})
}

func testAppendMessageCrossTenantBlocked(t *testing.T, newStore func() room.Store) {
	t.Run("AppendMessage_CrossTenantBlocked", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r := mustCreateRoom(t, s, tenantA, "goal")

		_, err := s.AppendMessage(context.Background(), tenantB, r.ID, "mem_1", "hello")
		if !errors.Is(err, room.ErrNotFound) {
			t.Errorf("err = %v, want ErrNotFound", err)
		}
	})
}

// testAppendMessageUnknownMemberRejected verifies that a message must be
// attributable to a member actually seated in the room — otherwise a caller
// could persist one pointing at a member that never existed, or one belonging
// to a different room.
func testAppendMessageUnknownMemberRejected(t *testing.T, newStore func() room.Store) {
	t.Run("AppendMessage_UnknownMemberRejected", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r := mustCreateRoom(t, s, tenantA, "goal")

		if _, err := s.AppendMessage(context.Background(), tenantA, r.ID, "mem_nope", "hello"); !errors.Is(err, room.ErrMemberNotFound) {
			t.Errorf("err = %v, want ErrMemberNotFound", err)
		}
	})
}

// testAppendMessageMemberFromAnotherRoomRejected verifies that a member seated
// in one room may not author messages in another, even when both rooms belong
// to the same tenant.
func testAppendMessageMemberFromAnotherRoomRejected(t *testing.T, newStore func() room.Store) {
	t.Run("AppendMessage_MemberFromAnotherRoomRejected", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r1 := mustCreateRoom(t, s, tenantA, "first")
		r2 := mustCreateRoom(t, s, tenantA, "second")

		member, err := s.AddMember(context.Background(), tenantA, r1.ID, "agt_1", tenantA, nil, room.ContextCommitment{})
		if err != nil {
			t.Fatalf("AddMember: %v", err)
		}

		if _, err := s.AppendMessage(context.Background(), tenantA, r2.ID, member.ID, "hello"); !errors.Is(err, room.ErrMemberNotFound) {
			t.Errorf("err = %v, want ErrMemberNotFound", err)
		}
	})
}

// testAppendMessageConcurrentDoNotRace exercises the store's append path from
// many goroutines at once; run with -race (make check's test target does). It
// is also the proof that concurrent appends still produce a valid contiguous
// sequence — the store's write serialization must hold even though the
// callers race.
func testAppendMessageConcurrentDoNotRace(t *testing.T, newStore func() room.Store) {
	t.Run("AppendMessage_ConcurrentDoNotRace", func(t *testing.T) {
		t.Parallel()

		const n = 50
		s := newStore()
		r, err := s.CreateRoomWithBudget(context.Background(), tenantA, "goal", n)
		if err != nil {
			t.Fatalf("CreateRoomWithBudget: %v", err)
		}
		member, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_1", tenantA, nil, room.ContextCommitment{})
		if err != nil {
			t.Fatalf("AddMember: %v", err)
		}

		var wg sync.WaitGroup
		wg.Add(n)
		for i := range n {
			go func(i int) {
				defer wg.Done()
				if _, err := s.AppendMessage(context.Background(), tenantA, r.ID, member.ID, "msg"); err != nil {
					t.Errorf("AppendMessage %d: %v", i, err)
				}
			}(i)
		}
		wg.Wait()

		msgs, err := s.Messages(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("Messages: %v", err)
		}
		if len(msgs) != n {
			t.Errorf("len(msgs) = %d, want %d", len(msgs), n)
		}

		ids := make(map[string]bool, n)
		for _, m := range msgs {
			if ids[m.ID] {
				t.Fatalf("duplicate message ID: %q", m.ID)
			}
			ids[m.ID] = true
		}

		// Sequence numbers assigned under concurrent append must still form a
		// valid contiguous run starting at 1 — the store's write serialization
		// must hold even though the callers race.
		events, err := s.Events(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("Events: %v", err)
		}
		seqs := make(map[int]bool, len(events))
		for _, ev := range events {
			if seqs[ev.Sequence] {
				t.Fatalf("duplicate sequence number: %d", ev.Sequence)
			}
			seqs[ev.Sequence] = true
		}
		// 1 member-joined event + n message-posted events.
		want := n + 1
		if len(events) != want {
			t.Fatalf("len(events) = %d, want %d", len(events), want)
		}
		for i := 1; i <= want; i++ {
			if !seqs[i] {
				t.Errorf("missing sequence number %d", i)
			}
		}
	})
}

// --------------------------------------------------------------- Events ---

// testEventsSequenceNumbering verifies that every kind of append — membership,
// messages, and terminal transitions — shares one contiguous, per-room
// sequence starting at 1.
func testEventsSequenceNumbering(t *testing.T, newStore func() room.Store) {
	t.Run("Events_SequenceNumbering", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r := mustCreateRoom(t, s, tenantA, "goal")
		member, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_1", tenantA, nil, room.ContextCommitment{})
		if err != nil {
			t.Fatalf("AddMember: %v", err)
		}
		if _, err := s.AppendMessage(context.Background(), tenantA, r.ID, member.ID, "hello"); err != nil {
			t.Fatalf("AppendMessage: %v", err)
		}
		if _, err := s.AppendMessage(context.Background(), tenantA, r.ID, member.ID, "world"); err != nil {
			t.Fatalf("AppendMessage: %v", err)
		}
		if _, err := s.CompleteRoom(context.Background(), tenantA, r.ID); err != nil {
			t.Fatalf("CompleteRoom: %v", err)
		}

		events, err := s.Events(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("Events: %v", err)
		}

		wantKinds := []room.EventKind{
			room.EventMemberJoined,
			room.EventMessagePosted,
			room.EventMessagePosted,
			room.EventRoomTerminated,
		}
		if len(events) != len(wantKinds) {
			t.Fatalf("len(events) = %d, want %d", len(events), len(wantKinds))
		}
		for i, ev := range events {
			wantSeq := i + 1
			if ev.Sequence != wantSeq {
				t.Errorf("events[%d].Sequence = %d, want %d", i, ev.Sequence, wantSeq)
			}
			if ev.Kind != wantKinds[i] {
				t.Errorf("events[%d].Kind = %q, want %q", i, ev.Kind, wantKinds[i])
			}
			if ev.Timestamp.IsZero() {
				t.Errorf("events[%d].Timestamp is zero", i)
			}
		}
	})
}

// ------------------------------------------------------------ transcript ---

// testMessagesReplaysTranscriptFromEvents verifies that a room's transcript is
// derived by replaying its event log, in order, skipping non-message events
// such as the member join and the terminal transition.
func testMessagesReplaysTranscriptFromEvents(t *testing.T, newStore func() room.Store) {
	t.Run("Messages_ReplaysTranscriptFromEvents", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r := mustCreateRoom(t, s, tenantA, "goal")
		member, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_1", tenantA, nil, room.ContextCommitment{})
		if err != nil {
			t.Fatalf("AddMember: %v", err)
		}

		var want []string
		for _, body := range []string{"first", "second", "third"} {
			msg, err := s.AppendMessage(context.Background(), tenantA, r.ID, member.ID, body)
			if err != nil {
				t.Fatalf("AppendMessage(%q): %v", body, err)
			}
			want = append(want, msg.ID)
		}
		if _, err := s.CompleteRoom(context.Background(), tenantA, r.ID); err != nil {
			t.Fatalf("CompleteRoom: %v", err)
		}

		msgs, err := s.Messages(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("Messages: %v", err)
		}
		if len(msgs) != len(want) {
			t.Fatalf("len(msgs) = %d, want %d", len(msgs), len(want))
		}
		for i, m := range msgs {
			if m.ID != want[i] {
				t.Errorf("msgs[%d].ID = %q, want %q", i, m.ID, want[i])
			}
			if m.Body != []string{"first", "second", "third"}[i] {
				t.Errorf("msgs[%d].Body = %q, want %q", i, m.Body, []string{"first", "second", "third"}[i])
			}
		}
	})
}

// ------------------------------------------------------------ turn budget ---

// testAppendMessageTurnBudgetExhaustionAbandonsRoom verifies that exceeding a
// room's turn budget rejects the over-budget message and abandons the room,
// recording the transition as an event.
func testAppendMessageTurnBudgetExhaustionAbandonsRoom(t *testing.T, newStore func() room.Store) {
	t.Run("AppendMessage_TurnBudgetExhaustionAbandonsRoom", func(t *testing.T) {
		t.Parallel()

		const budget = 2
		s := newStore()
		r, err := s.CreateRoomWithBudget(context.Background(), tenantA, "goal", budget)
		if err != nil {
			t.Fatalf("CreateRoomWithBudget: %v", err)
		}
		member, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_1", tenantA, nil, room.ContextCommitment{})
		if err != nil {
			t.Fatalf("AddMember: %v", err)
		}

		for i := range budget {
			if _, err := s.AppendMessage(context.Background(), tenantA, r.ID, member.ID, "msg"); err != nil {
				t.Fatalf("AppendMessage %d: %v", i, err)
			}
		}

		got, err := s.GetRoom(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("GetRoom: %v", err)
		}
		if got.State != room.StateOpen {
			t.Fatalf("State = %q, want %q before exceeding budget", got.State, room.StateOpen)
		}

		_, err = s.AppendMessage(context.Background(), tenantA, r.ID, member.ID, "one too many")
		if !errors.Is(err, room.ErrTurnBudgetExceeded) {
			t.Fatalf("err = %v, want ErrTurnBudgetExceeded", err)
		}

		got, err = s.GetRoom(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("GetRoom: %v", err)
		}
		if got.State != room.StateAbandoned {
			t.Fatalf("State = %q, want %q after exceeding budget", got.State, room.StateAbandoned)
		}

		msgs, err := s.Messages(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("Messages: %v", err)
		}
		if len(msgs) != budget {
			t.Fatalf("len(msgs) = %d, want %d (over-budget message must not be recorded)", len(msgs), budget)
		}

		events, err := s.Events(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("Events: %v", err)
		}
		last := events[len(events)-1]
		if last.Kind != room.EventRoomTerminated {
			t.Fatalf("last event kind = %q, want %q", last.Kind, room.EventRoomTerminated)
		}
		payload, ok := last.Payload.(room.RoomTerminatedPayload)
		if !ok {
			t.Fatalf("last event payload = %T, want room.RoomTerminatedPayload", last.Payload)
		}
		if payload.State != room.StateAbandoned {
			t.Errorf("terminated payload state = %q, want %q", payload.State, room.StateAbandoned)
		}
	})
}

func testCreateRoomWithBudgetRejectsNonPositive(t *testing.T, newStore func() room.Store) {
	t.Run("CreateRoomWithBudget_RejectsNonPositive", func(t *testing.T) {
		t.Parallel()

		tests := []struct {
			name   string
			budget int
		}{
			{"zero", 0},
			{"negative", -1},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				t.Parallel()

				s := newStore()
				_, err := s.CreateRoomWithBudget(context.Background(), tenantA, "goal", tt.budget)
				if err == nil {
					t.Fatal("err = nil, want error for non-positive turn budget")
				}
			})
		}
	})
}

// ---------------------------------------------------------- MemberAgentID ---

func testMemberAgentID(t *testing.T, newStore func() room.Store) {
	t.Run("MemberAgentID", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r := mustCreateRoom(t, s, tenantA, "goal")
		member, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_1", tenantA, nil, room.ContextCommitment{})
		if err != nil {
			t.Fatalf("AddMember: %v", err)
		}

		t.Run("resolves a seated member", func(t *testing.T) {
			t.Parallel()

			got, err := s.MemberAgentID(context.Background(), tenantA, r.ID, member.ID)
			if err != nil {
				t.Fatalf("MemberAgentID: %v", err)
			}
			if got != "agt_1" {
				t.Errorf("got %q, want %q", got, "agt_1")
			}
		})

		t.Run("unknown member is rejected", func(t *testing.T) {
			t.Parallel()

			if _, err := s.MemberAgentID(context.Background(), tenantA, r.ID, "mem_nope"); !errors.Is(err, room.ErrMemberNotFound) {
				t.Errorf("err = %v, want ErrMemberNotFound", err)
			}
		})

		t.Run("cross-tenant room is not found", func(t *testing.T) {
			t.Parallel()

			if _, err := s.MemberAgentID(context.Background(), tenantB, r.ID, member.ID); !errors.Is(err, room.ErrNotFound) {
				t.Errorf("err = %v, want ErrNotFound", err)
			}
		})
	})
}

// ----------------------------------------------------- RecordDeliveryFailure

func testRecordDeliveryFailure(t *testing.T, newStore func() room.Store) {
	t.Run("RecordDeliveryFailure", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r := mustCreateRoom(t, s, tenantA, "goal")
		sender, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_sender", tenantA, nil, room.ContextCommitment{})
		if err != nil {
			t.Fatalf("AddMember: %v", err)
		}
		recipient, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_recipient", tenantA, nil, room.ContextCommitment{})
		if err != nil {
			t.Fatalf("AddMember: %v", err)
		}

		if err := s.RecordDeliveryFailure(context.Background(), tenantA, r.ID, sender.ID, recipient.ID, "agt_recipient", "upstream_failure"); err != nil {
			t.Fatalf("RecordDeliveryFailure: %v", err)
		}

		events, err := s.Events(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("Events: %v", err)
		}
		last := events[len(events)-1]
		if last.Kind != room.EventDeliveryFailed {
			t.Fatalf("last event kind = %q, want %q", last.Kind, room.EventDeliveryFailed)
		}
		payload, ok := last.Payload.(room.DeliveryFailedPayload)
		if !ok {
			t.Fatalf("last event payload = %T, want room.DeliveryFailedPayload", last.Payload)
		}
		if payload.FromMemberID != sender.ID || payload.ToMemberID != recipient.ID || payload.ToAgentID != "agt_recipient" || payload.Class != "upstream_failure" {
			t.Errorf("payload = %+v, unexpected fields", payload)
		}

		// A failed delivery must never be recorded (or mistaken for) a posted
		// message: it consumes no turn and leaves the transcript untouched.
		msgs, err := s.Messages(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("Messages: %v", err)
		}
		if len(msgs) != 0 {
			t.Errorf("Messages = %v, want empty after a failed delivery", msgs)
		}

		if err := s.RecordDeliveryFailure(context.Background(), tenantB, r.ID, sender.ID, recipient.ID, "agt_recipient", "caller_error"); !errors.Is(err, room.ErrNotFound) {
			t.Errorf("cross-tenant RecordDeliveryFailure err = %v, want ErrNotFound", err)
		}
	})
}

// -------------------------------------------------------------- terminal ---

func testCompleteRoom(t *testing.T, newStore func() room.Store) {
	t.Run("CompleteRoom", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r := mustCreateRoom(t, s, tenantA, "goal")

		got, err := s.CompleteRoom(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("CompleteRoom: %v", err)
		}
		if got.State != room.StateCompleted {
			t.Errorf("State = %q, want %q", got.State, room.StateCompleted)
		}

		events, err := s.Events(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("Events: %v", err)
		}
		if len(events) != 1 || events[0].Kind != room.EventRoomTerminated {
			t.Fatalf("events = %+v, want a single EventRoomTerminated", events)
		}
	})
}

// testTerminatedRoomRejectsAppends is table-driven over both terminal states
// and every append path: appending anything to a terminated room is an error,
// regardless of how it became terminal.
func testTerminatedRoomRejectsAppends(t *testing.T, newStore func() room.Store) {
	t.Run("TerminatedRoomRejectsAppends", func(t *testing.T) {
		t.Parallel()

		tests := []struct {
			name      string
			terminate func(t *testing.T, s room.Store, roomID string)
		}{
			{
				name: "completed",
				terminate: func(t *testing.T, s room.Store, roomID string) {
					t.Helper()
					if _, err := s.CompleteRoom(context.Background(), tenantA, roomID); err != nil {
						t.Fatalf("CompleteRoom: %v", err)
					}
				},
			},
			{
				name: "abandoned via turn budget exhaustion",
				terminate: func(t *testing.T, s room.Store, roomID string) {
					t.Helper()
					member, err := s.AddMember(context.Background(), tenantA, roomID, "agt_budget_burner", tenantA, nil, room.ContextCommitment{})
					if err != nil {
						t.Fatalf("AddMember: %v", err)
					}
					// Budget is 1: the first message spends the only turn, the
					// second exceeds it and abandons the room.
					if _, err := s.AppendMessage(context.Background(), tenantA, roomID, member.ID, "spend the turn"); err != nil {
						t.Fatalf("AppendMessage (spend the turn): %v", err)
					}
					if _, err := s.AppendMessage(context.Background(), tenantA, roomID, member.ID, "burn the budget"); !errors.Is(err, room.ErrTurnBudgetExceeded) {
						t.Fatalf("AppendMessage (burn the budget): err = %v, want ErrTurnBudgetExceeded", err)
					}
				},
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				t.Parallel()

				s := newStore()
				r, err := s.CreateRoomWithBudget(context.Background(), tenantA, "goal", 1)
				if err != nil {
					t.Fatalf("CreateRoomWithBudget: %v", err)
				}
				tt.terminate(t, s, r.ID)

				member, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_late", tenantA, nil, room.ContextCommitment{})
				if err == nil {
					t.Errorf("AddMember on terminated room: got member %+v, want ErrRoomTerminated", member)
				} else if !errors.Is(err, room.ErrRoomTerminated) {
					t.Errorf("AddMember err = %v, want ErrRoomTerminated", err)
				}

				_, err = s.AppendMessage(context.Background(), tenantA, r.ID, "mem_whoever", "too late")
				if !errors.Is(err, room.ErrRoomTerminated) {
					t.Errorf("AppendMessage err = %v, want ErrRoomTerminated", err)
				}

				_, err = s.CompleteRoom(context.Background(), tenantA, r.ID)
				if !errors.Is(err, room.ErrRoomTerminated) {
					t.Errorf("CompleteRoom err = %v, want ErrRoomTerminated", err)
				}
			})
		}
	})
}

// ------------------------------------------------------- turn reservations ---

// testReserveTurnRunsTheSameChecksAsAppendMessage verifies that a reservation
// runs exactly the checks AppendMessage runs, so a caller can find out whether
// a message would be accepted BEFORE performing a side effect it cannot take
// back.
func testReserveTurnRunsTheSameChecksAsAppendMessage(t *testing.T, newStore func() room.Store) {
	t.Run("ReserveTurn_RunsTheSameChecksAsAppendMessage", func(t *testing.T) {
		t.Parallel()

		tests := []struct {
			name    string
			lookup  string
			setup   func(t *testing.T, s room.Store, roomID, memberID string) (member string)
			wantErr error
		}{
			{
				name:   "terminated room",
				lookup: tenantA,
				setup: func(t *testing.T, s room.Store, roomID, memberID string) string {
					t.Helper()
					if _, err := s.CompleteRoom(context.Background(), tenantA, roomID); err != nil {
						t.Fatalf("CompleteRoom: %v", err)
					}
					return memberID
				},
				wantErr: room.ErrRoomTerminated,
			},
			{
				name:    "sender not seated in the room",
				lookup:  tenantA,
				setup:   func(_ *testing.T, _ room.Store, _, _ string) string { return "mem_spoofed" },
				wantErr: room.ErrMemberNotFound,
			},
			{
				name:   "turn budget already spent",
				lookup: tenantA,
				setup: func(t *testing.T, s room.Store, roomID, memberID string) string {
					t.Helper()
					if _, err := s.AppendMessage(context.Background(), tenantA, roomID, memberID, "spend the turn"); err != nil {
						t.Fatalf("AppendMessage: %v", err)
					}
					return memberID
				},
				wantErr: room.ErrTurnBudgetExceeded,
			},
			{
				name:    "room belongs to another tenant",
				lookup:  tenantB,
				setup:   func(_ *testing.T, _ room.Store, _, memberID string) string { return memberID },
				wantErr: room.ErrNotFound,
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				t.Parallel()

				s := newStore()
				r, err := s.CreateRoomWithBudget(context.Background(), tenantA, "goal", 1)
				if err != nil {
					t.Fatalf("CreateRoomWithBudget: %v", err)
				}
				m, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_sender", tenantA, nil, room.ContextCommitment{})
				if err != nil {
					t.Fatalf("AddMember: %v", err)
				}
				memberID := tt.setup(t, s, r.ID, m.ID)

				res, err := s.ReserveTurn(context.Background(), tt.lookup, r.ID, room.PendingMessage{MemberID: memberID, Body: "hi"})
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				if res != nil {
					t.Errorf("reservation = %+v, want nil when the turn was refused", res)
				}
			})
		}
	})
}

// testReserveTurnOutOfTurnsAbandonsTheRoomLikeAppendMessage verifies that
// reserving is how an addressed message acquires its turn, so it carries the
// same consequence AppendMessage does: a room whose budget is genuinely spent
// is abandoned. Otherwise which of the two paths a post arrived on would
// decide whether the room lives, and an addressed message could keep asking
// for turns a broadcast one had already exhausted.
func testReserveTurnOutOfTurnsAbandonsTheRoomLikeAppendMessage(t *testing.T, newStore func() room.Store) {
	t.Run("ReserveTurn_OutOfTurnsAbandonsTheRoomLikeAppendMessage", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r, err := s.CreateRoomWithBudget(context.Background(), tenantA, "goal", 1)
		if err != nil {
			t.Fatalf("CreateRoomWithBudget: %v", err)
		}
		m, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_sender", tenantA, nil, room.ContextCommitment{})
		if err != nil {
			t.Fatalf("AddMember: %v", err)
		}
		if _, err := s.AppendMessage(context.Background(), tenantA, r.ID, m.ID, "spend the turn"); err != nil {
			t.Fatalf("AppendMessage: %v", err)
		}

		if _, err := s.ReserveTurn(context.Background(), tenantA, r.ID, room.PendingMessage{MemberID: m.ID, Body: "hi"}); !errors.Is(err, room.ErrTurnBudgetExceeded) {
			t.Fatalf("ReserveTurn err = %v, want ErrTurnBudgetExceeded", err)
		}

		got, err := s.GetRoom(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("GetRoom: %v", err)
		}
		if got.State != room.StateAbandoned {
			t.Errorf("State = %q, want %q", got.State, room.StateAbandoned)
		}
		last := got.Events[len(got.Events)-1]
		if last.Kind != room.EventRoomTerminated {
			t.Errorf("last event kind = %q, want %q", last.Kind, room.EventRoomTerminated)
		}
	})
}

// testReserveTurnHoldsTheTurnUntilResolved verifies the point of a
// reservation: the turn is held for the life of the side effect, so nothing
// arriving in the meantime can spend it. Releasing gives it back.
func testReserveTurnHoldsTheTurnUntilResolved(t *testing.T, newStore func() room.Store) {
	t.Run("ReserveTurn_HoldsTheTurnUntilResolved", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r, err := s.CreateRoomWithBudget(context.Background(), tenantA, "goal", 1)
		if err != nil {
			t.Fatalf("CreateRoomWithBudget: %v", err)
		}
		m, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_sender", tenantA, nil, room.ContextCommitment{})
		if err != nil {
			t.Fatalf("AddMember: %v", err)
		}

		res, err := s.ReserveTurn(context.Background(), tenantA, r.ID, room.PendingMessage{MemberID: m.ID, Body: "reserved"})
		if err != nil {
			t.Fatalf("ReserveTurn: %v", err)
		}

		// Refused — but as a retryable conflict, not an exhausted budget: the
		// reserved turn may still come back, so the room must not be abandoned
		// on account of a delivery that has not landed yet.
		if _, err := s.AppendMessage(context.Background(), tenantA, r.ID, m.ID, "steal the turn"); !errors.Is(err, room.ErrTurnReserved) {
			t.Fatalf("AppendMessage err = %v, want ErrTurnReserved — a reserved turn was spent twice", err)
		}
		got, err := s.GetRoom(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("GetRoom: %v", err)
		}
		if got.State != room.StateOpen {
			t.Fatalf("State = %q, want %q — a turn merely reserved must not abandon the room", got.State, room.StateOpen)
		}

		if err := s.ReleaseTurn(context.Background(), res); err != nil {
			t.Fatalf("ReleaseTurn: %v", err)
		}

		// Released unspent, so the room is free to use the turn — and nothing
		// was recorded for the reservation itself.
		if _, err := s.AppendMessage(context.Background(), tenantA, r.ID, m.ID, "after release"); err != nil {
			t.Fatalf("AppendMessage after release: %v — the released turn was lost", err)
		}
		msgs, err := s.Messages(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("Messages: %v", err)
		}
		if len(msgs) != 1 || msgs[0].Body != "after release" {
			t.Errorf("transcript = %+v, want only the message posted after the release", msgs)
		}
	})
}

// testCommitTurnRecordsTheMessageEvenIfTheRoomTerminatedMeanwhile verifies
// that committing is unconditional by design. The side effect the reservation
// was protecting has already happened — the message really was delivered to
// the recipient's agent — so the transcript records it even if the room was
// terminated or its budget exhausted while the delivery was in flight. A
// delivered call the room denies would be the worse outcome.
func testCommitTurnRecordsTheMessageEvenIfTheRoomTerminatedMeanwhile(t *testing.T, newStore func() room.Store) {
	t.Run("CommitTurn_RecordsTheMessageEvenIfTheRoomTerminatedMeanwhile", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		r, err := s.CreateRoomWithBudget(context.Background(), tenantA, "goal", 1)
		if err != nil {
			t.Fatalf("CreateRoomWithBudget: %v", err)
		}
		sender, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_sender", tenantA, nil, room.ContextCommitment{})
		if err != nil {
			t.Fatalf("AddMember: %v", err)
		}
		recipient, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_recipient", tenantA, nil, room.ContextCommitment{})
		if err != nil {
			t.Fatalf("AddMember: %v", err)
		}

		res, err := s.ReserveTurn(context.Background(), tenantA, r.ID, room.PendingMessage{
			MemberID:   sender.ID,
			ToMemberID: recipient.ID,
			Body:       "delivered",
		})
		if err != nil {
			t.Fatalf("ReserveTurn: %v", err)
		}

		// The room terminates while the call is in flight.
		if _, err := s.CompleteRoom(context.Background(), tenantA, r.ID); err != nil {
			t.Fatalf("CompleteRoom: %v", err)
		}

		msg, err := s.CommitTurn(context.Background(), res)
		if err != nil {
			t.Fatalf("CommitTurn: %v — a confirmed delivery was left out of the transcript", err)
		}
		if msg.ToMemberID != recipient.ID {
			t.Errorf("ToMemberID = %q, want %q", msg.ToMemberID, recipient.ID)
		}

		msgs, err := s.Messages(context.Background(), tenantA, r.ID)
		if err != nil {
			t.Fatalf("Messages: %v", err)
		}
		if len(msgs) != 1 || msgs[0].Body != "delivered" || msgs[0].ToMemberID != recipient.ID {
			t.Errorf("transcript = %+v, want the delivered message with its recipient", msgs)
		}
	})
}

// testReservationResolvesOnlyOnce verifies that a reservation is resolved
// exactly once. Resolving it twice would either double-record a message or
// hand back a turn that is not held.
func testReservationResolvesOnlyOnce(t *testing.T, newStore func() room.Store) {
	t.Run("ReservationResolvesOnlyOnce", func(t *testing.T) {
		t.Parallel()

		tests := map[string]func(s room.Store, res *room.Reservation) error{
			"commit then commit": func(s room.Store, res *room.Reservation) error {
				_, err := s.CommitTurn(context.Background(), res)
				return err
			},
			"commit then release": func(s room.Store, res *room.Reservation) error {
				return s.ReleaseTurn(context.Background(), res)
			},
		}

		for name, second := range tests {
			t.Run(name, func(t *testing.T) {
				t.Parallel()

				s := newStore()
				r := mustCreateRoom(t, s, tenantA, "goal")
				m, err := s.AddMember(context.Background(), tenantA, r.ID, "agt_sender", tenantA, nil, room.ContextCommitment{})
				if err != nil {
					t.Fatalf("AddMember: %v", err)
				}
				res, err := s.ReserveTurn(context.Background(), tenantA, r.ID, room.PendingMessage{MemberID: m.ID, Body: "once"})
				if err != nil {
					t.Fatalf("ReserveTurn: %v", err)
				}
				if _, err := s.CommitTurn(context.Background(), res); err != nil {
					t.Fatalf("CommitTurn: %v", err)
				}

				if err := second(s, res); !errors.Is(err, room.ErrReservationNotHeld) {
					t.Errorf("second resolution err = %v, want ErrReservationNotHeld", err)
				}

				msgs, err := s.Messages(context.Background(), tenantA, r.ID)
				if err != nil {
					t.Fatalf("Messages: %v", err)
				}
				if len(msgs) != 1 {
					t.Errorf("transcript = %+v, want exactly one message", msgs)
				}
			})
		}
	})
}
