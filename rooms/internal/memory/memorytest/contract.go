// Package memorytest holds the contract test suite every memory.Store
// implementation must satisfy. It is written against the memory.Store
// interface, not any concrete implementation, so it runs against
// memory.NewFake and against a real backend client alike.
//
// Two subtests — proving a non-chronological order survives, and driving
// StateAbstained — need more than the Store interface can express: a real
// backend derives both from data this suite has no way to seed through
// PrepareContext, Propose, and Record alone. Those subtests type-assert for
// the optional seeding hooks memory.Fake exposes and skip if a store does
// not implement them, rather than widening the Store interface itself.
//
// # Purpose is a retrieval query, not a label
//
// A real backend retrieves against PrepareRequest.Purpose — it is the search
// query, not descriptive metadata. Content whose text shares no term with
// the purpose is not retrieved at all, and the call returns StateEmpty. Every
// implementation, including the fake, must reject an empty Purpose rather
// than treat it as "match everything" — so every case below states a purpose
// that shares a term with the content it just wrote, the way a real caller
// would.
//
// # Visibility is part of the contract
//
// Room-shared versus member-private memory is covered here like any other
// case: AgentID is always required on a write, and Visibility states which
// partition the write lands in. A store that leaks member-private memory to
// another agent in the same room, or that fails to make VisibilityRoom's
// default behavior room-shared, fails this suite the same way a store that
// gets StateBudgetExhausted wrong does.
package memorytest

import (
	"context"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/rooms/internal/memory"
)

// orderSeeder is implemented by memory.Store implementations that support
// installing a memory at an explicit CreatedAt, bypassing Propose and
// Record. memory.Fake implements it.
type orderSeeder interface {
	Seed(roomID, agentID string, m memory.Memory)
}

// abstainForcer is implemented by memory.Store implementations that support
// forcing StateAbstained for a (room, agent) pair. memory.Fake implements
// it.
type abstainForcer interface {
	SetAbstain(roomID, agentID string)
}

