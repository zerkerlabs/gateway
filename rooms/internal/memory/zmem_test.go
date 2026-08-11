package memory_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/rooms/internal/memory"
	"github.com/zerkerlabs/gateway/rooms/internal/memory/memorytest"
)

const (
	testServiceToken = "s3cr3t-zmem-token" //nolint:gosec // test fixture, not a real credential
	testTenantID     = "tnt_fake"
)

// fakeZMemServer implements just enough of the wire contract ZMemClient
// speaks to exercise it end-to-end, without a real backend available. It
// wraps a memory.Fake for retrieval/admission/state logic — Fake already
// models that behavior — and adds only what a real backend does that Fake
// does not: a tenant identity on every response, a wire-format commitment,
// idempotency-key conflict detection, and a POST /v1/inject stub that must
// never be called.
type fakeZMemServer struct {
	tenantID string
	backing  *memory.Fake

	mu          sync.Mutex
	idempotency map[string]string // idempotency_key -> content, first write wins
	lastAuth    string
	lastWrite   writeRequestOut

	injectHits int32
	prepares   int32
	writes     int32
}

func newFakeZMemServer(tenantID string) *fakeZMemServer {
	return &fakeZMemServer{
		tenantID:    tenantID,
		backing:     memory.NewFake(),
		idempotency: make(map[string]string),
	}
}

// The wire types below deliberately do not import anything from zmem.go:
// they are this test's own model of the contract, so a test failure here
// means the client's actual bytes on the wire drifted from what a real
// backend would send or expect — not that a shared struct's tag changed
// underneath both sides at once.

type prepareRequestIn struct {
	RoomID              string `json:"room_id"`
	AgentID             string `json:"agent_id"`
	Purpose             string `json:"purpose"`
	Risk                string `json:"risk"`
	ContextBudgetTokens int    `json:"context_budget_tokens"`
	MembershipDigest    string `json:"membership_digest"`
	RoomStateDigest     string `json:"room_state_digest"`
}

type memoryOut struct {
	ID         string    `json:"id"`
	Content    string    `json:"content"`
	Provenance string    `json:"provenance"`
	CreatedAt  time.Time `json:"created_at"`
}

type countsOut struct {
	Retrieved     int `json:"retrieved"`
	Admitted      int `json:"admitted"`
	Withheld      int `json:"withheld"`
	BudgetDropped int `json:"budget_dropped"`
}

type omissionItemOut struct {
	MemoryID string `json:"memory_id"`
	Reason   string `json:"reason"`
	Rule     string `json:"rule,omitempty"`
}

type omissionsOut struct {
	Withheld      []omissionItemOut `json:"withheld"`
	BudgetDropped []omissionItemOut `json:"budget_dropped"`
	Abstention    map[string]any    `json:"abstention,omitempty"`
}

type prepareResponseOut struct {
	TenantID   string          `json:"tenant_id"`
	State      string          `json:"state"`
	Memories   []memoryOut     `json:"memories"`
	Counts     countsOut       `json:"counts"`
	Omissions  omissionsOut    `json:"omissions"`
	Commitment json.RawMessage `json:"commitment"`
}

type writeRequestOut struct {
	RoomID         string `json:"room_id"`
	AgentID        string `json:"agent_id"`
	Content        string `json:"content"`
	SourceEventID  string `json:"source_event_id"`
	IdempotencyKey string `json:"idempotency_key"`
}

type writeResponseOut struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *fakeZMemServer) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/contexts:prepare", s.handlePrepare)
	mux.HandleFunc("POST /v1/memories:propose", s.handleWrite(s.backing.Propose))
	mux.HandleFunc("POST /v1/memories:record", s.handleWrite(s.backing.Record))
	mux.HandleFunc("POST /v1/inject", s.handleInject)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func (s *fakeZMemServer) handleInject(w http.ResponseWriter, _ *http.Request) {
	atomic.AddInt32(&s.injectHits, 1)
	w.WriteHeader(http.StatusNotImplemented)
}

