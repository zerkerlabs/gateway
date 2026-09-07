package policy

import (
	"context"
	"log/slog"
	"time"
)

const (
	// decisionIDPrefix is the per-type prefix for a policy decision's opaque
	// "<prefix>_<uuidv7>" ID (ADR-0009).
	decisionIDPrefix = "pdec"

	// decisionDefaultLimit is the List page size when the caller passes a
	// non-positive limit. Mirrors the invocations list default.
	decisionDefaultLimit = 20
)

// storedFromRecorded projects a captured RecordedDecision into a StoredDecision
// with the store-assigned id and createdAt, copying the MCPTool pointer so the
// stored record never aliases the caller's value.
func storedFromRecorded(id string, d RecordedDecision, createdAt time.Time) *StoredDecision {
	rec := &StoredDecision{
		ID:          id,
		TenantID:    d.TenantID,
		AgentID:     d.AgentID,
		Protocol:    d.Protocol,
		Action:      d.Decision.Action,
		MatchedRule: d.Decision.MatchedRule,
		Reason:      d.Decision.Reason,
		CreatedAt:   createdAt,
	}
	if d.MCPTool != nil {
		tool := *d.MCPTool
		rec.MCPTool = &tool
	}
	return rec
}

// StoredDecision is one persisted policy Decision plus the identity the store
// assigns it (spec 0009, ticket T5). It is what GET /v1/policy/decisions
// returns — the read side of the RecordedDecision the enforcement point (T4)
// captures. Reason is the coarse, rule-position explanation the evaluator
// produced; a request body is never part of it (invariant #3).
type StoredDecision struct {
	// ID is a server-assigned "pdec_<uuidv7>" opaque identifier (ADR-0009).
	ID       string
	TenantID string
	AgentID  string
	Protocol string
	MCPTool  *string
	Action   Action
	// MatchedRule is the 1-based rule position that produced Action, or empty
	// when Action came from the policy's default/on_error (Decision, evaluate.go).
	MatchedRule string
	Reason      string
	// CreatedAt is when the decision was recorded, assigned by the store.
	CreatedAt time.Time

	// ReceiptArtifactID is the Treeship artifact signed for this decision, and
	// ReceiptSignedAt is when the emitter reported signing it. Both nil when
	// receipts are off, when the agent has emit_receipts off, or when emission
	// failed — never proof that no artifact exists, since emission is
	// fail-open and its reference is written after the fact.
	ReceiptArtifactID *string
	ReceiptSignedAt   *time.Time
}

// DecisionFilter narrows a decision listing.
//
// A denied call returns before an invocation is created, so this store is the
// only place a denial is ever visible. A limit-only feed therefore hides every
// denial older than the most recent page — which is exactly the history an
// operator asks for after an incident, and exactly what a denials-over-time
// chart needs. Hence a time range, an offset, and the two filters that make
// "what did this agent get refused, and why" answerable.
//
// The zero value selects everything, newest first, at the store's default page
// size.
type DecisionFilter struct {
	// Since and Until bound CreatedAt inclusively. A zero time is unbounded.
	Since time.Time
	Until time.Time

	// Action, when set, selects one decision action. Empty selects all.
	Action Action

	// AgentID, when set, selects one agent's decisions. Empty selects all.
	AgentID string

	// Limit is the page size; zero or negative means the store default.
	// Offset is the number of matching rows to skip, newest first.
	Limit  int
	Offset int
}

// DecisionStore persists policy decisions and reads them back for a tenant
// (spec 0009, ticket T5). Every method is scoped to a tenantID — no
// implementation may read or write another tenant's decisions (invariant #2,
// AGENTS.md; spec 0009 "Multi-tenant isolation": cross-tenant = 404).
//
// Insert returns an error so callers can decide how to handle a write failure;
// the inline enforcement path wraps a DecisionStore in a StoreRecorder, which
// makes capture async and fail-open (a store hiccup must never affect the
// proxied call the decision describes).
type DecisionStore interface {
	// Insert persists d, assigning it an ID and CreatedAt, and returns the
	// stored record.
	Insert(ctx context.Context, d RecordedDecision) (*StoredDecision, error)

	// List returns the tenant's decisions matching f, newest first, together
	// with the total number matching before Limit and Offset are applied. A
	// tenant with no decisions yields an empty slice and a zero total, not an
	// error.
	//
	// The total is what makes the denial history navigable: without it a
	// caller paging backwards cannot tell "no more rows" from "the page size
	// happened to land exactly on the end", and cannot say how many denials a
	// window holds without walking every page of it.
	List(ctx context.Context, tenantID string, f DecisionFilter) ([]*StoredDecision, int, error)

	// AttachReceipt records which Treeship artifact was signed for a decision
	// already stored. It is a second write because attestation happens after
	// the decision is recorded and must not delay it: the decision is the
	// operational fact, the artifact reference is evidence about it.
	//
	// A decision that no longer exists, or belongs to another tenant, is not
	// an error worth propagating — the caller is a fail-open goroutine with
	// nothing useful to do about it — but it must not write, either.
	AttachReceipt(ctx context.Context, tenantID, id, artifactID string, signedAt time.Time) error
}

// StoreRecorder adapts a DecisionStore to the DecisionRecorder seam the
// enforcement point calls (spec 0009, ticket T5). Record persists the decision
// and is fail-open: a store write failure is logged, never propagated — capture
// must never add latency to, or fail, the proxied call it describes (the
// handler already invokes Record off the request path). Reads go straight to
// the wrapped store via GET /v1/policy/decisions, not through this adapter.
type StoreRecorder struct {
	store  DecisionStore
	logger *slog.Logger
}

// NewStoreRecorder returns a StoreRecorder writing to store. logger must be
// non-nil; capture failures are logged at Error level and otherwise swallowed.
func NewStoreRecorder(store DecisionStore, logger *slog.Logger) *StoreRecorder {
	return &StoreRecorder{store: store, logger: logger}
}

// Record implements DecisionRecorder.
func (r *StoreRecorder) Record(ctx context.Context, d RecordedDecision) {
	if _, err := r.store.Insert(ctx, d); err != nil {
		r.logger.Error("policy decision capture: persist decision",
			"tenant", d.TenantID, "agent", d.AgentID, "action", d.Decision.Action, "err", err)
	}
}
