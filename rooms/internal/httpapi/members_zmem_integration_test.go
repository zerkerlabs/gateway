//go:build integration

package httpapi_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/zerkerlabs/gateway/rooms/internal/memory"
)

// zmemIntegrationCIMarker is set by GitHub Actions (and most other CI
// providers) on every job. Its presence is how this test tells "a human ran
// `go test -tags=integration` on a laptop with no backend handy, skip" apart
// from "CI ran this job and the backend it is supposed to have started is
// missing" — the latter must fail loudly, not skip, per
// rooms/internal/memory/zmem_integration_test.go, whose ZMEM_TEST_* variables
// and skip/fail convention this test reuses rather than adding a second one.
const zmemIntegrationCIMarker = "CI"

// newZMemIntegrationClient returns a *memory.ZMemClient pointed at the real
// backend the integration job starts, using the same ZMEM_TEST_BASE_URL,
// ZMEM_TEST_SERVICE_TOKEN, and ZMEM_TEST_TENANT_ID variables
// TestZMemClient_Contract_Integration reads. It skips locally when any of
// them is unset, and fails when CI is set instead — an unset variable there
// means the job's setup broke, not that no backend is available.
func newZMemIntegrationClient(t *testing.T) *memory.ZMemClient {
	t.Helper()

	baseURL := os.Getenv("ZMEM_TEST_BASE_URL")
	token := os.Getenv("ZMEM_TEST_SERVICE_TOKEN")
	tenantID := os.Getenv("ZMEM_TEST_TENANT_ID")
	if baseURL == "" || token == "" || tenantID == "" {
		msg := "ZMEM_TEST_BASE_URL, ZMEM_TEST_SERVICE_TOKEN, and ZMEM_TEST_TENANT_ID not all set"
		if os.Getenv(zmemIntegrationCIMarker) != "" {
			t.Fatalf("%s, but %s is set — the integration job must start a backend and provide these", msg, zmemIntegrationCIMarker)
		}
		t.Skip(msg + "; skipping integration test")
	}

	c, err := memory.NewZMemClient(memory.ZMemConfig{BaseURL: baseURL, ServiceToken: token, TenantID: tenantID}, nil)
	if err != nil {
		t.Fatalf("NewZMemClient: %v", err)
	}
	return c
}

