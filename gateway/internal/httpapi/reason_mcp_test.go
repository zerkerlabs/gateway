package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/zerkerlabs/gateway/gateway/internal/agent"
	"github.com/zerkerlabs/gateway/gateway/internal/httpapi"
	"github.com/zerkerlabs/gateway/gateway/internal/invocation"
	"github.com/zerkerlabs/gateway/gateway/internal/policy"
	"github.com/zerkerlabs/gateway/gateway/internal/proxy"
	reasonauth "github.com/zerkerlabs/gateway/gateway/internal/reason"
)

const reasonTestDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type fakeReasonVerifier struct {
	mu      sync.Mutex
	bundles [][]byte
	err     error
}

func (v *fakeReasonVerifier) Verify(_ context.Context, bundle []byte) (reasonauth.Verification, error) {
	v.mu.Lock()
	v.bundles = append(v.bundles, append([]byte(nil), bundle...))
	err := v.err
	v.mu.Unlock()
	if err != nil {
		return reasonauth.Verification{}, err
	}
	return reasonauth.Verification{RequestDigest: reasonTestDigest, ReasoningResultDigest: reasonTestDigest}, nil
}

func (v *fakeReasonVerifier) setError(err error) {
	v.mu.Lock()
	v.err = err
	v.mu.Unlock()
}

type reasonCapturingForwarder struct {
	mu    sync.Mutex
	body  []byte
	calls int
	err   error
}

func (f *reasonCapturingForwarder) Do(_ context.Context, _, _, _ string, r *http.Request) (*proxy.Result, error) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	f.body = body
	f.calls++
	err = f.err
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return fakeResult(http.StatusOK, `{"ok":true}`), nil
}

func (f *reasonCapturingForwarder) DoStream(_ context.Context, _, _, _ string, _ *http.Request) (*proxy.Result, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	return fakeResult(http.StatusOK, `{"ok":true}`), nil
}

func (f *reasonCapturingForwarder) snapshot() ([]byte, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.body...), f.calls
}

func reasonEnvelope(call, tool, arguments, agentID string) []byte {
	return reasonEnvelopeBound(call, tool, arguments, testUser, testTenant, agentID)
}

func reasonEnvelopeBound(call, tool, arguments, principal, tenantID, agentID string) []byte {
	bundle := `{"schema":"zerker.reason.authorization-bundle.v1","request":{"schema":"zerker.reason.action.v1","mission":{"principal":` + quoteJSON(principal) + `,"constraints":{"gateway.tenant_id":` + quoteJSON(tenantID) + `,"gateway.agent_id":` + quoteJSON(agentID) + `}},"action":{"tool":"` + tool + `","arguments":` + arguments + `}},"certificate":{}}`
	return []byte(`{"schema":"zerker.gateway.reason-mcp-call.v1","call":` + call + `,"authorization":` + bundle + `}`)
}

