package httpapi

import "testing"

func TestProposeIdempotencyKeyDeterministic(t *testing.T) {
	t.Parallel()

	got1 := proposeIdempotencyKey("rom_1", "msg_1")
	got2 := proposeIdempotencyKey("rom_1", "msg_1")
	if got1 != got2 {
		t.Fatalf("proposeIdempotencyKey is not deterministic: %q != %q", got1, got2)
	}
	if got1 == "" {
		t.Fatal("proposeIdempotencyKey returned an empty key")
	}
}

func TestProposeIdempotencyKeyDiffersByMessage(t *testing.T) {
	t.Parallel()

	a := proposeIdempotencyKey("rom_1", "msg_1")
	b := proposeIdempotencyKey("rom_1", "msg_2")
	if a == b {
		t.Errorf("proposeIdempotencyKey(rom_1, msg_1) == proposeIdempotencyKey(rom_1, msg_2): %q", a)
	}
}

func TestProposeIdempotencyKeyDiffersByRoom(t *testing.T) {
	t.Parallel()

	a := proposeIdempotencyKey("rom_1", "msg_1")
	b := proposeIdempotencyKey("rom_2", "msg_1")
	if a == b {
		t.Errorf("proposeIdempotencyKey(rom_1, msg_1) == proposeIdempotencyKey(rom_2, msg_1): %q", a)
	}
}
