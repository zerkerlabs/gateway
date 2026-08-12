package httpapi_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/rooms/internal/memory"
	"github.com/zerkerlabs/gateway/rooms/internal/receipt"
)

// recordingMemoryStore wraps a memory.Store, recording every Propose call it
// sees and letting a test simulate a failing or hanging backend. PrepareContext
// is delegated to the wrapped Store unchanged; Record calls are counted so a
// test can assert message posting never reaches it.
type recordingMemoryStore struct {
	memory.Store

	mu          sync.Mutex
	proposed    []memory.ProposeRequest
	recordCalls int
	err         error // returned from Propose instead of delegating, when set
	proposedCh  chan struct{}
	block       chan struct{} // read from before Propose does anything; only ctx cancellation unblocks it
}

func (s *recordingMemoryStore) Propose(ctx context.Context, req memory.ProposeRequest) (memory.WriteResult, error) {
	if s.block != nil {
		select {
		case <-s.block:
		case <-ctx.Done():
			return memory.WriteResult{}, ctx.Err()
		}
	}

	s.mu.Lock()
	s.proposed = append(s.proposed, req)
	s.mu.Unlock()

	if s.proposedCh != nil {
		select {
		case s.proposedCh <- struct{}{}:
		default:
		}
	}

	if s.err != nil {
		return memory.WriteResult{}, s.err
	}
	return s.Store.Propose(ctx, req)
}

func (s *recordingMemoryStore) Record(ctx context.Context, req memory.RecordRequest) (memory.WriteResult, error) {
	s.mu.Lock()
	s.recordCalls++
	s.mu.Unlock()
	return s.Store.Record(ctx, req)
}

func (s *recordingMemoryStore) Proposed() []memory.ProposeRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]memory.ProposeRequest(nil), s.proposed...)
}

func (s *recordingMemoryStore) RecordCalls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.recordCalls
}

// waitForPropose fails the test if s does not record a Propose call within
// 2s — generous enough to absorb scheduler noise without masking a bug that
// never proposes at all.
func waitForPropose(t *testing.T, s *recordingMemoryStore) {
	t.Helper()
	select {
	case <-s.proposedCh:
	case <-time.After(2 * time.Second):
		t.Fatal("no message proposed within 2s")
	}
}

// This is the behavioural heart of the write path: an agent's message is a
// claim, not a fact, so it must land quarantined. Posting it must never make
// it retrievable — as admitted content — by any member's subsequent
// PrepareContext call, including the author's own; the author's own call
// must instead show up in that call's withheld count, not vanish as though
// it were never written.
func TestHandlePostMessage_ProposedContentIsQuarantined(t *testing.T) {
	t.Parallel()

	fake := memory.NewFake()
	rec := &recordingMemoryStore{Store: fake, proposedCh: make(chan struct{}, 1)}

	mux, store, _ := newMuxWithReceipts(t, rec, unreachableGateway{t}, receipt.NewFake())
	roomID, authorID := roomAndMember(t, store, 0) // author's AgentID is "agt_1"
	other := mustAddMember(t, store, roomID, "agt_other")

	const body = "the deploy is safe to proceed"

	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/messages",
		map[string]any{"member_id": authorID, "body": body}, tenantA))
	if httpRec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", httpRec.Code, http.StatusCreated, httpRec.Body.String())
	}

	waitForPropose(t, rec)

	// No member of the room — the author included — may ever retrieve the
	// proposed content as admitted memory.
	for _, agentID := range []string{"agt_1", other.AgentID} {
		result, err := fake.PrepareContext(context.Background(), memory.PrepareRequest{
			RoomID: roomID, AgentID: agentID, Purpose: "the deploy",
		})
		if err != nil {
			t.Fatalf("PrepareContext(%s): %v", agentID, err)
		}
		for _, m := range result.Memories {
			if strings.Contains(m.Content, body) {
				t.Errorf("PrepareContext(%s) admitted the proposed message content, want it withheld: %+v", agentID, result.Memories)
			}
		}
	}

	// The author's own context preparation is the one whose scope actually
	// covers this proposal (memory.Fake scopes a write to the AgentID it was
	// proposed under) — it must report the withheld entry in its counts
	// rather than silently dropping it.
	authorResult, err := fake.PrepareContext(context.Background(), memory.PrepareRequest{
		RoomID: roomID, AgentID: "agt_1", Purpose: "the deploy",
	})
	if err != nil {
		t.Fatalf("PrepareContext(agt_1): %v", err)
	}
	if authorResult.Counts.Retrieved == 0 || authorResult.Counts.Withheld == 0 {
		t.Errorf("author's Counts = %+v, want a nonzero Retrieved and Withheld — the proposal must be reported withheld, not discarded", authorResult.Counts)
	}
	if authorResult.Counts.Admitted != 0 {
		t.Errorf("author's Counts.Admitted = %d, want 0 — an unreviewed proposal is never admitted", authorResult.Counts.Admitted)
	}
}

