package room_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/rooms/internal/gateway"
	"github.com/zerkerlabs/gateway/rooms/internal/room"
)

const reconcileTenant = "tenant-reconcile"

// fakeReconciler is a room.GatewayReconciler stand-in: it answers exactly
// what the test configures for a given invocation ID, so each reconciliation
// branch can be driven deterministically without a real gateway.
type fakeReconciler struct {
	outcomes map[string]gateway.ReconcileOutcome
	errs     map[string]error
	// block, if set, makes Reconcile wait for ctx to be done and return its
	// error — simulating a gateway that never answers, to prove
	// ReconcileReservations is actually bounded by its timeout rather than
	// hanging on an unresponsive one.
	block bool
}

func (f *fakeReconciler) Reconcile(ctx context.Context, _, invocationID string) (gateway.ReconcileOutcome, error) {
	if f.block {
		<-ctx.Done()
		return 0, ctx.Err()
	}
	if err, ok := f.errs[invocationID]; ok {
		return 0, err
	}
	return f.outcomes[invocationID], nil
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// reconcileFixture creates a room, seats a sender and a recipient, and
// reserves one turn for an addressed message between them — the state a crash
// between ReserveTurn and its resolution would leave behind. It returns the
// store, the reservation, and the recipient's agent ID (what
// ReconcileReservations would have resolved via PendingReservations).
//
// The budget is deliberately exactly one turn, and every test here relies on
// that: it is the tightest boundary, so a reconciliation that spends a turn it
// should not have shows up as an over-budget room rather than as slack.
func reconcileFixture(t *testing.T) (room.Store, *room.Reservation, *room.Room) {
	t.Helper()
	ctx := context.Background()

	s := room.NewMemoryStore()
	r, err := s.CreateRoomWithBudget(ctx, reconcileTenant, "goal", 1)
	if err != nil {
		t.Fatalf("CreateRoomWithBudget: %v", err)
	}
	sender, err := s.AddMember(ctx, reconcileTenant, r.ID, "agt_sender", reconcileTenant, nil, nil, room.ContextCommitment{})
	if err != nil {
		t.Fatalf("AddMember(sender): %v", err)
	}
	recipient, err := s.AddMember(ctx, reconcileTenant, r.ID, "agt_recipient", reconcileTenant, nil, nil, room.ContextCommitment{})
	if err != nil {
		t.Fatalf("AddMember(recipient): %v", err)
	}

	res, err := s.ReserveTurn(ctx, reconcileTenant, r.ID, room.PendingMessage{
		MemberID:   sender.ID,
		ToMemberID: recipient.ID,
		Body:       "crashed mid-delivery",
	})
	if err != nil {
		t.Fatalf("ReserveTurn: %v", err)
	}
	return s, res, r
}

// TestReconcileReservations_Landed proves the first branch a crash can leave
// a reservation in: the invocation ID was attached before the crash, and the
// gateway confirms the call landed. The reservation must be committed — the
// message recorded, the delivery recorded with the gateway's invocation ID —
// exactly as if the process had never crashed.
func TestReconcileReservations_Landed(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	s, res, r := reconcileFixture(t)
	if err := s.AttachReservationInvocation(ctx, res, "inv_landed"); err != nil {
		t.Fatalf("AttachReservationInvocation: %v", err)
	}

	gw := &fakeReconciler{outcomes: map[string]gateway.ReconcileOutcome{"inv_landed": gateway.ReconcileSucceeded}}
	if err := room.ReconcileReservations(ctx, s, gw, time.Second, testLogger()); err != nil {
		t.Fatalf("ReconcileReservations: %v", err)
	}

	msgs, err := s.Messages(ctx, reconcileTenant, r.ID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 1 || msgs[0].Body != "crashed mid-delivery" {
		t.Fatalf("Messages = %+v, want the recovered message recorded", msgs)
	}

	events, err := s.Events(ctx, reconcileTenant, r.ID)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	var sawDelivered, sawPosted bool
	for _, ev := range events {
		switch ev.Kind {
		case room.EventMessageDelivered:
			sawDelivered = true
			p := ev.Payload.(room.MessageDeliveredPayload)
			if p.InvocationID != "inv_landed" {
				t.Errorf("delivered invocation_id = %q, want %q", p.InvocationID, "inv_landed")
			}
		case room.EventMessagePosted:
			sawPosted = true
		}
	}
	if !sawDelivered || !sawPosted {
		t.Errorf("events = %+v, want both message_delivered and message_posted", events)
	}

	pending, err := s.PendingReservations(ctx)
	if err != nil {
		t.Fatalf("PendingReservations: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("pending reservations = %+v, want none left after reconciliation", pending)
	}
}

// TestReconcileReservations_DidNotLand proves the second branch: the gateway
// definitively answers that the invocation failed. The reservation must be
// released, not committed — nothing goes in the transcript, and the turn is
// free again.
func TestReconcileReservations_DidNotLand(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	s, res, r := reconcileFixture(t)
	if err := s.AttachReservationInvocation(ctx, res, "inv_failed"); err != nil {
		t.Fatalf("AttachReservationInvocation: %v", err)
	}

	gw := &fakeReconciler{outcomes: map[string]gateway.ReconcileOutcome{"inv_failed": gateway.ReconcileFailed}}
	if err := room.ReconcileReservations(ctx, s, gw, time.Second, testLogger()); err != nil {
		t.Fatalf("ReconcileReservations: %v", err)
	}

	msgs, err := s.Messages(ctx, reconcileTenant, r.ID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("Messages = %+v, want none — the call did not land", msgs)
	}

	// The turn came back: a plain post now succeeds again where the room's
	// single-turn budget would otherwise still be held by the reservation.
	got, err := s.GetRoom(ctx, reconcileTenant, r.ID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if _, err := s.AppendMessage(ctx, reconcileTenant, r.ID, got.Members[0].ID, "after release"); err != nil {
		t.Errorf("AppendMessage after release: %v — the released turn was lost", err)
	}

	events, err := s.Events(ctx, reconcileTenant, r.ID)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	var failed *room.DeliveryFailedPayload
	for _, ev := range events {
		if p, ok := ev.Payload.(room.DeliveryFailedPayload); ok {
			failed = &p
		}
	}
	if failed == nil || failed.Class != "reconciled_failed" {
		t.Errorf("delivery-failed payload = %+v, want class %q", failed, "reconciled_failed")
	}
}

// TestReconcileReservations_NotFound proves the "not found" branch is
// resolved by release, exactly like a definitive failure, but recorded with
// its own distinct class so an operator can tell the two apart in the
// transcript.
func TestReconcileReservations_NotFound(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	s, res, r := reconcileFixture(t)
	if err := s.AttachReservationInvocation(ctx, res, "inv_missing"); err != nil {
		t.Fatalf("AttachReservationInvocation: %v", err)
	}

	gw := &fakeReconciler{outcomes: map[string]gateway.ReconcileOutcome{"inv_missing": gateway.ReconcileNotFound}}
	if err := room.ReconcileReservations(ctx, s, gw, time.Second, testLogger()); err != nil {
		t.Fatalf("ReconcileReservations: %v", err)
	}

	events, err := s.Events(ctx, reconcileTenant, r.ID)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	var failed *room.DeliveryFailedPayload
	for _, ev := range events {
		if p, ok := ev.Payload.(room.DeliveryFailedPayload); ok {
			failed = &p
		}
	}
	if failed == nil || failed.Class != "reconciled_not_found" {
		t.Errorf("delivery-failed payload = %+v, want class %q", failed, "reconciled_not_found")
	}
}

// TestReconcileReservations_Unknown proves the third branch: the gateway
// cannot answer at all — here, because no invocation ID was ever attached
// (the crash happened before the proxied call was accepted). The
// reservation must be released, the same as a definitive failure, so the
// room is not stuck holding a turn forever.
func TestReconcileReservations_Unknown(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	s, _, r := reconcileFixture(t)
	// No AttachReservationInvocation call: this reservation has no
	// invocation ID, modelling a crash before the gateway ever accepted the
	// call.

	if err := room.ReconcileReservations(ctx, s, &fakeReconciler{}, time.Second, testLogger()); err != nil {
		t.Fatalf("ReconcileReservations: %v", err)
	}

	msgs, err := s.Messages(ctx, reconcileTenant, r.ID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("Messages = %+v, want none — an unanswerable reservation must never be committed", msgs)
	}

	events, err := s.Events(ctx, reconcileTenant, r.ID)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	var failed *room.DeliveryFailedPayload
	for _, ev := range events {
		if p, ok := ev.Payload.(room.DeliveryFailedPayload); ok {
			failed = &p
		}
	}
	if failed == nil || failed.Class != "reconciled_unknown" {
		t.Errorf("delivery-failed payload = %+v, want class %q", failed, "reconciled_unknown")
	}
}

// A gateway error (unreachable, ambiguous) is unknown too, and must be
// released the same way as a missing invocation ID.
func TestReconcileReservations_GatewayErrorIsUnknown(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	s, res, r := reconcileFixture(t)
	if err := s.AttachReservationInvocation(ctx, res, "inv_unreachable"); err != nil {
		t.Fatalf("AttachReservationInvocation: %v", err)
	}

	gw := &fakeReconciler{errs: map[string]error{"inv_unreachable": errors.New("connection refused")}}
	if err := room.ReconcileReservations(ctx, s, gw, time.Second, testLogger()); err != nil {
		t.Fatalf("ReconcileReservations: %v", err)
	}

	events, err := s.Events(ctx, reconcileTenant, r.ID)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	var failed *room.DeliveryFailedPayload
	for _, ev := range events {
		if p, ok := ev.Payload.(room.DeliveryFailedPayload); ok {
			failed = &p
		}
	}
	if failed == nil || failed.Class != "reconciled_unknown" {
		t.Errorf("delivery-failed payload = %+v, want class %q", failed, "reconciled_unknown")
	}
}

// A nil gateway (no gateway configured at all) must not panic — everything
// pending is released as unanswerable, same as any other case with nothing
// to ask.
func TestReconcileReservations_NilGateway(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	s, res, r := reconcileFixture(t)
	if err := s.AttachReservationInvocation(ctx, res, "inv_whatever"); err != nil {
		t.Fatalf("AttachReservationInvocation: %v", err)
	}

	if err := room.ReconcileReservations(ctx, s, nil, time.Second, testLogger()); err != nil {
		t.Fatalf("ReconcileReservations: %v", err)
	}

	msgs, err := s.Messages(ctx, reconcileTenant, r.ID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("Messages = %+v, want none", msgs)
	}
}

// The whole point of a bounded sweep: a gateway that never answers must not
// keep Rooms from starting. ReconcileReservations has to return once its
// timeout elapses, having released whatever it could not resolve in time.
func TestReconcileReservations_BoundedByTimeout(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	s, res, _ := reconcileFixture(t)
	if err := s.AttachReservationInvocation(ctx, res, "inv_hangs"); err != nil {
		t.Fatalf("AttachReservationInvocation: %v", err)
	}

	const budget = 100 * time.Millisecond
	start := time.Now()
	if err := room.ReconcileReservations(ctx, s, &fakeReconciler{block: true}, budget, testLogger()); err != nil {
		t.Fatalf("ReconcileReservations: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 10*budget {
		t.Errorf("ReconcileReservations took %s, want it bounded by ~%s", elapsed, budget)
	}

	pending, err := s.PendingReservations(ctx)
	if err != nil {
		t.Fatalf("PendingReservations: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("pending reservations = %+v, want the timed-out one released", pending)
	}
}

// TestReconcileReservations_TurnAccountingAfterRecovery is the acceptance
// bar: a recovered room cannot spend more turns than its budget allows. The
// reservation itself already counted against the budget (ReserveTurn), so
// committing it via reconciliation must not let the room exceed that budget
// afterward.
func TestReconcileReservations_TurnAccountingAfterRecovery(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	s, res, r := reconcileFixture(t)
	if err := s.AttachReservationInvocation(ctx, res, "inv_landed"); err != nil {
		t.Fatalf("AttachReservationInvocation: %v", err)
	}

	gw := &fakeReconciler{outcomes: map[string]gateway.ReconcileOutcome{"inv_landed": gateway.ReconcileSucceeded}}
	if err := room.ReconcileReservations(ctx, s, gw, time.Second, testLogger()); err != nil {
		t.Fatalf("ReconcileReservations: %v", err)
	}

	got, err := s.GetRoom(ctx, reconcileTenant, r.ID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	sender := got.Members[0].ID

	if _, err := s.AppendMessage(ctx, reconcileTenant, r.ID, sender, "over budget"); !errors.Is(err, room.ErrTurnBudgetExceeded) {
		t.Fatalf("AppendMessage after recovery: err = %v, want ErrTurnBudgetExceeded — the recovered room spent more than its budget", err)
	}
}
