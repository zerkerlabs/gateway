package room

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// Sentinel errors UnmarshalEvent wraps its return value in, so a caller
// replaying a persisted log can tell a row it should skip (a kind it does not
// know, a payload_version it does not know for a kind it does know, or a
// payload that does not parse) apart from every other decode failure. See
// DecodeEventLog, which uses these to implement that tolerance.
var (
	// ErrUnknownEventKind is returned for a kind not in this build's
	// discriminator table — the row a newer process wrote.
	ErrUnknownEventKind = errors.New("room: unknown event kind")
	// ErrUnknownPayloadVersion is returned for a kind this build knows, whose
	// payload_version it does not.
	ErrUnknownPayloadVersion = errors.New("room: unknown payload version")
	// ErrMalformedEventPayload is returned when the envelope or a known
	// kind's payload does not parse as its expected shape.
	ErrMalformedEventPayload = errors.New("room: malformed event payload")
)

// eventEnvelope is the stable, versioned JSON representation of an Event,
// suitable for storage in a single jsonb column. Kind is the discriminator:
// decoding looks it up in a fixed table to choose which payload shape to
// parse Payload into, rather than trusting anything about the Go type behind
// Event.Payload — that type does not exist until the table constructs it.
// PayloadVersion is carried alongside Kind from the first commit of this
// format, so a future change to a kind's payload shape can be introduced as a
// new version read alongside the old one instead of a migration.
type eventEnvelope struct {
	Sequence       int             `json:"sequence"`
	Kind           string          `json:"kind"`
	Timestamp      time.Time       `json:"timestamp"`
	PayloadVersion int             `json:"payload_version"`
	Payload        json.RawMessage `json:"payload"`
}

// wireMember is the wire representation of a Member. StartingContext is
// deliberately absent: it is the member's onboarding content, governed
// memory-backend material Rooms does not persist a durable copy of (see
// ContextCommitment in room.go). Only the commitment recorded for it is
// written here.
type wireMember struct {
	ID       string                `json:"id"`
	AgentID  string                `json:"agent_id"`
	JoinedAt time.Time             `json:"joined_at"`
	Context  wireContextCommitment `json:"context"`
}

// wireContextCommitment is the wire representation of a ContextCommitment.
type wireContextCommitment struct {
	Digest        string `json:"digest,omitempty"`
	State         string `json:"state,omitempty"`
	Admitted      int    `json:"admitted"`
	Withheld      int    `json:"withheld"`
	BudgetDropped int    `json:"budget_dropped"`
}

func newWireMember(m *Member) wireMember {
	return wireMember{
		ID:       m.ID,
		AgentID:  m.AgentID,
		JoinedAt: m.JoinedAt,
		Context: wireContextCommitment{
			Digest:        m.Context.Digest,
			State:         m.Context.State,
			Admitted:      m.Context.Admitted,
			Withheld:      m.Context.Withheld,
			BudgetDropped: m.Context.BudgetDropped,
		},
	}
}

// toMember reconstructs the Member a wireMember describes. The result always
// has ContextReplayable=false and an empty StartingContext: a decoded event
// came off a persisted log, which never carried onboarding content, only the
// commitment recorded for it — see ContextCommitment.
func (w wireMember) toMember() *Member {
	return &Member{
		ID:       w.ID,
		AgentID:  w.AgentID,
		JoinedAt: w.JoinedAt,
		Context: ContextCommitment{
			Digest:        w.Context.Digest,
			State:         w.Context.State,
			Admitted:      w.Context.Admitted,
			Withheld:      w.Context.Withheld,
			BudgetDropped: w.Context.BudgetDropped,
		},
		ContextReplayable: false,
	}
}

// wireMessage is the wire representation of a Message.
type wireMessage struct {
	ID         string    `json:"id"`
	MemberID   string    `json:"member_id"`
	ToMemberID string    `json:"to_member_id,omitempty"`
	Body       string    `json:"body"`
	CreatedAt  time.Time `json:"created_at"`
}

func newWireMessage(m *Message) wireMessage {
	return wireMessage{
		ID:         m.ID,
		MemberID:   m.MemberID,
		ToMemberID: m.ToMemberID,
		Body:       m.Body,
		CreatedAt:  m.CreatedAt,
	}
}

func (w wireMessage) toMessage() *Message {
	return &Message{
		ID:         w.ID,
		MemberID:   w.MemberID,
		ToMemberID: w.ToMemberID,
		Body:       w.Body,
		CreatedAt:  w.CreatedAt,
	}
}