func (s *fakeZMemServer) handlePrepare(w http.ResponseWriter, r *http.Request) {
	atomic.AddInt32(&s.prepares, 1)
	s.mu.Lock()
	s.lastAuth = r.Header.Get("Authorization")
	s.mu.Unlock()

	var req prepareRequestIn
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	result, err := s.backing.PrepareContext(r.Context(), memory.PrepareRequest{
		RoomID: req.RoomID, AgentID: req.AgentID, Purpose: req.Purpose, Risk: req.Risk,
		ContextBudgetTokens: req.ContextBudgetTokens, MembershipDigest: req.MembershipDigest, RoomStateDigest: req.RoomStateDigest,
	})
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	resp := prepareResponseOut{
		TenantID: s.tenantID,
		State:    string(result.State),
		Memories: make([]memoryOut, len(result.Memories)),
		Counts:   countsOut(result.Counts),
	}
	for i, m := range result.Memories {
		resp.Memories[i] = memoryOut{ID: m.ID, Content: m.Content, Provenance: m.Provenance, CreatedAt: m.CreatedAt}
	}
	for _, reason := range result.Omissions.Reasons {
		resp.Omissions.Withheld = append(resp.Omissions.Withheld, omissionItemOut{MemoryID: "mem_redacted", Reason: reason, Rule: "internal_rule"})
	}
	if result.Omissions.Abstention != "" {
		resp.Omissions.Abstention = map[string]any{"reason": result.Omissions.Abstention, "conflicting_memory_ids": []string{"mem_a", "mem_b"}}
	}
	resp.Commitment = s.computeCommitment(req.RoomID, req.AgentID, result)

	writeJSON(w, http.StatusOK, resp)
}

// computeCommitment builds a small, ASCII-only commitment object and signs
// it the same way the real backend does: sha256 over the object's compact,
// key-sorted JSON encoding, minus the digest field itself. Every value here
// is a room/agent/state identifier, so plain encoding/json.Marshal (which
// already sorts map keys and, given no non-ASCII or HTML-special content,
// happens to match the ensure_ascii-and-no-HTML-escaping canonical form
// byte-for-byte) is sufficient — the exhaustive proof that a client
// reproduces that canonical form even when content is NOT this well-behaved
// lives in TestZMemClient_CommitmentGoldenVectors instead of here.
func (s *fakeZMemServer) computeCommitment(roomID, agentID string, result memory.ContextResult) json.RawMessage {
	memIDs := make([]string, len(result.Memories))
	for i, m := range result.Memories {
		memIDs[i] = m.ID
	}
	fields := map[string]any{
		"tenant_id":  s.tenantID,
		"room_id":    roomID,
		"agent_id":   agentID,
		"state":      string(result.State),
		"memory_ids": memIDs,
	}
	canonical, err := json.Marshal(fields)
	if err != nil {
		panic(err) // test double: fields are always marshalable
	}
	sum := sha256.Sum256(canonical)
	fields["room_context_digest"] = "sha256:" + hex.EncodeToString(sum[:])
	raw, err := json.Marshal(fields)
	if err != nil {
		panic(err)
	}
	return raw
}

func (s *fakeZMemServer) handleWrite(do any) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&s.writes, 1)
		s.mu.Lock()
		s.lastAuth = r.Header.Get("Authorization")
		s.mu.Unlock()

		var req writeRequestOut
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		s.mu.Lock()
		s.lastWrite = req
		prior, seen := s.idempotency[req.IdempotencyKey]
		if seen && prior != req.Content {
			s.mu.Unlock()
			w.WriteHeader(http.StatusConflict)
			return
		}
		s.idempotency[req.IdempotencyKey] = req.Content
		s.mu.Unlock()

		var result memory.WriteResult
		var err error
		switch fn := do.(type) {
		case func(context.Context, memory.ProposeRequest) (memory.WriteResult, error):
			result, err = fn(r.Context(), memory.ProposeRequest{
				RoomID: req.RoomID, AgentID: req.AgentID, Content: req.Content,
				SourceEventID: req.SourceEventID, IdempotencyKey: req.IdempotencyKey,
			})
		case func(context.Context, memory.RecordRequest) (memory.WriteResult, error):
			result, err = fn(r.Context(), memory.RecordRequest{
				RoomID: req.RoomID, AgentID: req.AgentID, Content: req.Content,
				SourceEventID: req.SourceEventID, IdempotencyKey: req.IdempotencyKey,
			})
		}
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, writeResponseOut{ID: result.ID, CreatedAt: result.CreatedAt})
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fastZMemClient returns a client configured for testTenantID — every
// caller in this file exercises that tenant; TestZMemClient_TenantMismatchFailsClosedAndLogs
// builds its own client directly to use a different one.
func fastZMemClient(t *testing.T, baseURL string) *memory.ZMemClient {
	t.Helper()
	c, err := memory.NewZMemClient(memory.ZMemConfig{
		BaseURL: baseURL, ServiceToken: testServiceToken, TenantID: testTenantID, Timeout: 2 * time.Second,
	}, discardLogger())
	if err != nil {
		t.Fatalf("NewZMemClient: %v", err)
	}
	return c
}

