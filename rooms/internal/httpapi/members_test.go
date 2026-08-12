package httpapi_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/zerkerlabs/gateway/rooms/internal/memory"
	"github.com/zerkerlabs/gateway/rooms/internal/room"
)

var digestFormat = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// capturingMemoryStore wraps a *memory.Fake and records the PrepareRequest of
// its most recent PrepareContext call, so a test can inspect exactly what
// handleAddMember sent upstream.
type capturingMemoryStore struct {
	*memory.Fake
	lastPrepareRequest memory.PrepareRequest
}

func (s *capturingMemoryStore) PrepareContext(ctx context.Context, req memory.PrepareRequest) (memory.ContextResult, error) {
	s.lastPrepareRequest = req
	return s.Fake.PrepareContext(ctx, req)
}

// erroringMemoryStore is a memory.Store whose PrepareContext always fails,
// used to exercise onboarding's fail-closed path: a memory backend error
// must refuse the join rather than seat a member with an empty context.
type erroringMemoryStore struct{}

func (erroringMemoryStore) PrepareContext(ctx context.Context, req memory.PrepareRequest) (memory.ContextResult, error) {
	return memory.ContextResult{}, errors.New("memory backend unavailable")
}

func (erroringMemoryStore) Propose(ctx context.Context, req memory.ProposeRequest) (memory.WriteResult, error) {
	return memory.WriteResult{}, errors.New("memory backend unavailable")
}

func (erroringMemoryStore) Record(ctx context.Context, req memory.RecordRequest) (memory.WriteResult, error) {
	return memory.WriteResult{}, errors.New("memory backend unavailable")
}

// tenantMismatchStore wraps a room.Store and makes AddMember always fail with
// room.ErrTenantMismatch. The handler always passes its own tenant as
// AddMember's agentTenantID (rooms have no gateway client yet to resolve an
// agent's owning tenant), so room.MemoryStore can never actually return this
// error itself — this double is what lets a test reach that branch.
type tenantMismatchStore struct {
	room.Store
}

func (tenantMismatchStore) AddMember(ctx context.Context, tenantID, roomID, agentID, agentTenantID string, admittedMemory, callerDocuments []string, commitment room.ContextCommitment) (*room.Member, error) {
	return nil, room.ErrTenantMismatch
}

// fixedMemoryStore is a memory.Store whose PrepareContext always returns a
// caller-supplied ContextResult, for tests that need exact control over
// State, Counts, and Omissions beyond what memory.Fake's own admission logic
// naturally produces — in particular, forcing StateBudgetExhausted and
// shaping Omissions to exercise the reason collapse rule and redaction.
type fixedMemoryStore struct {
	result memory.ContextResult
}

func (s fixedMemoryStore) PrepareContext(ctx context.Context, req memory.PrepareRequest) (memory.ContextResult, error) {
	return s.result, nil
}

func (fixedMemoryStore) Propose(ctx context.Context, req memory.ProposeRequest) (memory.WriteResult, error) {
	return memory.WriteResult{}, errors.New("not implemented")
}

func (fixedMemoryStore) Record(ctx context.Context, req memory.RecordRequest) (memory.WriteResult, error) {
	return memory.WriteResult{}, errors.New("not implemented")
}

