// Package room defines the Room domain model — Room, Member, Message, and
// Event — and the Store interface that persists them. MemoryStore is the
// in-memory implementation.
//
// A room is a durable, membership-scoped space where two or more agents cowork
// a single task. Rooms are single-tenant: every member of a room belongs to the
// same tenant as the room. Cross-tenant rooms are out of scope (a larger
// identity/consent problem), so every store method scopes reads and mutations
// to a tenant and never lets a caller distinguish "belongs to another tenant"
// from "does not exist" (AGENTS.md invariant #2).
//
// A room's history is an append-only event log: every membership change,
// message, and lifecycle transition is appended as an Event, in order. The
// room's transcript is a replay of that log rather than a second structure
// kept in sync with it. A room also carries a turn budget: posting a message
// consumes one turn, and exceeding the budget abandons the room rather than
// letting agents loop indefinitely.
package room

import (
	"errors"
	"time"
)

// State is the lifecycle state of a room.
type State string

const (
	// StateOpen is the initial state: the room is active and accepting
	// members and messages.
	StateOpen State = "open"
	// StateCompleted is a terminal state: the room's goal was met.
	StateCompleted State = "completed"
	// StateAbandoned is a terminal state: the room was given up on.
	StateAbandoned State = "abandoned"
)

// ErrNotFound is returned when a room ID does not exist within the caller's
// tenant. Callers must never distinguish "doesn't exist" from "exists but not
// yours" — both cases return this error so existence is never confirmed across
// tenants (invariant #2, AGENTS.md).
var ErrNotFound = errors.New("room not found")

// ErrTenantMismatch is returned when adding a member whose tenant differs from
// the room's tenant. Rooms are single-tenant: every member must belong to the
// same tenant as the room it joins.
var ErrTenantMismatch = errors.New("member tenant does not match room tenant")

// ErrMemberNotFound is returned when an operation names a member that is not
// seated in the room it targets, so a message can never be attributed to a
// member who was never there.
var ErrMemberNotFound = errors.New("member not found in room")

// ErrRoomTerminated is returned when a caller tries to append to a room that
// has already reached a terminal state (StateCompleted or StateAbandoned).
var ErrRoomTerminated = errors.New("room is terminated")

// ErrTurnBudgetExceeded is returned when posting a message would consume more
// turns than a room's budget allows. The message is rejected and the room
// transitions to StateAbandoned as part of the same call.
var ErrTurnBudgetExceeded = errors.New("room turn budget exceeded")

// ErrTurnReserved is returned when a room's remaining turns are all reserved
// by deliveries still in flight (see Store.ReserveTurn). It is distinct from
// ErrTurnBudgetExceeded because the budget is not actually spent yet: a
// reservation may still be released unspent, so the room is not abandoned and
// the caller may retry once the in-flight delivery resolves.
var ErrTurnReserved = errors.New("room turns are reserved by a delivery in flight")

// ErrReservationNotHeld is returned when committing or releasing a turn
// reservation that is no longer outstanding, because it was already committed
// or released. Resolving one twice would either double-record a message or
// hand back a turn that is not held.
var ErrReservationNotHeld = errors.New("turn reservation is not outstanding")

// ErrAlreadyMember is returned when adding an agent to a room it is already
// seated in.
var ErrAlreadyMember = errors.New("agent is already a member of this room")

// DefaultTurnBudget is the turn budget assigned to a room created without an
// explicit one. It bounds how many message-posting turns a room's members may
// spend before the room is abandoned rather than left to loop indefinitely.
const DefaultTurnBudget = 50

// Room is the canonical record for a room.
type Room struct {
	ID         string
	TenantID   string
	Goal       string
	State      State
	CreatedAt  time.Time
	Members    []*Member
	TurnBudget int
	Events     []*Event
}

// Member is an agent seated in a room.
type Member struct {
	ID       string
	AgentID  string // the agt_-prefixed gateway agent this member represents
	JoinedAt time.Time
	// AdmittedMemory is the room-scoped memory a governed memory backend
	// admitted for this member on join (rooms/internal/memory). It has
	// passed policy — every entry is something the backend was willing to
	// hand back for this agent, for this task, at this moment. It holds real
	// content only while ContextReplayable is true.
	AdmittedMemory []string
	// CallerDocuments is the onboarding material supplied directly on the
	// add-member request. It is ungoverned input — nothing has reviewed or
	// admitted it — and is kept separate from AdmittedMemory for exactly
	// that reason: nothing downstream can tell a policy-approved memory
	// entry from an unreviewed caller document unless they arrive as
	// distinct fields. It holds real content only while ContextReplayable is
	// true.
	CallerDocuments []string
	// Context is the commitment recorded for this member's onboarding — see
	// ContextCommitment. It is always populated, even for a member who
	// joined with no admitted memory: a zero Admitted count is how "joined
	// with genuinely no context" is told apart from "context not replayable"
	// below.
	Context ContextCommitment
	// ContextReplayable reports whether AdmittedMemory and CallerDocuments
	// hold this member's actual onboarding content. It is true for a live,
	// in-process member — one AddMember just returned, in the same process —
	// and false for a member reconstructed by replaying a persisted event
	// log, whose member_joined event never stored that content, only
	// Context above. A false value paired with empty AdmittedMemory and
	// CallerDocuments must never be read as "this member had no onboarding
	// context" — check Context.Admitted instead.
	ContextReplayable bool
}