func classOf(t *testing.T, err error) memory.ErrorClass {
	t.Helper()
	var ce *memory.ClientError
	if !errors.As(err, &ce) {
		t.Fatalf("err = %v (%T), want *memory.ClientError", err, err)
	}
	return ce.Class
}

func TestNewZMemClient_RequiresConfig(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		cfg  memory.ZMemConfig
	}{
		{"missing base URL", memory.ZMemConfig{ServiceToken: testServiceToken, TenantID: testTenantID}},
		{"missing service token", memory.ZMemConfig{BaseURL: "http://127.0.0.1:8766", TenantID: testTenantID}},
		{"missing tenant ID", memory.ZMemConfig{BaseURL: "http://127.0.0.1:8766", ServiceToken: testServiceToken}},
		{"schemeless base URL", memory.ZMemConfig{BaseURL: "127.0.0.1:8766", ServiceToken: testServiceToken, TenantID: testTenantID}},
		{"non-HTTP base URL", memory.ZMemConfig{BaseURL: "ftp://127.0.0.1:8766", ServiceToken: testServiceToken, TenantID: testTenantID}},
		{"base URL with no host", memory.ZMemConfig{BaseURL: "http://", ServiceToken: testServiceToken, TenantID: testTenantID}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			c, err := memory.NewZMemClient(tt.cfg, discardLogger())
			if err == nil {
				t.Fatal("err = nil, want an error for incomplete config")
			}
			if c != nil {
				t.Errorf("client = %v, want nil", c)
			}
		})
	}
}

// The acceptance gate: memorytest.RunContract must pass unchanged against
// ZMemClient, the same as it does against Fake. Each newStore() call gets
// its own fake backend instance, modeling how a real deployment is
// tenant-local — two Rooms services never share a backend process, so two
// independent clients never share state either.
func TestZMemClient_Contract(t *testing.T) {
	t.Parallel()

	memorytest.RunContract(t, func() memory.Store {
		srv := newFakeZMemServer(testTenantID)
		return fastZMemClient(t, srv.server(t).URL)
	})
}

