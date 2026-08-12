package httpapi

import (
	"regexp"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/rooms/internal/room"
)

var digestFormat = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func TestMembershipDigestDeterministic(t *testing.T) {
	t.Parallel()

	members := []*room.Member{
		{AgentID: "agt_b"},
		{AgentID: "agt_a"},
		{AgentID: "agt_c"},
	}

	got1 := membershipDigest(members)
	got2 := membershipDigest(members)
	if got1 != got2 {
		t.Fatalf("membershipDigest is not deterministic: %q != %q", got1, got2)
	}
	if !digestFormat.MatchString(got1) {
		t.Errorf("membershipDigest = %q, want sha256:<64 hex>", got1)
	}

	// Same set, different underlying slice order, must produce the same digest.
	reordered := []*room.Member{members[2], members[0], members[1]}
	if got := membershipDigest(reordered); got != got1 {
		t.Errorf("membershipDigest changed with member order: %q != %q", got, got1)
	}
}

func TestMembershipDigestChangesWithMembership(t *testing.T) {
	t.Parallel()

	before := membershipDigest([]*room.Member{{AgentID: "agt_a"}})
	after := membershipDigest([]*room.Member{{AgentID: "agt_a"}, {AgentID: "agt_b"}})
	if before == after {
		t.Errorf("membershipDigest did not change after adding a member: %q", before)
	}
}

func TestRoomStateDigestDeterministic(t *testing.T) {
	t.Parallel()

	r := &room.Room{
		State: room.StateOpen,
		Events: []*room.Event{
			{Sequence: 1, Kind: room.EventMemberJoined, Timestamp: time.Unix(0, 0)},
		},
	}

	got1 := roomStateDigest(r)
	got2 := roomStateDigest(r)
	if got1 != got2 {
		t.Fatalf("roomStateDigest is not deterministic: %q != %q", got1, got2)
	}
	if !digestFormat.MatchString(got1) {
		t.Errorf("roomStateDigest = %q, want sha256:<64 hex>", got1)
	}
}

func TestRoomStateDigestChangesWithEvents(t *testing.T) {
	t.Parallel()

	r := &room.Room{
		State: room.StateOpen,
		Events: []*room.Event{
			{Sequence: 1, Kind: room.EventMemberJoined},
		},
	}
	before := roomStateDigest(r)

	r.Events = append(r.Events, &room.Event{Sequence: 2, Kind: room.EventMessagePosted})
	after := roomStateDigest(r)

	if before == after {
		t.Errorf("roomStateDigest did not change after appending an event: %q", before)
	}
}

func TestRoomStateDigestEmptyRoom(t *testing.T) {
	t.Parallel()

	got := roomStateDigest(&room.Room{State: room.StateOpen})
	if !digestFormat.MatchString(got) {
		t.Errorf("roomStateDigest = %q, want sha256:<64 hex>", got)
	}
}
