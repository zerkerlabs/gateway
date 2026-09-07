package httpapi

import (
	"net/http"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/auth"
)

// Posture is the deployment-shaped half of GET /v1/capabilities: facts about
// how this gateway was started that the handler cannot see for itself.
//
// It is set once at boot from configuration (see WithPosture) and is never
// derived from a request. Everything in it is a mode, never a value: which
// kind of store, whether the KMS key was supplied — never the DSN, never the
// key. Invariant #9 keeps configuration values out of operational routes, and
// that applies here even though this route is authenticated.
type Posture struct {
	// Store is "postgres" or "memory". The memory store is non-durable and
	// dev-only, and a console showing an operator their agent catalog should
	// be able to say so before they lose it on the next restart.
	Store string

	// KMSKeyConfigured is false when ZERKER_KMS_KEY was unset and the gateway
	// generated an ephemeral key at boot. Every credential stored under that
	// key stops decrypting at the next restart, which is a thing an operator
	// wants to be told once, loudly, rather than discover from a 500.
	KMSKeyConfigured bool
}

// capabilitiesResponse is the body of GET /v1/capabilities.
//
// It answers the question a client cannot otherwise ask: RegisterRoutes mounts
// whole route families conditionally, so a gateway with no credential service
// answers GET /v1/credentials with 404 — the same status as a mistyped path
// and as an empty result on some other surface. Three different facts, one
// status code. A client that cannot tell them apart either renders a broken
// affordance or invents an explanation.
type capabilitiesResponse struct {
	Surfaces capabilitySurfaces `json:"surfaces"`
	Limits   capabilityLimits   `json:"limits"`
	Posture  capabilityPosture  `json:"posture"`
}

// capabilitySurfaces reports which route families this deployment mounted.
// Agents are unconditional, so there is no field for them.
type capabilitySurfaces struct {
	Credentials       bool `json:"credentials"`
	Invocations       bool `json:"invocations"`
	Analytics         bool `json:"analytics"`
	Proxy             bool `json:"proxy"`
	AgentEvents       bool `json:"agent_events"`
	Settlement        bool `json:"settlement"`
	Policy            bool `json:"policy"`
	PolicyDecisions   bool `json:"policy_decisions"`
	Receipts          bool `json:"receipts"`
	ReasonEnforcement bool `json:"reason_enforcement"`
}

// capabilityLimits reports the server-side bounds a client must respect.
//
// These are the same constants the handlers enforce, not a second copy: a
// console that hardcodes "31 days" is duplicating a server constant it cannot
// see change, and the first time the two disagree the operator gets a 400 for
// a query the UI offered them.
type capabilityLimits struct {
	AnalyticsMaxRangeDays  int   `json:"analytics_max_range_days"`
	InvocationsMaxLimit    int   `json:"invocations_max_limit"`
	PolicyDecisionMaxLimit int   `json:"policy_decision_max_limit"`
	AgentEventMaxRangeDays int   `json:"agent_event_max_range_days"`
	TransactMaxBodyBytes   int64 `json:"transact_max_body_bytes"`
	CapturedBodyMaxBytes   int64 `json:"captured_body_max_bytes"`
	ModelHeaderMaxBytes    int   `json:"model_header_max_bytes"`
}

// capabilityPosture reports how this deployment is running. Modes only.
type capabilityPosture struct {
	Store            string `json:"store"`
	KMSKeyConfigured bool   `json:"kms_key_configured"`

	// ReceiptsEnabled reports whether a Treeship emitter is attached. It is a
	// deployment fact; whether any given agent emits is the per-agent
	// emit_receipts flag on the catalog record.
	ReceiptsEnabled bool `json:"receipts_enabled"`

	// ReceiptActor is the actor URI receipts are signed as, empty when
	// receipts are off. It is the identity an auditor verifies against, so it
	// is publishable by construction — it is written into every artifact.
	ReceiptActor string `json:"receipt_actor"`

	// SettlementOrchestration reports whether a settler is wired at all. A
	// tenant with a facilitator configured still cannot settle without it.
	SettlementOrchestration bool `json:"settlement_orchestration"`
}

// handleCapabilities handles GET /v1/capabilities: which surfaces this gateway
// mounted, the limits it enforces, and the posture it is running in.
//
// Authenticated, like every route that is not /healthz or /version (invariant
// #1). It carries no tenant data — the answer is the same for every caller —
// but an unauthenticated deployment inventory is a reconnaissance gift, and
// invariant #1's exemptions are a closed list of two.
func (h *Handler) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	if auth.TenantFromContext(r.Context()) == "" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	receiptActor := ""
	if a, ok := h.emitter.(interface{ Actor() string }); ok && h.emitter != nil {
		receiptActor = a.Actor()
	}

	writeJSON(w, http.StatusOK, capabilitiesResponse{
		Surfaces: capabilitySurfaces{
			Credentials:       h.credSvc != nil,
			Invocations:       h.invocations != nil,
			Analytics:         h.invocations != nil,
			Proxy:             h.forwarder != nil && h.invocations != nil,
			AgentEvents:       h.agentEvents != nil,
			Settlement:        h.settlementStore != nil && h.credSvc != nil,
			Policy:            h.policyStore != nil,
			PolicyDecisions:   h.decisionStore != nil,
			Receipts:          h.emitter != nil,
			ReasonEnforcement: h.reasonVerifier != nil,
		},
		Limits: capabilityLimits{
			AnalyticsMaxRangeDays:  int(maxAnalyticsRange / (24 * time.Hour)),
			InvocationsMaxLimit:    invocationMaxLimit,
			PolicyDecisionMaxLimit: policyDecisionMaxLimit,
			AgentEventMaxRangeDays: int(maxAgentEventRange / (24 * time.Hour)),
			TransactMaxBodyBytes:   maxRequestBodyBytes,
			CapturedBodyMaxBytes:   bodyCapBytes,
			ModelHeaderMaxBytes:    maxModelNameBytes,
		},
		Posture: capabilityPosture{
			Store:                   h.posture.Store,
			KMSKeyConfigured:        h.posture.KMSKeyConfigured,
			ReceiptsEnabled:         h.emitter != nil,
			ReceiptActor:            receiptActor,
			SettlementOrchestration: h.settler != nil && h.facilitatorCreds != nil,
		},
	})
}
