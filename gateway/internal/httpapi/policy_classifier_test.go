package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/policy"
)

func TestHTTPClassifierClient_Classify_Success(t *testing.T) {
	t.Parallel()

	var gotReq policy.ClassifierRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %q, want POST", r.Method)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotReq); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(policy.ClassifierVerdict{Action: policy.ActionDeny, Reason: "flagged: unsafe content"})
	}))
	defer srv.Close()

	client := NewHTTPClassifierClient(srv.Client())
	tool := "risky_tool"
	verdict, err := client.Classify(context.Background(), srv.URL, policy.ClassifierRequest{
		TenantID: "tnt_1", AgentID: "agt_1", Protocol: policy.ProtocolMCP, MCPTool: &tool,
	})
	if err != nil {
		t.Fatalf("Classify: unexpected error: %v", err)
	}
	if verdict.Action != policy.ActionDeny {
		t.Errorf("Action = %q, want deny", verdict.Action)
	}
	if verdict.Reason != "flagged: unsafe content" {
		t.Errorf("Reason = %q, want %q", verdict.Reason, "flagged: unsafe content")
	}
	if gotReq.TenantID != "tnt_1" || gotReq.AgentID != "agt_1" {
		t.Errorf("request context not forwarded correctly: %+v", gotReq)
	}
	if gotReq.MCPTool == nil || *gotReq.MCPTool != tool {
		t.Errorf("request MCPTool = %v, want %q", gotReq.MCPTool, tool)
	}
}

func TestHTTPClassifierClient_Classify_Allow(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(policy.ClassifierVerdict{Action: policy.ActionAllow})
	}))
	defer srv.Close()

	client := NewHTTPClassifierClient(srv.Client())
	verdict, err := client.Classify(context.Background(), srv.URL, policy.ClassifierRequest{TenantID: "tnt_1"})
	if err != nil {
		t.Fatalf("Classify: unexpected error: %v", err)
	}
	if verdict.Action != policy.ActionAllow {
		t.Errorf("Action = %q, want allow", verdict.Action)
	}
}

func TestHTTPClassifierClient_Classify_BadStatus(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := NewHTTPClassifierClient(srv.Client())
	_, err := client.Classify(context.Background(), srv.URL, policy.ClassifierRequest{TenantID: "tnt_1"})
	if err == nil {
		t.Fatal("Classify: expected error, got nil")
	}
}

func TestHTTPClassifierClient_Classify_MalformedBody(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not json"))
	}))
	defer srv.Close()

	client := NewHTTPClassifierClient(srv.Client())
	_, err := client.Classify(context.Background(), srv.URL, policy.ClassifierRequest{TenantID: "tnt_1"})
	if err == nil {
		t.Fatal("Classify: expected error, got nil")
	}
}

func TestHTTPClassifierClient_Classify_InvalidVerdictAction(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(policy.ClassifierVerdict{Action: policy.Action("block")})
	}))
	defer srv.Close()

	client := NewHTTPClassifierClient(srv.Client())
	_, err := client.Classify(context.Background(), srv.URL, policy.ClassifierRequest{TenantID: "tnt_1"})
	if err == nil {
		t.Fatal("Classify: expected error for invalid verdict action, got nil")
	}
}

func TestHTTPClassifierClient_Classify_Unreachable(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // closed immediately: connection refused

	client := NewHTTPClassifierClient(srv.Client())
	_, err := client.Classify(context.Background(), url, policy.ClassifierRequest{TenantID: "tnt_1"})
	if err == nil {
		t.Fatal("Classify: expected error, got nil")
	}
}

func TestHTTPClassifierClient_Classify_Timeout(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(100 * time.Millisecond)
		_ = json.NewEncoder(w).Encode(policy.ClassifierVerdict{Action: policy.ActionDeny})
	}))
	defer srv.Close()

	fastClient := *srv.Client()
	fastClient.Timeout = 10 * time.Millisecond
	client := NewHTTPClassifierClient(&fastClient)

	_, err := client.Classify(context.Background(), srv.URL, policy.ClassifierRequest{TenantID: "tnt_1"})
	if err == nil {
		t.Fatal("Classify: expected a timeout error, got nil")
	}
	var netErr interface{ Timeout() bool }
	if errors.As(err, &netErr) && !netErr.Timeout() {
		t.Errorf("Classify: error is not a timeout: %v", err)
	}
}

