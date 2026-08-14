package httpapi

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/zerkerlabs/gateway/rooms/internal/memory"
	"github.com/zerkerlabs/gateway/rooms/internal/room"
)

// recordTimeout bounds a single Record call so a slow or hanging memory
// backend can't pin a goroutine indefinitely, or past Shutdown's drain
// window — mirrors proposeTimeout and receiptEmitTimeout.
const recordTimeout = 10 * time.Second

// recordAgentID is the contributor Record calls attribute Rooms' own
// asserted writes to. A room_terminated or task_state_changed event is an
// accepted transition the Rooms service itself is asserting, not any one
// member's claim — unlike a posted message, there is no agent to credit — so
// this fixed identity names the asserting service instead of a
// agt_-prefixed member.
const recordAgentID = "rooms"

// recordableContent derives the memory Content a room event should be
// recorded with, and whether it should be recorded at all. Only
// EventRoomTerminated carries a payload today; EventTaskStateChanged is
// declared but no code path emits it yet (see its doc comment in room.go),
// so there is nothing to derive a payload from and it falls through to the
// default. The key derivation, async dispatch, and fail-open handling below
// are kind-agnostic and would carry a second kind unchanged.
//
// **recordTerminalEvent is not.** It locates the event to record by scanning
// for the first recognized one, which is exact only because this function
// recognizes a single kind and a room terminates exactly once. Adding a case
// here breaks that: a room could then hold a task-state change AND a
// termination, and the scan would silently record whichever came first and
// drop the other. So adding a kind means deciding there what "the event to
// record" means when there are several — record each one, or select by kind
// per call site — not just adding a case here.
//
// Every other kind — member_joined, message_posted (routed to Propose
// instead, never Record), message_delivered, delivery_failed — is
// deliberately absent: writing them here would be a policy change, not a bug
// fix, so absence has to read as "considered and excluded," not "forgotten."
func recordableContent(ev *room.Event) (string, bool) {
	switch p := ev.Payload.(type) {
	case room.RoomTerminatedPayload:
		return fmt.Sprintf("room %s", p.State), true
	default:
		return "", false
	}
}

// recordEventSourceID derives a room event's own identity as a memory
// backend source_event_id. A room's (roomID, Sequence) pair is exactly what
// makes one of its events durable and unique (room.Event.Sequence is
// contiguous per room), so two calls for the same event always compute the
// same ID.
func recordEventSourceID(roomID string, ev *room.Event) string {
	return roomID + ":" + strconv.Itoa(ev.Sequence)
}

// recordIdempotencyKey deterministically derives a Record call's idempotency
// key from a room event's own identity, mirroring proposeIdempotencyKey: two
// calls for the same event always compute the same key, so a replayed or
// duplicated call is a safe no-op rather than a second recorded memory.
func recordIdempotencyKey(roomID string, ev *room.Event) string {
	return sha256Digest("record", roomID, strconv.Itoa(ev.Sequence))
}

// doRecord submits content to Record for the room event identified by
// sourceEventID/idempotencyKey. It is the single place every Record call in
// the write path funnels through, so failure handling is defined once:
// fail-open — the room transition this call records already happened and is
// durable whether or not the memory write succeeds — except a 409, which
// means idempotencyKey was reused for content that does not match what it
// was first used for. That can only happen if this file's key derivation is
// wrong, not because the caller did anything invalid, so it is logged as an
// internal error rather than a routine failure and is never retried with a
// different key — retrying would turn a derivation bug into a duplicate
// memory instead of a loud signal to fix it.
func (h *Handler) doRecord(ctx context.Context, roomID, sourceEventID, idempotencyKey, content string) {
	if _, err := h.memoryStore.Record(ctx, memory.RecordRequest{
		RoomID:         roomID,
		AgentID:        recordAgentID,
		Content:        content,
		SourceEventID:  sourceEventID,
		IdempotencyKey: idempotencyKey,
	}); err != nil {
		var ce *memory.ClientError
		if errors.As(err, &ce) && ce.Class == memory.ErrorClassIdempotencyConflict {
			h.logger.Error("record accepted transition: idempotency key reused for different content — key derivation bug",
				"room_id", roomID, "source_event_id", sourceEventID, "err", err)
			return
		}
		h.logger.Warn("record accepted transition failed (fail-open)",
			"room_id", roomID, "source_event_id", sourceEventID, "err", err)
	}
}

