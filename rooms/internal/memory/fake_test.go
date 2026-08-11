package memory_test

import (
	"context"
	"sync"
	"testing"

	"github.com/zerkerlabs/gateway/rooms/internal/memory"
	"github.com/zerkerlabs/gateway/rooms/internal/memory/memorytest"
)

func TestFake_Contract(t *testing.T) {
	t.Parallel()

	memorytest.RunContract(t, func() memory.Store {
		return memory.NewFake()
	})
}

// TestFake_VisibilityContract pins the Fake's room-shared vs member-private
// behaviour. Only the Fake runs this suite — see RunVisibilityContract for
// why it is not part of the shared contract, and what has to change before
// it can be.
func TestFake_VisibilityContract(t *testing.T) {
	t.Parallel()

	memorytest.RunVisibilityContract(t, func() memory.Store {
		return memory.NewFake()
	})
}

// TestFake_ConcurrentWritesDoNotRace exercises the Fake's write and read
// paths from many goroutines at once; run with -race (make check's test
// target does).
func TestFake_ConcurrentWritesDoNotRace(t *testing.T) {
	t.Parallel()

	const n = 50
	f := memory.NewFake()
	roomID, agentID := "rom_1", "agt_1"

	var wg sync.WaitGroup
	wg.Add(n)
	for i := range n {
		go func(i int) {
			defer wg.Done()
			req := memory.RecordRequest{RoomID: roomID, AgentID: agentID, Content: "entry", SourceEventID: "evt", IdempotencyKey: "key"}
			if _, err := f.Record(context.Background(), req); err != nil {
				t.Errorf("Record %d: %v", i, err)
			}
		}(i)
	}
	wg.Wait()

	result, err := f.PrepareContext(context.Background(), memory.PrepareRequest{RoomID: roomID, AgentID: agentID})
	if err != nil {
		t.Fatalf("PrepareContext: %v", err)
	}
	if len(result.Memories) != n {
		t.Errorf("len(Memories) = %d, want %d", len(result.Memories), n)
	}
}

// TestFake_DrivesEachState exercises every one of the six states a
// PrepareContext call may return, since memorytest.RunContract exercises
// most of them only through the Store interface — this test is the
// authoritative place all six are named and driven from one Fake.
func TestFake_DrivesEachState(t *testing.T) {
	t.Parallel()

	ctx := context.Background()

	t.Run(string(memory.StateEmpty), func(t *testing.T) {
		t.Parallel()
		f := memory.NewFake()
		result, err := f.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateEmpty {
			t.Errorf("State = %q, want %q", result.State, memory.StateEmpty)
		}
	})

	t.Run(string(memory.StateReady), func(t *testing.T) {
		t.Parallel()
		f := memory.NewFake()
		if _, err := f.Record(ctx, memory.RecordRequest{RoomID: "rom_1", AgentID: "agt_1", Content: "fact", SourceEventID: "evt_1", IdempotencyKey: "key_1"}); err != nil {
			t.Fatalf("Record: %v", err)
		}
		result, err := f.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateReady {
			t.Errorf("State = %q, want %q", result.State, memory.StateReady)
		}
	})

	t.Run(string(memory.StatePartial), func(t *testing.T) {
		t.Parallel()
		f := memory.NewFake()
		if _, err := f.Record(ctx, memory.RecordRequest{RoomID: "rom_1", AgentID: "agt_1", Content: "accepted", SourceEventID: "evt_1", IdempotencyKey: "key_1"}); err != nil {
			t.Fatalf("Record: %v", err)
		}
		if _, err := f.Propose(ctx, memory.ProposeRequest{RoomID: "rom_1", AgentID: "agt_1", Content: "unreviewed", SourceEventID: "evt_2", IdempotencyKey: "key_2"}); err != nil {
			t.Fatalf("Propose: %v", err)
		}
		result, err := f.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StatePartial {
			t.Errorf("State = %q, want %q", result.State, memory.StatePartial)
		}
	})

	t.Run(string(memory.StateBlocked), func(t *testing.T) {
		t.Parallel()
		f := memory.NewFake()
		if _, err := f.Propose(ctx, memory.ProposeRequest{RoomID: "rom_1", AgentID: "agt_1", Content: "unreviewed", SourceEventID: "evt_1", IdempotencyKey: "key_1"}); err != nil {
			t.Fatalf("Propose: %v", err)
		}
		result, err := f.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateBlocked {
			t.Errorf("State = %q, want %q", result.State, memory.StateBlocked)
		}
	})

	t.Run(string(memory.StateAbstained), func(t *testing.T) {
		t.Parallel()
		f := memory.NewFake()
		f.SetAbstain("rom_1", "agt_1")
		result, err := f.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateAbstained {
			t.Errorf("State = %q, want %q", result.State, memory.StateAbstained)
		}
	})

	t.Run(string(memory.StateBudgetExhausted), func(t *testing.T) {
		t.Parallel()
		f := memory.NewFake()
		if _, err := f.Record(ctx, memory.RecordRequest{RoomID: "rom_1", AgentID: "agt_1", Content: "too long for the budget", SourceEventID: "evt_1", IdempotencyKey: "key_1"}); err != nil {
			t.Fatalf("Record: %v", err)
		}
		result, err := f.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1", ContextBudgetTokens: 1})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateBudgetExhausted {
			t.Errorf("State = %q, want %q", result.State, memory.StateBudgetExhausted)
		}
	})
}
