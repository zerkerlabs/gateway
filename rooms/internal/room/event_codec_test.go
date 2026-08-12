package room_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/rooms/internal/room"
)

// fixedTimestamp carries sub-second precision so a round trip that lost any
// of it would reorder events sharing the same second.
var fixedTimestamp = time.Date(2026, 8, 10, 12, 34, 56, 123456789, time.UTC)

// allKinds lists every event kind this package declares, so the round-trip
// test can assert it has coverage for all of them.
var allKinds = []room.EventKind{
	room.EventMemberJoined,
	room.EventMessagePosted,
	room.EventTaskStateChanged,
	room.EventRoomTerminated,
	room.EventDeliveryFailed,
	room.EventMessageDelivered,
}

func sampleEvent(kind room.EventKind) *room.Event {
	ev := &room.Event{
		Sequence:  7,
		Kind:      kind,
		Timestamp: fixedTimestamp,
	}
	switch kind {
	case room.EventMemberJoined:
		ev.Payload = room.MemberJoinedPayload{
			Member: &room.Member{
				ID:      "mem_123",
				AgentID: "agt_456",
				// AdmittedMemory and CallerDocuments deliberately hold
				// sentinel content (sentinelOnboardingContext and
				// sentinelCallerDocument below): neither must ever survive a
				// marshal/unmarshal round trip — see
				// TestMarshalEvent_MemberJoined_DropsOnboardingContext.
				JoinedAt:        fixedTimestamp,
				AdmittedMemory:  []string{sentinelOnboardingContext, "line two"},
				CallerDocuments: []string{sentinelCallerDocument},
				Context: room.ContextCommitment{
					Digest:        "sha256:" + strings.Repeat("ab", 32),
					State:         "partial",
					Retrieved:     4,
					Admitted:      2,
					Withheld:      1,
					BudgetDropped: 3,
					Reasons:       []string{"policy_withheld", "budget"},
				},
				ContextReplayable: true,
			},
		}
	case room.EventMessagePosted:
		ev.Payload = room.MessagePostedPayload{
			Message: &room.Message{
				ID:         "msg_123",
				MemberID:   "mem_123",
				ToMemberID: "mem_456",
				Body:       "hello room",
				CreatedAt:  fixedTimestamp,
			},
		}
	case room.EventTaskStateChanged:
		ev.Payload = nil
	case room.EventRoomTerminated:
		ev.Payload = room.RoomTerminatedPayload{State: room.StateAbandoned}
	case room.EventDeliveryFailed:
		ev.Payload = room.DeliveryFailedPayload{
			FromMemberID: "mem_123",
			ToMemberID:   "mem_456",
			ToAgentID:    "agt_456",
			Class:        "upstream_failure",
		}
	case room.EventMessageDelivered:
		ev.Payload = room.MessageDeliveredPayload{
			FromMemberID: "mem_123",
			ToMemberID:   "mem_456",
			ToAgentID:    "agt_456",
			InvocationID: "inv_789",
		}
	default:
		panic("sampleEvent: unhandled kind " + string(kind))
	}
	return ev
}

func TestMarshalUnmarshalEvent_RoundTrip_AllKinds(t *testing.T) {
	t.Parallel()

	if len(allKinds) != 6 {
		t.Fatalf("allKinds has %d entries, want 6 (one per currently-declared EventKind)", len(allKinds))
	}

	for _, kind := range allKinds {
		kind := kind
		t.Run(string(kind), func(t *testing.T) {
			t.Parallel()

			want := sampleEvent(kind)
			data, err := room.MarshalEvent(want)
			if err != nil {
				t.Fatalf("MarshalEvent: %v", err)
			}

			got, err := room.UnmarshalEvent(data)
			if err != nil {
				t.Fatalf("UnmarshalEvent: %v", err)
			}

			assertEventsEqual(t, want, got)
		})
	}
}