// recordTerminalEvent submits r's terminal event to Record.
//
// It finds that event by identity, not by position. Trusting r.Events' LAST
// entry looks equivalent and is not: a room keeps accepting delivery-outcome
// events after it terminates, deliberately — a turn reserved before the
// termination still records what became of its proxied call, which is what
// keeps the transcript honest about a call that really was made. So an
// EventMessageDelivered or EventDeliveryFailed can land after
// room_terminated and displace it from last position, at which point a
// positional read finds nothing recordable and the room's own outcome goes
// unwritten.
//
// Scanning is exact, not merely safer: recordableContent recognizes only
// RoomTerminatedPayload, and a room terminates exactly once, so there is at
// most one match and its Sequence is stable. That also keeps the
// source_event_id and idempotency key derived from it stable across retries.
//
// That exactness is borrowed from recordableContent's single kind, and it is
// the coupling to check before adding a second one — see its doc comment.
func (h *Handler) recordTerminalEvent(ctx context.Context, roomID string, r *room.Room) {
	for _, ev := range r.Events {
		if content, ok := recordableContent(ev); ok {
			h.doRecord(ctx, roomID, recordEventSourceID(roomID, ev), recordIdempotencyKey(roomID, ev), content)
			return
		}
	}
	// Nothing recordable. Callers reach here only for a room that holds no
	// terminal event at all, which for the terminated paths means the write
	// this function exists to make is being skipped — say so rather than
	// returning silently, since a silent skip is indistinguishable from a
	// successful record.
	h.logger.Warn("record accepted transition skipped: no terminal event found in room",
		"room_id", roomID, "events", len(r.Events))
}

// recordRoomTerminated asynchronously submits r's terminal event to Record —
// see recordTerminalEvent. r must already carry the terminal event; where in
// r.Events it sits does not matter, and CompleteRoom's own return value
// satisfies that.
//
// Submission does not block the request path: the room transition it records
// already happened and is durable whether or not this call succeeds, so a
// terminated room stays terminated regardless of what the memory backend
// does. The goroutine is tracked in h.recordWG so Shutdown can drain it, and
// its context derives from h.shutdownCtx so Shutdown cancels a still-running
// call promptly instead of waiting out its full timeout.
func (h *Handler) recordRoomTerminated(roomID string, r *room.Room) {
	h.recordWG.Add(1)
	go func() {
		defer h.recordWG.Done()

		ctx, cancel := context.WithTimeout(h.shutdownCtx, recordTimeout)
		defer cancel()
		h.recordTerminalEvent(ctx, roomID, r)
	}()
}

// recordRoomTerminatedAfterAbandon is recordRoomTerminated for the path that
// does not already hold the post-transition Room: AppendMessage and
// ReserveTurn abandon a room for exceeding its turn budget and append its
// room_terminated event synchronously before returning
// ErrTurnBudgetExceeded, so the event is already durable by the time this
// runs — reading it back happens off the request path, in the same
// goroutine as the Record call itself, so a slow store read cannot stall the
// response either.
//
// Because it re-reads rather than holding a snapshot, this is the path where
// events appended between the abandonment and the read are visible — see
// recordTerminalEvent for why the terminal event is located by identity
// rather than by position.
func (h *Handler) recordRoomTerminatedAfterAbandon(tenantID, roomID string) {
	h.recordWG.Add(1)
	go func() {
		defer h.recordWG.Done()

		ctx, cancel := context.WithTimeout(h.shutdownCtx, recordTimeout)
		defer cancel()

		r, err := h.store.GetRoom(ctx, tenantID, roomID)
		if err != nil {
			h.logger.Warn("record accepted transition failed (fail-open): reload abandoned room",
				"room_id", roomID, "err", err)
			return
		}
		h.recordTerminalEvent(ctx, roomID, r)
	}()
}
