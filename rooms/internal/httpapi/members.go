package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/zerkerlabs/gateway/rooms/internal/auth"
	"github.com/zerkerlabs/gateway/rooms/internal/memory"
	"github.com/zerkerlabs/gateway/rooms/internal/room"
)

// addMemberRequest is the request body for POST /v1/rooms/{rom_id}/members.
// Documents is optional onboarding material for the member; it may be empty.
type addMemberRequest struct {
	AgentID   string   `json:"agent_id"`
	Documents []string `json:"documents"`
}

// handleAddMember onboards and seats an agent in a room. Onboarding prepares
// the room's governed memory context for the agent and combines it with the
// request's documents into the member's starting context. Rooms are
// single-tenant in v1 (there is no gateway client yet to resolve an agent's
// owning tenant — that lands with the proxy client), so the added agent is
// assumed to belong to the caller's own tenant, same as the room it joins.
func (h *Handler) handleAddMember(w http.ResponseWriter, r *http.Request) {
	tenantID := auth.TenantFromContext(r.Context())
	if tenantID == "" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	roomID := r.PathValue("rom_id")

	var req addMemberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.AgentID == "" {
		writeError(w, http.StatusBadRequest, "agent_id is required")
		return
	}

	// Onboarding fails closed: a memory preparation error refuses the join
	// before any member is seated. A member that believes it was onboarded but
	// holds an empty context would produce confidently wrong work, which is
	// worse than an obvious error here.
	//
	// Purpose, Risk, and ContextBudgetTokens are room and tenant policy inputs
	// this handler does not yet wire up, and the result's State is not yet
	// branched on (ready vs. partial vs. a refusal state) — both are a
	// separate change. This call exists so the join path builds against the
	// new seam.
	result, err := h.memoryStore.PrepareContext(r.Context(), memory.PrepareRequest{RoomID: roomID, AgentID: req.AgentID})
	if err != nil {
		h.logger.Error("add member: onboarding memory preparation failed", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	member, err := h.store.AddMember(r.Context(), tenantID, roomID, req.AgentID, tenantID, onboardingContext(result, req.Documents))
	if err != nil {
		switch {
		case errors.Is(err, room.ErrNotFound):
			writeError(w, http.StatusNotFound, "room not found")
		case errors.Is(err, room.ErrRoomTerminated):
			writeError(w, http.StatusConflict, "room is terminated")
		case errors.Is(err, room.ErrTenantMismatch):
			writeError(w, http.StatusBadRequest, "agent belongs to a different tenant")
		default:
			h.logger.Error("add member: store error", "err", err)
			w.WriteHeader(http.StatusInternalServerError)
		}
		return
	}

	writeJSON(w, http.StatusCreated, toMemberResponse(member))
}

// onboardingContext combines a member's prepared memory with caller-supplied
// documents into a single ordered starting context: the room's admitted
// memory first, then the documents supplied for this room.
func onboardingContext(result memory.ContextResult, documents []string) []string {
	ctx := make([]string, 0, len(result.Memories)+len(documents))
	for _, m := range result.Memories {
		ctx = append(ctx, m.Content)
	}
	ctx = append(ctx, documents...)
	return ctx
}
