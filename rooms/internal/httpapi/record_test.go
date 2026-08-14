package httpapi_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/rooms/internal/memory"
	"github.com/zerkerlabs/gateway/rooms/internal/receipt"
)

// Completing a room is Rooms asserting its own accepted outcome, so it must
// be recorded — not proposed — as authoritative room memory, carrying the
// room event's own identity as SourceEventID and a non-empty, deterministic
// IdempotencyKey.
func TestHandleCompleteRoom_RecordsAcceptedOutcome(t *testing.T) {
	t.Parallel()

	rec := &recordingMemoryStore{Store: memory.NewFake(), recordedCh: make(chan struct{}, 1)}
	mux, store, _ := newMuxWithReceipts(t, rec, unreachableGateway{t}, receipt.NewFake())
	roomID, _ := roomAndMember(t, store, 0)

	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/complete", nil, tenantA))
	if httpRec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", httpRec.Code, http.StatusOK, httpRec.Body.String())
	}

	waitForRecord(t, rec)

	got := rec.Recorded()
	if len(got) != 1 {
		t.Fatalf("Recorded() = %+v, want exactly one call", got)
	}
	if got[0].RoomID != roomID {
		t.Errorf("RoomID = %q, want %q", got[0].RoomID, roomID)
	}
	if got[0].AgentID == "" {
		t.Error("AgentID is empty, want a non-empty contributor identity")
	}
	if !strings.Contains(got[0].Content, "completed") {
		t.Errorf("Content = %q, want it to describe the room as completed", got[0].Content)
	}
	if got[0].SourceEventID == "" {
		t.Error("SourceEventID is empty, want the room event's own identity")
	}
	if got[0].IdempotencyKey == "" {
		t.Error("IdempotencyKey is empty, want a deterministic, non-empty key")
	}
	if n := len(rec.Proposed()); n != 0 {
		t.Errorf("Proposed() had %d calls, want 0 — a room outcome is Recorded, never Proposed", n)
	}
}

// Posting a message that exceeds the room's turn budget abandons it — the
// store appends the room_terminated event synchronously as part of the same
// call that rejects the message — and that accepted outcome must be recorded
// the same way an explicit completion is.
func TestHandlePostMessage_TurnBudgetExceededRecordsAbandonment(t *testing.T) {
	t.Parallel()

	rec := &recordingMemoryStore{Store: memory.NewFake(), proposedCh: make(chan struct{}, 2), recordedCh: make(chan struct{}, 1)}
	mux, store, _ := newMuxWithReceipts(t, rec, unreachableGateway{t}, receipt.NewFake())
	roomID, memberID := roomAndMember(t, store, 1)

	// Spends the room's only turn.
	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/messages",
		map[string]any{"member_id": memberID, "body": "first"}, tenantA))
	if httpRec.Code != http.StatusCreated {
		t.Fatalf("first post status = %d, want %d; body = %s", httpRec.Code, http.StatusCreated, httpRec.Body.String())
	}
	waitForPropose(t, rec)

	// Exceeds it, abandoning the room.
	httpRec = httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/messages",
		map[string]any{"member_id": memberID, "body": "over budget"}, tenantA))
	if httpRec.Code != http.StatusConflict {
		t.Fatalf("second post status = %d, want %d; body = %s", httpRec.Code, http.StatusConflict, httpRec.Body.String())
	}

	waitForRecord(t, rec)

	got := rec.Recorded()
	if len(got) != 1 {
		t.Fatalf("Recorded() = %+v, want exactly one call", got)
	}
	if got[0].RoomID != roomID {
		t.Errorf("RoomID = %q, want %q", got[0].RoomID, roomID)
	}
	if !strings.Contains(got[0].Content, "abandoned") {
		t.Errorf("Content = %q, want it to describe the room as abandoned", got[0].Content)
	}
	if got[0].SourceEventID == "" {
		t.Error("SourceEventID is empty, want the room event's own identity")
	}
	if got[0].IdempotencyKey == "" {
		t.Error("IdempotencyKey is empty, want a deterministic, non-empty key")
	}
}

// Seating a member is Rooms-owned bookkeeping the memory backend would just
// feed back in as context — it must never reach Record.
func TestHandleAddMember_DoesNotRecord(t *testing.T) {
	t.Parallel()

	rec := &recordingMemoryStore{Store: memory.NewFake()}
	mux, store, _ := newMuxWithReceipts(t, rec, unreachableGateway{t}, receipt.NewFake())
	roomID := mustCreateRoom(t, store, "goal").ID

	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/members",
		map[string]any{"agent_id": "agt_1"}, tenantA))
	if httpRec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", httpRec.Code, http.StatusCreated, httpRec.Body.String())
	}

	if n := rec.RecordCalls(); n != 0 {
		t.Errorf("Record was called %d times for a member_joined event, want 0", n)
	}
}

