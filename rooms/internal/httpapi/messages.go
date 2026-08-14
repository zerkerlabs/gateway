package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/zerkerlabs/gateway/rooms/internal/auth"
	"github.com/zerkerlabs/gateway/rooms/internal/gateway"
	"github.com/zerkerlabs/gateway/rooms/internal/memory"
	"github.com/zerkerlabs/gateway/rooms/internal/receipt"
	"github.com/zerkerlabs/gateway/rooms/internal/room"
)

// postMessageRequest is the request body for POST /v1/rooms/{rom_id}/messages.
// ToMemberID is optional: when set, the message is addressed to another
// member and is delivered as a proxied call to that member's agent through
// the gateway (rooms/internal/gateway) before being recorded as a room
// message. When empty, the message is recorded directly, exactly as before.
type postMessageRequest struct {
	MemberID   string `json:"member_id"`
	ToMemberID string `json:"to_member_id"`
	Body       string `json:"body"`
}

func (h *Handler) handlePostMessage(w http.ResponseWriter, r *http.Request) {
	tenantID := auth.TenantFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, CodeUnauthorized, "unauthorized")
		return
	}

	roomID := r.PathValue("rom_id")

	var req postMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, CodeInvalidRequestBody, "invalid request body")
		return
	}

	if req.MemberID == "" {
		writeError(w, http.StatusBadRequest, CodeMissingField, "member_id is required")
		return
	}
	if req.Body == "" {
		writeError(w, http.StatusBadRequest, CodeMissingField, "body is required")
		return
	}
	// Validated against the memory backend's own limit before anything is
	// posted, so an oversized body is rejected here rather than discovered
	// as a 4xx from Propose after the message is already in the transcript
	// (rooms/internal/memory.MaxContentChars).
	if n := utf8.RuneCountInString(req.Body); n > memory.MaxContentChars {
		writeError(w, http.StatusBadRequest, CodeInvalidField,
			fmt.Sprintf("body exceeds the memory backend's %d character limit", memory.MaxContentChars))
		return
	}

	// An addressed message is delivered as a proxied call to the recipient's
	// agent before it is ever recorded, so a failed call can never look like a
	// delivered message. That call is a REAL side effect on another member's
	// agent, with policy and payment consequences, so it happens under a turn
	// reservation — see postAddressedMessage.
	//
	// The two paths are exclusive on purpose. An addressed message must never
	// be able to reach the plain append below: that path takes no ToMemberID
	// and makes no call, so an addressed request arriving there would be
	// silently recorded as a broadcast, with a 201 and no proxied call at all
	// — the bypass this whole package exists to prevent. Every way the
	// addressed path can fail is answered inside it.
	if req.ToMemberID != "" {
		h.postAddressedMessage(w, r, tenantID, roomID, req)
		return
	}

	msg, err := h.store.AppendMessage(r.Context(), tenantID, roomID, req.MemberID, req.Body)
	if err != nil {
		h.writePostFailure(w, tenantID, roomID, err)
		return
	}

	h.proposeMessage(tenantID, roomID, msg)

	writeJSON(w, http.StatusCreated, toMessageResponse(msg))
}