func quoteJSON(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func newReasonHandler(t *testing.T, verifier reasonauth.Verifier, priced bool) (*http.ServeMux, *invocation.MemoryStore, *reasonCapturingForwarder, string) {
	t.Helper()
	return newReasonHandlerWithOptions(t, verifier, priced)
}

func newReasonHandlerWithOptions(t *testing.T, verifier reasonauth.Verifier, priced bool, options ...func(*httpapi.Handler)) (*http.ServeMux, *invocation.MemoryStore, *reasonCapturingForwarder, string) {
	t.Helper()
	store := agent.NewMemoryStore()
	url := "https://mcp-upstream.example.com"
	transport := "streamable_http"
	a := &agent.Agent{Name: "reason-mcp", CreatedBy: testUser, UpstreamURL: &url, Protocol: "mcp", MCPTransport: &transport}
	if priced {
		a.Pricing = &agent.Pricing{Amount: "10000", Asset: "USDC", Network: "base", PayTo: "0x1111111111111111111111111111111111111111"}
	}
	if err := store.Create(context.Background(), testTenant, a); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	invStore := invocation.NewMemoryStore()
	fwd := &reasonCapturingForwarder{}
	h := httpapi.NewHandler(store, slog.New(slog.NewTextHandler(io.Discard, nil))).
		WithProxy(fwd, invStore).
		WithReasonVerifier(verifier)
	for _, option := range options {
		option(h)
	}
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux, invStore, fwd, a.ID
}

func TestReasonMCPAuthorizedExactCallForwardsOnlyInnerCall(t *testing.T) {
	verifier := &fakeReasonVerifier{}
	mux, invStore, fwd, agentID := newReasonHandler(t, verifier, false)
	call := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"deploy","arguments":{"version":"1.0","targets":["a","b"]}}}`
	req := authedPostRequest(t, "/v1/proxy/"+agentID, reasonEnvelope(call, "deploy", `{"targets":["a","b"],"version":"1.0"}`, agentID), testTenant, testUser)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	invID := rec.Header().Get("X-Zerker-Invocation-ID")
	inv := waitForStatus(t, invStore, invID, invocation.StatusSucceeded)
	gotBody, calls := fwd.snapshot()
	if calls != 1 || string(gotBody) != call {
		t.Fatalf("forwarded calls=%d body=%s, want exact inner call %s", calls, gotBody, call)
	}
	if inv.ReasonRequestDigest == nil || *inv.ReasonRequestDigest != reasonTestDigest ||
		inv.ReasoningResultDigest == nil || *inv.ReasoningResultDigest != reasonTestDigest {
		t.Fatalf("Reason commitments = %v %v", inv.ReasonRequestDigest, inv.ReasoningResultDigest)
	}
	verifier.mu.Lock()
	defer verifier.mu.Unlock()
	if len(verifier.bundles) != 1 || !strings.Contains(string(verifier.bundles[0]), "authorization-bundle.v1") {
		t.Fatalf("verifier bundles = %q", verifier.bundles)
	}
}

func TestReasonMCPAuthorizationIsBoundToAuthenticatedContext(t *testing.T) {
	call := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"deploy","arguments":{}}}`
	tests := []struct {
		name      string
		principal string
		tenantID  string
		agentID   func(actual string) string
	}{
		{name: "different principal", principal: "user_other", tenantID: testTenant, agentID: func(actual string) string { return actual }},
		{name: "different tenant", principal: testUser, tenantID: "tenant_other", agentID: func(actual string) string { return actual }},
		{name: "different agent", principal: testUser, tenantID: testTenant, agentID: func(string) string { return "agent_other" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mux, invStore, fwd, actualAgentID := newReasonHandler(t, &fakeReasonVerifier{}, false)
			body := reasonEnvelopeBound(call, "deploy", `{}`, tt.principal, tt.tenantID, tt.agentID(actualAgentID))
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, authedPostRequest(t, "/v1/proxy/"+actualAgentID, body, testTenant, testUser))
			if rec.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403; body=%s", rec.Code, rec.Body.String())
			}
			if _, calls := fwd.snapshot(); calls != 0 {
				t.Fatalf("forwarder calls = %d, want 0", calls)
			}
			_, total, err := invStore.List(context.Background(), testTenant, actualAgentID, 1, 10)
			if err != nil || total != 0 {
				t.Fatalf("invocations total=%d err=%v, want none", total, err)
			}
		})
	}
}

func TestReasonMCPFailuresPrecedePaymentInvocationAndForwarding(t *testing.T) {
	call := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"deploy","arguments":{"environment":"production"}}}`
	tests := []struct {
		name     string
		verifier *fakeReasonVerifier
		body     func(agentID string) []byte
		want     int
	}{
		{name: "missing envelope", verifier: &fakeReasonVerifier{}, body: func(string) []byte { return []byte(call) }, want: http.StatusForbidden},
		{name: "tampered certificate", verifier: &fakeReasonVerifier{err: reasonauth.ErrNotAuthorized}, body: func(agentID string) []byte {
			return reasonEnvelope(call, "deploy", `{"environment":"production"}`, agentID)
		}, want: http.StatusForbidden},
		{name: "verifier timeout", verifier: &fakeReasonVerifier{err: context.DeadlineExceeded}, body: func(agentID string) []byte {
			return reasonEnvelope(call, "deploy", `{"environment":"production"}`, agentID)
		}, want: http.StatusForbidden},
		{name: "tool mismatch", verifier: &fakeReasonVerifier{}, body: func(agentID string) []byte {
			return reasonEnvelope(call, "delete", `{"environment":"production"}`, agentID)
		}, want: http.StatusForbidden},
		{name: "argument mismatch", verifier: &fakeReasonVerifier{}, body: func(agentID string) []byte {
			return reasonEnvelope(call, "deploy", `{"environment":"staging"}`, agentID)
		}, want: http.StatusForbidden},
		{name: "duplicate argument key", verifier: &fakeReasonVerifier{}, body: func(agentID string) []byte {
			return reasonEnvelope(call, "deploy", `{"environment":"production","environment":"staging"}`, agentID)
		}, want: http.StatusBadRequest},
		{name: "malformed call", verifier: &fakeReasonVerifier{}, body: func(string) []byte { return []byte(`{"jsonrpc":"2.0","method":"tools/call"}`) }, want: http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mux, invStore, fwd, agentID := newReasonHandler(t, tt.verifier, true)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, authedPostRequest(t, "/v1/proxy/"+agentID, tt.body(agentID), testTenant, testUser))
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, tt.want, rec.Body.String())
			}
			if _, calls := fwd.snapshot(); calls != 0 {
				t.Fatalf("forwarder calls = %d, want 0", calls)
			}
			invs, total, err := invStore.List(context.Background(), testTenant, agentID, 1, 10)
			if err != nil || total != 0 || len(invs) != 0 {
				t.Fatalf("invocations = %d/%d err=%v, want none", len(invs), total, err)
			}
			if rec.Code == http.StatusPaymentRequired {
				t.Fatal("Reason failure leaked through to x402 challenge")
			}
		})
	}
}

func TestReasonMCPReplayIsDurablyReservedByInvocationStore(t *testing.T) {
	mux, invStore, fwd, agentID := newReasonHandler(t, &fakeReasonVerifier{}, false)
	call := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"deploy","arguments":{}}}`
	body := reasonEnvelope(call, "deploy", `{}`, agentID)

	first := httptest.NewRecorder()
	mux.ServeHTTP(first, authedPostRequest(t, "/v1/proxy/"+agentID, body, testTenant, testUser))
	if first.Code != http.StatusAccepted {
		t.Fatalf("first status = %d; body=%s", first.Code, first.Body.String())
	}
	waitForStatus(t, invStore, first.Header().Get("X-Zerker-Invocation-ID"), invocation.StatusSucceeded)

	second := httptest.NewRecorder()
	mux.ServeHTTP(second, authedPostRequest(t, "/v1/proxy/"+agentID, body, testTenant, testUser))
	if second.Code != http.StatusConflict {
		t.Fatalf("replay status = %d, want 409; body=%s", second.Code, second.Body.String())
	}
	if _, calls := fwd.snapshot(); calls != 1 {
		t.Fatalf("forwarder calls = %d, want 1", calls)
	}
}