// TestHandleAddMemberContextStates exercises every one of the six
// PrepareContext states the memory backend can return, using
// fixedMemoryStore to shape Counts and Omissions precisely: StateReady,
// StatePartial, and StateEmpty seat the member; StateBlocked,
// StateAbstained, and StateBudgetExhausted refuse the join with 409 before
// any member is seated. It also asserts the redaction guarantees: a
// withheld reason every entry agrees on is surfaced, but a divergent set (or
// backend free-text abstention detail) never reaches the response — only the
// Rooms-owned default does, using sentinel values recognizable enough that
// their absence from the response body is a meaningful check. A final case
// covers a State value outside those six: refusalFor whitelists only the
// three seating states, so an unrecognized value refuses the join instead of
// seating on it.
func TestHandleAddMemberContextStates(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		result     memory.ContextResult
		wantStatus int
		wantCode   string
		wantReason string
		wantSeated bool
		mustAbsent []string // substrings that must not appear anywhere in the raw response body
	}{
		{
			name:       "ready seats with the returned context",
			result:     memory.ContextResult{State: memory.StateReady, Memories: []memory.Memory{{ID: "mem_1", Content: "fact"}}},
			wantStatus: http.StatusCreated,
			wantSeated: true,
		},
		{
			name: "partial seats with the admitted subset",
			result: memory.ContextResult{
				State:     memory.StatePartial,
				Memories:  []memory.Memory{{ID: "mem_1", Content: "fact"}},
				Counts:    memory.Counts{Retrieved: 2, Admitted: 1, Withheld: 1},
				Omissions: memory.Omissions{Reasons: []string{"policy_withheld"}},
			},
			wantStatus: http.StatusCreated,
			wantSeated: true,
		},
		{
			name:       "empty seats with no prior memory",
			result:     memory.ContextResult{State: memory.StateEmpty},
			wantStatus: http.StatusCreated,
			wantSeated: true,
		},
		{
			name: "blocked refuses the join, surfacing a unanimous withheld reason",
			result: memory.ContextResult{
				State:     memory.StateBlocked,
				Counts:    memory.Counts{Retrieved: 1, Withheld: 1},
				Omissions: memory.Omissions{Reasons: []string{"policy_withheld"}},
			},
			wantStatus: http.StatusConflict,
			wantCode:   "memory_blocked",
			wantReason: "policy_withheld",
		},
		{
			name: "blocked falls back to the Rooms-owned default when withheld reasons diverge, without leaking them",
			result: memory.ContextResult{
				State:     memory.StateBlocked,
				Counts:    memory.Counts{Retrieved: 2, Withheld: 2},
				Omissions: memory.Omissions{Reasons: []string{"sentinel_mem_id_777", "sentinel_rule_predicate_x"}},
			},
			wantStatus: http.StatusConflict,
			wantCode:   "memory_blocked",
			wantReason: "policy_withheld_all",
			mustAbsent: []string{"sentinel_mem_id_777", "sentinel_rule_predicate_x"},
		},
		{
			name:       "blocked falls back to the Rooms-owned default with no withheld entries",
			result:     memory.ContextResult{State: memory.StateBlocked},
			wantStatus: http.StatusConflict,
			wantCode:   "memory_blocked",
			wantReason: "policy_withheld_all",
		},
		{
			name: "abstained refuses the join without forwarding the abstention detail",
			result: memory.ContextResult{
				State:     memory.StateAbstained,
				Omissions: memory.Omissions{Abstention: "leaked sentinel_mem_id_888 rule=sentinel_predicate_y"},
			},
			wantStatus: http.StatusConflict,
			wantCode:   "memory_abstained",
			wantReason: "evidence_conflicted",
			mustAbsent: []string{"sentinel_mem_id_888", "sentinel_predicate_y"},
		},
		{
			name: "budget_exhausted refuses the join",
			result: memory.ContextResult{
				State:     memory.StateBudgetExhausted,
				Counts:    memory.Counts{Retrieved: 1, BudgetDropped: 1},
				Omissions: memory.Omissions{Reasons: []string{"budget"}},
			},
			wantStatus: http.StatusConflict,
			wantCode:   "memory_budget_exhausted",
			wantReason: "budget",
		},
		{
			name:       "an unrecognized state refuses the join rather than seating on it",
			result:     memory.ContextResult{State: memory.State("future_state")},
			wantStatus: http.StatusConflict,
			wantCode:   "memory_unrecognized_state",
			wantReason: "unrecognized_state",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var store room.Store = room.NewMemoryStore()
			mux := newMuxWithStore(t, store, fixedMemoryStore{result: tt.result})
			roomID := mustCreateRoom(t, store, "goal").ID

			req := requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/members", map[string]any{"agent_id": "agt_1"}, tenantA)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			raw := rec.Body.String()
			if tt.wantCode != "" || tt.wantReason != "" {
				body := decodeBody(t, rec)
				if tt.wantCode != "" && body["code"] != tt.wantCode {
					t.Errorf("code = %v, want %q", body["code"], tt.wantCode)
				}
				if tt.wantReason != "" && body["reason"] != tt.wantReason {
					t.Errorf("reason = %v, want %q", body["reason"], tt.wantReason)
				}
			}
			for _, s := range tt.mustAbsent {
				if strings.Contains(raw, s) {
					t.Errorf("response body leaked sentinel %q: %s", s, raw)
				}
			}

			got, err := store.GetRoom(context.Background(), tenantA, roomID)
			if err != nil {
				t.Fatalf("GetRoom: %v", err)
			}
			if seated := len(got.Members) == 1; seated != tt.wantSeated {
				t.Errorf("member seated = %v, want %v (members = %v)", seated, tt.wantSeated, got.Members)
			}
		})
	}
}

