package httpapi

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"

	"github.com/zerkerlabs/gateway/rooms/internal/memory"
	"github.com/zerkerlabs/gateway/rooms/internal/room"
)

func TestRecordableContent_RoomTerminated(t *testing.T) {
	t.Parallel()

	for _, state := range []room.State{room.StateCompleted, room.StateAbandoned} {
		ev := &room.Event{Kind: room.EventRoomTerminated, Payload: room.RoomTerminatedPayload{State: state}}
		content, ok := recordableContent(ev)
		if !ok {
			t.Fatalf("recordableContent(%v) ok = false, want true", state)
		}
		if content == "" {
			t.Errorf("recordableContent(%v) content is empty", state)
		}
	}

	completed, _ := recordableContent(&room.Event{Payload: room.RoomTerminatedPayload{State: room.StateCompleted}})
	abandoned, _ := recordableContent(&room.Event{Payload: room.RoomTerminatedPayload{State: room.StateAbandoned}})
	if completed == abandoned {
		t.Errorf("completed and abandoned produced identical content %q, want distinguishable", completed)
	}
}

// task_state_changed is declared but nothing in this build ever constructs a
// payload for it (room.EventTaskStateChanged's doc comment), so today's
// correct behavior is "not recordable" — not because the kind is excluded on
// purpose the way member_joined is, but because there is nothing yet to
// derive content from. This pins that today's behavior, so a future payload
// type lands as an added case here rather than a silent gap.
func TestRecordableContent_TaskStateChangedHasNoPayloadYet(t *testing.T) {
	t.Parallel()

	_, ok := recordableContent(&room.Event{Kind: room.EventTaskStateChanged, Payload: nil})
	if ok {
		t.Error("recordableContent(task_state_changed, nil payload) ok = true, want false")
	}
}

// member_joined, message_posted, message_delivered, and delivery_failed are
// deliberately excluded from Record — member_joined is Rooms-owned and would
// duplicate a fact the backend feeds back in as context, message_posted goes
// through Propose instead (never Record), and message_delivered /
// delivery_failed are transport telemetry, not knowledge about the task.
func TestRecordableContent_ExcludedKindsAreNotRecordable(t *testing.T) {
	t.Parallel()

	cases := []*room.Event{
		{Kind: room.EventMemberJoined, Payload: room.MemberJoinedPayload{Member: &room.Member{ID: "mem_1"}}},
		{Kind: room.EventMessagePosted, Payload: room.MessagePostedPayload{Message: &room.Message{ID: "msg_1"}}},
		{Kind: room.EventMessageDelivered, Payload: room.MessageDeliveredPayload{}},
		{Kind: room.EventDeliveryFailed, Payload: room.DeliveryFailedPayload{}},
	}
	for _, ev := range cases {
		if _, ok := recordableContent(ev); ok {
			t.Errorf("recordableContent(%s) ok = true, want false", ev.Kind)
		}
	}
}

func TestRecordEventSourceIDDeterministic(t *testing.T) {
	t.Parallel()

	ev := &room.Event{Sequence: 3}
	got1 := recordEventSourceID("rom_1", ev)
	got2 := recordEventSourceID("rom_1", ev)
	if got1 != got2 {
		t.Fatalf("recordEventSourceID is not deterministic: %q != %q", got1, got2)
	}
	if got1 == "" {
		t.Fatal("recordEventSourceID returned an empty ID")
	}
}

func TestRecordEventSourceIDDiffersBySequenceAndRoom(t *testing.T) {
	t.Parallel()

	base := recordEventSourceID("rom_1", &room.Event{Sequence: 1})
	if got := recordEventSourceID("rom_1", &room.Event{Sequence: 2}); got == base {
		t.Errorf("recordEventSourceID unchanged across sequence numbers: %q", got)
	}
	if got := recordEventSourceID("rom_2", &room.Event{Sequence: 1}); got == base {
		t.Errorf("recordEventSourceID unchanged across rooms: %q", got)
	}
}

func TestRecordIdempotencyKeyDeterministic(t *testing.T) {
	t.Parallel()

	ev := &room.Event{Sequence: 1}
	got1 := recordIdempotencyKey("rom_1", ev)
	got2 := recordIdempotencyKey("rom_1", ev)
	if got1 != got2 {
		t.Fatalf("recordIdempotencyKey is not deterministic: %q != %q", got1, got2)
	}
	if got1 == "" {
		t.Fatal("recordIdempotencyKey returned an empty key")
	}
}

func TestRecordIdempotencyKeyDiffersBySequenceAndRoom(t *testing.T) {
	t.Parallel()

	base := recordIdempotencyKey("rom_1", &room.Event{Sequence: 1})
	if got := recordIdempotencyKey("rom_1", &room.Event{Sequence: 2}); got == base {
		t.Errorf("recordIdempotencyKey unchanged across sequence numbers: %q", got)
	}
	if got := recordIdempotencyKey("rom_2", &room.Event{Sequence: 1}); got == base {
		t.Errorf("recordIdempotencyKey unchanged across rooms: %q", got)
	}
}