func TestZMemClient_DrivesEachState(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	newClient := func(t *testing.T) (*memory.ZMemClient, *fakeZMemServer) {
		t.Helper()
		srv := newFakeZMemServer(testTenantID)
		return fastZMemClient(t, srv.server(t).URL), srv
	}

	t.Run(string(memory.StateEmpty), func(t *testing.T) {
		t.Parallel()
		c, _ := newClient(t)
		result, err := c.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateEmpty {
			t.Errorf("State = %q, want %q", result.State, memory.StateEmpty)
		}
	})

	t.Run(string(memory.StateReady), func(t *testing.T) {
		t.Parallel()
		c, _ := newClient(t)
		if _, err := c.Record(ctx, memory.RecordRequest{RoomID: "rom_1", AgentID: "agt_1", Content: "fact", SourceEventID: "evt_1", IdempotencyKey: "key_1"}); err != nil {
			t.Fatalf("Record: %v", err)
		}
		result, err := c.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateReady {
			t.Errorf("State = %q, want %q", result.State, memory.StateReady)
		}
		if result.Commitment.Digest == "" {
			t.Error("Commitment.Digest is empty")
		}
	})

	t.Run(string(memory.StatePartial), func(t *testing.T) {
		t.Parallel()
		c, _ := newClient(t)
		if _, err := c.Record(ctx, memory.RecordRequest{RoomID: "rom_1", AgentID: "agt_1", Content: "accepted", SourceEventID: "evt_1", IdempotencyKey: "key_1"}); err != nil {
			t.Fatalf("Record: %v", err)
		}
		if _, err := c.Propose(ctx, memory.ProposeRequest{RoomID: "rom_1", AgentID: "agt_1", Content: "unreviewed", SourceEventID: "evt_2", IdempotencyKey: "key_2"}); err != nil {
			t.Fatalf("Propose: %v", err)
		}
		result, err := c.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StatePartial {
			t.Errorf("State = %q, want %q", result.State, memory.StatePartial)
		}
		if len(result.Omissions.Reasons) == 0 {
			t.Error("Omissions.Reasons is empty, want the pending-review reason")
		}
	})

	t.Run(string(memory.StateBlocked), func(t *testing.T) {
		t.Parallel()
		c, _ := newClient(t)
		if _, err := c.Propose(ctx, memory.ProposeRequest{RoomID: "rom_1", AgentID: "agt_1", Content: "unreviewed", SourceEventID: "evt_1", IdempotencyKey: "key_1"}); err != nil {
			t.Fatalf("Propose: %v", err)
		}
		result, err := c.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateBlocked {
			t.Errorf("State = %q, want %q", result.State, memory.StateBlocked)
		}
	})

	t.Run(string(memory.StateAbstained), func(t *testing.T) {
		t.Parallel()
		c, srv := newClient(t)
		srv.backing.SetAbstain("rom_1", "agt_1")
		result, err := c.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateAbstained {
			t.Errorf("State = %q, want %q", result.State, memory.StateAbstained)
		}
		if result.Omissions.Abstention == "" {
			t.Error("Omissions.Abstention is empty, want the whitelisted reason")
		}
	})

	t.Run(string(memory.StateBudgetExhausted), func(t *testing.T) {
		t.Parallel()
		c, _ := newClient(t)
		if _, err := c.Record(ctx, memory.RecordRequest{RoomID: "rom_1", AgentID: "agt_1", Content: "too long for the budget", SourceEventID: "evt_1", IdempotencyKey: "key_1"}); err != nil {
			t.Fatalf("Record: %v", err)
		}
		result, err := c.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1", ContextBudgetTokens: 1})
		if err != nil {
			t.Fatalf("PrepareContext: %v", err)
		}
		if result.State != memory.StateBudgetExhausted {
			t.Errorf("State = %q, want %q", result.State, memory.StateBudgetExhausted)
		}
	})
}

// The order a backend returns memories in is ranked, not chronological, and
// must survive the wire unchanged. memory.Fake.Seed lets this test install
// memories directly, out of chronological order, the same way
// memorytest's own ordering case does against Fake — this test proves the
// same property holds once PrepareContext has been through JSON encode,
// HTTP, and JSON decode.
func TestZMemClient_PreservesReturnedOrder(t *testing.T) {
	t.Parallel()

	srv := newFakeZMemServer(testTenantID)
	c := fastZMemClient(t, srv.server(t).URL)

	now := time.Now()
	newer := memory.Memory{ID: "mem_newer", Content: "seeded first, timestamped later", CreatedAt: now}
	older := memory.Memory{ID: "mem_older", Content: "seeded second, timestamped earlier", CreatedAt: now.Add(-time.Hour)}
	srv.backing.Seed("rom_1", "", newer)
	srv.backing.Seed("rom_1", "", older)

	result, err := c.PrepareContext(context.Background(), memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
	if err != nil {
		t.Fatalf("PrepareContext: %v", err)
	}
	if len(result.Memories) != 2 || result.Memories[0].ID != "mem_newer" || result.Memories[1].ID != "mem_older" {
		t.Errorf("Memories = %+v, want [mem_newer mem_older] in seeded order, not chronological order", result.Memories)
	}
}

// The client must never call the transitional compatibility alias — see the
// package doc and zmem.go's endpoint constants.
func TestZMemClient_NeverCallsInject(t *testing.T) {
	t.Parallel()

	srv := newFakeZMemServer(testTenantID)
	c := fastZMemClient(t, srv.server(t).URL)
	ctx := context.Background()

	if _, err := c.PrepareContext(ctx, memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"}); err != nil {
		t.Fatalf("PrepareContext: %v", err)
	}
	if _, err := c.Record(ctx, memory.RecordRequest{RoomID: "rom_1", AgentID: "agt_1", Content: "x", SourceEventID: "evt_1", IdempotencyKey: "key_1"}); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if _, err := c.Propose(ctx, memory.ProposeRequest{RoomID: "rom_1", AgentID: "agt_1", Content: "y", SourceEventID: "evt_2", IdempotencyKey: "key_2"}); err != nil {
		t.Fatalf("Propose: %v", err)
	}

	if got := atomic.LoadInt32(&srv.injectHits); got != 0 {
		t.Errorf("POST /v1/inject was called %d times, want 0", got)
	}
}

func TestZMemClient_SendsBearerToken(t *testing.T) {
	t.Parallel()

	srv := newFakeZMemServer(testTenantID)
	c := fastZMemClient(t, srv.server(t).URL)

	if _, err := c.PrepareContext(context.Background(), memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"}); err != nil {
		t.Fatalf("PrepareContext: %v", err)
	}
	srv.mu.Lock()
	auth := srv.lastAuth
	srv.mu.Unlock()
	if want := "Bearer " + testServiceToken; auth != want {
		t.Errorf("Authorization = %q, want %q", auth, want)
	}
}

// AGENTS.md invariant #4: the credential must never surface anywhere a
// caller could log or return, including in an error from a failed call.
func TestZMemClient_ServiceTokenNeverLeaksInErrors(t *testing.T) {
	t.Parallel()

	cases := map[string]http.HandlerFunc{
		"non-2xx response": func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) },
		"malformed body":   func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("not json")) },
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			srv := httptest.NewServer(h)
			t.Cleanup(srv.Close)
			c := fastZMemClient(t, srv.URL)

			_, err := c.PrepareContext(context.Background(), memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
			if err == nil {
				t.Fatal("err = nil, want an error")
			}
			if strings.Contains(err.Error(), testServiceToken) {
				t.Errorf("error %q contains the service token", err.Error())
			}
		})
	}
}