// TestHandleAddMemberContextResponse asserts the shape of the context object
// the add-member response carries for every state that seats a member —
// ready, partial, and empty — and that GET /v1/rooms/{rom_id} reports the
// identical context for that same member afterward. It also asserts that
// AdmittedMemory and CallerDocuments themselves never appear in either
// response: surfacing that memory was omitted must never require making the
// memory readable.
func TestHandleAddMemberContextResponse(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		result      memory.ContextResult
		wantState   string
		wantCounts  map[string]any
		wantReasons []any
	}{
		{
			name:        "ready reports zero omissions",
			result:      memory.ContextResult{State: memory.StateReady, Memories: []memory.Memory{{ID: "mem_1", Content: "fact"}}, Counts: memory.Counts{Retrieved: 1, Admitted: 1}},
			wantState:   "ready",
			wantCounts:  map[string]any{"retrieved": float64(1), "admitted": float64(1), "withheld": float64(0), "budget_dropped": float64(0)},
			wantReasons: []any{},
		},
		{
			name: "partial reports counts and deduplicated bounded reasons",
			result: memory.ContextResult{
				State:     memory.StatePartial,
				Memories:  []memory.Memory{{ID: "mem_1", Content: "fact"}},
				Counts:    memory.Counts{Retrieved: 12, Admitted: 7, Withheld: 4, BudgetDropped: 1},
				Omissions: memory.Omissions{Reasons: []string{"policy_withheld", "budget"}},
			},
			wantState:   "partial",
			wantCounts:  map[string]any{"retrieved": float64(12), "admitted": float64(7), "withheld": float64(4), "budget_dropped": float64(1)},
			wantReasons: []any{"policy_withheld", "budget"},
		},
		{
			name:        "empty reports zero counts, not an absent object",
			result:      memory.ContextResult{State: memory.StateEmpty},
			wantState:   "empty",
			wantCounts:  map[string]any{"retrieved": float64(0), "admitted": float64(0), "withheld": float64(0), "budget_dropped": float64(0)},
			wantReasons: []any{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var store room.Store = room.NewMemoryStore()
			mux := newMuxWithStore(t, store, fixedMemoryStore{result: tt.result})
			roomID := mustCreateRoom(t, store, "goal").ID

			addReq := requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/members", map[string]any{"agent_id": "agt_1"}, tenantA)
			addRec := httptest.NewRecorder()
			mux.ServeHTTP(addRec, addReq)
			if addRec.Code != http.StatusCreated {
				t.Fatalf("add-member status = %d, want %d; body = %s", addRec.Code, http.StatusCreated, addRec.Body.String())
			}
			if strings.Contains(addRec.Body.String(), "starting_context") {
				t.Fatalf("add-member response exposes starting_context: %s", addRec.Body.String())
			}
			assertMemberContext(t, decodeBody(t, addRec), tt.wantState, tt.wantCounts, tt.wantReasons)

			getReq := requestAs(t, http.MethodGet, "/v1/rooms/"+roomID, nil, tenantA)
			getRec := httptest.NewRecorder()
			mux.ServeHTTP(getRec, getReq)
			if getRec.Code != http.StatusOK {
				t.Fatalf("get-room status = %d, want %d; body = %s", getRec.Code, http.StatusOK, getRec.Body.String())
			}
			if strings.Contains(getRec.Body.String(), "starting_context") {
				t.Fatalf("get-room response exposes starting_context: %s", getRec.Body.String())
			}
			members, ok := decodeBody(t, getRec)["members"].([]any)
			if !ok || len(members) != 1 {
				t.Fatalf("members = %v, want a single member", members)
			}
			member, ok := members[0].(map[string]any)
			if !ok {
				t.Fatalf("members[0] = %v, want an object", members[0])
			}
			assertMemberContext(t, member, tt.wantState, tt.wantCounts, tt.wantReasons)
		})
	}
}