// TestMarshalEvent_CarriesPayloadVersion asserts payload_version is present
// in the wire form from the first commit, as the acceptance criteria
// requires, rather than only being exercised indirectly through round trips.
func TestMarshalEvent_CarriesPayloadVersion(t *testing.T) {
	t.Parallel()

	data, err := room.MarshalEvent(sampleEvent(room.EventMessagePosted))
	if err != nil {
		t.Fatalf("MarshalEvent: %v", err)
	}

	var envelope map[string]any
	if err := json.Unmarshal(data, &envelope); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	v, ok := envelope["payload_version"]
	if !ok {
		t.Fatal("encoded event has no payload_version field")
	}
	if v != float64(1) {
		t.Errorf("payload_version = %v, want 1", v)
	}
	if envelope["kind"] != string(room.EventMessagePosted) {
		t.Errorf("kind = %v, want %q", envelope["kind"], room.EventMessagePosted)
	}
}

// TestUnmarshalEvent_UnknownKind proves a synthetic unknown kind is reported
// distinctly (ErrUnknownEventKind) rather than crashing decode.
func TestUnmarshalEvent_UnknownKind(t *testing.T) {
	t.Parallel()

	raw := []byte(`{"sequence":1,"kind":"member_teleported","timestamp":"2026-08-10T12:00:00Z","payload_version":1,"payload":{}}`)

	_, err := room.UnmarshalEvent(raw)
	if !errors.Is(err, room.ErrUnknownEventKind) {
		t.Fatalf("UnmarshalEvent error = %v, want wrapping ErrUnknownEventKind", err)
	}
}

// TestUnmarshalEvent_UnknownPayloadVersion proves an unrecognized
// payload_version for a known kind is reported distinctly rather than
// silently misparsed or fatal.
func TestUnmarshalEvent_UnknownPayloadVersion(t *testing.T) {
	t.Parallel()

	raw := []byte(`{"sequence":1,"kind":"message_posted","timestamp":"2026-08-10T12:00:00Z","payload_version":99,"payload":{"message":{"id":"msg_1","member_id":"mem_1","body":"hi","created_at":"2026-08-10T12:00:00Z"}}}`)

	_, err := room.UnmarshalEvent(raw)
	if !errors.Is(err, room.ErrUnknownPayloadVersion) {
		t.Fatalf("UnmarshalEvent error = %v, want wrapping ErrUnknownPayloadVersion", err)
	}
}

// TestUnmarshalEvent_MalformedPayload proves a payload that does not parse
// into a known kind's shape is reported distinctly rather than fatal.
func TestUnmarshalEvent_MalformedPayload(t *testing.T) {
	t.Parallel()

	raw := []byte(`{"sequence":1,"kind":"message_posted","timestamp":"2026-08-10T12:00:00Z","payload_version":1,"payload":"not-an-object"}`)

	_, err := room.UnmarshalEvent(raw)
	if !errors.Is(err, room.ErrMalformedEventPayload) {
		t.Fatalf("UnmarshalEvent error = %v, want wrapping ErrMalformedEventPayload", err)
	}
}

// TestDecodeEventLog_SkipsUnknownKindWithWarning proves a replay containing
// one event of an unknown kind returns the events it does understand, in
// order, rather than failing the whole room — and logs a warning for the
// skipped one.
func TestDecodeEventLog_SkipsUnknownKindWithWarning(t *testing.T) {
	t.Parallel()

	first := sampleEvent(room.EventMemberJoined)
	first.Sequence = 1
	unknown := []byte(`{"sequence":2,"kind":"member_teleported","timestamp":"2026-08-10T12:00:00Z","payload_version":1,"payload":{}}`)
	third := sampleEvent(room.EventMessagePosted)
	third.Sequence = 3

	firstData, err := room.MarshalEvent(first)
	if err != nil {
		t.Fatalf("MarshalEvent(first): %v", err)
	}
	thirdData, err := room.MarshalEvent(third)
	if err != nil {
		t.Fatalf("MarshalEvent(third): %v", err)
	}

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))

	got := room.DecodeEventLog(logger, [][]byte{firstData, unknown, thirdData})

	if len(got) != 2 {
		t.Fatalf("DecodeEventLog returned %d events, want 2 (unknown kind skipped)", len(got))
	}
	assertEventsEqual(t, first, got[0])
	assertEventsEqual(t, third, got[1])

	logged := logBuf.String()
	if !strings.Contains(logged, "WARN") {
		t.Errorf("log output = %q, want a WARN-level entry for the skipped event", logged)
	}
	if !strings.Contains(logged, "member_teleported") || !strings.Contains(logged, room.ErrUnknownEventKind.Error()) {
		t.Errorf("log output = %q, want it to identify the unknown kind", logged)
	}
}

