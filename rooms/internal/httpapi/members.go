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
// the room's governed memory context for the agent and carries it alongside
// the request's documents as the member's starting context — the two are
// kept as separate fields throughout, never merged, since one is
// policy-approved and the other is ungoverned caller input (see
// room.Member.AdmittedMemory and room.Member.CallerDocuments). Rooms are
// single-tenant in v1 (there is no gateway client yet to resolve an agent's
// owning tenant — that lands with the proxy client), so the added agent is
// assumed to belong to the caller's own tenant, same as the room it joins.
func (h *Handler) handleAddMember(w http.ResponseWriter, r *http.Request) {
	tenantID := auth.TenantFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, CodeUnauthorized, "unauthorized")
		return
	}

	roomID := r.PathValue("rom_id")

	var req addMemberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, CodeInvalidRequestBody, "invalid request body")
		return
	}

	if req.AgentID == "" {
		writeError(w, http.StatusBadRequest, CodeMissingField, "agent_id is required")
		return
	}

	// The room is fetched before onboarding so membershipDigest and
	// roomStateDigest can be computed over the room state that is actually
	// asking for context — the state before this join, since the member
	// being seated is not yet a member.
	got, err := h.store.GetRoom(r.Context(), tenantID, roomID)
	if err != nil {
		if errors.Is(err, room.ErrNotFound) {
			writeError(w, http.StatusNotFound, CodeRoomNotFound, "room not found")
			return
		}
		h.logger.Error("add member: room lookup failed", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	// Onboarding fails closed: a memory preparation error refuses the join
	// before any member is seated. A member that believes it was onboarded but
	// holds an empty context would produce confidently wrong work, which is
	// worse than an obvious error here. StateBlocked, StateAbstained, and
	// StateBudgetExhausted extend the same reasoning through the success path:
	// a governed backend can return a 200-shaped result that admitted nothing,
	// and seating on that basis is the identical failure arriving with no
	// error to catch it. Only StateReady, StatePartial, and StateEmpty seat.
	//
	// Purpose, Risk, and ContextBudgetTokens are room and tenant policy inputs
	// this handler does not yet wire up — a separate change.
	result, err := h.memoryStore.PrepareContext(r.Context(), memory.PrepareRequest{
		RoomID:           roomID,
		AgentID:          req.AgentID,
		MembershipDigest: membershipDigest(got.Members),
		RoomStateDigest:  roomStateDigest(got),
	})
	if err != nil {
		h.logger.Error("add member: onboarding memory preparation failed", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	if code, def, refused := refusalFor(result.State); refused {
		reason := def
		switch len(result.Omissions.Reasons) {
		case 0:
			// no withheld entries to collapse; def stands.
		case 1:
			reason = result.Omissions.Reasons[0]
		default:
			h.logger.Warn("add member: onboarding refused with divergent withheld reasons",
				"state", result.State, "reasons", result.Omissions.Reasons)
		}
		// Omissions.Abstention is backend free text, not a bounded set of
		// known values like Reasons — it is logged for operators, never
		// forwarded into the response, so it cannot become the one place
		// withheld content escapes through a refusal.
		if result.Omissions.Abstention != "" {
			h.logger.Info("add member: onboarding abstained", "detail", result.Omissions.Abstention)
		}
		writeErrorWithReason(w, http.StatusConflict, code,
			"onboarding refused: room memory policy did not admit a usable context", reason)
		return
	}

	// commitment is derived only from result — the memory backend's own
	// output — never from req.Documents. Documents are ungoverned input
	// supplied directly by the caller, not memory the backend admitted, so
	// they must not be folded into what gets recorded as a governed-memory
	// commitment.
	commitment := room.ContextCommitment{
		Digest:        result.Commitment.Digest,
		State:         string(result.State),
		Retrieved:     result.Counts.Retrieved,
		Admitted:      result.Counts.Admitted,
		Withheld:      result.Counts.Withheld,
		BudgetDropped: result.Counts.BudgetDropped,
		Reasons:       result.Omissions.Reasons,
	}

	member, err := h.store.AddMember(r.Context(), tenantID, roomID, req.AgentID, tenantID, admittedMemory(result), req.Documents, commitment)
	if err != nil {
		switch {
		case errors.Is(err, room.ErrNotFound):
			writeError(w, http.StatusNotFound, CodeRoomNotFound, "room not found")
		case errors.Is(err, room.ErrRoomTerminated):
			writeError(w, http.StatusConflict, CodeRoomTerminated, "room is terminated")
		case errors.Is(err, room.ErrTenantMismatch):
			writeError(w, http.StatusBadRequest, CodeTenantMismatch, "agent belongs to a different tenant")
		default:
			h.logger.Error("add member: store error", "err", err)
			w.WriteHeader(http.StatusInternalServerError)
		}
		return
	}

	writeJSON(w, http.StatusCreated, toMemberResponse(member))
}

// Rooms-owned default reasons for a refused join, used by refusalFor when the
// collapse rule below does not resolve to a single reason the backend's
// withheld entries agree on.
const (
	reasonMemoryBlocked         = "policy_withheld_all"
	reasonMemoryAbstained       = "evidence_conflicted"
	reasonMemoryBudgetExhausted = "budget_exhausted_all"
	reasonMemoryUnrecognized    = "unrecognized_state"
)

// refusalFor reports the response Code and default reason for a memory.State
// that must refuse a join, and whether state refuses at all. Only
// StateReady, StatePartial, and StateEmpty are whitelisted to seat; every
// other value — including one outside the six documented states — refuses,
// so an unrecognized or malformed state fails closed instead of seating a
// member on an unknown basis.
//
// def is only the fallback: the collapse rule at the call site prefers a
// reason every one of the backend's withheld entries agrees on, and falls
// back to def only when they diverge or there are none — see the caller in
// handleAddMember.
func refusalFor(state memory.State) (code Code, def string, refused bool) {
	switch state {
	case memory.StateReady, memory.StatePartial, memory.StateEmpty:
		return "", "", false
	case memory.StateBlocked:
		return CodeMemoryBlocked, reasonMemoryBlocked, true
	case memory.StateAbstained:
		return CodeMemoryAbstained, reasonMemoryAbstained, true
	case memory.StateBudgetExhausted:
		return CodeMemoryBudgetExhausted, reasonMemoryBudgetExhausted, true
	default:
		return CodeMemoryUnrecognized, reasonMemoryUnrecognized, true
	}
}

// admittedMemory extracts the content the memory backend admitted for this
// member, preserving the backend's returned order. It is passed to
// room.Store.AddMember separately from the request's documents — the two
// must never be combined into one list, since only this one has passed
// policy.
func admittedMemory(result memory.ContextResult) []string {
	ctx := make([]string, len(result.Memories))
	for i, m := range result.Memories {
		ctx[i] = m.Content
	}
	return ctx
}
