package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/agent"
	"github.com/zerkerlabs/gateway/gateway/internal/httpapi"
	"github.com/zerkerlabs/gateway/gateway/internal/policy"
)

// signalDecisionRecorder persists each captured decision to store and signals
// on ch once the write is done. It lets a test wait out the enforcement point's
// async `go Record(...)` deterministically (mirroring fakeEmitter's channel),
// while the read endpoint reads the same store back.
type signalDecisionRecorder struct {
	store policy.DecisionStore
	ch    chan struct{}
}

func (r *signalDecisionRecorder) Record(ctx context.Context, d policy.RecordedDecision) {
	_, _ = r.store.Insert(ctx, d)
	r.ch <- struct{}{}
}

// decisionListResponse mirrors the handler's policyDecisionListResponse for
// decoding in tests (the wire shape, not the unexported handler type).
type decisionListResponse struct {
	Data []struct {
		ID          string  `json:"id"`
		AgentID     string  `json:"agent_id"`
		Protocol    string  `json:"protocol"`
		MCPTool     *string `json:"mcp_tool"`
		Action      string  `json:"action"`
		MatchedRule string  `json:"matched_rule"`
		Reason      string  `json:"reason"`
		CreatedAt   string  `json:"created_at"`
	} `json:"data"`
	Limit int `json:"limit"`
}

func decodeDecisions(t *testing.T, body []byte) decisionListResponse {
	t.Helper()
	var resp decisionListResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode decisions body: %v; body = %s", err, body)
	}
	return resp
}

// denyThenWarnPolicy is a two-rule document: deny delete_*, warn risky_tool.
func denyThenWarnPolicy() policy.PutFields {
	return policy.PutFields{
		Default: policy.ActionAllow,
		OnError: policy.ActionDeny,
		Rules: []policy.Rule{
			{Action: policy.ActionDeny, Match: policy.Match{Tools: []string{"delete_*"}}},
			{Action: policy.ActionWarn, Match: policy.Match{Tools: []string{"risky_tool"}}},
		},
	}
}

func TestPolicyDecisions_DenyAndWarnAppearOnRead(t *testing.T) {
	t.Parallel()

	fwd := &mockForwarder{streamResult: fakeResult(200, `{"ok":true}`)}
	store := policy.NewMemoryStore()
	putPolicy(t, store, denyThenWarnPolicy())

	decStore := policy.NewMemoryDecisionStore()
	sig := &signalDecisionRecorder{store: decStore, ch: make(chan struct{}, 8)}
	mux, agentStore, _ := policyEnforcementHandler(t, fwd, store, func(h *httpapi.Handler) {
		h.WithPolicyDecisions(decStore).WithPolicyDecisionRecorder(sig)
	})
	agentID := seedMCPAgent(t, agentStore, "https://mcp-upstream.example.com/")

	// A denied call (delete_repo → rule 1) and a warned call (risky_tool →
	// rule 2), both via the streaming path (which forwards synchronously).
	denyBody := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delete_repo"}}`)
	warnBody := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"risky_tool"}}`)

	denyRec := httptest.NewRecorder()
	mux.ServeHTTP(denyRec, authedPostRequest(t, "/v1/proxy/"+agentID+"/stream", denyBody, testTenant, testUser))
	if denyRec.Code != http.StatusForbidden {
		t.Fatalf("deny call status = %d, want 403; body = %s", denyRec.Code, denyRec.Body.String())
	}
	<-sig.ch // wait out the async capture

	warnRec := httptest.NewRecorder()
	mux.ServeHTTP(warnRec, authedPostRequest(t, "/v1/proxy/"+agentID+"/stream", warnBody, testTenant, testUser))
	if warnRec.Code != http.StatusOK {
		t.Fatalf("warn call status = %d, want 200; body = %s", warnRec.Code, warnRec.Body.String())
	}
	<-sig.ch

	// The read side: both decisions, newest first (warn, then deny).
	getRec := httptest.NewRecorder()
	mux.ServeHTTP(getRec, authedGetRequest(t, "/v1/policy/decisions", testTenant, testUser))
	if getRec.Code != http.StatusOK {
		t.Fatalf("GET /v1/policy/decisions status = %d, want 200; body = %s", getRec.Code, getRec.Body.String())
	}

	resp := decodeDecisions(t, getRec.Body.Bytes())
	if len(resp.Data) != 2 {
		t.Fatalf("read %d decisions, want 2 (a deny + a warn); body = %s", len(resp.Data), getRec.Body.String())
	}

	warn, deny := resp.Data[0], resp.Data[1]
	if warn.Action != "warn" || warn.MCPTool == nil || *warn.MCPTool != "risky_tool" {
		t.Errorf("newest decision = %+v, want warn on risky_tool", warn)
	}
	if deny.Action != "deny" || deny.MCPTool == nil || *deny.MCPTool != "delete_repo" {
		t.Errorf("older decision = %+v, want deny on delete_repo", deny)
	}
	// Each decision carries its matched rule + a coarse reason (spec 0009 audit
	// capture), and an id/agent.
	if deny.MatchedRule == "" {
		t.Error("deny decision has empty matched_rule, want the matched rule position")
	}
	if deny.Reason == "" {
		t.Error("deny decision has empty reason, want a coarse explanation")
	}
	if deny.ID == "" || deny.AgentID != agentID {
		t.Errorf("deny decision id/agent = %q/%q, want non-empty id and agent %q", deny.ID, deny.AgentID, agentID)
	}
}

func TestPolicyDecisions_TenantIsolation(t *testing.T) {
	t.Parallel()

	fwd := &mockForwarder{streamResult: fakeResult(200, `{"ok":true}`)}
	store := policy.NewMemoryStore()
	putPolicy(t, store, denyThenWarnPolicy())

	decStore := policy.NewMemoryDecisionStore()
	sig := &signalDecisionRecorder{store: decStore, ch: make(chan struct{}, 8)}
	mux, agentStore, _ := policyEnforcementHandler(t, fwd, store, func(h *httpapi.Handler) {
		h.WithPolicyDecisions(decStore).WithPolicyDecisionRecorder(sig)
	})
	agentID := seedMCPAgent(t, agentStore, "https://mcp-upstream.example.com/")

	denyBody := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delete_repo"}}`)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, authedPostRequest(t, "/v1/proxy/"+agentID+"/stream", denyBody, testTenant, testUser))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("deny call status = %d, want 403", rec.Code)
	}
	<-sig.ch

	// A different tenant must never see testTenant's decisions.
	getRec := httptest.NewRecorder()
	mux.ServeHTTP(getRec, authedGetRequest(t, "/v1/policy/decisions", "tenant-2", testUser))
	if getRec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200; body = %s", getRec.Code, getRec.Body.String())
	}
	resp := decodeDecisions(t, getRec.Body.Bytes())
	if len(resp.Data) != 0 {
		t.Errorf("tenant-2 read %d decisions, want 0 — cross-tenant reads must not leak", len(resp.Data))
	}
}

