package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zerkerlabs/gateway/gateway/internal/auth/authtest"
	"github.com/zerkerlabs/gateway/gateway/internal/invocation"
	"github.com/zerkerlabs/gateway/gateway/internal/policy"
)

// The decision the engine makes immediately before an invocation is created is
// now recorded on that invocation (spec 0009). The distinction these tests
// exist to protect is between "allowed" and "no policy applied": both let the
// call through, and collapsing them would report every call in a tenant with
// no policy document as having passed a check that never ran.

// proxyOnceForPolicy issues one transactional call and waits for the
// invocation to exist, returning the single row.
func proxyOnceForPolicy(t *testing.T, mux *http.ServeMux, invStore *invocation.MemoryStore, agentID string, wantStatus int) []*invocation.Invocation {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/proxy/"+agentID, bytes.NewReader([]byte(`{"x":1}`)))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(authtest.WithIdentity(req.Context(), testTenant, testUser))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != wantStatus {
		t.Fatalf("proxy status = %d, want %d; body = %s", rec.Code, wantStatus, rec.Body.String())
	}
	rows, _, err := invStore.ListFiltered(context.Background(), testTenant, invocation.ListFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list invocations: %v", err)
	}
	return rows
}

func TestAllowedCallRecordsItsPolicyDecision(t *testing.T) {
	fwd := &mockForwarder{result: fakeResult(200, `{"ok":true}`)}
	store := policy.NewMemoryStore()
	putPolicy(t, store, policy.PutFields{Default: policy.ActionAllow, OnError: policy.ActionDeny})
	mux, agentStore, invStore := policyEnforcementHandler(t, fwd, store)
	agentID := seedActiveAgent(t, agentStore, "https://upstream.example.com/api")

	rows := proxyOnceForPolicy(t, mux, invStore, agentID, http.StatusAccepted)
	if len(rows) != 1 {
		t.Fatalf("got %d invocations, want 1", len(rows))
	}
	inv := rows[0]
	if inv.PolicyAction == nil {
		t.Fatal("PolicyAction is nil; an evaluated allow must be recorded, not left absent")
	}
	if *inv.PolicyAction != "allow" {
		t.Fatalf("PolicyAction = %q, want allow", *inv.PolicyAction)
	}
	// The configured default applied because no rule matched. The empty string
	// records that distinctly from "rule 1 matched".
	if inv.PolicyMatchedRule == nil || *inv.PolicyMatchedRule != "" {
		t.Fatalf("PolicyMatchedRule = %v, want a recorded empty string", inv.PolicyMatchedRule)
	}
}

func TestWarnedCallRecordsWarnAndItsRulePosition(t *testing.T) {
	fwd := &mockForwarder{result: fakeResult(200, `{"ok":true}`)}
	store := policy.NewMemoryStore()
	putPolicy(t, store, policy.PutFields{
		Default: policy.ActionAllow,
		OnError: policy.ActionDeny,
		Rules:   []policy.Rule{{Action: policy.ActionWarn, Match: policy.Match{}}},
	})
	mux, agentStore, invStore := policyEnforcementHandler(t, fwd, store)
	agentID := seedActiveAgent(t, agentStore, "https://upstream.example.com/api")

	rows := proxyOnceForPolicy(t, mux, invStore, agentID, http.StatusAccepted)
	if len(rows) != 1 {
		t.Fatalf("got %d invocations, want 1", len(rows))
	}
	if rows[0].PolicyAction == nil || *rows[0].PolicyAction != "warn" {
		t.Fatalf("PolicyAction = %v, want warn", rows[0].PolicyAction)
	}
	if rows[0].PolicyMatchedRule == nil || *rows[0].PolicyMatchedRule != "1" {
		t.Fatalf("PolicyMatchedRule = %v, want \"1\"", rows[0].PolicyMatchedRule)
	}
}