// RunContract runs the full contract suite against implementations returned
// by newStore, calling it once per behaviour so each case starts from a
// clean store.
func RunContract(t *testing.T, newStore func() memory.Store) {
	t.Helper()

	t.Run("PrepareContext for a room with no prior memory returns StateEmpty", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		result, err := s.PrepareContext(context.Background(), memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1", Purpose: "anything at all"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateEmpty {
			t.Errorf("State = %q, want %q", result.State, memory.StateEmpty)
		}
		if len(result.Memories) != 0 {
			t.Errorf("Memories = %+v, want empty", result.Memories)
		}
	})

	t.Run("Record makes content immediately admitted, returning StateReady", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		ctx := context.Background()
		roomID := "rom_1"
		if _, err := s.Record(ctx, memory.RecordRequest{
			RoomID: roomID, AgentID: "agt_1", Content: "the room's accepted outcome",
			SourceEventID: "evt_1", IdempotencyKey: "key_1",
		}); err != nil {
			t.Fatalf("Record: %v", err)
		}

		result, err := s.PrepareContext(ctx, memory.PrepareRequest{RoomID: roomID, AgentID: "agt_1", Purpose: "the accepted outcome"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateReady {
			t.Fatalf("State = %q, want %q", result.State, memory.StateReady)
		}
		if len(result.Memories) != 1 || result.Memories[0].Content != "the room's accepted outcome" {
			t.Errorf("Memories = %+v, want the recorded content", result.Memories)
		}
		if result.Counts.Retrieved != 1 || result.Counts.Admitted != 1 || result.Counts.Withheld != 0 || result.Counts.BudgetDropped != 0 {
			t.Errorf("Counts = %+v, want {1 1 0 0}", result.Counts)
		}
		if result.Commitment.Digest == "" {
			t.Error("Commitment.Digest is empty, want a non-empty attestation over the returned context")
		}
	})

	t.Run("Propose quarantines content, returning StateBlocked with none admitted", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		ctx := context.Background()
		roomID := "rom_1"
		if _, err := s.Propose(ctx, memory.ProposeRequest{
			RoomID: roomID, AgentID: "agt_1", Content: "an agent's unreviewed claim",
			SourceEventID: "evt_1", IdempotencyKey: "key_1",
		}); err != nil {
			t.Fatalf("Propose: %v", err)
		}

		result, err := s.PrepareContext(ctx, memory.PrepareRequest{RoomID: roomID, AgentID: "agt_1", Purpose: "the unreviewed claim"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateBlocked {
			t.Fatalf("State = %q, want %q", result.State, memory.StateBlocked)
		}
		if len(result.Memories) != 0 {
			t.Errorf("Memories = %+v, want empty — proposed content is not admitted", result.Memories)
		}
		if result.Counts.Retrieved != 1 || result.Counts.Withheld != 1 {
			t.Errorf("Counts = %+v, want Retrieved=1 Withheld=1", result.Counts)
		}
	})

	t.Run("mixing Record and Propose returns StatePartial", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		ctx := context.Background()
		roomID := "rom_1"
		if _, err := s.Record(ctx, memory.RecordRequest{
			RoomID: roomID, AgentID: "agt_1", Content: "accepted decision",
			SourceEventID: "evt_1", IdempotencyKey: "key_1",
		}); err != nil {
			t.Fatalf("Record: %v", err)
		}
		if _, err := s.Propose(ctx, memory.ProposeRequest{
			RoomID: roomID, AgentID: "agt_1", Content: "unreviewed decision",
			SourceEventID: "evt_2", IdempotencyKey: "key_2",
		}); err != nil {
			t.Fatalf("Propose: %v", err)
		}

		result, err := s.PrepareContext(ctx, memory.PrepareRequest{RoomID: roomID, AgentID: "agt_1", Purpose: "decision"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StatePartial {
			t.Fatalf("State = %q, want %q", result.State, memory.StatePartial)
		}
		if len(result.Memories) != 1 || result.Memories[0].Content != "accepted decision" {
			t.Errorf("Memories = %+v, want only the recorded content", result.Memories)
		}
		if result.Counts.Retrieved != 2 || result.Counts.Admitted != 1 || result.Counts.Withheld != 1 {
			t.Errorf("Counts = %+v, want Retrieved=2 Admitted=1 Withheld=1", result.Counts)
		}
	})

	t.Run("a context budget too small for any recorded content returns StateBudgetExhausted", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		ctx := context.Background()
		roomID := "rom_1"
		if _, err := s.Record(ctx, memory.RecordRequest{
			RoomID: roomID, AgentID: "agt_1", Content: "content too long for the budget",
			SourceEventID: "evt_1", IdempotencyKey: "key_1",
		}); err != nil {
			t.Fatalf("Record: %v", err)
		}

		result, err := s.PrepareContext(ctx, memory.PrepareRequest{RoomID: roomID, AgentID: "agt_1", Purpose: "the budget content", ContextBudgetTokens: 1})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateBudgetExhausted {
			t.Fatalf("State = %q, want %q", result.State, memory.StateBudgetExhausted)
		}
		if len(result.Memories) != 0 {
			t.Errorf("Memories = %+v, want empty", result.Memories)
		}
		if result.Counts.BudgetDropped != 1 {
			t.Errorf("Counts.BudgetDropped = %d, want 1", result.Counts.BudgetDropped)
		}
	})

	t.Run("StateAbstained", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		forcer, ok := s.(abstainForcer)
		if !ok {
			t.Skip("store does not support forcing abstention")
		}

		roomID := "rom_1"
		forcer.SetAbstain(roomID, "agt_1")

		result, err := s.PrepareContext(context.Background(), memory.PrepareRequest{RoomID: roomID, AgentID: "agt_1", Purpose: "anything at all"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateAbstained {
			t.Fatalf("State = %q, want %q", result.State, memory.StateAbstained)
		}
		if result.Omissions.Abstention == "" {
			t.Error("Omissions.Abstention is empty, want a reason")
		}
	})

	t.Run("cross-tenant isolation: independent store instances never share state", func(t *testing.T) {
		t.Parallel()

		storeA := newStore()
		storeB := newStore()
		ctx := context.Background()
		roomID, agentID := "rom_1", "agt_1"

		if _, err := storeA.Record(ctx, memory.RecordRequest{
			RoomID: roomID, AgentID: agentID, Content: "tenant-a-only",
			SourceEventID: "evt_1", IdempotencyKey: "key_1",
		}); err != nil {
			t.Fatalf("Record: %v", err)
		}

		result, err := storeB.PrepareContext(ctx, memory.PrepareRequest{RoomID: roomID, AgentID: agentID, Purpose: "tenant-a-only"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateEmpty || len(result.Memories) != 0 {
			t.Errorf("PrepareContext on a second store instance = %+v, want empty (first instance's memory leaked across tenants)", result)
		}
	})

	t.Run("cross-room isolation: memory recorded in one room is not visible from another", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		ctx := context.Background()
		agentID := "agt_1"

		if _, err := s.Record(ctx, memory.RecordRequest{
			RoomID: "rom_1", AgentID: agentID, Content: "rom_1-only",
			SourceEventID: "evt_1", IdempotencyKey: "key_1",
		}); err != nil {
			t.Fatalf("Record: %v", err)
		}

		result, err := s.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_2", AgentID: agentID, Purpose: "rom_1-only"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateEmpty || len(result.Memories) != 0 {
			t.Errorf("rom_2's PrepareContext = %+v, want empty (rom_1's memory leaked across rooms)", result)
		}
	})

	t.Run("PrepareContext preserves the given order verbatim, not sorted chronologically", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		seeder, ok := s.(orderSeeder)
		if !ok {
			t.Skip("store does not support seeding an explicit order")
		}

		roomID := "rom_1"
		now := time.Now()
		// newer is seeded first even though its CreatedAt is later than
		// older's — an oldest-first (or newest-first) chronological sort
		// would place them in the opposite order from how they were seeded.
		newer := memory.Memory{ID: "mem_newer", Content: "seeded first, timestamped later", CreatedAt: now}
		older := memory.Memory{ID: "mem_older", Content: "seeded second, timestamped earlier", CreatedAt: now.Add(-time.Hour)}
		seeder.Seed(roomID, "", newer)
		seeder.Seed(roomID, "", older)

		result, err := s.PrepareContext(context.Background(), memory.PrepareRequest{RoomID: roomID, AgentID: "agt_1", Purpose: "seeded"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if len(result.Memories) != 2 || result.Memories[0].ID != "mem_newer" || result.Memories[1].ID != "mem_older" {
			t.Errorf("Memories = %+v, want [mem_newer mem_older] in the order seeded, not chronological order", result.Memories)
		}
	})

	t.Run("PrepareContext requires a non-empty Purpose", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		if _, err := s.PrepareContext(context.Background(), memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"}); err == nil {
			t.Fatal("err = nil, want an error for an empty Purpose")
		}
	})

	t.Run("Propose and Record require a non-empty AgentID", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		ctx := context.Background()
		if _, err := s.Propose(ctx, memory.ProposeRequest{
			RoomID: "rom_1", Content: "no contributor named",
			SourceEventID: "evt_1", IdempotencyKey: "key_1",
		}); err == nil {
			t.Fatal("Propose: err = nil, want an error for an empty AgentID")
		}
		if _, err := s.Record(ctx, memory.RecordRequest{
			RoomID: "rom_1", Content: "no contributor named",
			SourceEventID: "evt_2", IdempotencyKey: "key_2",
		}); err == nil {
			t.Fatal("Record: err = nil, want an error for an empty AgentID")
		}
	})

	t.Run("Propose and Record reject an unrecognized Visibility value", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		ctx := context.Background()
		const bogus memory.Visibility = "everyone"
		if _, err := s.Propose(ctx, memory.ProposeRequest{
			RoomID: "rom_1", AgentID: "agt_1", Content: "bogus visibility",
			Visibility:    bogus,
			SourceEventID: "evt_1", IdempotencyKey: "key_1",
		}); err == nil {
			t.Fatal("Propose: err = nil, want an error for an unrecognized Visibility")
		}
		if _, err := s.Record(ctx, memory.RecordRequest{
			RoomID: "rom_1", AgentID: "agt_1", Content: "bogus visibility",
			Visibility:    bogus,
			SourceEventID: "evt_2", IdempotencyKey: "key_2",
		}); err == nil {
			t.Fatal("Record: err = nil, want an error for an unrecognized Visibility")
		}
	})

	t.Run("cross-agent isolation: member-private memory is not visible to another agent in the same room", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		ctx := context.Background()
		roomID := "rom_1"

		if _, err := s.Record(ctx, memory.RecordRequest{
			RoomID: roomID, AgentID: "agt_1", Content: "private to agt_1",
			Visibility:    memory.VisibilityMember,
			SourceEventID: "evt_1", IdempotencyKey: "key_1",
		}); err != nil {
			t.Fatalf("Record: %v", err)
		}

		result, err := s.PrepareContext(ctx, memory.PrepareRequest{RoomID: roomID, AgentID: "agt_2", Purpose: "private to agt_1"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateEmpty || len(result.Memories) != 0 {
			t.Errorf("agt_2's PrepareContext = %+v, want empty (agt_1's private memory leaked)", result)
		}

		// The writer's own PrepareContext call still sees it.
		own, err := s.PrepareContext(ctx, memory.PrepareRequest{RoomID: roomID, AgentID: "agt_1", Purpose: "private to agt_1"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if own.State != memory.StateReady || len(own.Memories) != 1 {
			t.Errorf("agt_1's own PrepareContext = %+v, want its private memory admitted", own)
		}
	})

	t.Run("room-shared memory is visible to every agent in the room", func(t *testing.T) {
		t.Parallel()

		s := newStore()
		ctx := context.Background()
		roomID := "rom_1"

		// Visibility left at its zero value: the default must be room-shared.
		if _, err := s.Record(ctx, memory.RecordRequest{
			RoomID: roomID, AgentID: "agt_1", Content: "shared with the whole room",
			SourceEventID: "evt_1", IdempotencyKey: "key_1",
		}); err != nil {
			t.Fatalf("Record: %v", err)
		}

		for _, agentID := range []string{"agt_1", "agt_2"} {
			result, err := s.PrepareContext(ctx, memory.PrepareRequest{RoomID: roomID, AgentID: agentID, Purpose: "shared with the whole room"})
			if err != nil {
				t.Fatalf("PrepareContext(%s): %v", agentID, err)
			}
			if result.State != memory.StateReady || len(result.Memories) != 1 {
				t.Errorf("PrepareContext(%s) = %+v, want the shared memory admitted", agentID, result)
			}
		}
	})
}