func TestReasonMCPPolicyDenialDoesNotConsumeAuthorization(t *testing.T) {
	policyStore := policy.NewMemoryStore()
	putPolicy(t, policyStore, policy.PutFields{Default: policy.ActionDeny, OnError: policy.ActionDeny})
	mux, invStore, fwd, agentID := newReasonHandlerWithOptions(t, &fakeReasonVerifier{}, false, func(h *httpapi.Handler) {
		h.WithPolicy(policyStore)
	})
	call := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"deploy","arguments":{}}}`
	body := reasonEnvelope(call, "deploy", `{}`, agentID)

	denied := httptest.NewRecorder()
	mux.ServeHTTP(denied, authedPostRequest(t, "/v1/proxy/"+agentID, body, testTenant, testUser))
	if denied.Code != http.StatusForbidden {
		t.Fatalf("denied status = %d, want 403; body=%s", denied.Code, denied.Body.String())
	}

	putPolicy(t, policyStore, policy.PutFields{Default: policy.ActionAllow, OnError: policy.ActionDeny})
	retry := httptest.NewRecorder()
	mux.ServeHTTP(retry, authedPostRequest(t, "/v1/proxy/"+agentID, body, testTenant, testUser))
	if retry.Code != http.StatusAccepted {
		t.Fatalf("retry status = %d, want 202; body=%s", retry.Code, retry.Body.String())
	}
	waitForStatus(t, invStore, retry.Header().Get("X-Zerker-Invocation-ID"), invocation.StatusSucceeded)
	if _, calls := fwd.snapshot(); calls != 1 {
		t.Fatalf("forwarder calls = %d, want 1", calls)
	}
}

func TestReasonMCPVerifierFailureDoesNotConsumeAuthorization(t *testing.T) {
	verifier := &fakeReasonVerifier{err: reasonauth.ErrNotAuthorized}
	mux, invStore, fwd, agentID := newReasonHandler(t, verifier, false)
	call := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"deploy","arguments":{}}}`
	body := reasonEnvelope(call, "deploy", `{}`, agentID)

	rejected := httptest.NewRecorder()
	mux.ServeHTTP(rejected, authedPostRequest(t, "/v1/proxy/"+agentID, body, testTenant, testUser))
	if rejected.Code != http.StatusForbidden {
		t.Fatalf("rejected status = %d, want 403; body=%s", rejected.Code, rejected.Body.String())
	}

	verifier.setError(nil)
	retry := httptest.NewRecorder()
	mux.ServeHTTP(retry, authedPostRequest(t, "/v1/proxy/"+agentID, body, testTenant, testUser))
	if retry.Code != http.StatusAccepted {
		t.Fatalf("retry status = %d, want 202; body=%s", retry.Code, retry.Body.String())
	}
	waitForStatus(t, invStore, retry.Header().Get("X-Zerker-Invocation-ID"), invocation.StatusSucceeded)
	if _, calls := fwd.snapshot(); calls != 1 {
		t.Fatalf("forwarder calls = %d, want 1", calls)
	}
}