// TestDecodeEventLog_SkipsUnknownPayloadVersionWithWarning mirrors the
// unknown-kind case for a kind this build knows but a payload_version it does
// not.
func TestDecodeEventLog_SkipsUnknownPayloadVersionWithWarning(t *testing.T) {
	t.Parallel()

	ok := sampleEvent(room.EventRoomTerminated)
	ok.Sequence = 1
	okData, err := room.MarshalEvent(ok)
	if err != nil {
		t.Fatalf("MarshalEvent(ok): %v", err)
	}
	futureVersion := []byte(`{"sequence":2,"kind":"room_terminated","timestamp":"2026-08-10T12:00:00Z","payload_version":99,"payload":{"state":"completed"}}`)

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))

	got := room.DecodeEventLog(logger, [][]byte{okData, futureVersion})

	if len(got) != 1 {
		t.Fatalf("DecodeEventLog returned %d events, want 1 (unknown payload_version skipped)", len(got))
	}
	assertEventsEqual(t, ok, got[0])

	if !strings.Contains(logBuf.String(), "WARN") {
		t.Errorf("log output = %q, want a WARN-level entry for the skipped event", logBuf.String())
	}
}

// TestDecodeEventLog_SkipsMalformedPayloadWithWarning mirrors the same
// tolerance for a payload that fails to parse for a known kind and version.
func TestDecodeEventLog_SkipsMalformedPayloadWithWarning(t *testing.T) {
	t.Parallel()

	ok := sampleEvent(room.EventDeliveryFailed)
	ok.Sequence = 1
	okData, err := room.MarshalEvent(ok)
	if err != nil {
		t.Fatalf("MarshalEvent(ok): %v", err)
	}
	malformed := []byte(`{"sequence":2,"kind":"delivery_failed","timestamp":"2026-08-10T12:00:00Z","payload_version":1,"payload":[1,2,3]}`)

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))

	got := room.DecodeEventLog(logger, [][]byte{okData, malformed})

	if len(got) != 1 {
		t.Fatalf("DecodeEventLog returned %d events, want 1 (malformed payload skipped)", len(got))
	}
	assertEventsEqual(t, ok, got[0])

	if !strings.Contains(logBuf.String(), "WARN") {
		t.Errorf("log output = %q, want a WARN-level entry for the skipped event", logBuf.String())
	}
}

// TestDecodeEventLog_Empty confirms an empty log decodes to an empty (not
// nil-panicking) slice, and that a fully healthy log logs nothing.
func TestDecodeEventLog_Empty(t *testing.T) {
	t.Parallel()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	got := room.DecodeEventLog(logger, nil)
	if len(got) != 0 {
		t.Fatalf("DecodeEventLog(nil) = %v, want empty", got)
	}
}

