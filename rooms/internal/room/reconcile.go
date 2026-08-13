package room

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/zerkerlabs/gateway/rooms/internal/gateway"
)

// GatewayReconciler is the subset of *gateway.Client ReconcileReservations
// needs: a one-shot check of whether a previously accepted invocation reached
// a terminal state. *gateway.Client satisfies this interface.
type GatewayReconciler interface {
	Reconcile(ctx context.Context, agentID, invocationID string) (gateway.ReconcileOutcome, error)
}

// DefaultReconcileTimeout bounds the whole startup reservation-reconciliation
// sweep when no timeout is supplied. A gateway that cannot be reached must
// not stop Rooms from starting, so this — not an unbounded wait — is what
// caps it.
const DefaultReconcileTimeout = 30 * time.Second

// ReconcileReservations resolves every reservation store still holds open —
// left over by a crash between reserving a turn and resolving it — against
// the gateway's own invocation record, so a restart neither burns a turn for
// a call that landed nor silently drops one that did not.
//
// For each pending reservation:
//   - no invocation ID was attached (the crash happened before the proxied
//     call was even accepted, or before that ID reached durable storage) →
//     released; there is nothing to ask the gateway.
//   - invocation found and succeeded → committed, recording the message the
//     reservation was held for and a delivery event carrying the invocation
//     ID, exactly as the live delivery path would have.
//   - invocation found and failed, or not found → released, recording a
//     delivery-failure event so the outcome stays visible in the room's own
//     transcript.
//   - the gateway could not answer at all (unreachable, or any other error) →
//     released, logged at error level with the room ID, member ID, and
//     reservation ID — this is the one case where the trail has a known gap.
//
// timeout bounds the whole sweep — a gateway that cannot be reached does not
// stop Rooms from starting; every reservation still open when it expires is
// released and logged like any other unanswerable one. gw may be nil, in
// which case every pending reservation is released immediately, logged the
// same way as any other case the gateway cannot answer for.
func ReconcileReservations(ctx context.Context, store Store, gw GatewayReconciler, timeout time.Duration, logger *slog.Logger) error {
	if timeout <= 0 {
		timeout = DefaultReconcileTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	pending, err := store.PendingReservations(ctx)
	if err != nil {
		return fmt.Errorf("room: list pending reservations: %w", err)
	}

	for _, pr := range pending {
		reconcileOne(ctx, store, gw, pr, logger)
	}
	return nil
}

// reconcileOne resolves a single pending reservation. It never returns an
// error: every branch either commits, releases, or (if even that fails)
// leaves the reservation for the next startup's sweep to try again, logging
// as it goes so an operator can see what happened.
func reconcileOne(ctx context.Context, store Store, gw GatewayReconciler, pr *PendingReservation, logger *slog.Logger) {
	fields := []any{
		"tenant_id", pr.TenantID,
		"room_id", pr.RoomID,
		"member_id", pr.Reservation.msg.MemberID,
		"reservation_id", pr.Reservation.messageID,
	}

	if gw == nil || pr.InvocationID == "" {
		logger.Error("room: reservation left by a crash has no invocation to reconcile against gateway; releasing", fields...)
		releaseReconciled(ctx, store, pr, "reconciled_unknown", logger, fields)
		return
	}

	outcome, err := gw.Reconcile(ctx, pr.ToAgentID, pr.InvocationID)
	if err != nil {
		logger.Error("room: gateway could not answer for a reservation left by a crash; releasing",
			append(fields, "invocation_id", pr.InvocationID, "err", err)...)
		releaseReconciled(ctx, store, pr, "reconciled_unknown", logger, fields)
		return
	}

	switch outcome {
	case gateway.ReconcileSucceeded:
		logger.Info("room: gateway confirms a crash-recovered reservation's call landed; committing", fields...)
		commitReconciled(ctx, store, pr, logger, fields)
	case gateway.ReconcileFailed:
		logger.Info("room: gateway confirms a crash-recovered reservation's call did not land; releasing", fields...)
		releaseReconciled(ctx, store, pr, "reconciled_failed", logger, fields)
	case gateway.ReconcileNotFound:
		logger.Info("room: gateway has no record of a crash-recovered reservation's invocation; releasing", fields...)
		releaseReconciled(ctx, store, pr, "reconciled_not_found", logger, fields)
	default:
		logger.Error("room: gateway returned an unrecognized outcome for a crash-recovered reservation; releasing", fields...)
		releaseReconciled(ctx, store, pr, "reconciled_unknown", logger, fields)
	}
}

// commitReconciled records the delivery the reservation was held for, then
// commits it — mirroring the live delivery path's RecordDelivery-then-
// CommitTurn order, so a call recovered by reconciliation leaves the same
// shape of trail a call confirmed in-process would have.
func commitReconciled(ctx context.Context, store Store, pr *PendingReservation, logger *slog.Logger, fields []any) {
	msg := pr.Reservation.msg
	if err := store.RecordDelivery(ctx, pr.Reservation.tenantID, pr.Reservation.roomID, msg.MemberID, msg.ToMemberID, pr.ToAgentID, pr.InvocationID); err != nil {
		logger.Error("room: reconcile: record delivery for a recovered reservation", append(fields, "err", err)...)
	}
	if _, err := store.CommitTurn(ctx, pr.Reservation); err != nil {
		logger.Error("room: reconcile: commit a recovered reservation", append(fields, "err", err)...)
	}
}

// releaseReconciled records why the reservation did not land (or could not
// be answered for), then releases its turn back to the room. class is the
// DeliveryFailedPayload.Class value the recorded event carries — see the
// "reconciled_*" values above, distinguishing a definitive gateway answer
// from one it could never give.
func releaseReconciled(ctx context.Context, store Store, pr *PendingReservation, class string, logger *slog.Logger, fields []any) {
	msg := pr.Reservation.msg
	if err := store.RecordDeliveryFailure(ctx, pr.Reservation.tenantID, pr.Reservation.roomID, msg.MemberID, msg.ToMemberID, pr.ToAgentID, class); err != nil {
		logger.Error("room: reconcile: record delivery failure for a recovered reservation", append(fields, "err", err)...)
	}
	if err := store.ReleaseTurn(ctx, pr.Reservation); err != nil {
		logger.Error("room: reconcile: release a recovered reservation", append(fields, "err", err)...)
	}
}
