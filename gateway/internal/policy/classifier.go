package policy

import "context"

// ClassifierHook is a rule's opt-in configuration for the optional semantic
// rail (spec 0009 Decision 4, ticket T6): delegate this rule's decision to an
// operator-configured external classifier webhook (e.g. Llama Guard / Lakera /
// an LLM-judge) instead of a fixed Action. Zerker bundles no classifier and
// calls nothing unless a rule sets this.
type ClassifierHook struct {
	// URL is the operator-configured classifier endpoint. It is egress the
	// same way a tenant's upstream_url is, so it is subject to the same SSRF
	// guard (internal/ssrf) at both the authoring boundary and dial time (T6
	// acceptance).
	URL string `json:"url"`
}

// ClassifierRequest is the minimal request context POSTed to a classifier
// webhook when a rule with a Classifier hook matches. It carries only the
// call's structural identity, mirroring the deterministic engine's own inputs
// (RequestContext) — never request or response body content (T6 scope
// boundary excludes response-body inspection).
type ClassifierRequest struct {
	TenantID  string  `json:"tenant_id"`
	AgentID   string  `json:"agent_id"`
	Protocol  string  `json:"protocol"`
	MCPMethod *string `json:"mcp_method,omitempty"`
	MCPTool   *string `json:"mcp_tool,omitempty"`

	// State and Questions are the same call in the judge contract that
	// Treeship's `treeship judge --judge-url` speaks (state plus typed
	// questions in, typed answers out), so one webhook can serve both the
	// Gateway and a Treeship gate. They are derived from the fields above
	// by the client and carry nothing more; a legacy classifier ignores
	// them. See JudgeState and JudgeQuestions.
	State     *JudgeState              `json:"state,omitempty"`
	Questions map[string]JudgeQuestion `json:"questions,omitempty"`
}

// JudgeState is the judge contract's view of the call: the tool about to
// run, the capability name, and the structural input. Never request or
// response body content.
type JudgeState struct {
	Tool       string            `json:"tool"`
	Capability string            `json:"capability,omitempty"`
	Input      map[string]string `json:"input"`
}

// JudgeQuestion is one typed question in the judge contract: a "noul"
// (yes/no probability), a "choice" from Options, or a "score".
type JudgeQuestion struct {
	Type         string   `json:"type"`
	Instructions string   `json:"instructions,omitempty"`
	Options      []string `json:"options,omitempty"`
}

// JudgeQuestionVerdict and JudgeQuestionUnsafe are the two questions the
// Gateway asks. A judge answers either: "verdict" as a choice among the
// three Actions, or "unsafe" as a probability held to JudgeUnsafeThreshold.
const (
	JudgeQuestionVerdict = "verdict"
	JudgeQuestionUnsafe  = "unsafe"
	// JudgeUnsafeThreshold is the bar an "unsafe" probability is held to:
	// at or above it the call is denied.
	JudgeUnsafeThreshold = 0.5
)

// JudgeQuestions returns the questions the Gateway asks a judge.
func JudgeQuestions() map[string]JudgeQuestion {
	return map[string]JudgeQuestion{
		JudgeQuestionVerdict: {
			Type:         "choice",
			Instructions: "Should this call be allowed, allowed with a warning, or denied?",
			Options:      []string{string(ActionAllow), string(ActionWarn), string(ActionDeny)},
		},
		JudgeQuestionUnsafe: {
			Type:         "noul",
			Instructions: "Is this call unsafe for the tenant: destructive, exfiltrating, or outside what the agent should reach?",
		},
	}
}

// JudgeAnswer is one typed answer in the judge contract.
type JudgeAnswer struct {
	Noul          *float64           `json:"noul,omitempty"`
	Choice        *string            `json:"choice,omitempty"`
	Score         *float64           `json:"score,omitempty"`
	Probabilities map[string]float64 `json:"probabilities,omitempty"`
	Confidence    *float64           `json:"confidence,omitempty"`
}

// JudgeResponse is a judge-contract response body: which judge answered and
// one answer per question key. A body carrying "answers" is read as this
// shape; one carrying "action" is read as ClassifierVerdict.
type JudgeResponse struct {
	Judge struct {
		Model      string `json:"model"`
		Kind       string `json:"kind,omitempty"`
		Replayable *bool  `json:"replayable,omitempty"`
	} `json:"judge"`
	Answers map[string]JudgeAnswer `json:"answers"`
}

// ClassifierVerdict is a classifier webhook's JSON response body: the Action
// its verdict maps to (spec 0009 Decision 4 — "its verdict feeds a
// warn/deny"), plus an optional coarse reason. Action must be one of the
// three well-formed Action values; any other value is treated as malformed —
// the caller falls back to the policy's on_error, exactly as a timeout or
// non-2xx response would. A judge-contract response (JudgeResponse) is
// mapped onto this shape by the client: the "verdict" choice is the Action,
// or the "unsafe" probability at or above JudgeUnsafeThreshold is a deny.
type ClassifierVerdict struct {
	Action Action `json:"action"`
	Reason string `json:"reason,omitempty"`
}

// ClassifierClient calls an operator-configured classifier webhook on behalf
// of a matched rule. Implementations must be best-effort: a bounded timeout
// and no retry, so a slow or unreachable webhook can never hang the request
// path (spec 0009 Decision 4), and must apply the same SSRF guard used for
// tenant-supplied upstream URLs before dialing hookURL (T6 acceptance).
type ClassifierClient interface {
	Classify(ctx context.Context, hookURL string, req ClassifierRequest) (ClassifierVerdict, error)
}