// A confirmed delivery (message_delivered) is transport telemetry, not an
// accepted transition — it must never reach Record.
func TestHandlePostMessage_DeliveredMessageDoesNotRecord(t *testing.T) {
	t.Parallel()

	gw := newCountingGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"invocation_id":"inv_test"}`))
	})
	rec := &recordingMemoryStore{Store: memory.NewFake(), proposedCh: make(chan struct{}, 1)}

	mux, store, _ := newMuxWithReceipts(t, rec, gw, receipt.NewFake())
	roomID, memberID := roomAndMember(t, store, 0)
	recipient := mustAddMember(t, store, roomID, "agt_recipient")

	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/messages",
		map[string]any{"member_id": memberID, "to_member_id": recipient.ID, "body": "hello"}, tenantA))
	if httpRec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", httpRec.Code, http.StatusCreated, httpRec.Body.String())
	}
	waitForPropose(t, rec)

	if n := rec.RecordCalls(); n != 0 {
		t.Errorf("Record was called %d times for a message_delivered event, want 0", n)
	}
}

// A failed proxied call (delivery_failed) is not knowledge about the task —
// it must never reach Record.
func TestHandlePostMessage_DeliveryFailureDoesNotRecord(t *testing.T) {
	t.Parallel()

	gw := newCountingGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	rec := &recordingMemoryStore{Store: memory.NewFake()}

	mux, store, _ := newMuxWithReceipts(t, rec, gw, receipt.NewFake())
	roomID, memberID := roomAndMember(t, store, 0)
	recipient := mustAddMember(t, store, roomID, "agt_recipient")

	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/messages",
		map[string]any{"member_id": memberID, "to_member_id": recipient.ID, "body": "hello"}, tenantA))
	if httpRec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d; body = %s", httpRec.Code, http.StatusUnprocessableEntity, httpRec.Body.String())
	}

	if n := rec.RecordCalls(); n != 0 {
		t.Errorf("Record was called %d times for a delivery_failed event, want 0", n)
	}
}

// A record failure must not fail the room operation it describes: the room
// is terminated whether or not its memory write succeeded.
func TestHandleCompleteRoom_RecordFailureIsFailOpen(t *testing.T) {
	t.Parallel()

	rec := &recordingMemoryStore{
		Store: memory.NewFake(), err: nil, recordedCh: make(chan struct{}, 1),
	}
	rec.Store = &alwaysFailingRecord{Store: memory.NewFake()}

	mux, store, _ := newMuxWithReceipts(t, rec, unreachableGateway{t}, receipt.NewFake())
	roomID, _ := roomAndMember(t, store, 0)

	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/complete", nil, tenantA))
	if httpRec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d despite a permanently failing memory backend; body = %s", httpRec.Code, http.StatusOK, httpRec.Body.String())
	}

	waitForRecord(t, rec)

	got, err := store.GetRoom(context.Background(), tenantA, roomID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if got.State != "completed" {
		t.Errorf("room state = %q, want %q — a failed record must not roll back termination", got.State, "completed")
	}
}

// Recording a room's outcome must not add the memory backend's latency to
// the complete-room request path.
func TestHandleCompleteRoom_RecordIsAsyncAndDoesNotBlockRequest(t *testing.T) {
	t.Parallel()

	// recordBlock is never closed in this test: the store hangs until
	// Shutdown cancels it below, which is exactly the case the request path
	// must not wait on.
	rec := &recordingMemoryStore{Store: memory.NewFake(), recordBlock: make(chan struct{})}
	mux, store, h := newMuxWithReceipts(t, rec, unreachableGateway{t}, receipt.NewFake())
	roomID, _ := roomAndMember(t, store, 0)

	start := time.Now()
	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/complete", nil, tenantA))
	elapsed := time.Since(start)

	if httpRec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", httpRec.Code, http.StatusOK, httpRec.Body.String())
	}
	if elapsed > time.Second {
		t.Errorf("request took %s while its Record call was hung — the request path blocked on the memory backend", elapsed)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
}

// Handler.Shutdown must cancel an in-flight Record call rather than waiting
// out its own timeout (recordTimeout, 10s) — a record goroutine must not
// outlive the service.
func TestHandler_ShutdownDrainsRecordGoroutines(t *testing.T) {
	t.Parallel()

	rec := &recordingMemoryStore{Store: memory.NewFake(), recordBlock: make(chan struct{})}
	mux, store, h := newMuxWithReceipts(t, rec, unreachableGateway{t}, receipt.NewFake())
	roomID, _ := roomAndMember(t, store, 0)

	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/complete", nil, tenantA))
	if httpRec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", httpRec.Code, http.StatusOK, httpRec.Body.String())
	}

	start := time.Now()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("Shutdown() = %v, want nil", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("Shutdown took %s, want well under the 10s record timeout — the record goroutine was not cancelled promptly", elapsed)
	}
}

// alwaysFailingRecord wraps a memory.Store so every Record call fails,
// exercising the write path's fail-open posture without relying on
// recordingMemoryStore's single shared err field also affecting Propose.
type alwaysFailingRecord struct {
	memory.Store
}

func (s *alwaysFailingRecord) Record(context.Context, memory.RecordRequest) (memory.WriteResult, error) {
	return memory.WriteResult{}, errAlwaysFailingRecord
}

var errAlwaysFailingRecord = &memory.ClientError{Class: memory.ErrorClassTransport}