// TestHTTPClassifierClient_Classify_SSRFGuard exercises the production wiring
// (NewHTTPClassifierClient(nil)): a classifier URL that resolves to loopback
// must be blocked, exactly as the facilitator settle client is (T6
// acceptance: "same SSRF guard as upstreams"). Tests that want to hit a local
// httptest.Server instead inject its client (see the tests above), which
// bypasses this guard the same way NewFacilitatorSettler's tests do.
func TestHTTPClassifierClient_Classify_SSRFGuard(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(policy.ClassifierVerdict{Action: policy.ActionAllow})
	}))
	defer srv.Close()

	client := NewHTTPClassifierClient(nil)
	_, err := client.Classify(context.Background(), srv.URL, policy.ClassifierRequest{TenantID: "tnt_1"})
	if err == nil {
		t.Fatal("Classify: expected the SSRF guard to block a loopback classifier URL, got nil error")
	}
}

// The judge contract: the same webhook `treeship judge --judge-url` speaks.
func TestHTTPClassifierClient_Classify_JudgeContractVerdict(t *testing.T) {
	t.Parallel()

	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		_, _ = w.Write([]byte(`{"judge":{"model":"jev-1.13.0","kind":"decision-model","replayable":false},"answers":{"verdict":{"choice":"deny","probabilities":{"allow":0.1,"warn":0.1,"deny":0.8},"confidence":0.8}}}`))
	}))
	defer srv.Close()

	client := NewHTTPClassifierClient(srv.Client())
	tool, method := "risky_tool", "tools/call"
	verdict, err := client.Classify(context.Background(), srv.URL, policy.ClassifierRequest{
		TenantID: "tnt_1", AgentID: "agt_1", Protocol: policy.ProtocolMCP, MCPMethod: &method, MCPTool: &tool,
	})
	if err != nil {
		t.Fatalf("Classify: unexpected error: %v", err)
	}
	if verdict.Action != policy.ActionDeny {
		t.Errorf("Action = %q, want deny", verdict.Action)
	}
	if verdict.Reason != "jev-1.13.0: verdict deny" {
		t.Errorf("Reason = %q", verdict.Reason)
	}
	// The request carried both shapes: the legacy fields and the judge's
	// state and questions, derived from the structural identity only.
	if got["tenant_id"] != "tnt_1" {
		t.Errorf("legacy tenant_id missing: %v", got)
	}
	state, _ := got["state"].(map[string]any)
	if state["tool"] != tool || state["capability"] != method {
		t.Errorf("judge state = %v", state)
	}
	input, _ := state["input"].(map[string]any)
	if input["agent_id"] != "agt_1" || input["mcp_tool"] != tool {
		t.Errorf("judge state input = %v", input)
	}
	questions, _ := got["questions"].(map[string]any)
	if _, ok := questions["verdict"]; !ok {
		t.Errorf("questions missing verdict: %v", questions)
	}
	if _, ok := questions["unsafe"]; !ok {
		t.Errorf("questions missing unsafe: %v", questions)
	}
}

func TestHTTPClassifierClient_Classify_JudgeContractUnsafeThreshold(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		body string
		want policy.Action
	}{
		{`{"judge":{"model":"treeship-rules/0.31.6","kind":"rules","replayable":true},"answers":{"unsafe":{"noul":1.0,"confidence":1.0}}}`, policy.ActionDeny},
		{`{"judge":{"model":"m"},"answers":{"unsafe":{"noul":0.5}}}`, policy.ActionDeny},
		{`{"judge":{"model":"m"},"answers":{"unsafe":{"noul":0.49}}}`, policy.ActionAllow},
	} {
		body := tc.body
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(body))
		}))
		client := NewHTTPClassifierClient(srv.Client())
		verdict, err := client.Classify(context.Background(), srv.URL, policy.ClassifierRequest{TenantID: "tnt_1"})
		srv.Close()
		if err != nil {
			t.Fatalf("Classify(%s): unexpected error: %v", body, err)
		}
		if verdict.Action != tc.want {
			t.Errorf("Classify(%s): Action = %q, want %q", body, verdict.Action, tc.want)
		}
	}
}

func TestHTTPClassifierClient_Classify_JudgeContractMalformedIsAnError(t *testing.T) {
	t.Parallel()

	for _, body := range []string{
		`{"judge":{"model":"m"},"answers":{}}`,                             // answered neither question
		`{"judge":{"model":"m"},"answers":{"verdict":{"choice":"maybe"}}}`, // not an action
		`{"judge":{"model":"m"},"answers":{"unsafe":{"noul":1.5}}}`,        // out of range
		`{"judge":{"model":"m"},"answers":"yes"}`,                          // wrong shape
	} {
		body := body
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(body))
		}))
		client := NewHTTPClassifierClient(srv.Client())
		_, err := client.Classify(context.Background(), srv.URL, policy.ClassifierRequest{TenantID: "tnt_1"})
		srv.Close()
		if err == nil {
			t.Errorf("Classify(%s): expected an error (on_error path), got none", body)
		}
	}
}