func TestNoPolicyConfiguredLeavesTheDecisionAbsentRatherThanAllowed(t *testing.T) {
	// The load-bearing case. A tenant with no policy document did not allow
	// this call — nothing evaluated it. Recording "allow" would make the field
	// claim a check ran, and would make every pre-policy row read as vetted.
	fwd := &mockForwarder{result: fakeResult(200, `{"ok":true}`)}
	mux, agentStore, invStore := policyEnforcementHandler(t, fwd, policy.NewMemoryStore())
	agentID := seedActiveAgent(t, agentStore, "https://upstream.example.com/api")

	rows := proxyOnceForPolicy(t, mux, invStore, agentID, http.StatusAccepted)
	if len(rows) != 1 {
		t.Fatalf("got %d invocations, want 1", len(rows))
	}
	if rows[0].PolicyAction != nil {
		t.Fatalf("PolicyAction = %q, want nil when no policy is configured", *rows[0].PolicyAction)
	}
	if rows[0].PolicyMatchedRule != nil {
		t.Fatalf("PolicyMatchedRule = %q, want nil", *rows[0].PolicyMatchedRule)
	}
}

func TestDeniedCallCreatesNoInvocationToRecordADecisionOn(t *testing.T) {
	// Why policy_action can never read "deny": enforcePolicy returns before
	// invocations.Create. The absence of denials in this table is a property of
	// the table, not evidence that nothing is being denied.
	fwd := &mockForwarder{result: fakeResult(200, `{"ok":true}`)}
	store := policy.NewMemoryStore()
	putPolicy(t, store, policy.PutFields{Default: policy.ActionDeny, OnError: policy.ActionDeny})
	mux, agentStore, invStore := policyEnforcementHandler(t, fwd, store)
	agentID := seedActiveAgent(t, agentStore, "https://upstream.example.com/api")

	rows := proxyOnceForPolicy(t, mux, invStore, agentID, http.StatusForbidden)
	if len(rows) != 0 {
		t.Fatalf("got %d invocations for a denied call, want 0", len(rows))
	}
}

func TestPolicyFilterRejectsDenyAndSaysWhy(t *testing.T) {
	fwd := &mockForwarder{result: fakeResult(200, `{"ok":true}`)}
	mux, _, _ := policyEnforcementHandler(t, fwd, policy.NewMemoryStore())

	req := httptest.NewRequest(http.MethodGet, "/v1/invocations?policy=deny", nil)
	req = req.WithContext(authtest.WithIdentity(req.Context(), testTenant, testUser))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// An empty page would read as "nothing was denied" rather than "denials
	// are not in this table", so the rejection has to explain itself.
	if !strings.Contains(body["error"], "creates no invocation") {
		t.Fatalf("error %q should explain why deny cannot match", body["error"])
	}
}

func TestPolicyFilterTreatsAnAbsentDecisionAsNeitherAllowNorWarn(t *testing.T) {
	store := invocation.NewMemoryStore()
	ctx := context.Background()
	allow, warn := "allow", "warn"
	for _, action := range []*string{&allow, &warn, nil} {
		if err := store.Create(ctx, testTenant, &invocation.Invocation{
			AgentID: "agt_1",
			Mode:    invocation.ModeTransactional,
			Status:  invocation.StatusSucceeded,
			// A nil action is a row from a tenant with no policy document.
			PolicyAction: action,
		}); err != nil {
			t.Fatalf("create: %v", err)
		}
	}

	for _, tc := range []struct{ filter, want string }{{allow, "allow"}, {warn, "warn"}} {
		f := tc.filter
		rows, total, err := store.ListFiltered(ctx, testTenant, invocation.ListFilter{PolicyAction: &f, Limit: 10})
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		if total != 1 || len(rows) != 1 {
			t.Fatalf("%s: total = %d, rows = %d, want 1 and 1 — the null-decision row must not match", f, total, len(rows))
		}
		if *rows[0].PolicyAction != tc.want {
			t.Fatalf("got %q, want %q", *rows[0].PolicyAction, tc.want)
		}
	}
}