// Per-kind payload wire shapes. Each mirrors the corresponding *Payload
// struct in room.go field-for-field; they exist separately so the wire
// format (json tags, nested wire types) can stay stable even if the in-memory
// struct it mirrors is renamed or reordered.
type (
	wireMemberJoinedPayload struct {
		Member wireMember `json:"member"`
	}
	wireMessagePostedPayload struct {
		Message wireMessage `json:"message"`
	}
	wireRoomTerminatedPayload struct {
		State string `json:"state"`
	}
	wireDeliveryFailedPayload struct {
		FromMemberID string `json:"from_member_id"`
		ToMemberID   string `json:"to_member_id"`
		ToAgentID    string `json:"to_agent_id"`
		Class        string `json:"class"`
	}
	wireMessageDeliveredPayload struct {
		FromMemberID string `json:"from_member_id"`
		ToMemberID   string `json:"to_member_id"`
		ToAgentID    string `json:"to_agent_id"`
		InvocationID string `json:"invocation_id"`
	}
)

// Current payload_version for each event kind. All start at 1: this is the
// format's first commit, so there is nothing to be compatible with yet.
const (
	memberJoinedPayloadVersion     = 1
	messagePostedPayloadVersion    = 1
	taskStateChangedPayloadVersion = 1
	roomTerminatedPayloadVersion   = 1
	deliveryFailedPayloadVersion   = 1
	messageDeliveredPayloadVersion = 1
)

// MarshalEvent encodes ev as the stable JSON representation described by
// eventEnvelope, ready to store in a jsonb column. It is the inverse of
// UnmarshalEvent.
func MarshalEvent(ev *Event) ([]byte, error) {
	payload, version, err := marshalPayload(ev.Kind, ev.Payload)
	if err != nil {
		return nil, fmt.Errorf("room: marshal event kind %q: %w", ev.Kind, err)
	}
	b, err := json.Marshal(eventEnvelope{
		Sequence:       ev.Sequence,
		Kind:           string(ev.Kind),
		Timestamp:      ev.Timestamp,
		PayloadVersion: version,
		Payload:        payload,
	})
	if err != nil {
		return nil, fmt.Errorf("room: marshal event: %w", err)
	}
	return b, nil
}

// marshalPayload encodes payload according to kind, returning the current
// payload_version for that kind alongside it. kind is Event.Kind, the same
// field the envelope carries as its discriminator, so the wire payload_version
// always matches the shape actually written.
func marshalPayload(kind EventKind, payload any) (json.RawMessage, int, error) {
	switch kind {
	case EventMemberJoined:
		p, ok := payload.(MemberJoinedPayload)
		if !ok {
			return nil, 0, fmt.Errorf("payload type %T does not match kind %q", payload, kind)
		}
		b, err := json.Marshal(wireMemberJoinedPayload{Member: newWireMember(p.Member)})
		return b, memberJoinedPayloadVersion, err
	case EventMessagePosted:
		p, ok := payload.(MessagePostedPayload)
		if !ok {
			return nil, 0, fmt.Errorf("payload type %T does not match kind %q", payload, kind)
		}
		b, err := json.Marshal(wireMessagePostedPayload{Message: newWireMessage(p.Message)})
		return b, messagePostedPayloadVersion, err
	case EventTaskStateChanged:
		// No payload struct exists yet — nothing emits this kind (see
		// EventTaskStateChanged's doc comment) — so the only value this
		// build can round-trip for it is the absence of one.
		if payload != nil {
			return nil, 0, fmt.Errorf("payload type %T does not match kind %q", payload, kind)
		}
		b, err := json.Marshal(struct{}{})
		return b, taskStateChangedPayloadVersion, err
	case EventRoomTerminated:
		p, ok := payload.(RoomTerminatedPayload)
		if !ok {
			return nil, 0, fmt.Errorf("payload type %T does not match kind %q", payload, kind)
		}
		b, err := json.Marshal(wireRoomTerminatedPayload{State: string(p.State)})
		return b, roomTerminatedPayloadVersion, err
	case EventDeliveryFailed:
		p, ok := payload.(DeliveryFailedPayload)
		if !ok {
			return nil, 0, fmt.Errorf("payload type %T does not match kind %q", payload, kind)
		}
		b, err := json.Marshal(wireDeliveryFailedPayload(p))
		return b, deliveryFailedPayloadVersion, err
	case EventMessageDelivered:
		p, ok := payload.(MessageDeliveredPayload)
		if !ok {
			return nil, 0, fmt.Errorf("payload type %T does not match kind %q", payload, kind)
		}
		b, err := json.Marshal(wireMessageDeliveredPayload(p))
		return b, messageDeliveredPayloadVersion, err
	default:
		return nil, 0, fmt.Errorf("%w: %q", ErrUnknownEventKind, kind)
	}
}