// assertEventsEqual compares two Events field by field. Timestamps are
// compared with time.Time.Equal rather than reflect.DeepEqual, since a
// round-tripped time.Time need not share the exact internal representation
// of the original to represent the identical instant.
func assertEventsEqual(t *testing.T, want, got *room.Event) {
	t.Helper()

	if got.Sequence != want.Sequence {
		t.Errorf("Sequence = %d, want %d", got.Sequence, want.Sequence)
	}
	if got.Kind != want.Kind {
		t.Errorf("Kind = %q, want %q", got.Kind, want.Kind)
	}
	if !got.Timestamp.Equal(want.Timestamp) {
		t.Errorf("Timestamp = %v, want %v", got.Timestamp, want.Timestamp)
	}
	if got.Timestamp.UnixNano() != want.Timestamp.UnixNano() {
		t.Errorf("Timestamp lost precision: got %d ns, want %d ns", got.Timestamp.UnixNano(), want.Timestamp.UnixNano())
	}

	switch wantPayload := want.Payload.(type) {
	case room.MemberJoinedPayload:
		gotPayload, ok := got.Payload.(room.MemberJoinedPayload)
		if !ok {
			t.Fatalf("Payload type = %T, want room.MemberJoinedPayload", got.Payload)
		}
		assertMembersEqual(t, wantPayload.Member, gotPayload.Member)
	case room.MessagePostedPayload:
		gotPayload, ok := got.Payload.(room.MessagePostedPayload)
		if !ok {
			t.Fatalf("Payload type = %T, want room.MessagePostedPayload", got.Payload)
		}
		assertMessagesEqual(t, wantPayload.Message, gotPayload.Message)
	case room.RoomTerminatedPayload:
		gotPayload, ok := got.Payload.(room.RoomTerminatedPayload)
		if !ok {
			t.Fatalf("Payload type = %T, want room.RoomTerminatedPayload", got.Payload)
		}
		if gotPayload.State != wantPayload.State {
			t.Errorf("RoomTerminatedPayload.State = %q, want %q", gotPayload.State, wantPayload.State)
		}
	case room.DeliveryFailedPayload:
		gotPayload, ok := got.Payload.(room.DeliveryFailedPayload)
		if !ok {
			t.Fatalf("Payload type = %T, want room.DeliveryFailedPayload", got.Payload)
		}
		if gotPayload != wantPayload {
			t.Errorf("DeliveryFailedPayload = %+v, want %+v", gotPayload, wantPayload)
		}
	case room.MessageDeliveredPayload:
		gotPayload, ok := got.Payload.(room.MessageDeliveredPayload)
		if !ok {
			t.Fatalf("Payload type = %T, want room.MessageDeliveredPayload", got.Payload)
		}
		if gotPayload != wantPayload {
			t.Errorf("MessageDeliveredPayload = %+v, want %+v", gotPayload, wantPayload)
		}
	case nil:
		if got.Payload != nil {
			t.Errorf("Payload = %#v, want nil", got.Payload)
		}
	default:
		t.Fatalf("assertEventsEqual: unhandled payload type %T", want.Payload)
	}
}

// assertMembersEqual compares two Members field by field, except
// AdmittedMemory, CallerDocuments, and ContextReplayable: a Member decoded
// off the wire never carries onboarding content, however it was assembled
// before marshaling — see TestMarshalEvent_MemberJoined_DropsOnboardingContext,
// which checks that asymmetry directly.
func assertMembersEqual(t *testing.T, want, got *room.Member) {
	t.Helper()

	if got.ID != want.ID {
		t.Errorf("Member.ID = %q, want %q", got.ID, want.ID)
	}
	if got.AgentID != want.AgentID {
		t.Errorf("Member.AgentID = %q, want %q", got.AgentID, want.AgentID)
	}
	if !got.JoinedAt.Equal(want.JoinedAt) {
		t.Errorf("Member.JoinedAt = %v, want %v", got.JoinedAt, want.JoinedAt)
	}
	if !reflect.DeepEqual(got.Context, want.Context) {
		t.Errorf("Member.Context = %+v, want %+v", got.Context, want.Context)
	}
	if got.ContextReplayable {
		t.Error("Member.ContextReplayable = true for a decoded event, want false")
	}
	if len(got.AdmittedMemory) != 0 {
		t.Errorf("Member.AdmittedMemory = %v, want empty (never persisted)", got.AdmittedMemory)
	}
	if len(got.CallerDocuments) != 0 {
		t.Errorf("Member.CallerDocuments = %v, want empty (never persisted)", got.CallerDocuments)
	}
}

// sentinelOnboardingContext is recognizable admitted-memory content used to
// prove it never reaches a persisted event's wire bytes. Also used by
// postgres_test.go (integration-tagged, same package) to check the same
// thing end to end against room_events.payload.
const sentinelOnboardingContext = "SENTINEL: this member's real onboarding content must never be persisted"

// sentinelCallerDocument is recognizable caller-document content, distinct
// from sentinelOnboardingContext, used alongside it to prove admitted memory
// and caller documents both drop from persisted wire bytes and stay
// distinguishable from each other everywhere they do survive. Also used by
// postgres_test.go.
const sentinelCallerDocument = "SENTINEL: this member's real caller document must never be persisted"

