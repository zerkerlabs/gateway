package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/auth"
	"github.com/zerkerlabs/gateway/gateway/internal/invocation"
)

// invocationReceiptResponse is the body of GET /v1/invocations/{id}/receipt:
// which Treeship artifact this gateway signed for one invocation, and how to
// check it.
//
// What it deliberately does not contain is a verdict. The gateway signed this
// artifact; a gateway that also reported it as valid would be marking its own
// homework, and invariant #6 is explicit that a receipt is verified against
// its signature by the party relying on it, never asserted by the emitter.
// So this hands back an identifier and the actor to verify against, and
// verification happens where the trust actually lives.
type invocationReceiptResponse struct {
	InvocationID string `json:"invocation_id"`

	// Attested is false when no artifact reference is recorded for this
	// invocation. That is not "no receipt exists": emission is fail-open and
	// off the request path, so a signed artifact can outlive a lost reference.
	// Reason says which of the several possible causes applies.
	Attested bool `json:"attested"`

	// Reason is empty when Attested is true. Otherwise it is one of a closed
	// set of coarse explanations — receipts_disabled, receipts_not_enabled,
	// not_recorded — so a client can tell "this gateway does not sign" from
	// "this agent does not sign" from "the reference is missing" without
	// inventing an explanation for a blank field.
	Reason string `json:"reason,omitempty"`

	ArtifactID string     `json:"artifact_id,omitempty"`
	Actor      string     `json:"actor,omitempty"`
	SignedAt   *time.Time `json:"signed_at,omitempty"`

	// Verify is the command that checks the artifact against the signing key,
	// run against the Treeship store the gateway signed into. It is
	// constructed from the artifact ID alone and contains no path, host, or
	// key material.
	Verify string `json:"verify,omitempty"`
}

// handleGetInvocationReceipt handles GET /v1/invocations/{id}/receipt.
//
// Tenant-scoped through the invocation lookup: an ID belonging to another
// tenant is not found, exactly as the invocation read itself answers, so this
// route cannot be used to probe for another tenant's invocations.
func (h *Handler) handleGetInvocationReceipt(w http.ResponseWriter, r *http.Request) {
	tenant := auth.TenantFromContext(r.Context())
	user := auth.UserFromContext(r.Context())
	if tenant == "" || user == "" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "invocation id is required")
		return
	}

	inv, err := h.invocations.Get(r.Context(), tenant, id)
	if err != nil {
		if errors.Is(err, invocation.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		h.logger.Error("get invocation receipt: store error", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	resp := invocationReceiptResponse{InvocationID: inv.ID}

	if inv.ReceiptArtifactID == nil || *inv.ReceiptArtifactID == "" {
		// With an emitter attached, either this agent has emit_receipts off or
		// the reference never landed. Both are reported the same way on
		// purpose: distinguishing them would mean reading the agent record to
		// describe an absence, and the honest answer to "why is there no
		// artifact" is that this gateway did not record one.
		resp.Reason = "not_recorded"
		if h.emitter == nil {
			resp.Reason = "receipts_disabled"
		}
		writeJSON(w, http.StatusOK, resp)
		return
	}

	resp.Attested = true
	resp.ArtifactID = *inv.ReceiptArtifactID
	resp.SignedAt = inv.ReceiptSignedAt
	if a, ok := h.emitter.(interface{ Actor() string }); ok {
		resp.Actor = a.Actor()
	}
	resp.Verify = "treeship verify " + resp.ArtifactID

	writeJSON(w, http.StatusOK, resp)
}
