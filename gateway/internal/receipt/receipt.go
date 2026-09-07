// Package receipt models the trust receipts Zerker emits to Treeship after a
// proxied invocation completes. Treeship is an external system (ADR-0003), so
// this package defines only the payload and the emitter interface; the concrete
// Treeship HTTP emitter is wired separately and is a follow-up.
package receipt

import (
	"context"
	"time"
)

// Receipt is the auditable summary of one proxied invocation, handed to Treeship
// for a tamper-evident trust receipt. It carries only metadata that is safe to
// record — never secret material or request/response bodies (invariant #4).
type Receipt struct {
	InvocationID   string
	TenantID       string
	AgentID        string
	Mode           string // "transactional" | "streaming"
	Status         string // "succeeded" | "failed"
	UpstreamStatus *int   // upstream HTTP status; nil if the upstream was never reached
	LatencyMS      *int64
	RequestSize    *int64
	ResponseSize   *int64
	CompletedAt    time.Time
}

// Denial is the auditable summary of one call the policy engine refused.
//
// It exists because a denial is not an invocation. enforcePolicy returns
// before invocations.Create is reached, so a blocked call never becomes a row
// and never reaches Emit — the gateway was signing every call it allowed and
// saying nothing about the calls it stopped. That is the wrong half to
// attest: "this gateway blocked agent X from calling tool Y at time T" is the
// claim an auditor wants proven; "a call succeeded" is the routine one.
//
// Like Receipt, this carries metadata only (invariant #4). It also carries no
// rule content: MatchedRule is the rule's 1-based position, never its match
// conditions, so an artifact that may be shared cannot leak the ruleset it was
// produced by (invariant #3).
type Denial struct {
	TenantID string
	AgentID  string
	Protocol string

	// MCPMethod and MCPTool are the parsed JSON-RPC method and tool for MCP
	// agents, nil for HTTP agents or an unparseable body. Nil means "not
	// known", which is different from "not a tool call".
	MCPMethod *string
	MCPTool   *string

	// MatchedRule is the 1-based position of the rule that denied, or empty
	// when the policy's default denied and no rule matched. Empty is a real
	// distinction: "the default refused this" is not "rule 3 refused this".
	MatchedRule string

	// Reason is the engine's coarse explanation. Already free of match
	// conditions by construction (policy.Decision doc).
	Reason string

	DeniedAt time.Time

	// DecisionID is the stored policy decision this denial was recorded as,
	// when the caller knows it.
	//
	// Without it, the artifact is bound to the denial's *shape* — tenant,
	// agent, protocol, method, tool, rule — and nothing else. Two refusals of
	// the same call under the same rule then produce byte-identical artifacts,
	// which Treeship stores once. That is defensible as a claim ("this agent
	// is refused this tool under this rule") and wrong as evidence: an
	// operator looking at ten denials finds one receipt and cannot tell
	// whether the other nine were attested or dropped.
	//
	// Optional because a caller that attests before the decision is stored has
	// no ID to give, and an artifact bound to the shape alone is better than
	// none. Empty leaves the previous digest and meta exactly as they were.
	DecisionID string
}

// Emitter delivers a receipt to the trust backend. Implementations must be safe
// for concurrent use. Emit may block (e.g. an HTTP round-trip), so callers run
// it off the request path; the returned error is advisory only — emission is
// fail-open, so a failed receipt must never fail the underlying invocation
// (spec 0002 Q9).
// A nil Emitter means receipts are disabled: the proxy skips emission entirely
// (see Handler.emitReceipt's nil guard), so there is no separate no-op type.
type Emitter interface {
	Emit(ctx context.Context, r Receipt) error
}

// DenialEmitter attests a policy denial.
//
// Separate from Emitter, and discovered by type assertion at the call site,
// so the two capabilities stay independently absent. An emitter that can
// record completed invocations but not denials is a coherent thing to have;
// folding EmitDenial into Emitter would force every implementation to claim
// both, and a stub that silently accepted denials would be worse than one
// that never sees them.
type DenialEmitter interface {
	EmitDenial(ctx context.Context, d Denial) error
}

// Attestation identifies the artifact an emitter actually signed.
//
// Emit reports only success or failure, which is enough to keep the proxy
// fail-open but not enough to ever find the artifact again: the gateway was
// signing receipts and keeping no reference to them, so "every call leaves a
// trusted receipt" was a claim its own API could not substantiate. This is the
// pointer that makes it checkable.
//
// It carries an identifier and a signing time, never the artifact and never
// key material. Verification is Treeship's job and is done against the
// artifact itself; a gateway that reported its own receipts as verified would
// be asserting exactly what invariant #6 says it must not.
type Attestation struct {
	// ArtifactID is the Treeship artifact identifier ("art_<hex>").
	ArtifactID string
	// Actor is the URI the artifact was signed as.
	Actor string
	// SignedAt is when the emitter reported the signature, in UTC.
	SignedAt time.Time
}

// AttestingEmitter is an Emitter that can also report what it signed.
//
// Separate from Emitter, and discovered by type assertion at the call site,
// for the same reason DenialEmitter is: an emitter that delivers receipts but
// cannot name them is a coherent thing to have, and folding this into Emitter
// would force every implementation to claim a capability it may not have.
type AttestingEmitter interface {
	Emitter
	// EmitAttested emits r and returns the artifact it signed. The error
	// contract is Emit's: advisory only, never a reason to fail the
	// invocation the receipt describes.
	EmitAttested(ctx context.Context, r Receipt) (Attestation, error)
}

// AttestingDenialEmitter is a DenialEmitter that can also report what it
// signed. Same rationale as AttestingEmitter.
type AttestingDenialEmitter interface {
	DenialEmitter
	EmitDenialAttested(ctx context.Context, d Denial) (Attestation, error)
}
