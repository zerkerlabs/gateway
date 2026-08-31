package httpapi_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/agent"
	"github.com/zerkerlabs/gateway/gateway/internal/auth/authtest"
	"github.com/zerkerlabs/gateway/gateway/internal/httpapi"
	"github.com/zerkerlabs/gateway/gateway/internal/policy"
	"github.com/zerkerlabs/gateway/gateway/internal/receipt"
)

// A denied call never becomes an invocation — enforcePolicy returns before
// invocations.Create — so none of the invocation-row assertions elsewhere in
// this package can observe one. Before this, that meant the gateway signed
// every call it allowed and produced no evidence at all for the calls it
// blocked, which is the wrong half to attest.
//
// These tests watch the emitter directly, because the emitter is the only
// place a denial leaves a trace.

// recordingEmitter captures both emission paths.
type recordingEmitter struct {
	mu       sync.Mutex
	receipts []receipt.Receipt
	denials  []receipt.Denial
	got      chan struct{} // closed-ish signal: one send per denial
}

func newRecordingEmitter() *recordingEmitter {
	return &recordingEmitter{got: make(chan struct{}, 8)}
}

func (e *recordingEmitter) Emit(_ context.Context, r receipt.Receipt) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.receipts = append(e.receipts, r)
	return nil
}

func (e *recordingEmitter) EmitDenial(_ context.Context, d receipt.Denial) error {
	e.mu.Lock()
	e.denials = append(e.denials, d)
	e.mu.Unlock()
	select {
	case e.got <- struct{}{}:
	default:
	}
	return nil
}

// awaitDenial waits for one denial rather than sleeping: emission is
// deliberately off the request path, so the 403 can land before it.
func (e *recordingEmitter) awaitDenial(t *testing.T) receipt.Denial {
	t.Helper()
	select {
	case <-e.got:
	case <-time.After(3 * time.Second):
		t.Fatal("no denial artifact was emitted within 3s")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.denials[len(e.denials)-1]
}

func (e *recordingEmitter) denialCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.denials)
}

// seedReceiptingAgent creates an active agent with EmitReceipts enabled.
func seedReceiptingAgent(t *testing.T, store agent.AgentStore) string {
	t.Helper()
	upstream := "https://upstream.example.com/api"
	a := &agent.Agent{
		Name: "denial-receipt-agent", CreatedBy: testUser,
		UpstreamURL: &upstream, EmitReceipts: true,
	}
	if err := store.Create(context.Background(), testTenant, a); err != nil {
		t.Fatalf("seedReceiptingAgent: %v", err)
	}
	return a.ID
}

// denyOnce issues one call that the policy is expected to refuse.
func denyOnce(t *testing.T, mux *http.ServeMux, agentID string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/proxy/"+agentID, bytes.NewReader([]byte(`{"x":1}`)))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(authtest.WithIdentity(req.Context(), testTenant, testUser))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body = %s", rec.Code, rec.Body.String())
	}
}

func TestDeniedCallIsAttested(t *testing.T) {
	em := newRecordingEmitter()
	fwd := &mockForwarder{result: fakeResult(200, `{"ok":true}`)}
	store := policy.NewMemoryStore()
	putPolicy(t, store, policy.PutFields{Default: policy.ActionDeny, OnError: policy.ActionDeny})
	mux, agentStore, _ := policyEnforcementHandler(t, fwd, store,
		func(h *httpapi.Handler) { h.WithReceipts(em) })
	agentID := seedReceiptingAgent(t, agentStore)

	denyOnce(t, mux, agentID)
	d := em.awaitDenial(t)

	if d.AgentID != agentID {
		t.Fatalf("denial agent = %q, want %q", d.AgentID, agentID)
	}
	if d.TenantID != testTenant {
		t.Fatalf("denial tenant = %q, want %q", d.TenantID, testTenant)
	}
	if d.DeniedAt.IsZero() {
		t.Fatal("denial has no timestamp")
	}
	// The default refused, so no rule matched. Reporting a rule position here
	// would attribute the refusal to a rule that did not make it.
	if d.MatchedRule != "" {
		t.Fatalf("MatchedRule = %q, want empty when the policy default denied", d.MatchedRule)
	}

	// A denied call must not also be reported as a completed invocation.
	em.mu.Lock()
	n := len(em.receipts)
	em.mu.Unlock()
	if n != 0 {
		t.Fatalf("got %d invocation receipts for a denied call, want 0", n)
	}
}