// writePostFailure answers a request whose message could not be posted. Both
// ways of acquiring a turn — AppendMessage and ReserveTurn — reject with the
// same errors, and share this so an addressed message and a broadcast one
// report an identical room state identically.
func (h *Handler) writePostFailure(w http.ResponseWriter, tenantID, roomID string, err error) {
	switch {
	case errors.Is(err, room.ErrNotFound):
		writeError(w, http.StatusNotFound, CodeRoomNotFound, "room not found")
	case errors.Is(err, room.ErrRoomTerminated):
		writeError(w, http.StatusConflict, CodeRoomTerminated, "room is terminated")
	case errors.Is(err, room.ErrTurnBudgetExceeded):
		// The store already abandoned the room and appended its
		// room_terminated event as part of the same call that returned this
		// error — Rooms asserting its own accepted outcome, recorded the same
		// way an explicit completion is (see record.go).
		h.recordRoomTerminatedAfterAbandon(tenantID, roomID)
		writeError(w, http.StatusConflict, CodeTurnBudgetExceeded, "room turn budget exceeded")
	case errors.Is(err, room.ErrTurnReserved):
		// Not out of turns — the remaining ones are held by a delivery still
		// in flight. The room is still open, so this is worth retrying, unlike
		// an exhausted budget.
		writeError(w, http.StatusConflict, CodeTurnReserved, "the room's remaining turns are in flight; retry once delivery completes")
	case errors.Is(err, room.ErrMemberNotFound):
		writeError(w, http.StatusBadRequest, CodeMemberNotFound, "member not found in room")
	default:
		h.logger.Error("post message: store error", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
	}
}

// postAddressedMessage handles a message addressed to another member: it
// delivers the message as a proxied call to that member's agent and, once
// delivery is confirmed, records it. It always writes a response — there is no
// outcome it hands back to the caller, precisely so an addressed message can
// never end up on the plain append path with no call made.
//
// The whole thing runs under a turn reservation, which is what makes delivery
// and recording safe as a pair. Confirming a call can take tens of seconds;
// between a bare "may this member post?" check and the eventual write, a
// concurrent request could consume the room's last turn or terminate the room,
// and the message would be refused after the recipient's agent had already
// been called — a real, possibly billed call with nothing in the transcript to
// show for it. Reserving the turn up front runs every check AppendMessage
// would run AND holds the turn across the delivery, so a confirmed call always
// lands.
func (h *Handler) postAddressedMessage(w http.ResponseWriter, r *http.Request, tenantID, roomID string, req postMessageRequest) {
	res, err := h.store.ReserveTurn(r.Context(), tenantID, roomID, room.PendingMessage{
		MemberID:   req.MemberID,
		ToMemberID: req.ToMemberID,
		Body:       req.Body,
	})
	if err != nil {
		// The room refused the turn, so nothing is delivered and nothing is
		// recorded. Reported exactly as the same refusal on a broadcast
		// message would be — but NOT by retrying as one. ErrTurnReserved in
		// particular is transient: a retry as a broadcast could well succeed,
		// turning a message meant for another agent into an ordinary one that
		// never left the room.
		h.writePostFailure(w, tenantID, roomID, err)
		return
	}

	// A reservation must be resolved exactly once, or the room holds a turn it
	// can never spend. Everything below either commits it or falls into here.
	committed := false
	defer func() {
		if committed {
			return
		}
		if err := h.store.ReleaseTurn(r.Context(), res); err != nil {
			h.logger.Error("post message: release turn", "err", err)
		}
	}()

	if !h.deliverToMember(w, r, tenantID, roomID, req, res) {
		return
	}

	// Delivered and confirmed. Recording it must not be abandoned because the
	// caller hung up mid-delivery — hanging up does not un-call the recipient's
	// agent, and the transcript has to say the call happened. Hence a context
	// detached from the request's cancellation.
	msg, err := h.store.CommitTurn(context.WithoutCancel(r.Context()), res)
	if err != nil {
		h.logger.Error("post message: record delivered message", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	committed = true

	h.proposeMessage(tenantID, roomID, msg)

	writeJSON(w, http.StatusCreated, toMessageResponse(msg))
}

// deliveredMessage is the payload a proxied call carries to the recipient
// agent. Rooms does not interpret or transform the body — the gateway and the
// recipient agent are what act on it — but it does carry the room and sender
// alongside it so the recipient knows which conversation the message belongs
// to, and so a delivery can be correlated with the room's event log.
type deliveredMessage struct {
	RoomID       string `json:"room_id"`
	FromMemberID string `json:"from_member_id"`
	ToMemberID   string `json:"to_member_id"`
	Body         string `json:"body"`
}

// deliverToMember resolves req.ToMemberID to its agent and delivers req.Body
// as a single proxied call through the gateway. It writes an error response
// and returns false on any failure: an unknown room/recipient, a call the
// gateway rejected or that failed at the recipient, or one whose outcome could
// not be confirmed — each recorded as an EventDeliveryFailed event carrying
// its class, so a failed or unconfirmed call is never indistinguishable from a
// delivered one.
//
// Returns true only once delivery is CONFIRMED, at which point the caller
// proceeds to record the message itself. The gateway's proxy is asynchronous,
// so the client polls the invocation to completion rather than trusting the
// 202 that accepts it.
//
// Callers must hold a turn reservation for the message (see Store.ReserveTurn)
// before calling this — it performs a real side effect on another member's
// agent, and that side effect must be both permitted and recordable. res is
// that same reservation: as soon as the gateway accepts the call, its
// invocation ID is attached to res so a crash during the confirmation wait
// that follows can still be reconciled against the gateway's own invocation
// record on the next startup (room.ReconcileReservations).
func (h *Handler) deliverToMember(w http.ResponseWriter, r *http.Request, tenantID, roomID string, req postMessageRequest, res *room.Reservation) bool {
	toAgentID, err := h.store.MemberAgentID(r.Context(), tenantID, roomID, req.ToMemberID)
	if err != nil {
		switch {
		case errors.Is(err, room.ErrNotFound):
			writeError(w, http.StatusNotFound, CodeRoomNotFound, "room not found")
		case errors.Is(err, room.ErrMemberNotFound):
			writeError(w, http.StatusBadRequest, CodeMemberNotFound, "to_member_id not found in room")
		default:
			h.logger.Error("post message: resolve recipient", "err", err)
			w.WriteHeader(http.StatusInternalServerError)
		}
		return false
	}

	payload, err := json.Marshal(deliveredMessage{
		RoomID:       roomID,
		FromMemberID: req.MemberID,
		ToMemberID:   req.ToMemberID,
		Body:         req.Body,
	})
	if err != nil {
		h.logger.Error("post message: marshal delivered payload", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return false
	}

	result, callErr := h.gateway.Deliver(r.Context(), tenantID, toAgentID, payload, func(invocationID string) {
		// Best-effort: a failure here does not abort the call, which may
		// already be running on the recipient's agent. Attaching the ID is
		// what lets a crash during the confirmation wait below be
		// reconciled against the gateway on the next startup; losing it
		// just means that specific reservation falls back to the
		// gateway-cannot-answer case if a crash does happen here.
		if err := h.store.AttachReservationInvocation(context.WithoutCancel(r.Context()), res, invocationID); err != nil {
			h.logger.Error("post message: attach reservation invocation", "err", err)
		}
	})

	// What happened to the call is recorded on a context detached from the
	// request's: the call reached the recipient (or didn't) whether or not the
	// caller is still waiting, and an event log that drops outcomes when a
	// client disconnects is not one you can audit against.
	recordCtx := context.WithoutCancel(r.Context())

	if callErr == nil {
		// Confirmed delivered. Record the gateway's invocation ID so this
		// room's transcript can be reconciled against the gateway's own
		// invocation record when debugging.
		if err := h.store.RecordDelivery(recordCtx, tenantID, roomID, req.MemberID, req.ToMemberID, toAgentID, result.InvocationID); err != nil {
			h.logger.Error("post message: record delivery", "err", err)
		}
		h.emitReceipt(receipt.Receipt{
			RoomID:       roomID,
			TenantID:     tenantID,
			FromMemberID: req.MemberID,
			ToMemberID:   req.ToMemberID,
			ToAgentID:    toAgentID,
			InvocationID: result.InvocationID,
			Outcome:      receipt.OutcomeSucceeded,
			OccurredAt:   time.Now().UTC(),
		})
		return true
	}

	class := gateway.ErrorClassUpstreamFailure
	var ce *gateway.CallError
	if errors.As(callErr, &ce) {
		class = ce.Class
	}
	if err := h.store.RecordDeliveryFailure(recordCtx, tenantID, roomID, req.MemberID, req.ToMemberID, toAgentID, string(class)); err != nil {
		h.logger.Error("post message: record delivery failure", "err", err)
	}
	h.emitReceipt(receipt.Receipt{
		RoomID:       roomID,
		TenantID:     tenantID,
		FromMemberID: req.MemberID,
		ToMemberID:   req.ToMemberID,
		ToAgentID:    toAgentID,
		Outcome:      receipt.OutcomeFailed,
		FailureClass: string(class),
		OccurredAt:   time.Now().UTC(),
	})

	// The gateway's response is classified, never forwarded: a non-2xx body
	// must never leak into the room transcript or this API response
	// (AGENTS.md invariant #3).
	switch class {
	case gateway.ErrorClassCallerError:
		writeError(w, http.StatusUnprocessableEntity, CodeDeliveryRejected, "message could not be delivered: the gateway rejected the call")
	case gateway.ErrorClassUnconfirmed:
		// The call was accepted but its outcome is unknown. Reported
		// distinctly from a failure: it may have reached the recipient, so the
		// caller must not assume it can safely retry as if nothing happened.
		writeError(w, http.StatusGatewayTimeout, CodeDeliveryUnconfirmed, "message delivery could not be confirmed: the call was accepted but did not complete in time")
	case gateway.ErrorClassTenantMismatch:
		// Nothing was sent: this deployment's gateway credential acts for a
		// different tenant, so the call could only have gone out misattributed.
		// A deployment problem, not a request problem — hence 5xx.
		h.logger.Error("post message: gateway client cannot act for this tenant",
			"tenant", tenantID, "room", roomID)
		writeError(w, http.StatusInternalServerError, CodeDeliveryUnavailable, "addressed messages are not available for this tenant")
	default:
		writeError(w, http.StatusBadGateway, CodeDeliveryUpstream, "message could not be delivered: gateway upstream failure")
	}
	return false
}

// receiptEmitTimeout bounds a single receipt emission so a slow or hanging
// backend can't pin a goroutine indefinitely, or past Shutdown's drain
// window.
const receiptEmitTimeout = 10 * time.Second

// emitReceipt records one cross-agent interaction — an addressed message's
// proxied call, whether it succeeded or failed — through the receipt seam.
// Emission is asynchronous and fail-open: it never delays or fails the room
// operation it describes, and a failing or hanging emitter only produces a
// log line. The goroutine is tracked in h.emitWG so Shutdown can drain it
// rather than letting it outlive the service; its context derives from
// h.shutdownCtx so Shutdown cancels a still-running emission promptly
// instead of waiting out its full timeout.
func (h *Handler) emitReceipt(r receipt.Receipt) {
	h.emitWG.Add(1)
	go func() {
		defer h.emitWG.Done()

		ctx, cancel := context.WithTimeout(h.shutdownCtx, receiptEmitTimeout)
		defer cancel()
		if err := h.emitter.Emit(ctx, r); err != nil {
			h.logger.Warn("receipt emission failed (fail-open)",
				"room_id", r.RoomID, "invocation_id", r.InvocationID, "outcome", r.Outcome, "err", err)
		}
	}()
}

// proposeTimeout bounds a single Propose call so a slow or hanging memory
// backend can't pin a goroutine indefinitely, or past Shutdown's drain
// window.
const proposeTimeout = 10 * time.Second

// proposeMessage submits a posted message to the memory backend
// (rooms/internal/memory) as agent-authored content. It is always routed
// through Propose, never Record: a message a member posts is that agent's
// claim, not a fact Rooms itself is asserting, so it must land quarantined —
// reported as withheld until reviewed — rather than becoming authoritative
// room memory the moment it is posted. Recording every message as active
// memory would also duplicate the room transcript in a store whose contract
// says it does not do that.
//
// Submission is asynchronous and fail-open, the same posture emitReceipt
// takes: msg is already durably posted and its transcript is correct whether
// or not this call succeeds, so a failure here is logged and nothing more —
// it must never fail, delay, or retry the message post it describes. The
// goroutine is tracked in h.proposeWG so Shutdown can drain it, and its
// context derives from h.shutdownCtx so Shutdown cancels a still-running
// call promptly instead of waiting out its full timeout.
//
// SourceEventID and IdempotencyKey are both derived from msg.ID — the
// message_posted event's own identity — rather than generated fresh per
// call, so a proposal that runs twice for the same message (a retry, a
// duplicate delivery of this goroutine) reuses the same key and proposes
// nothing new; the backend treats a replay with identical content as a
// no-op.
//
// One limitation worth stating plainly: the backend deliberately ships no
// remote promote/reject endpoint, so a proposal sits in its local review
// queue until Rooms has an operator capability to act on it — proposed
// message memory accumulates unreviewed and never surfaces in a later
// member's onboarding context on its own. That is the correct failure
// direction (nothing false becomes authoritative on Rooms' say-so alone),
// but it does mean "the next agent receives the accepted room state" holds
// for room outcomes and task-state transitions, not for message content,
// until that capability exists.
func (h *Handler) proposeMessage(tenantID, roomID string, msg *room.Message) {
	h.proposeWG.Add(1)
	go func() {
		defer h.proposeWG.Done()

		ctx, cancel := context.WithTimeout(h.shutdownCtx, proposeTimeout)
		defer cancel()

		agentID, err := h.store.MemberAgentID(ctx, tenantID, roomID, msg.MemberID)
		if err != nil {
			h.logger.Warn("propose message failed (fail-open): resolve author agent",
				"room_id", roomID, "message_id", msg.ID, "err", err)
			return
		}

		if _, err := h.memoryStore.Propose(ctx, memory.ProposeRequest{
			RoomID:         roomID,
			AgentID:        agentID,
			Content:        msg.Body,
			SourceEventID:  msg.ID,
			IdempotencyKey: proposeIdempotencyKey(roomID, msg.ID),
		}); err != nil {
			h.logger.Warn("propose message failed (fail-open)",
				"room_id", roomID, "message_id", msg.ID, "err", err)
		}
	}()
}

// proposeIdempotencyKey deterministically derives a Propose call's
// idempotency key from the room and the message's own ID — the event this
// content came from. Two calls for the same message always compute the same
// key, which is what makes a retried or duplicated proposal for that message
// safe: the backend sees an identical key with identical content and treats
// it as a no-op rather than a second candidate memory.
func proposeIdempotencyKey(roomID, messageID string) string {
	return sha256Digest("propose", roomID, messageID)
}