// assertMemberContext checks the "context" object of a memberResponse —
// either the add-member response body itself or one entry of a room-get
// response's "members" array — against the expected state, counts, and
// omission reasons.
func assertMemberContext(t *testing.T, body map[string]any, wantState string, wantCounts map[string]any, wantReasons []any) {
	t.Helper()

	ctx, ok := body["context"].(map[string]any)
	if !ok {
		t.Fatalf("context = %v, want an object", body["context"])
	}
	if ctx["state"] != wantState {
		t.Errorf("context.state = %v, want %q", ctx["state"], wantState)
	}
	counts, ok := ctx["counts"].(map[string]any)
	if !ok {
		t.Fatalf("context.counts = %v, want an object", ctx["counts"])
	}
	for k, want := range wantCounts {
		if counts[k] != want {
			t.Errorf("context.counts.%s = %v, want %v", k, counts[k], want)
		}
	}
	reasons, ok := ctx["omission_reasons"].([]any)
	if !ok {
		t.Fatalf("context.omission_reasons = %v, want an array", ctx["omission_reasons"])
	}
	if len(reasons) != len(wantReasons) {
		t.Errorf("context.omission_reasons = %v, want %v", reasons, wantReasons)
		return
	}
	for i, want := range wantReasons {
		if reasons[i] != want {
			t.Errorf("context.omission_reasons[%d] = %v, want %v", i, reasons[i], want)
		}
	}
}

// TestHandleAddMemberSendsDigests asserts that every context-preparation
// request handleAddMember issues carries a membership_digest and
// room_state_digest in the "sha256:<64 hex>" format the backend expects, and
// that adding a second member changes the digest a subsequent join sends —
// the same room, asked about twice, is no longer the same membership.
func TestHandleAddMemberSendsDigests(t *testing.T) {
	t.Parallel()

	store := room.NewMemoryStore()
	capturing := &capturingMemoryStore{Fake: memory.NewFake()}
	mux := newMuxWithStore(t, store, capturing)
	roomID := mustCreateRoom(t, store, "goal").ID

	req1 := requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/members", map[string]any{"agent_id": "agt_1"}, tenantA)
	rec1 := httptest.NewRecorder()
	mux.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusCreated {
		t.Fatalf("first add-member status = %d, want %d; body = %s", rec1.Code, http.StatusCreated, rec1.Body.String())
	}
	firstMembership := capturing.lastPrepareRequest.MembershipDigest
	firstRoomState := capturing.lastPrepareRequest.RoomStateDigest
	if !digestFormat.MatchString(firstMembership) {
		t.Errorf("MembershipDigest = %q, want sha256:<64 hex>", firstMembership)
	}
	if !digestFormat.MatchString(firstRoomState) {
		t.Errorf("RoomStateDigest = %q, want sha256:<64 hex>", firstRoomState)
	}

	req2 := requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/members", map[string]any{"agent_id": "agt_2"}, tenantA)
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusCreated {
		t.Fatalf("second add-member status = %d, want %d; body = %s", rec2.Code, http.StatusCreated, rec2.Body.String())
	}
	secondMembership := capturing.lastPrepareRequest.MembershipDigest
	secondRoomState := capturing.lastPrepareRequest.RoomStateDigest
	if !digestFormat.MatchString(secondMembership) {
		t.Errorf("MembershipDigest = %q, want sha256:<64 hex>", secondMembership)
	}
	if !digestFormat.MatchString(secondRoomState) {
		t.Errorf("RoomStateDigest = %q, want sha256:<64 hex>", secondRoomState)
	}
	if firstMembership == secondMembership {
		t.Error("MembershipDigest did not change after the room gained a member")
	}
	if firstRoomState == secondRoomState {
		t.Error("RoomStateDigest did not change after the room gained a member's join event")
	}
}

