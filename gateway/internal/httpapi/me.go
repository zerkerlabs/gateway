package httpapi

import (
	"net/http"

	"github.com/zerkerlabs/gateway/gateway/internal/auth"
)

// meResponse is the body of GET /v1/me: the identity the gateway derived from
// the caller's token, echoed back.
//
// The console is the reason this exists. Its backend-for-frontend holds the
// bearer and the browser never sees it, which is the correct arrangement and
// also means the page has no way to name the tenant it is administering, or to
// know whether the operator may read invocation bodies. Without this it must
// render a control and discover from the failure that the scope was missing.
//
// Nothing here is new authority: every field is already in the validated token
// the caller presented. Echoing a caller's own identity discloses nothing it
// did not send, and the response is derived from the request context only —
// there is no lookup, so no other tenant's data can reach it.
type meResponse struct {
	TenantID string   `json:"tenant_id"`
	UserID   string   `json:"user_id"`
	Scopes   []string `json:"scopes"`

	// CanReadInvocationBodies is HasScope(invocations:read_body), named rather
	// than left for the caller to re-derive from Scopes. It gates one specific,
	// high-risk surface (GET /v1/invocations/{id} body fields), and a client
	// that has to string-match a scope name to find that out will eventually
	// match the wrong one.
	CanReadInvocationBodies bool `json:"can_read_invocation_bodies"`
}

// handleMe handles GET /v1/me. Authenticated like every other /v1 route; it
// reports the caller's own identity and effective scopes, never another's.
func (h *Handler) handleMe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tenant := auth.TenantFromContext(ctx)
	user := auth.UserFromContext(ctx)
	if tenant == "" || user == "" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	scopes := auth.ScopesFromContext(ctx)
	if scopes == nil {
		// An absent scope claim and an empty one are the same fact for a
		// caller — no scopes — and `[]` says it without making the client
		// handle null.
		scopes = []string{}
	}

	writeJSON(w, http.StatusOK, meResponse{
		TenantID:                tenant,
		UserID:                  user,
		Scopes:                  scopes,
		CanReadInvocationBodies: auth.HasScope(ctx, invocationReadBodyScope),
	})
}
