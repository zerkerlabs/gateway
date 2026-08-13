package room_test

import (
	"context"
	"testing"

	"github.com/zerkerlabs/gateway/rooms/internal/room"
	"github.com/zerkerlabs/gateway/rooms/internal/room/roomtest"
)

func TestMemoryStore_Contract(t *testing.T) {
	t.Parallel()

	roomtest.RunContract(t, func(t *testing.T) room.Store {
		return room.NewMemoryStore()
	})
}

// TestMemoryStore_StoredOnboardingContentIsNotAliased is MemoryStore's half of
// a guarantee the shared contract cannot make.
//
// AddMember must defensively copy the admitted-memory and caller-document
// slices into the member it STORES, not just into the one it returns — the
// returned member is cloned on the way out, so a test that only inspects it
// passes whether or not the stored copy was made.
//
// This cannot live in roomtest.RunContract because observing it requires
// reading the content back, and a durable store deliberately does not keep it:
// the persisted member_joined payload is the commitment digest plus counts,
// never the content, so nothing the memory policy withheld can outlive that
// policy in a room's own tables. PostgresStore's corresponding claim — that a
// reload reproduces the commitment and marks the member's context not
// replayable, so it stays distinguishable from a member that genuinely had
// none — is asserted in its own test.
func TestMemoryStore_StoredOnboardingContentIsNotAliased(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	s := room.NewMemoryStore()

	r, err := s.CreateRoom(ctx, "tenant-alpha", "goal")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}

	admittedMemory := []string{"memory entry"}
	callerDocuments := []string{"onboarding doc"}
	if _, err := s.AddMember(ctx, "tenant-alpha", r.ID, "agt_1", "tenant-alpha",
		admittedMemory, callerDocuments, room.ContextCommitment{}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	admittedMemory[0] = "mutated"
	callerDocuments[0] = "mutated"

	got, err := s.GetRoom(ctx, "tenant-alpha", r.ID)
	if err != nil {
		t.Fatalf("GetRoom: %v", err)
	}
	if len(got.Members) != 1 {
		t.Fatalf("Members = %v, want one", got.Members)
	}
	if got.Members[0].AdmittedMemory[0] != "memory entry" {
		t.Errorf("stored AdmittedMemory[0] = %q, want %q (caller mutation leaked into the store)",
			got.Members[0].AdmittedMemory[0], "memory entry")
	}
	if got.Members[0].CallerDocuments[0] != "onboarding doc" {
		t.Errorf("stored CallerDocuments[0] = %q, want %q (caller mutation leaked into the store)",
			got.Members[0].CallerDocuments[0], "onboarding doc")
	}
}