func TestHandleAddMember(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		setup func(t *testing.T, s room.Store) string // returns the room ID to target
		// memStore, if non-nil, entirely replaces the default fresh
		// memory.Fake — for a case that needs a custom implementation
		// (e.g. one that always errors).
		memStore memory.Store
		// wrapStore, if non-nil, wraps the fresh room.MemoryStore before it is
		// handed to setup and the handler — for a case that needs a store
		// double to reach a branch the real MemoryStore cannot take itself.
		wrapStore func(room.Store) room.Store
		// seedMemory, if non-nil, runs after setup has created the room, so
		// it can seed the default memory.Fake for the room ID setup
		// returned — a room ID only exists once setup runs. It is ignored
		// when memStore is set.
		seedMemory func(t *testing.T, f *memory.Fake, roomID string)
		body       any
		lookupAs   string
		wantStatus int
		wantCode   string
		checkBody  func(t *testing.T, body map[string]any)
		afterCheck func(t *testing.T, s room.Store, roomID string)
	}{
		{
			name: "201 seats an agent",
			setup: func(t *testing.T, s room.Store) string {
				t.Helper()
				return mustCreateRoom(t, s, "goal").ID
			},
			body:       map[string]any{"agent_id": "agt_1"},
			lookupAs:   tenantA,
			wantStatus: http.StatusCreated,
			checkBody: func(t *testing.T, body map[string]any) {
				t.Helper()
				if body["id"] == "" || body["id"] == nil {
					t.Error("id is empty")
				}
				if body["agent_id"] != "agt_1" {
					t.Errorf("agent_id = %v, want %q", body["agent_id"], "agt_1")
				}
				if body["joined_at"] == "" || body["joined_at"] == nil {
					t.Error("joined_at is empty")
				}
			},
		},
		{
			name: "400 missing agent_id",
			setup: func(t *testing.T, s room.Store) string {
				t.Helper()
				return mustCreateRoom(t, s, "goal").ID
			},
			body:       map[string]any{},
			lookupAs:   tenantA,
			wantStatus: http.StatusBadRequest,
			wantCode:   "missing_field",
		},
		{
			name: "400 malformed JSON",
			setup: func(t *testing.T, s room.Store) string {
				t.Helper()
				return mustCreateRoom(t, s, "goal").ID
			},
			body:       []byte(`{"agent_id": `),
			lookupAs:   tenantA,
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_request_body",
		},
		{
			name: "404 for an unknown room ID",
			setup: func(t *testing.T, s room.Store) string {
				t.Helper()
				return "rom_does_not_exist"
			},
			body:       map[string]any{"agent_id": "agt_1"},
			lookupAs:   tenantA,
			wantStatus: http.StatusNotFound,
			wantCode:   "room_not_found",
		},
		{
			name: "404 for a room owned by a different tenant",
			setup: func(t *testing.T, s room.Store) string {
				t.Helper()
				return mustCreateRoom(t, s, "goal").ID
			},
			body:       map[string]any{"agent_id": "agt_1"},
			lookupAs:   tenantB,
			wantStatus: http.StatusNotFound,
			wantCode:   "room_not_found",
		},
		{
			name: "409 for a terminated room",
			setup: func(t *testing.T, s room.Store) string {
				t.Helper()
				r := mustCreateRoom(t, s, "goal")
				if _, err := s.CompleteRoom(context.Background(), tenantA, r.ID); err != nil {
					t.Fatalf("CompleteRoom: %v", err)
				}
				return r.ID
			},
			body:       map[string]any{"agent_id": "agt_1"},
			lookupAs:   tenantA,
			wantStatus: http.StatusConflict,
			wantCode:   "room_terminated",
		},
		{
			// No Authorization header at all, so the auth middleware itself
			// refuses the request (401, no body, by its own documented
			// contract) before the handler's own belt-and-braces tenant check
			// ever runs.
			name: "401 when no tenant is in context",
			setup: func(t *testing.T, s room.Store) string {
				t.Helper()
				return mustCreateRoom(t, s, "goal").ID
			},
			body:       map[string]any{"agent_id": "agt_1"},
			lookupAs:   "",
			wantStatus: http.StatusUnauthorized,
		},
		{
			// The acceptance check for keeping admitted memory and caller
			// documents apart: a member onboards with both governed memory
			// (seeded into the fake backend, so it is policy-admitted) and
			// caller-supplied documents (ungoverned request input), and the
			// two must remain distinguishable in the stored member, not
			// merged into one list.
			name: "201 onboards a member from memory entries plus documents",
			setup: func(t *testing.T, s room.Store) string {
				t.Helper()
				// The goal shares a term with the seeded memory below: Purpose
				// is a retrieval query, and a Fake that ignored it would pass
				// this test regardless — this keeps the goal realistic instead
				// of accidentally proving nothing.
				return mustCreateRoom(t, s, "recall the prior facts").ID
			},
			seedMemory: func(t *testing.T, f *memory.Fake, roomID string) {
				t.Helper()
				ctx := context.Background()
				if _, err := f.Record(ctx, memory.RecordRequest{
					RoomID: roomID, AgentID: "agt_1", Content: "prior fact 1",
					SourceEventID: "evt_1", IdempotencyKey: "key_1",
				}); err != nil {
					t.Fatalf("Record: %v", err)
				}
				if _, err := f.Record(ctx, memory.RecordRequest{
					RoomID: roomID, AgentID: "agt_1", Content: "prior fact 2",
					SourceEventID: "evt_2", IdempotencyKey: "key_2",
				}); err != nil {
					t.Fatalf("Record: %v", err)
				}
			},
			body:       map[string]any{"agent_id": "agt_1", "documents": []string{"doc A", "doc B"}},
			lookupAs:   tenantA,
			wantStatus: http.StatusCreated,
			afterCheck: func(t *testing.T, s room.Store, roomID string) {
				t.Helper()
				got, err := s.GetRoom(context.Background(), tenantA, roomID)
				if err != nil {
					t.Fatalf("GetRoom: %v", err)
				}
				if len(got.Members) != 1 {
					t.Fatalf("Members = %v, want a single member", got.Members)
				}
				member := got.Members[0]

				wantMemory := []string{"prior fact 1", "prior fact 2"}
				if len(member.AdmittedMemory) != len(wantMemory) {
					t.Fatalf("AdmittedMemory = %v, want %v", member.AdmittedMemory, wantMemory)
				}
				for i := range wantMemory {
					if member.AdmittedMemory[i] != wantMemory[i] {
						t.Errorf("AdmittedMemory[%d] = %q, want %q", i, member.AdmittedMemory[i], wantMemory[i])
					}
				}

				wantDocuments := []string{"doc A", "doc B"}
				if len(member.CallerDocuments) != len(wantDocuments) {
					t.Fatalf("CallerDocuments = %v, want %v", member.CallerDocuments, wantDocuments)
				}
				for i := range wantDocuments {
					if member.CallerDocuments[i] != wantDocuments[i] {
						t.Errorf("CallerDocuments[%d] = %q, want %q", i, member.CallerDocuments[i], wantDocuments[i])
					}
				}
			},
		},
		{
			name: "201 seats a member with zero documents",
			setup: func(t *testing.T, s room.Store) string {
				t.Helper()
				return mustCreateRoom(t, s, "goal").ID
			},
			body:       map[string]any{"agent_id": "agt_1"},
			lookupAs:   tenantA,
			wantStatus: http.StatusCreated,
			afterCheck: func(t *testing.T, s room.Store, roomID string) {
				t.Helper()
				got, err := s.GetRoom(context.Background(), tenantA, roomID)
				if err != nil {
					t.Fatalf("GetRoom: %v", err)
				}
				if len(got.Members) != 1 {
					t.Fatalf("Members = %v, want a single member", got.Members)
				}
				if len(got.Members[0].AdmittedMemory) != 0 {
					t.Errorf("AdmittedMemory = %v, want empty", got.Members[0].AdmittedMemory)
				}
				if len(got.Members[0].CallerDocuments) != 0 {
					t.Errorf("CallerDocuments = %v, want empty", got.Members[0].CallerDocuments)
				}
			},
		},
		{
			name: "400 agent belongs to a different tenant",
			setup: func(t *testing.T, s room.Store) string {
				t.Helper()
				return mustCreateRoom(t, s, "goal").ID
			},
			wrapStore:  func(s room.Store) room.Store { return tenantMismatchStore{s} },
			body:       map[string]any{"agent_id": "agt_1"},
			lookupAs:   tenantA,
			wantStatus: http.StatusBadRequest,
			wantCode:   "tenant_mismatch",
		},
		{
			name: "500 refuses the join when the memory read fails; no member is added",
			setup: func(t *testing.T, s room.Store) string {
				t.Helper()
				return mustCreateRoom(t, s, "goal").ID
			},
			memStore:   erroringMemoryStore{},
			body:       map[string]any{"agent_id": "agt_1"},
			lookupAs:   tenantA,
			wantStatus: http.StatusInternalServerError,
			afterCheck: func(t *testing.T, s room.Store, roomID string) {
				t.Helper()
				got, err := s.GetRoom(context.Background(), tenantA, roomID)
				if err != nil {
					t.Fatalf("GetRoom: %v", err)
				}
				if len(got.Members) != 0 {
					t.Errorf("Members = %v, want empty after a refused join", got.Members)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			memStore := tt.memStore
			var fake *memory.Fake
			if memStore == nil {
				fake = memory.NewFake()
				memStore = fake
			}
			var store room.Store = room.NewMemoryStore()
			if tt.wrapStore != nil {
				store = tt.wrapStore(store)
			}
			mux := newMuxWithStore(t, store, memStore)
			roomID := tt.setup(t, store)
			if tt.seedMemory != nil {
				tt.seedMemory(t, fake, roomID)
			}

			req := requestAs(t, http.MethodPost, "/v1/rooms/"+roomID+"/members", tt.body, tt.lookupAs)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantCode != "" {
				body := decodeBody(t, rec)
				if body["code"] != tt.wantCode {
					t.Errorf("code = %v, want %q", body["code"], tt.wantCode)
				}
			}
			if tt.checkBody != nil {
				tt.checkBody(t, decodeBody(t, rec))
			}
			if tt.afterCheck != nil {
				tt.afterCheck(t, store, roomID)
			}
		})
	}
}
