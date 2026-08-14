package httpapi

import (
	"errors"
	"net/http"

	"github.com/zerkerlabs/gateway/rooms/internal/auth"
	"github.com/zerkerlabs/gateway/rooms/internal/room"
)

// handleCompleteRoom serves POST /v1/rooms/{rom_id}/complete: the caller
// declares the room's goal met, transitioning it to the completed terminal
// state. Nothing here infers whether the goal was actually met — that
// judgment is the caller's; the store only records the transition.
//
// Returns 409, not 404, when the room is already terminal: the room was found
// under the caller's own tenant, so the owning tenant learns it was already
// done rather than being told the room doesn't exist. A cross-tenant caller
// still gets 404, identical to a missing room (AGENTS.md invariant #2).
func (h *Handler) handleCompleteRoom(w http.ResponseWriter, r *http.Request) {
	tenantID := auth.TenantFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, CodeUnauthorized, "unauthorized")
		return
	}

	roomID := r.PathValue("rom_id")

	completed, err := h.store.CompleteRoom(r.Context(), tenantID, roomID)
	if err != nil {
		switch {
		case errors.Is(err, room.ErrNotFound):
			writeError(w, http.StatusNotFound, CodeRoomNotFound, "room not found")
		case errors.Is(err, room.ErrRoomTerminated):
			writeError(w, http.StatusConflict, CodeRoomTerminated, "room is already terminated")
		default:
			h.logger.Error("complete room: store error", "err", err)
			w.WriteHeader(http.StatusInternalServerError)
		}
		return
	}

	// The room's accepted outcome is Rooms asserting a fact about itself, not
	// an agent's claim, so it is recorded — never proposed — as authoritative
	// room memory (see record.go). Submission is asynchronous and fail-open:
	// the room is completed whether or not the memory write succeeds.
	h.recordRoomTerminated(roomID, completed)

	// The store's own ErrNotFound scoping means transcript lookup cannot fail
	// here for a reason a caller could hit: the room was just found under the
	// same tenant and ID.
	transcript, err := h.store.Messages(r.Context(), tenantID, roomID)
	if err != nil {
		h.logger.Error("complete room: transcript replay error", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, toRoomResponse(completed, transcript))
}
