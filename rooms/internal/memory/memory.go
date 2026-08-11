// Package memory defines the narrow interface Rooms needs against an
// external, room-scoped memory backend: prepare the governed context an
// onboarding member should start with, and submit content the backend may
// remember. That is all Rooms consumes — this package does not design a
// memory product; there is no ranking, no embeddings, and no retrieval logic
// here, only the seam.
//
// The real backend scopes memory to (tenant, room), with room-shared and
// member-private partitions inside a room — a different shape than an early
// draft of this seam assumed, which scoped memory to (tenant, agent). A
// member's onboarding context is "what this room knows, plus what is private
// to me here," not "everything this agent has ever remembered anywhere."
//
// The tenant is never a field on a request here. A real backend deployment
// is tenant-local — one deployment serves exactly one tenant — so the tenant
// is backend configuration, not caller input; a tenant parameter would be a
// field an attacker could aim to read across tenants.
//
// The real backend does not have a client in this module yet. This package
// therefore ships an in-memory Fake behind the same Store interface so Rooms
// can be built and tested today; a real client lands later without changing
// the interface (rooms/internal/receipt is the same pattern for another
// external system with no client yet).
package memory

import (
	"context"
	"time"
)

// State is the outcome of a PrepareContext call: what the backend was able
// to do with a room's governed memory for the agent that asked. It is a
// closed set — exactly these six values — so a caller can branch on it
// exhaustively rather than inferring intent from a count.
type State string

const (
	// StateReady means every retrieved memory was admitted; Memories is the
	// full retrieved set.
	StateReady State = "ready"
	// StatePartial means some retrieved memory was admitted and some was
	// withheld or dropped for budget; Memories carries only the admitted
	// subset.
	StatePartial State = "partial"
	// StateEmpty means the room has no prior memory for this request — not
	// an error, and distinct from StateBlocked.
	StateEmpty State = "empty"
	// StateBlocked means memory existed but policy admitted none of it.
	StateBlocked State = "blocked"
	// StateAbstained means the backend declined to answer because the
	// evidence it retrieved conflicted.
	StateAbstained State = "abstained"
	// StateBudgetExhausted means every retrieved memory would have been
	// admitted but none fit within ContextBudgetTokens.
	StateBudgetExhausted State = "budget_exhausted"
)

// PrepareRequest asks a backend to prepare the governed context an agent
// should start with in a room. It carries no tenant field — see the package
// doc.
type PrepareRequest struct {
	RoomID  string
	AgentID string
	// Purpose is the retrieval purpose, typically the room's goal.
	Purpose string
	// Risk is the room or tenant's configured risk level: "low", "medium",
	// or "high".
	Risk string
	// ContextBudgetTokens bounds how much admitted content PrepareContext
	// may return. Rooms sends it explicitly rather than relying on a
	// backend default, so the value a commitment attests to is always
	// visible at the call site.
	ContextBudgetTokens int
	// MembershipDigest and RoomStateDigest are optional "sha256:<64 hex>"
	// digests binding the returned Commitment to the room state that
	// requested it. Computing them is a separate change; a request may
	// leave both empty.
	MembershipDigest string
	RoomStateDigest  string
}

// Memory is one item of governed context a PrepareContext call admitted.
// Rooms reads it verbatim; it does not interpret, rank, or embed the
// content — that judgment already happened before it reached this seam.
type Memory struct {
	ID      string
	Content string
	// Provenance is a short, backend-supplied description of where this
	// memory came from (e.g. "recorded", "proposed"). Rooms treats it as
	// opaque, informational metadata.
	Provenance string
	CreatedAt  time.Time
}

// Counts summarizes how many memories a PrepareContext call considered and
// what became of them. Retrieved is the number the backend found relevant
// before applying policy or budget; Admitted is how many ended up in
// Memories; Withheld and BudgetDropped partition the remainder by why they
// did not.
type Counts struct {
	Retrieved     int
	Admitted      int
	Withheld      int
	BudgetDropped int
}

// Omissions carries the bounded, deduplicated reasons memory was withheld or
// dropped for budget. It never carries a per-memory identifier or the
// internal policy predicate that withheld it — those belong in a backend's
// own logs, not in a value this seam hands back to a caller.
type Omissions struct {
	// Reasons is the deduplicated set of reasons memory was withheld or
	// dropped for budget.
	Reasons []string
	// Abstention is a short, backend-supplied explanation, set only when
	// State is StateAbstained.
	Abstention string
}

// Commitment is a backend's attestation over exactly what a PrepareContext
// call returned. Digest is opaque to this seam; verifying it against a real
// backend's wire format is the concern of the client that speaks to that
// backend, not this package.
type Commitment struct {
	Digest string
}

// ContextResult is what a PrepareContext call returns.
type ContextResult struct {
	State      State
	Memories   []Memory
	Counts     Counts
	Omissions  Omissions
	Commitment Commitment
}

// ProposeRequest submits agent-authored content as a candidate memory. It is
// quarantined until reviewed — calling Propose vouches for nothing beyond
// "this was said."
type ProposeRequest struct {
	RoomID  string
	AgentID string
	Content string
	// SourceEventID is the Rooms event this content came from, and
	// IdempotencyKey makes the write safe to retry: replaying the same key
	// with identical content is a no-op: reusing it for different content is
	// rejected.
	SourceEventID  string
	IdempotencyKey string
}

// RecordRequest submits content Rooms itself is asserting as an accepted
// transition — a room outcome or a task-state change — so it is active
// immediately rather than quarantined.
type RecordRequest struct {
	RoomID         string
	AgentID        string
	Content        string
	SourceEventID  string
	IdempotencyKey string
}

// WriteResult is the outcome of a Propose or Record call.
type WriteResult struct {
	ID        string
	CreatedAt time.Time
}

// Store is the seam Rooms needs against an external, room-scoped memory
// backend. Implementations must be safe for concurrent use.
type Store interface {
	// PrepareContext prepares the governed context an agent should start
	// with in a room, per req. The order of req's returned Memories is
	// whatever the backend decided — a ranked order, not necessarily
	// chronological — and an implementation must return it verbatim, never
	// re-sorted.
	PrepareContext(ctx context.Context, req PrepareRequest) (ContextResult, error)

	// Propose submits agent-authored content as a candidate memory,
	// quarantined until reviewed.
	Propose(ctx context.Context, req ProposeRequest) (WriteResult, error)

	// Record submits content Rooms itself is asserting as an accepted
	// transition, active immediately.
	Record(ctx context.Context, req RecordRequest) (WriteResult, error)
}
