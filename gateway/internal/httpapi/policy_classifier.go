package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/policy"
	"github.com/zerkerlabs/gateway/gateway/internal/ssrf"
)

// defaultClassifierTimeout bounds a single classifier webhook round-trip so a
// slow or unresponsive webhook can never hang the request path (spec 0009
// Decision 4: "best-effort ... no hang on the request path; bounded
// timeout"). enforcePolicy additionally wraps the call in a context with this
// same bound, so the guarantee holds even if a caller injects a
// policy.ClassifierClient whose own *http.Client carries no Timeout.
const defaultClassifierTimeout = 2 * time.Second

// maxClassifierResponseBytes caps how much of a classifier webhook's response
// body is read, mirroring maxSettleResponseBytes — a misbehaving or malicious
// webhook cannot exhaust memory.
const maxClassifierResponseBytes = 1 << 16 // 64 KiB

// httpClassifierClient is the production policy.ClassifierClient: it POSTs
// the minimal request context to an operator-configured webhook and parses
// its verdict. It makes no assumption about the webhook's own implementation
// (Llama Guard, Lakera, an LLM-judge) — only the wire contract in
// policy.ClassifierVerdict.
type httpClassifierClient struct {
	client *http.Client
}

// NewHTTPClassifierClient returns a policy.ClassifierClient that calls
// webhooks over HTTP(S) through the SSRF guard (internal/ssrf), exactly as
// NewFacilitatorSettler does for the facilitator settle call (T6 acceptance:
// "same SSRF guard as upstreams"). If client is nil, a client with the
// SSRF-safe dialer and defaultClassifierTimeout is constructed; tests may
// inject a stubbed override (e.g. an httptest.Server's own client) the same
// way NewFacilitatorSettler's tests do.
func NewHTTPClassifierClient(client *http.Client) policy.ClassifierClient {
	if client == nil {
		t := http.DefaultTransport.(*http.Transport).Clone() //nolint:forcetypeassert // http.DefaultTransport is always *http.Transport
		t.DialContext = ssrf.SafeDialContext
		client = &http.Client{Transport: t, Timeout: defaultClassifierTimeout}
	}
	return &httpClassifierClient{client: client}
}

// Classify implements policy.ClassifierClient.
func (c *httpClassifierClient) Classify(ctx context.Context, hookURL string, req policy.ClassifierRequest) (policy.ClassifierVerdict, error) {
	// The same call in the judge contract, so a webhook that serves
	// `treeship judge --judge-url` serves this hook too. Derived from the
	// structural fields only; a legacy classifier ignores the extra keys.
	if req.State == nil {
		req.State = judgeState(req)
	}
	if req.Questions == nil {
		req.Questions = policy.JudgeQuestions()
	}
	body, err := json.Marshal(req)
	if err != nil {
		return policy.ClassifierVerdict{}, fmt.Errorf("classifier: build request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, hookURL, bytes.NewReader(body))
	if err != nil {
		return policy.ClassifierVerdict{}, fmt.Errorf("classifier: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(httpReq) //nolint:gosec // hookURL validated at authoring boundary (validateClassifierURL); DNS-rebinding re-checked at dial time via ssrf.SafeDialContext
	if err != nil {
		return policy.ClassifierVerdict{}, fmt.Errorf("classifier: unreachable: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxClassifierResponseBytes))
	if err != nil {
		return policy.ClassifierVerdict{}, fmt.Errorf("classifier: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return policy.ClassifierVerdict{}, fmt.Errorf("classifier: non-2xx status %d", resp.StatusCode)
	}

	// Two response shapes: the judge contract ("answers") and the legacy
	// verdict ("action"). Decided by which key is present, never by guessing
	// from a partial document.
	var probe struct {
		Answers json.RawMessage `json:"answers"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return policy.ClassifierVerdict{}, fmt.Errorf("classifier: malformed response: %w", err)
	}
	if len(probe.Answers) > 0 {
		var jr policy.JudgeResponse
		if err := json.Unmarshal(raw, &jr); err != nil {
			return policy.ClassifierVerdict{}, fmt.Errorf("classifier: malformed judge response: %w", err)
		}
		return verdictFromJudge(jr)
	}

	var verdict policy.ClassifierVerdict
	if err := json.Unmarshal(raw, &verdict); err != nil {
		return policy.ClassifierVerdict{}, fmt.Errorf("classifier: malformed response: %w", err)
	}
	if !isValidAction(verdict.Action) {
		return policy.ClassifierVerdict{}, fmt.Errorf("classifier: invalid verdict action %q", verdict.Action)
	}

	return verdict, nil
}

// judgeState is the judge contract's state for a Gateway call: the MCP tool
// (or the protocol, for plain HTTP) as the tool, the MCP method as the
// capability, and the structural identity as the input.
func judgeState(req policy.ClassifierRequest) *policy.JudgeState {
	tool := req.Protocol
	if req.MCPTool != nil && *req.MCPTool != "" {
		tool = *req.MCPTool
	}
	st := &policy.JudgeState{
		Tool: tool,
		Input: map[string]string{
			"tenant_id": req.TenantID,
			"agent_id":  req.AgentID,
			"protocol":  req.Protocol,
		},
	}
	if req.MCPMethod != nil {
		st.Capability = *req.MCPMethod
		st.Input["mcp_method"] = *req.MCPMethod
	}
	if req.MCPTool != nil {
		st.Input["mcp_tool"] = *req.MCPTool
	}
	return st
}

// verdictFromJudge maps a judge-contract response onto a verdict. The
// "verdict" choice, when it is one of the three Actions, is the Action. Else
// the "unsafe" probability at or above JudgeUnsafeThreshold denies and
// below it allows. A response answering neither, or answering out of range,
// is malformed: the caller applies on_error, never a guess.
func verdictFromJudge(jr policy.JudgeResponse) (policy.ClassifierVerdict, error) {
	model := jr.Judge.Model
	if model == "" {
		model = "judge"
	}
	if a, ok := jr.Answers[policy.JudgeQuestionVerdict]; ok && a.Choice != nil {
		action := policy.Action(*a.Choice)
		if !isValidAction(action) {
			return policy.ClassifierVerdict{}, fmt.Errorf("classifier: judge verdict %q is not an action", *a.Choice)
		}
		return policy.ClassifierVerdict{Action: action, Reason: model + ": verdict " + string(action)}, nil
	}
	if a, ok := jr.Answers[policy.JudgeQuestionUnsafe]; ok && a.Noul != nil {
		p := *a.Noul
		if p < 0 || p > 1 || p != p { // NaN is never in range
			return policy.ClassifierVerdict{}, fmt.Errorf("classifier: judge unsafe probability %v is not in 0..1", p)
		}
		if p >= policy.JudgeUnsafeThreshold {
			return policy.ClassifierVerdict{Action: policy.ActionDeny, Reason: fmt.Sprintf("%s: unsafe %.2f at or above %.2f", model, p, policy.JudgeUnsafeThreshold)}, nil
		}
		return policy.ClassifierVerdict{Action: policy.ActionAllow, Reason: fmt.Sprintf("%s: unsafe %.2f below %.2f", model, p, policy.JudgeUnsafeThreshold)}, nil
	}
	return policy.ClassifierVerdict{}, fmt.Errorf("classifier: judge answered neither %q nor %q", policy.JudgeQuestionVerdict, policy.JudgeQuestionUnsafe)
}