// TestMarshalEvent_MemberJoined_DropsOnboardingContext is the acceptance
// check for the member_joined payload shape: onboarding context — admitted
// memory and caller documents alike — is content Rooms does not own a
// durable copy of, so neither must ever reach room_events.payload, however
// recognizable the content. This proves it at the wire-bytes level, not just
// by checking the decoded struct — a leak that survived marshaling but got
// dropped on decode would still have written the content to storage.
func TestMarshalEvent_MemberJoined_DropsOnboardingContext(t *testing.T) {
	t.Parallel()

	ev := &room.Event{
		Sequence:  1,
		Kind:      room.EventMemberJoined,
		Timestamp: fixedTimestamp,
		Payload: room.MemberJoinedPayload{
			Member: &room.Member{
				ID:                "mem_123",
				AgentID:           "agt_456",
				JoinedAt:          fixedTimestamp,
				AdmittedMemory:    []string{sentinelOnboardingContext},
				CallerDocuments:   []string{sentinelCallerDocument},
				Context:           room.ContextCommitment{Digest: "sha256:" + strings.Repeat("cd", 32), State: "ready", Admitted: 1},
				ContextReplayable: true,
			},
		},
	}

	data, err := room.MarshalEvent(ev)
	if err != nil {
		t.Fatalf("MarshalEvent: %v", err)
	}
	if strings.Contains(string(data), sentinelOnboardingContext) {
		t.Fatalf("marshaled event bytes contain the admitted-memory sentinel: %s", data)
	}
	if strings.Contains(string(data), sentinelCallerDocument) {
		t.Fatalf("marshaled event bytes contain the caller-document sentinel: %s", data)
	}
	if strings.Contains(string(data), "starting_context") {
		t.Fatalf("marshaled event bytes contain a starting_context field: %s", data)
	}
	if strings.Contains(string(data), "admitted_memory") || strings.Contains(string(data), "caller_documents") {
		t.Fatalf("marshaled event bytes contain an admitted_memory or caller_documents field: %s", data)
	}

	got, err := room.UnmarshalEvent(data)
	if err != nil {
		t.Fatalf("UnmarshalEvent: %v", err)
	}
	payload, ok := got.Payload.(room.MemberJoinedPayload)
	if !ok {
		t.Fatalf("Payload type = %T, want room.MemberJoinedPayload", got.Payload)
	}
	if len(payload.Member.AdmittedMemory) != 0 {
		t.Errorf("decoded AdmittedMemory = %v, want empty", payload.Member.AdmittedMemory)
	}
	if len(payload.Member.CallerDocuments) != 0 {
		t.Errorf("decoded CallerDocuments = %v, want empty", payload.Member.CallerDocuments)
	}
	if payload.Member.ContextReplayable {
		t.Error("decoded ContextReplayable = true, want false")
	}
	wantCommitment := room.ContextCommitment{Digest: "sha256:" + strings.Repeat("cd", 32), State: "ready", Admitted: 1}
	if !reflect.DeepEqual(payload.Member.Context, wantCommitment) {
		t.Errorf("decoded Context = %+v, want %+v", payload.Member.Context, wantCommitment)
	}
}

func assertMessagesEqual(t *testing.T, want, got *room.Message) {
	t.Helper()

	if got.ID != want.ID {
		t.Errorf("Message.ID = %q, want %q", got.ID, want.ID)
	}
	if got.MemberID != want.MemberID {
		t.Errorf("Message.MemberID = %q, want %q", got.MemberID, want.MemberID)
	}
	if got.ToMemberID != want.ToMemberID {
		t.Errorf("Message.ToMemberID = %q, want %q", got.ToMemberID, want.ToMemberID)
	}
	if got.Body != want.Body {
		t.Errorf("Message.Body = %q, want %q", got.Body, want.Body)
	}
	if !got.CreatedAt.Equal(want.CreatedAt) {
		t.Errorf("Message.CreatedAt = %v, want %v", got.CreatedAt, want.CreatedAt)
	}
}