// TestHandleAddMember_ZMemIntegration_MemoryPresent joins a room against a
// real backend after content has been recorded into it, and checks that the
// join seats the member with that memory admitted — the same assertion
// TestHandleAddMemberContextStates makes against memory.Fake, but here
// nothing stands in for the backend: this is the seam's real HTTP client,
// commitment verification and all, talking to a real `zmem serve` process.
func TestHandleAddMember_ZMemIntegration_MemoryPresent(t *testing.T) {
	t.Parallel()

	client := newZMemIntegrationClient(t)
	mux, store := newMuxWithMemory(t, client)

	// The room's goal is sent verbatim as the retrieval purpose, and the
	// backend ANDs its terms: EVERY word in the goal must appear in a memory
	// for that memory to be retrieved at all. So this goal is deliberately a
	// subset of the content below, not a natural-sounding paraphrase of it.
	// An earlier version read "recall the launch decision" and retrieved
	// nothing, because "recall" appears nowhere in the content — the whole
	// query then matches nothing rather than degrading to a partial match.
	// TestHandleAddMember_ZMemIntegration_PurposeTermAbsentRetrievesNothing
	// pins that behaviour; do not "improve" this goal's wording without
	// reading it first.
	roomID := mustCreateRoom(t, store, "the launch decision").ID
	if _, err := client.Record(context.Background(), memory.RecordRequest{
		RoomID: roomID, AgentID: "agt_1", Content: "the launch decision was to proceed",
		SourceEventID: "evt_1", IdempotencyKey: "key_1",
	}); err != nil {
		t.Fatalf("Record: %v", err)
	}

	req := requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/members", map[string]any{"agent_id": "agt_1"}, tenantA)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	body := decodeBody(t, rec)
	ctx, ok := body["context"].(map[string]any)
	if !ok {
		t.Fatalf("context = %v, want an object", body["context"])
	}
	if ctx["state"] != "ready" {
		t.Errorf("context.state = %v, want %q", ctx["state"], "ready")
	}
	counts, ok := ctx["counts"].(map[string]any)
	if !ok || counts["admitted"] != float64(1) {
		t.Errorf("context.counts = %v, want admitted=1", ctx["counts"])
	}

	got, err := store.GetRoom(context.Background(), tenantA, roomID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if len(got.Members) != 1 {
		t.Fatalf("Members = %v, want a single member", got.Members)
	}
	if want := []string{"the launch decision was to proceed"}; len(got.Members[0].AdmittedMemory) != 1 || got.Members[0].AdmittedMemory[0] != want[0] {
		t.Errorf("AdmittedMemory = %v, want %v", got.Members[0].AdmittedMemory, want)
	}
}

// TestHandleAddMember_ZMemIntegration_NoMemory joins a fresh room a real
// backend has never seen any content for. The backend returns StateEmpty —
// not an error — and the join must still seat the member, with an explicit
// no-prior-memory marker rather than an admitted count.
func TestHandleAddMember_ZMemIntegration_NoMemory(t *testing.T) {
	t.Parallel()

	client := newZMemIntegrationClient(t)
	mux, store := newMuxWithMemory(t, client)

	roomID := mustCreateRoom(t, store, "a brand new room with no history").ID

	req := requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/members", map[string]any{"agent_id": "agt_1"}, tenantA)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	body := decodeBody(t, rec)
	ctx, ok := body["context"].(map[string]any)
	if !ok {
		t.Fatalf("context = %v, want an object", body["context"])
	}
	if ctx["state"] != "empty" {
		t.Errorf("context.state = %v, want %q", ctx["state"], "empty")
	}

	got, err := store.GetRoom(context.Background(), tenantA, roomID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if len(got.Members) != 1 {
		t.Errorf("Members = %v, want a single member seated with no prior memory", got.Members)
	}
}

// TestHandleAddMember_ZMemIntegration_RefusedPolicyAdmittedNothing joins a
// room where the only content a real backend has for it was Proposed, not
// Recorded — quarantined and unreviewed. Policy admits none of it, the
// backend returns StateBlocked, and the join must be refused with 409 rather
// than seating a member who believes it was onboarded and holds nothing.
func TestHandleAddMember_ZMemIntegration_RefusedPolicyAdmittedNothing(t *testing.T) {
	t.Parallel()

	client := newZMemIntegrationClient(t)
	mux, store := newMuxWithMemory(t, client)

	roomID := mustCreateRoom(t, store, "an unreviewed agent claim").ID
	if _, err := client.Propose(context.Background(), memory.ProposeRequest{
		RoomID: roomID, AgentID: "agt_1", Content: "an unreviewed agent claim about the outcome",
		SourceEventID: "evt_1", IdempotencyKey: "key_1",
	}); err != nil {
		t.Fatalf("Propose: %v", err)
	}

	req := requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/members", map[string]any{"agent_id": "agt_1"}, tenantA)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	body := decodeBody(t, rec)
	if body["code"] != "memory_blocked" {
		t.Errorf("code = %v, want %q", body["code"], "memory_blocked")
	}

	got, err := store.GetRoom(context.Background(), tenantA, roomID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if len(got.Members) != 0 {
		t.Errorf("Members = %v, want empty after a refused join", got.Members)
	}
}

// TestHandleAddMember_ZMemIntegration_PurposeTermAbsentRetrievesNothing pins
// the retrieval semantics the join path inherits, because they are not
// obvious and they decide whether a member is onboarded with context or with
// nothing.
//
// The room's goal is the retrieval purpose (spec decision), it is sent
// verbatim, and the backend combines its terms with AND. There is no stopword
// removal and no stemming. So a goal containing a single word that appears
// nowhere in a memory retrieves that memory not at all — retrieval does not
// degrade to a partial or ranked match, it returns empty.
//
// The content here is squarely on-topic for the goal by any human reading, and
// is still not retrieved. That is the point of the test: the failure mode is
// silent, produces a well-formed 201 with an empty context, and looks
// identical to a room that genuinely has no memory.
func TestHandleAddMember_ZMemIntegration_PurposeTermAbsentRetrievesNothing(t *testing.T) {
	t.Parallel()

	client := newZMemIntegrationClient(t)
	mux, store := newMuxWithMemory(t, client)

	// "safely" and "product" appear nowhere in the content below.
	roomID := mustCreateRoom(t, store, "ship the product safely").ID
	if _, err := client.Record(context.Background(), memory.RecordRequest{
		RoomID: roomID, AgentID: "agt_1",
		Content:       "we agreed to ship on Friday after the security review passed",
		SourceEventID: "evt_1", IdempotencyKey: "key_1",
	}); err != nil {
		t.Fatalf("Record: %v", err)
	}

	req := requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/members", map[string]any{"agent_id": "agt_1"}, tenantA)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	// Seated, with a 201 and an empty context — indistinguishable from a room
	// that has no memory at all.
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	ctx, ok := decodeBody(t, rec)["context"].(map[string]any)
	if !ok {
		t.Fatalf("context = %v, want an object", decodeBody(t, rec)["context"])
	}
	if ctx["state"] != "empty" {
		t.Errorf("context.state = %v, want %q — if this now returns memory, the backend's "+
			"retrieval stopped being strict-AND and the join path's behaviour changed with it",
			ctx["state"], "empty")
	}

	// The same content IS retrieved when every term of the purpose is present,
	// which is what proves the cause is the absent term and not the write.
	subsetRoomID := mustCreateRoom(t, store, "ship on Friday").ID
	if _, err := client.Record(context.Background(), memory.RecordRequest{
		RoomID: subsetRoomID, AgentID: "agt_1",
		Content:       "we agreed to ship on Friday after the security review passed",
		SourceEventID: "evt_2", IdempotencyKey: "key_2",
	}); err != nil {
		t.Fatalf("Record: %v", err)
	}

	req = requestAs(t, http.MethodPost, "/v1/rooms/"+subsetRoomID+"/members", map[string]any{"agent_id": "agt_1"}, tenantA)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("subset goal: status = %d, want %d; body = %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	ctx, ok = decodeBody(t, rec)["context"].(map[string]any)
	if !ok {
		t.Fatalf("subset goal: context = %v, want an object", decodeBody(t, rec)["context"])
	}
	if ctx["state"] != "ready" {
		t.Errorf("subset goal: context.state = %v, want %q — the write itself failed, so the "+
			"absent-term case above proves nothing", ctx["state"], "ready")
	}
}