func TestPolicyDecisions_Unauthenticated401(t *testing.T) {
	t.Parallel()

	fwd := &mockForwarder{}
	mux, _, _ := policyEnforcementHandler(t, fwd, policy.NewMemoryStore(), func(h *httpapi.Handler) {
		h.WithPolicyDecisions(policy.NewMemoryDecisionStore())
	})

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, unauthGetRequest(t, "/v1/policy/decisions"))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (no identity)", rec.Code)
	}
}

func TestPolicyDecisions_EmptyWhenNoCaptures(t *testing.T) {
	t.Parallel()

	fwd := &mockForwarder{}
	mux, _, _ := policyEnforcementHandler(t, fwd, policy.NewMemoryStore(), func(h *httpapi.Handler) {
		h.WithPolicyDecisions(policy.NewMemoryDecisionStore())
	})

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, authedGetRequest(t, "/v1/policy/decisions", testTenant, testUser))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	resp := decodeDecisions(t, rec.Body.Bytes())
	if len(resp.Data) != 0 {
		t.Errorf("read %d decisions on a fresh store, want 0", len(resp.Data))
	}
}

// --- filtering, paging, and totals (the denial history) ---------------------

// decisionListWithTotals mirrors the wire shape including the paging fields.
type decisionListWithTotals struct {
	Data []struct {
		Action            string  `json:"action"`
		AgentID           string  `json:"agent_id"`
		ReceiptArtifactID *string `json:"receipt_artifact_id"`
		CreatedAt         string  `json:"created_at"`
	} `json:"data"`
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
	Total  int `json:"total"`
}

func seedDecisions(t *testing.T, store policy.DecisionStore, n int, action policy.Action, agentID string) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, err := store.Insert(context.Background(), policy.RecordedDecision{
			TenantID: testTenant,
			AgentID:  agentID,
			Protocol: "mcp",
			Decision: policy.Decision{Action: action, Reason: "seeded"},
		}); err != nil {
			t.Fatalf("seed decision: %v", err)
		}
	}
}

func listDecisions(t *testing.T, mux *http.ServeMux, query string) decisionListWithTotals {
	t.Helper()
	rec := getJSON(t, mux, "/v1/policy/decisions?"+query)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET decisions?%s = %d; body = %s", query, rec.Code, rec.Body.String())
	}
	var got decisionListWithTotals
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode decisions: %v; body = %s", err, rec.Body.String())
	}
	return got
}