func TestZMemClient_UnreachableBackendIsTransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // nothing listening now

	c := fastZMemClient(t, url)
	_, err := c.PrepareContext(context.Background(), memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
	if got := classOf(t, err); got != memory.ErrorClassTransport {
		t.Errorf("class = %q, want %q", got, memory.ErrorClassTransport)
	}
}

func TestZMemClient_TimeoutIsTransportError(t *testing.T) {
	t.Parallel()

	// Unblocks the handler before srv.Close() (registered below) runs, so
	// Close does not wait forever for an in-flight handler that only this
	// defer — which runs first — ever lets return.
	block := make(chan struct{})
	defer close(block)
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		<-block
	}))
	t.Cleanup(srv.Close)

	c, err := memory.NewZMemClient(memory.ZMemConfig{
		BaseURL: srv.URL, ServiceToken: testServiceToken, TenantID: testTenantID, Timeout: 20 * time.Millisecond,
	}, discardLogger())
	if err != nil {
		t.Fatalf("NewZMemClient: %v", err)
	}

	_, callErr := c.PrepareContext(context.Background(), memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
	if got := classOf(t, callErr); got != memory.ErrorClassTransport {
		t.Errorf("class = %q, want %q (a timed-out request is a transport failure)", got, memory.ErrorClassTransport)
	}
}

func TestZMemClient_NonTwoXXIsUpstreamStatus(t *testing.T) {
	t.Parallel()

	statuses := []int{http.StatusBadRequest, http.StatusUnauthorized, http.StatusNotFound, http.StatusInternalServerError, http.StatusBadGateway}
	for _, status := range statuses {
		t.Run(http.StatusText(status), func(t *testing.T) {
			t.Parallel()

			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) }))
			t.Cleanup(srv.Close)
			c := fastZMemClient(t, srv.URL)

			_, err := c.PrepareContext(context.Background(), memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
			if got := classOf(t, err); got != memory.ErrorClassUpstreamStatus {
				t.Errorf("class = %q, want %q", got, memory.ErrorClassUpstreamStatus)
			}
		})
	}
}