func TestDeniedCallCarriesTheMatchedRulePosition(t *testing.T) {
	em := newRecordingEmitter()
	fwd := &mockForwarder{result: fakeResult(200, `{"ok":true}`)}
	store := policy.NewMemoryStore()
	// One rule matching any agent, so it — not the default — produces the deny.
	putPolicy(t, store, policy.PutFields{
		Rules:   []policy.Rule{{Action: policy.ActionDeny}},
		Default: policy.ActionAllow,
		OnError: policy.ActionDeny,
	})
	mux, agentStore, _ := policyEnforcementHandler(t, fwd, store,
		func(h *httpapi.Handler) { h.WithReceipts(em) })
	agentID := seedReceiptingAgent(t, agentStore)

	denyOnce(t, mux, agentID)
	if got := em.awaitDenial(t).MatchedRule; got != "1" {
		t.Fatalf("MatchedRule = %q, want \"1\" (1-based position of the deny rule)", got)
	}
}

func TestDenialIsNotAttestedWhenTheAgentHasReceiptsOff(t *testing.T) {
	// An operator who turned receipts off for an agent should not start
	// receiving artifacts for it because a call was refused rather than allowed.
	em := newRecordingEmitter()
	fwd := &mockForwarder{result: fakeResult(200, `{"ok":true}`)}
	store := policy.NewMemoryStore()
	putPolicy(t, store, policy.PutFields{Default: policy.ActionDeny, OnError: policy.ActionDeny})
	mux, agentStore, _ := policyEnforcementHandler(t, fwd, store,
		func(h *httpapi.Handler) { h.WithReceipts(em) })
	// seedActiveAgent leaves EmitReceipts at its false default.
	agentID := seedActiveAgent(t, agentStore, "https://upstream.example.com/api")

	denyOnce(t, mux, agentID)

	// Emission is asynchronous, so absence needs a window to be meaningful.
	time.Sleep(250 * time.Millisecond)
	if n := em.denialCount(); n != 0 {
		t.Fatalf("got %d denial artifacts for an agent with receipts disabled, want 0", n)
	}
}

func TestDenialStillDeniesWhenAttestationFails(t *testing.T) {
	// Fail-open is the contract: a gateway that cannot attest a denial must
	// still deny. If attestation failure ever turned a 403 into a 500, the
	// telemetry path would have become a availability dependency.
	em := &failingDenialEmitter{}
	fwd := &mockForwarder{result: fakeResult(200, `{"ok":true}`)}
	store := policy.NewMemoryStore()
	putPolicy(t, store, policy.PutFields{Default: policy.ActionDeny, OnError: policy.ActionDeny})
	mux, agentStore, _ := policyEnforcementHandler(t, fwd, store,
		func(h *httpapi.Handler) { h.WithReceipts(em) })
	agentID := seedReceiptingAgent(t, agentStore)

	denyOnce(t, mux, agentID) // asserts 403
}

type failingDenialEmitter struct{}

func (failingDenialEmitter) Emit(context.Context, receipt.Receipt) error { return nil }
func (failingDenialEmitter) EmitDenial(context.Context, receipt.Denial) error {
	return context.DeadlineExceeded
}

func TestPlainEmitterWithoutDenialSupportIsNotAFailure(t *testing.T) {
	// DenialEmitter is discovered by type assertion. An Emitter that only
	// handles completed invocations must stay valid and simply contribute no
	// denial artifacts — never panic, never block the 403.
	fwd := &mockForwarder{result: fakeResult(200, `{"ok":true}`)}
	store := policy.NewMemoryStore()
	putPolicy(t, store, policy.PutFields{Default: policy.ActionDeny, OnError: policy.ActionDeny})
	mux, agentStore, _ := policyEnforcementHandler(t, fwd, store,
		func(h *httpapi.Handler) { h.WithReceipts(invocationOnlyEmitter{}) })
	agentID := seedReceiptingAgent(t, agentStore)

	denyOnce(t, mux, agentID)
}

type invocationOnlyEmitter struct{}

func (invocationOnlyEmitter) Emit(context.Context, receipt.Receipt) error { return nil }