// idempotentRecordStore is a minimal memory.Store double that implements the
// real backend's documented Record contract precisely enough to test against:
// keyed by IdempotencyKey, a replay with identical content is a no-op, and
// reusing a key for different content returns the same
// ErrorClassIdempotencyConflict shape a real backend's 409 is reclassified
// into (see ZMemClient.write). memory.Fake does not implement this — it has
// no idempotency dedup at all — so this stands in for it in this file only.
type idempotentRecordStore struct {
	memory.Store

	mu    sync.Mutex
	byKey map[string]string // idempotency key -> content
	calls int
}

func newIdempotentRecordStore() *idempotentRecordStore {
	return &idempotentRecordStore{Store: memory.NewFake(), byKey: make(map[string]string)}
}

func (s *idempotentRecordStore) Record(_ context.Context, req memory.RecordRequest) (memory.WriteResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++

	if prior, ok := s.byKey[req.IdempotencyKey]; ok {
		if prior != req.Content {
			return memory.WriteResult{}, &memory.ClientError{Class: memory.ErrorClassIdempotencyConflict, StatusCode: 409}
		}
		return memory.WriteResult{ID: "mem_replay"}, nil
	}
	s.byKey[req.IdempotencyKey] = req.Content
	return memory.WriteResult{ID: "mem_new"}, nil
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// Driving the same room event through the write path twice — a retry, or a
// crash-and-replay — must never produce a second recorded memory: same key,
// same content, safe no-op.
func TestRecordTerminalEvent_ReplayingSameEventIsANoOp(t *testing.T) {
	t.Parallel()

	store := newIdempotentRecordStore()
	h := NewHandler(room.NewMemoryStore(), store, memory.ContextPolicy{}, nil, nil, testLogger())

	r := &room.Room{Events: []*room.Event{
		{Sequence: 1, Kind: room.EventRoomTerminated, Payload: room.RoomTerminatedPayload{State: room.StateCompleted}},
	}}

	ctx := context.Background()
	h.recordTerminalEvent(ctx, "rom_1", r)
	h.recordTerminalEvent(ctx, "rom_1", r)

	store.mu.Lock()
	defer store.mu.Unlock()
	if store.calls != 2 {
		t.Errorf("Record called %d times, want 2 — both calls must reach the backend; it is the backend's key that dedupes them", store.calls)
	}
	if len(store.byKey) != 1 {
		t.Errorf("stored %d distinct memories, want 1 (a replay must not create a duplicate)", len(store.byKey))
	}
}

// A key collision with different content can only mean this file's key
// derivation is broken — it must be logged loudly and never retried with a
// different key, which would silently paper over the bug instead of
// surfacing it.
func TestRecordTerminalEvent_KeyCollisionWithDifferentContentIsNotRetried(t *testing.T) {
	t.Parallel()

	store := newIdempotentRecordStore()
	h := NewHandler(room.NewMemoryStore(), store, memory.ContextPolicy{}, nil, nil, testLogger())

	ctx := context.Background()
	completed := &room.Event{Sequence: 1, Kind: room.EventRoomTerminated, Payload: room.RoomTerminatedPayload{State: room.StateCompleted}}
	h.recordTerminalEvent(ctx, "rom_1", &room.Room{Events: []*room.Event{completed}})

	// Same room and sequence — the same idempotency key — but different
	// content. This can only arise from a key-derivation bug; the test forces
	// it directly rather than trying to reproduce the bug itself.
	abandoned := &room.Event{Sequence: 1, Kind: room.EventRoomTerminated, Payload: room.RoomTerminatedPayload{State: room.StateAbandoned}}
	h.recordTerminalEvent(ctx, "rom_1", &room.Room{Events: []*room.Event{abandoned}})

	store.mu.Lock()
	defer store.mu.Unlock()
	if store.calls != 2 {
		t.Fatalf("Record called %d times, want exactly 2 (a conflict must not be retried with a mutated key)", store.calls)
	}
	if got := store.byKey[recordIdempotencyKey("rom_1", completed)]; got != "room completed" {
		t.Errorf("stored content = %q, want the first write's content left untouched (%q)", got, "room completed")
	}
}

// A Room whose last event is not a recordable kind — e.g. one still open, or
// one about to have a member seated — must produce zero Record calls.
func TestRecordTerminalEvent_NonRecordableLastEventIsANoOp(t *testing.T) {
	t.Parallel()

	store := newIdempotentRecordStore()
	h := NewHandler(room.NewMemoryStore(), store, memory.ContextPolicy{}, nil, nil, testLogger())

	r := &room.Room{Events: []*room.Event{
		{Sequence: 1, Kind: room.EventMemberJoined, Payload: room.MemberJoinedPayload{Member: &room.Member{ID: "mem_1"}}},
	}}
	h.recordTerminalEvent(context.Background(), "rom_1", r)

	store.mu.Lock()
	defer store.mu.Unlock()
	if store.calls != 0 {
		t.Errorf("Record called %d times for a member_joined event, want 0", store.calls)
	}
}

// A Room with no events at all must not panic and must produce zero Record
// calls.
func TestRecordTerminalEvent_EmptyRoomIsANoOp(t *testing.T) {
	t.Parallel()

	store := newIdempotentRecordStore()
	h := NewHandler(room.NewMemoryStore(), store, memory.ContextPolicy{}, nil, nil, testLogger())

	h.recordTerminalEvent(context.Background(), "rom_1", &room.Room{})

	store.mu.Lock()
	defer store.mu.Unlock()
	if store.calls != 0 {
		t.Errorf("Record called %d times for a room with no events, want 0", store.calls)
	}
}