func TestReasonMCPPaymentChallengeDoesNotConsumeAuthorization(t *testing.T) {
	mux, invStore, fwd, agentID := newReasonHandler(t, &fakeReasonVerifier{}, true)
	call := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"deploy","arguments":{}}}`
	body := reasonEnvelope(call, "deploy", `{}`, agentID)

	challenge := httptest.NewRecorder()
	mux.ServeHTTP(challenge, authedPostRequest(t, "/v1/proxy/"+agentID, body, testTenant, testUser))
	if challenge.Code != http.StatusPaymentRequired {
		t.Fatalf("challenge status = %d, want 402; body=%s", challenge.Code, challenge.Body.String())
	}

	used, err := invStore.ReasonAuthorizationUsed(context.Background(), testTenant, reasonTestDigest)
	if err != nil || used {
		t.Fatalf("authorization used=%v err=%v after payment challenge, want false", used, err)
	}
	if _, calls := fwd.snapshot(); calls != 0 {
		t.Fatalf("forwarder calls = %d, want 0", calls)
	}
}

func TestReasonMCPAuthorizationRemainsConsumedAfterUpstreamFailure(t *testing.T) {
	mux, invStore, fwd, agentID := newReasonHandler(t, &fakeReasonVerifier{}, false)
	fwd.err = errors.New("upstream failed after dispatch")
	call := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"deploy","arguments":{}}}`
	body := reasonEnvelope(call, "deploy", `{}`, agentID)

	first := httptest.NewRecorder()
	mux.ServeHTTP(first, authedPostRequest(t, "/v1/proxy/"+agentID, body, testTenant, testUser))
	if first.Code != http.StatusAccepted {
		t.Fatalf("first status = %d, want 202; body=%s", first.Code, first.Body.String())
	}
	waitForStatus(t, invStore, first.Header().Get("X-Zerker-Invocation-ID"), invocation.StatusFailed)

	second := httptest.NewRecorder()
	mux.ServeHTTP(second, authedPostRequest(t, "/v1/proxy/"+agentID, body, testTenant, testUser))
	if second.Code != http.StatusConflict {
		t.Fatalf("replay status = %d, want 409; body=%s", second.Code, second.Body.String())
	}
	if _, calls := fwd.snapshot(); calls != 1 {
		t.Fatalf("forwarder calls = %d, want 1", calls)
	}
}

func TestReasonMCPKnownReplayIsRejectedBeforeX402(t *testing.T) {
	mux, invStore, fwd, agentID := newReasonHandler(t, &fakeReasonVerifier{}, true)
	used := &invocation.Invocation{
		AgentID:             agentID,
		Mode:                invocation.ModeTransactional,
		Status:              invocation.StatusSucceeded,
		ReasonRequestDigest: ptr(reasonTestDigest),
	}
	if err := invStore.Create(context.Background(), testTenant, used); err != nil {
		t.Fatalf("seed used authorization: %v", err)
	}
	call := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"deploy","arguments":{}}}`
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, authedPostRequest(t, "/v1/proxy/"+agentID, reasonEnvelope(call, "deploy", `{}`, agentID), testTenant, testUser))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 before x402; body=%s", rec.Code, rec.Body.String())
	}
	if _, calls := fwd.snapshot(); calls != 0 {
		t.Fatalf("forwarder calls = %d, want 0", calls)
	}
}

func ptr[T any](value T) *T { return &value }

func TestReasonMCPStreamingEndpointCannotBypassEnforcement(t *testing.T) {
	mux, invStore, fwd, agentID := newReasonHandler(t, &fakeReasonVerifier{}, true)
	rec := httptest.NewRecorder()
	body := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"deploy","arguments":{}}}`)
	mux.ServeHTTP(rec, authedPostRequest(t, "/v1/proxy/"+agentID+"/stream", body, testTenant, testUser))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if _, calls := fwd.snapshot(); calls != 0 {
		t.Fatalf("forwarder calls = %d, want 0", calls)
	}
	_, total, err := invStore.List(context.Background(), testTenant, agentID, 1, 10)
	if err != nil || total != 0 {
		t.Fatalf("invocations total=%d err=%v, want none", total, err)
	}
}

func TestReasonMCPDiscoveryRequestRemainsUnenveloped(t *testing.T) {
	mux, invStore, _, agentID := newReasonHandler(t, &fakeReasonVerifier{err: errors.New("must not run")}, false)
	body := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, authedPostRequest(t, "/v1/proxy/"+agentID, body, testTenant, testUser))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	waitForStatus(t, invStore, rec.Header().Get("X-Zerker-Invocation-ID"), invocation.StatusSucceeded)
}