// ContextCommitment is what a persisted member_joined event records about a
// member's onboarding context in place of the context content itself: a
// memory backend's commitment digest over what it admitted, the outcome
// state its PrepareContext call returned, and the admitted/withheld/dropped
// counts (rooms/internal/memory). It is enough to prove what a member was
// onboarded with, and to re-derive it from the memory backend later, without
// Rooms holding a durable copy of governed memory content it does not own.
//
// The zero value records a member with no governed-memory commitment at all
// — every AddMember caller that has none to give (most tests, and any agent
// added before onboarding is wired up to a real memory backend) passes it.
type ContextCommitment struct {
	// Digest is the memory backend's commitment digest, opaque to Rooms.
	Digest string
	// State is the memory backend's PrepareContext outcome for this member
	// (e.g. "ready", "partial", "empty" — memory.State), carried as a plain
	// string so this package's persisted format does not depend on the
	// memory package's type.
	State string
	// Retrieved, Admitted, Withheld, and BudgetDropped mirror memory.Counts:
	// how many entries the backend considered before applying policy or
	// budget, how many ended up in AdmittedMemory, and how many did not,
	// partitioned by why.
	Retrieved     int
	Admitted      int
	Withheld      int
	BudgetDropped int
	// Reasons mirrors memory.Omissions.Reasons: the bounded, deduplicated
	// set of reasons memory was withheld or dropped for budget. Like
	// Omissions.Reasons, it never carries a per-memory identifier or an
	// internal policy rule name.
	Reasons []string
}

// Message is one member's contribution to a room.
type Message struct {
	ID       string
	MemberID string // the Member that authored this message
	// ToMemberID is the Member this message was addressed to, empty when it
	// was posted to the room at large. An addressed message is one that was
	// delivered as a proxied call to that member's agent before being
	// recorded, so carrying the recipient here lets a transcript reader see
	// who a message was for without cross-referencing the event log.
	ToMemberID string
	Body       string
	CreatedAt  time.Time
}

// EventKind identifies the kind of a room Event.
type EventKind string

const (
	// EventMemberJoined records that an agent was seated in the room.
	EventMemberJoined EventKind = "member_joined"
	// EventMessagePosted records a member's message.
	EventMessagePosted EventKind = "message_posted"
	// EventTaskStateChanged records a transition in the room's shared task
	// state. Reserved for the shared task-state feature; no store method
	// emits it yet.
	EventTaskStateChanged EventKind = "task_state_changed"
	// EventRoomTerminated records the room reaching a terminal state.
	EventRoomTerminated EventKind = "room_terminated"
	// EventDeliveryFailed records that a message addressed to another member
	// could not be delivered as a proxied call to that member's agent (the
	// gateway rejected the call or failed to reach it). No EventMessagePosted
	// event is appended for a message that failed delivery, so a failed call
	// can never be mistaken for one that reached its recipient.
	EventDeliveryFailed EventKind = "delivery_failed"
	// EventMessageDelivered records that a message addressed to another member
	// was confirmed delivered as a proxied call to that member's agent. It
	// carries the gateway's invocation ID so a room's history can be
	// reconciled against the gateway's own invocation record.
	EventMessageDelivered EventKind = "message_delivered"
)

// Event is one entry in a room's append-only log. Every membership change,
// message, and lifecycle transition is appended as an Event, in the order it
// happened; a room's transcript is a replay of this log rather than a second
// structure kept in sync with it.
type Event struct {
	Sequence  int // contiguous, starting at 1, per room
	Kind      EventKind
	Timestamp time.Time
	Payload   any
}

// MemberJoinedPayload is the Payload of an EventMemberJoined event.
//
// Its persisted wire form (event_codec.go) deliberately omits
// Member.AdmittedMemory and Member.CallerDocuments: onboarding content is
// either governed memory-backend material Rooms does not own a durable copy
// of, or ungoverned caller input Rooms does not persist either. What
// survives to storage is Member.Context — a commitment digest, counts, and
// backend state — never the content itself.
type MemberJoinedPayload struct {
	Member *Member
}

// MessagePostedPayload is the Payload of an EventMessagePosted event.
type MessagePostedPayload struct {
	Message *Message
}

// RoomTerminatedPayload is the Payload of an EventRoomTerminated event,
// recording which terminal state the room reached.
type RoomTerminatedPayload struct {
	State State
}

// MessageDeliveredPayload is the Payload of an EventMessageDelivered event.
type MessageDeliveredPayload struct {
	FromMemberID string
	ToMemberID   string
	ToAgentID    string
	// InvocationID is the gateway's identifier for the proxied call, the join
	// key between this room's history and the gateway's invocation record.
	InvocationID string
}

// DeliveryFailedPayload is the Payload of an EventDeliveryFailed event. Class
// is the classified outcome (e.g. "caller_error" or "upstream_failure") — the
// raw upstream response is never recorded here (AGENTS.md invariant #3).
type DeliveryFailedPayload struct {
	FromMemberID string
	ToMemberID   string
	ToAgentID    string
	Class        string
}
