package httpapi

import (
	"net/http"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/auth"
	"github.com/zerkerlabs/gateway/gateway/internal/policy"
)

const (
	policyDecisionDefaultLimit = 20
	policyDecisionMaxLimit     = 100
)

// policyDecisionItem is the per-row shape returned by GET /v1/policy/decisions
// (spec 0009 §Behavior "Audit capture": action, matched rule, reason, agent,
// tool). reason is the coarse, rule-position explanation — never call content
// (invariant #3). mcp_tool is null for protocol=http calls.
type policyDecisionItem struct {
	ID          string        `json:"id"`
	AgentID     string        `json:"agent_id"`
	Protocol    string        `json:"protocol"`
	MCPTool     *string       `json:"mcp_tool"`
	Action      policy.Action `json:"action"`
	MatchedRule string        `json:"matched_rule"`
	Reason      string        `json:"reason"`
	CreatedAt   time.Time     `json:"created_at"`

	// ReceiptArtifactID is the Treeship artifact signed for this decision,
	// null when none was recorded. A denial is the one outcome with no
	// invocation to carry evidence, so this is the only place the proof of a
	// refusal is reachable from the API.
	ReceiptArtifactID *string `json:"receipt_artifact_id"`
}

type policyDecisionListResponse struct {
	Data  []policyDecisionItem `json:"data"`
	Limit int                  `json:"limit"`

	// Offset and Total make the denial history navigable. A denied call
	// returns before an invocation is created, so this feed is the only place
	// a denial is ever visible: without a total, "how many times did policy
	// refuse this agent last week" cannot be answered without walking every
	// page, and without an offset the answer is unreachable past the first.
	Offset int `json:"offset"`
	Total  int `json:"total"`
}

func toPolicyDecisionItem(d *policy.StoredDecision) policyDecisionItem {
	return policyDecisionItem{
		ID:                d.ID,
		AgentID:           d.AgentID,
		Protocol:          d.Protocol,
		MCPTool:           d.MCPTool,
		Action:            d.Action,
		MatchedRule:       d.MatchedRule,
		Reason:            d.Reason,
		CreatedAt:         d.CreatedAt,
		ReceiptArtifactID: d.ReceiptArtifactID,
	}
}

// handleListPolicyDecisions handles GET /v1/policy/decisions: the calling
// tenant's most-recent policy decisions, newest first (spec 0009, ticket T5 —
// the "OSS captures" read side). Tenant-scoped by the store; a tenant only ever
// sees its own decisions, so there is no cross-tenant record to leak.
func (h *Handler) handleListPolicyDecisions(w http.ResponseWriter, r *http.Request) {
	tenant := auth.TenantFromContext(r.Context())
	user := auth.UserFromContext(r.Context())
	if tenant == "" || user == "" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	q := r.URL.Query()

	// Limit/offset clamped the same way the invocations list does it, so one
	// paging convention covers both feeds.
	limit := queryInt(r, "limit", policyDecisionDefaultLimit)
	if limit < 1 {
		limit = policyDecisionDefaultLimit
	}
	if limit > policyDecisionMaxLimit {
		limit = policyDecisionMaxLimit
	}
	offset := queryInt(r, "offset", 0)
	if offset < 0 {
		offset = 0
	}

	filter := policy.DecisionFilter{Limit: limit, Offset: offset}

	// RFC 3339 bounds, matching the invocations filter contract exactly: a
	// caller correlating a denial with the traffic around it should not have
	// to learn two time formats.
	if v := q.Get("since"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid since: must be RFC 3339 timestamp")
			return
		}
		filter.Since = t
	}
	if v := q.Get("until"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid until: must be RFC 3339 timestamp")
			return
		}
		filter.Until = t
	}
	if !filter.Since.IsZero() && !filter.Until.IsZero() && filter.Since.After(filter.Until) {
		writeError(w, http.StatusBadRequest, "since must not be after until")
		return
	}

	// Every recorded action is filterable, deny included. Unlike the
	// invocations list — where deny is rejected because a denied call creates
	// no invocation to filter — deny is the most useful value here, because
	// this is the store that has them.
	if v := q.Get("action"); v != "" {
		switch policy.Action(v) {
		case policy.ActionAllow, policy.ActionWarn, policy.ActionDeny:
			filter.Action = policy.Action(v)
		default:
			writeError(w, http.StatusBadRequest, "invalid action: must be one of allow, warn, deny")
			return
		}
	}
	filter.AgentID = q.Get("agent_id")

	decisions, total, err := h.decisionStore.List(r.Context(), tenant, filter)
	if err != nil {
		h.logger.Error("list policy decisions: store error", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	items := make([]policyDecisionItem, len(decisions))
	for i, d := range decisions {
		items[i] = toPolicyDecisionItem(d)
	}

	writeJSON(w, http.StatusOK, policyDecisionListResponse{Data: items, Limit: limit, Offset: offset, Total: total})
}