// UnmarshalEvent decodes one JSON-encoded event previously produced by
// MarshalEvent. kind is looked up in a fixed table to choose which payload
// shape to parse — decoding never relies on a Go type assertion against
// Event.Payload, since nothing of that type exists until this function
// constructs it.
//
// It returns an error wrapping ErrUnknownEventKind, ErrUnknownPayloadVersion,
// or ErrMalformedEventPayload for a row a caller replaying a persisted log
// should skip rather than fail on; see DecodeEventLog.
func UnmarshalEvent(data []byte) (*Event, error) {
	var env eventEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrMalformedEventPayload, err)
	}
	kind := EventKind(env.Kind)
	payload, err := unmarshalPayload(kind, env.PayloadVersion, env.Payload)
	if err != nil {
		return nil, err
	}
	return &Event{
		Sequence:  env.Sequence,
		Kind:      kind,
		Timestamp: env.Timestamp,
		Payload:   payload,
	}, nil
}

func unmarshalPayload(kind EventKind, version int, raw json.RawMessage) (any, error) {
	switch kind {
	case EventMemberJoined:
		if version != memberJoinedPayloadVersion {
			return nil, fmt.Errorf("%w: kind %q version %d", ErrUnknownPayloadVersion, kind, version)
		}
		var w wireMemberJoinedPayload
		if err := json.Unmarshal(raw, &w); err != nil {
			return nil, fmt.Errorf("%w: kind %q: %w", ErrMalformedEventPayload, kind, err)
		}
		return MemberJoinedPayload{Member: w.Member.toMember()}, nil
	case EventMessagePosted:
		if version != messagePostedPayloadVersion {
			return nil, fmt.Errorf("%w: kind %q version %d", ErrUnknownPayloadVersion, kind, version)
		}
		var w wireMessagePostedPayload
		if err := json.Unmarshal(raw, &w); err != nil {
			return nil, fmt.Errorf("%w: kind %q: %w", ErrMalformedEventPayload, kind, err)
		}
		return MessagePostedPayload{Message: w.Message.toMessage()}, nil
	case EventTaskStateChanged:
		if version != taskStateChangedPayloadVersion {
			return nil, fmt.Errorf("%w: kind %q version %d", ErrUnknownPayloadVersion, kind, version)
		}
		return nil, nil
	case EventRoomTerminated:
		if version != roomTerminatedPayloadVersion {
			return nil, fmt.Errorf("%w: kind %q version %d", ErrUnknownPayloadVersion, kind, version)
		}
		var w wireRoomTerminatedPayload
		if err := json.Unmarshal(raw, &w); err != nil {
			return nil, fmt.Errorf("%w: kind %q: %w", ErrMalformedEventPayload, kind, err)
		}
		return RoomTerminatedPayload{State: State(w.State)}, nil
	case EventDeliveryFailed:
		if version != deliveryFailedPayloadVersion {
			return nil, fmt.Errorf("%w: kind %q version %d", ErrUnknownPayloadVersion, kind, version)
		}
		var w wireDeliveryFailedPayload
		if err := json.Unmarshal(raw, &w); err != nil {
			return nil, fmt.Errorf("%w: kind %q: %w", ErrMalformedEventPayload, kind, err)
		}
		return DeliveryFailedPayload(w), nil
	case EventMessageDelivered:
		if version != messageDeliveredPayloadVersion {
			return nil, fmt.Errorf("%w: kind %q version %d", ErrUnknownPayloadVersion, kind, version)
		}
		var w wireMessageDeliveredPayload
		if err := json.Unmarshal(raw, &w); err != nil {
			return nil, fmt.Errorf("%w: kind %q: %w", ErrMalformedEventPayload, kind, err)
		}
		return MessageDeliveredPayload(w), nil
	default:
		return nil, fmt.Errorf("%w: %q", ErrUnknownEventKind, kind)
	}
}

// DecodeEventLog decodes a room's persisted event log from its stored
// representation, in sequence order. A record a newer process wrote — an
// unrecognized kind, an unrecognized payload_version for a kind this build
// does know, or a payload that fails to parse — is skipped with a logged
// warning instead of failing the whole replay, so a mixed-version rolling
// restart degrades to "this room's history is missing one entry" rather than
// "this room does not load."
func DecodeEventLog(logger *slog.Logger, records [][]byte) []*Event {
	events := make([]*Event, 0, len(records))
	for i, data := range records {
		ev, err := UnmarshalEvent(data)
		if err != nil {
			logger.Warn("room: skipping event that failed to decode", "index", i, "error", err)
			continue
		}
		events = append(events, ev)
	}
	return events
}