// A response tenant_id that does not match the client's configured
// expectation must refuse the call closed rather than trust the backend —
// otherwise a Rooms deployment pointed at the wrong sidecar would silently
// read another tenant's memory.
func TestZMemClient_TenantMismatchFailsClosedAndLogs(t *testing.T) {
	t.Parallel()

	srv := newFakeZMemServer("tnt_other")
	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))

	c, err := memory.NewZMemClient(memory.ZMemConfig{
		BaseURL: srv.server(t).URL, ServiceToken: testServiceToken, TenantID: testTenantID,
	}, logger)
	if err != nil {
		t.Fatalf("NewZMemClient: %v", err)
	}

	result, callErr := c.PrepareContext(context.Background(), memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
	if callErr == nil {
		t.Fatal("err = nil — a cross-tenant response was accepted")
	}
	if result.State != "" {
		t.Errorf("result = %+v, want the zero value on tenant mismatch", result)
	}
	if got := classOf(t, callErr); got != memory.ErrorClassTenantMismatch {
		t.Errorf("class = %q, want %q", got, memory.ErrorClassTenantMismatch)
	}
	if logged := logBuf.String(); !strings.Contains(logged, "tenant") {
		t.Errorf("log output = %q, want it to mention the tenant mismatch", logged)
	}
	if strings.Contains(logBuf.String(), testServiceToken) {
		t.Error("log output contains the service token")
	}
}

func TestZMemClient_WriteContentTooLargeIsRejectedLocally(t *testing.T) {
	t.Parallel()

	srv := newFakeZMemServer(testTenantID)
	server := srv.server(t)
	c := fastZMemClient(t, server.URL)

	oversized := strings.Repeat("a", memory.MaxContentChars+1)
	_, err := c.Record(context.Background(), memory.RecordRequest{
		RoomID: "rom_1", AgentID: "agt_1", Content: oversized, SourceEventID: "evt_1", IdempotencyKey: "key_1",
	})
	if got := classOf(t, err); got != memory.ErrorClassContentTooLarge {
		t.Errorf("class = %q, want %q", got, memory.ErrorClassContentTooLarge)
	}
	if got := atomic.LoadInt32(&srv.writes); got != 0 {
		t.Errorf("write requests reaching the backend = %d, want 0 — oversized content must never be sent", got)
	}
}

// Every write carries a source_event_id and idempotency_key, and reusing a
// key for content that does not match its first use must surface as an
// internal error — the backend's 409 means this client's key derivation is
// buggy, not that the caller did anything wrong.
func TestZMemClient_WriteIncludesEventAndKeyAndSurfaces409AsInternalError(t *testing.T) {
	t.Parallel()

	srv := newFakeZMemServer(testTenantID)
	c := fastZMemClient(t, srv.server(t).URL)
	ctx := context.Background()

	if _, err := c.Record(ctx, memory.RecordRequest{
		RoomID: "rom_1", AgentID: "agt_1", Content: "first", SourceEventID: "evt_1", IdempotencyKey: "key_1",
	}); err != nil {
		t.Fatalf("Record: %v", err)
	}
	srv.mu.Lock()
	last := srv.lastWrite
	srv.mu.Unlock()
	if last.SourceEventID != "evt_1" || last.IdempotencyKey != "key_1" {
		t.Errorf("last write = %+v, want SourceEventID=evt_1 IdempotencyKey=key_1", last)
	}

	// Replaying the identical content under the same key is safe.
	if _, err := c.Record(ctx, memory.RecordRequest{
		RoomID: "rom_1", AgentID: "agt_1", Content: "first", SourceEventID: "evt_1", IdempotencyKey: "key_1",
	}); err != nil {
		t.Errorf("replaying identical content under the same key: %v, want no error", err)
	}

	// Reusing the key for different content is this client's bug, and must
	// surface as an internal error.
	_, err := c.Record(ctx, memory.RecordRequest{
		RoomID: "rom_1", AgentID: "agt_1", Content: "different content", SourceEventID: "evt_1", IdempotencyKey: "key_1",
	})
	if err == nil {
		t.Fatal("err = nil, want an error for an idempotency key reused with different content")
	}
	if got := classOf(t, err); got != memory.ErrorClassIdempotencyConflict {
		t.Errorf("class = %q, want %q", got, memory.ErrorClassIdempotencyConflict)
	}
}