func decisionMux(t *testing.T) (*http.ServeMux, policy.DecisionStore) {
	t.Helper()
	store := policy.NewMemoryDecisionStore()
	h := httpapi.NewHandler(agent.NewMemoryStore(), slog.New(slog.NewTextHandler(io.Discard, nil))).
		WithPolicy(policy.NewMemoryStore()).
		WithPolicyDecisions(store)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux, store
}

// Total counts every match, not just the page — otherwise a caller cannot tell
// "no more rows" from "the page ended exactly here".
func TestPolicyDecisions_TotalCountsBeyondThePage(t *testing.T) {
	t.Parallel()
	mux, store := decisionMux(t)
	seedDecisions(t, store, 7, policy.ActionDeny, "agt_a")

	got := listDecisions(t, mux, "limit=3")
	if len(got.Data) != 3 {
		t.Errorf("page size = %d, want 3", len(got.Data))
	}
	if got.Total != 7 {
		t.Errorf("total = %d, want 7", got.Total)
	}
	if got.Limit != 3 || got.Offset != 0 {
		t.Errorf("limit/offset = %d/%d, want 3/0", got.Limit, got.Offset)
	}
}

// Denials older than one page must be reachable: this store is the only record
// of a refused call.
func TestPolicyDecisions_OffsetReachesOlderRows(t *testing.T) {
	t.Parallel()
	mux, store := decisionMux(t)
	seedDecisions(t, store, 5, policy.ActionDeny, "agt_a")

	first := listDecisions(t, mux, "limit=2&offset=0")
	second := listDecisions(t, mux, "limit=2&offset=2")
	third := listDecisions(t, mux, "limit=2&offset=4")

	if len(first.Data) != 2 || len(second.Data) != 2 || len(third.Data) != 1 {
		t.Fatalf("page sizes = %d/%d/%d, want 2/2/1", len(first.Data), len(second.Data), len(third.Data))
	}
	if first.Data[0].CreatedAt == second.Data[0].CreatedAt && first.Data[1].CreatedAt == second.Data[1].CreatedAt {
		t.Error("offset returned the same rows as the first page")
	}
	for _, page := range []decisionListWithTotals{first, second, third} {
		if page.Total != 5 {
			t.Errorf("total = %d on a paged read, want 5 regardless of page", page.Total)
		}
	}
}

// deny is the most useful filter value here, and unlike the invocations list
// it must be accepted: this is the store that has denials.
func TestPolicyDecisions_FilterByAction(t *testing.T) {
	t.Parallel()
	mux, store := decisionMux(t)
	seedDecisions(t, store, 2, policy.ActionDeny, "agt_a")
	seedDecisions(t, store, 3, policy.ActionAllow, "agt_a")

	denies := listDecisions(t, mux, "action=deny")
	if denies.Total != 2 {
		t.Errorf("deny total = %d, want 2", denies.Total)
	}
	for _, d := range denies.Data {
		if d.Action != "deny" {
			t.Errorf("action=deny returned a %q row", d.Action)
		}
	}
	if allows := listDecisions(t, mux, "action=allow"); allows.Total != 3 {
		t.Errorf("allow total = %d, want 3", allows.Total)
	}
}

func TestPolicyDecisions_FilterByAgent(t *testing.T) {
	t.Parallel()
	mux, store := decisionMux(t)
	seedDecisions(t, store, 2, policy.ActionDeny, "agt_a")
	seedDecisions(t, store, 4, policy.ActionDeny, "agt_b")

	if got := listDecisions(t, mux, "agent_id=agt_b"); got.Total != 4 {
		t.Errorf("agent_id=agt_b total = %d, want 4", got.Total)
	}
}

func TestPolicyDecisions_TimeRangeExcludesOutsideRows(t *testing.T) {
	t.Parallel()
	mux, store := decisionMux(t)
	seedDecisions(t, store, 3, policy.ActionDeny, "agt_a")

	future := time.Now().UTC().Add(time.Hour).Format(time.RFC3339)
	if got := listDecisions(t, mux, "since="+future); got.Total != 0 {
		t.Errorf("since=<future> total = %d, want 0", got.Total)
	}
	past := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	if got := listDecisions(t, mux, "since="+past); got.Total != 3 {
		t.Errorf("since=<past> total = %d, want 3", got.Total)
	}
}

func TestPolicyDecisions_InvalidFiltersAre400(t *testing.T) {
	t.Parallel()
	mux, _ := decisionMux(t)

	for _, q := range []string{"since=yesterday", "until=soon", "action=block"} {
		rec := getJSON(t, mux, "/v1/policy/decisions?"+q)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("GET decisions?%s = %d, want 400", q, rec.Code)
		}
	}

	now := time.Now().UTC()
	rec := getJSON(t, mux, "/v1/policy/decisions?since="+now.Format(time.RFC3339)+"&until="+now.Add(-time.Hour).Format(time.RFC3339))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("since after until = %d, want 400", rec.Code)
	}
}