// message_posted events must route to Propose, never Record — recording them
// would make every unreviewed agent assertion authoritative room memory.
func TestHandlePostMessage_RoutesToProposeNeverRecord(t *testing.T) {
	t.Parallel()

	rec := &recordingMemoryStore{Store: memory.NewFake(), proposedCh: make(chan struct{}, 1)}
	mux, store, _ := newMuxWithReceipts(t, rec, unreachableGateway{t}, receipt.NewFake())
	roomID, memberID := roomAndMember(t, store, 0)

	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/messages",
		map[string]any{"member_id": memberID, "body": "hello"}, tenantA))
	if httpRec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", httpRec.Code, http.StatusCreated, httpRec.Body.String())
	}

	waitForPropose(t, rec)

	if n := rec.RecordCalls(); n != 0 {
		t.Errorf("Record was called %d times for a message_posted event, want 0", n)
	}
}

// Each Propose call must carry the room event's own ID as SourceEventID, and
// a non-empty IdempotencyKey so the write is safe to retry.
func TestHandlePostMessage_ProposeCarriesSourceEventAndIdempotencyKey(t *testing.T) {
	t.Parallel()

	rec := &recordingMemoryStore{Store: memory.NewFake(), proposedCh: make(chan struct{}, 1)}
	mux, store, _ := newMuxWithReceipts(t, rec, unreachableGateway{t}, receipt.NewFake())
	roomID, memberID := roomAndMember(t, store, 0)

	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/messages",
		map[string]any{"member_id": memberID, "body": "hello"}, tenantA))
	if httpRec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", httpRec.Code, http.StatusCreated, httpRec.Body.String())
	}
	msgID, _ := decodeBody(t, httpRec)["id"].(string)
	if msgID == "" {
		t.Fatal("response id is empty")
	}

	waitForPropose(t, rec)

	got := rec.Proposed()
	if len(got) != 1 {
		t.Fatalf("Proposed() = %+v, want exactly one call", got)
	}
	if got[0].SourceEventID != msgID {
		t.Errorf("SourceEventID = %q, want the posted message's own ID %q", got[0].SourceEventID, msgID)
	}
	if got[0].IdempotencyKey == "" {
		t.Error("IdempotencyKey is empty, want a deterministic, non-empty key")
	}
	if got[0].RoomID != roomID {
		t.Errorf("RoomID = %q, want %q", got[0].RoomID, roomID)
	}
	if got[0].Content != "hello" {
		t.Errorf("Content = %q, want %q", got[0].Content, "hello")
	}
}

// Two distinct messages must never collide on the same idempotency key.
func TestHandlePostMessage_ProposeIdempotencyKeyDiffersAcrossMessages(t *testing.T) {
	t.Parallel()

	rec := &recordingMemoryStore{Store: memory.NewFake(), proposedCh: make(chan struct{}, 2)}
	mux, store, _ := newMuxWithReceipts(t, rec, unreachableGateway{t}, receipt.NewFake())
	roomID, memberID := roomAndMember(t, store, 0)

	for range 2 {
		httpRec := httptest.NewRecorder()
		mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/messages",
			map[string]any{"member_id": memberID, "body": "hello"}, tenantA))
		if httpRec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want %d; body = %s", httpRec.Code, http.StatusCreated, httpRec.Body.String())
		}
		waitForPropose(t, rec)
	}

	got := rec.Proposed()
	if len(got) != 2 {
		t.Fatalf("Proposed() = %+v, want exactly two calls", got)
	}
	if got[0].SourceEventID == got[1].SourceEventID {
		t.Errorf("two distinct messages shared SourceEventID %q", got[0].SourceEventID)
	}
	if got[0].IdempotencyKey == got[1].IdempotencyKey {
		t.Errorf("two distinct messages shared IdempotencyKey %q", got[0].IdempotencyKey)
	}
}