// TestZMemClient_CommitmentGoldenVectors pins commitment verification to
// hand-verified, known-good digests rather than a self-consistency check
// against this package's own canonicalizer. Vector 1 is the realistic
// shape: every field ASCII-safe, matching what the contract expects in
// practice today. Vector 2 is adversarial — non-ASCII text and HTML-special
// characters the contract says must never appear in a real commitment
// field — and exists purely to prove the canonicalizer reproduces Python's
// ensure_ascii=True, no-HTML-escaping bytes exactly, the way the ticket's
// "commitment-verification trap" warns a naive encoding/json.Marshal would
// not. Both canonical forms and digests below were derived by hand from
// Python's json.dumps(value, sort_keys=True, separators=(",", ":"),
// ensure_ascii=True) semantics and cross-checked independently of this
// package's canonicalJSON.
func TestZMemClient_CommitmentGoldenVectors(t *testing.T) {
	t.Parallel()

	envelope := func(commitment string) string {
		return `{"tenant_id":"` + testTenantID + `","state":"ready","memories":[],` +
			`"counts":{"retrieved":0,"admitted":0,"withheld":0,"budget_dropped":0},"omissions":{},` +
			`"commitment":` + commitment + `}`
	}

	tests := []struct {
		name       string
		body       string
		wantErr    bool
		wantClass  memory.ErrorClass
		wantDigest string
	}{
		{
			name:       "realistic ASCII-only commitment verifies",
			body:       envelope(`{"agent_id":"agt_1","context_budget_tokens":2000,"counts":{"admitted":2,"budget_dropped":0,"retrieved":3,"withheld":1},"membership_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","purpose_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","risk":"low","room_id":"rom_1","room_state_digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","state":"ready","tenant_id":"tnt_test123","room_context_digest":"sha256:9256914573baa3f3e692400ae840d76db24748c4e9e914832bbd31397da34c87"}`),
			wantDigest: "sha256:9256914573baa3f3e692400ae840d76db24748c4e9e914832bbd31397da34c87",
		},
		{
			// Key order differs from canonical (b before a) and "café" is sent
			// as raw UTF-8, not pre-escaped — the client must still arrive at
			// the same canonical bytes Python would produce.
			name:       "non-ASCII and HTML-special content verifies against a hand-derived digest",
			body:       envelope(`{"b":"<b>&\"'</b>\n","a":"café","room_context_digest":"sha256:196091d6e1a2e970d2c1b97fc6b9eecff7071a973d5a6381b604b0e3226f71f4"}`),
			wantDigest: "sha256:196091d6e1a2e970d2c1b97fc6b9eecff7071a973d5a6381b604b0e3226f71f4",
		},
		{
			name:      "missing digest field fails closed",
			body:      envelope(`{"agent_id":"agt_1"}`),
			wantErr:   true,
			wantClass: memory.ErrorClassCommitmentInvalid,
		},
		{
			name:      "malformed digest format fails closed",
			body:      envelope(`{"agent_id":"agt_1","room_context_digest":"not-a-digest"}`),
			wantErr:   true,
			wantClass: memory.ErrorClassCommitmentInvalid,
		},
		{
			name:      "well-formed but wrong digest fails closed",
			body:      envelope(`{"agent_id":"agt_1","room_context_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}`),
			wantErr:   true,
			wantClass: memory.ErrorClassCommitmentInvalid,
		},
		{
			name:      "commitment is not a JSON object",
			body:      envelope(`"just-a-string"`),
			wantErr:   true,
			wantClass: memory.ErrorClassCommitmentInvalid,
		},
		{
			name:      "commitment absent entirely",
			body:      `{"tenant_id":"` + testTenantID + `","state":"ready","memories":[],"counts":{"retrieved":0,"admitted":0,"withheld":0,"budget_dropped":0},"omissions":{}}`,
			wantErr:   true,
			wantClass: memory.ErrorClassCommitmentInvalid,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tt.body))
			}))
			t.Cleanup(srv.Close)
			c := fastZMemClient(t, srv.URL)

			result, err := c.PrepareContext(context.Background(), memory.PrepareRequest{RoomID: "rom_1", AgentID: "agt_1"})
			if tt.wantErr {
				if err == nil {
					t.Fatal("err = nil, want an error")
				}
				if got := classOf(t, err); got != tt.wantClass {
					t.Errorf("class = %q, want %q", got, tt.wantClass)
				}
				return
			}
			if err != nil {
				t.Fatalf("PrepareContext: %v", err)
			}
			if result.Commitment.Digest != tt.wantDigest {
				t.Errorf("Commitment.Digest = %q, want %q", result.Commitment.Digest, tt.wantDigest)
			}
		})
	}
}