// A failed proposal must not fail the message post: the message is posted
// and the transcript is correct whether or not the proposal succeeded.
func TestHandlePostMessage_ProposeFailureIsFailOpen(t *testing.T) {
	t.Parallel()

	rec := &recordingMemoryStore{
		Store: memory.NewFake(), err: errors.New("memory backend down"),
		proposedCh: make(chan struct{}, 1),
	}
	mux, store, _ := newMuxWithReceipts(t, rec, unreachableGateway{t}, receipt.NewFake())
	roomID, memberID := roomAndMember(t, store, 0)

	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/messages",
		map[string]any{"member_id": memberID, "body": "hello"}, tenantA))
	if httpRec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d despite a permanently failing memory backend; body = %s", httpRec.Code, http.StatusCreated, httpRec.Body.String())
	}

	// The store was still invoked (fail-open != skipped).
	waitForPropose(t, rec)

	msgs, err := store.Messages(context.Background(), tenantA, roomID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("transcript = %+v, want exactly the one posted message", msgs)
	}
}

// Proposal writes must not add the memory backend's latency to the
// message-post request path.
func TestHandlePostMessage_ProposeIsAsyncAndDoesNotBlockRequest(t *testing.T) {
	t.Parallel()

	// block is never closed in this test: the store hangs until Shutdown
	// cancels it below, which is exactly the case the request path must not
	// wait on.
	rec := &recordingMemoryStore{Store: memory.NewFake(), block: make(chan struct{})}
	mux, store, h := newMuxWithReceipts(t, rec, unreachableGateway{t}, receipt.NewFake())
	roomID, memberID := roomAndMember(t, store, 0)

	start := time.Now()
	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/messages",
		map[string]any{"member_id": memberID, "body": "hello"}, tenantA))
	elapsed := time.Since(start)

	if httpRec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", httpRec.Code, http.StatusCreated, httpRec.Body.String())
	}
	if elapsed > time.Second {
		t.Errorf("request took %s while its proposal was hung — the request path blocked on the memory backend", elapsed)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
}

// Handler.Shutdown must cancel an in-flight proposal rather than waiting out
// its own timeout (proposeTimeout, 10s) — a proposal goroutine must not
// outlive the service.
func TestHandler_ShutdownDrainsProposeGoroutines(t *testing.T) {
	t.Parallel()

	rec := &recordingMemoryStore{Store: memory.NewFake(), block: make(chan struct{})}
	mux, store, h := newMuxWithReceipts(t, rec, unreachableGateway{t}, receipt.NewFake())
	roomID, memberID := roomAndMember(t, store, 0)

	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/messages",
		map[string]any{"member_id": memberID, "body": "hello"}, tenantA))
	if httpRec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", httpRec.Code, http.StatusCreated, httpRec.Body.String())
	}

	start := time.Now()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("Shutdown() = %v, want nil", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("Shutdown took %s, want well under the 10s propose timeout — the proposal goroutine was not cancelled promptly", elapsed)
	}
}

// An addressed message reaches the transcript through CommitTurn rather than
// AppendMessage — a different code path that must propose its message_posted
// event exactly the same way a broadcast message does.
func TestHandlePostMessage_AddressedMessageIsProposed(t *testing.T) {
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

	got := rec.Proposed()
	if len(got) != 1 {
		t.Fatalf("Proposed() = %+v, want exactly one call", got)
	}
	if got[0].Content != "hello" {
		t.Errorf("Content = %q, want %q", got[0].Content, "hello")
	}
	if n := rec.RecordCalls(); n != 0 {
		t.Errorf("Record was called %d times for an addressed message_posted event, want 0", n)
	}
}

// A message body over the memory backend's content limit is rejected up
// front, before anything is posted, rather than discovered as a failed
// proposal after the fact.
func TestHandlePostMessage_BodyOverContentLimitIsRejected(t *testing.T) {
	t.Parallel()

	mux, store := newMux(t)
	roomID, memberID := roomAndMember(t, store, 0)

	oversized := strings.Repeat("a", memory.MaxContentChars+1)

	httpRec := httptest.NewRecorder()
	mux.ServeHTTP(httpRec, requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/messages",
		map[string]any{"member_id": memberID, "body": oversized}, tenantA))
	if httpRec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", httpRec.Code, http.StatusBadRequest, httpRec.Body.String())
	}
	body := decodeBody(t, httpRec)
	if body["code"] != "invalid_field" {
		t.Errorf("code = %v, want %q", body["code"], "invalid_field")
	}

	msgs, err := store.Messages(context.Background(), tenantA, roomID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 0 {
		t.Errorf("transcript = %+v, want empty — an oversized body must never be posted", msgs)
	}
}
