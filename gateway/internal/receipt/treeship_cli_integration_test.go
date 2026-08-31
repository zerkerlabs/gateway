package receipt

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestE2EAgainstRealTreeshipBinary exercises the emitter against a real
// treeship binary, proving the CLI contract this package depends on -- flag
// names, --format json's shape, and the "ok" status -- is the contract the
// installed CLI actually honors. Every other test in this package fakes the
// runner, so nothing else would notice if that contract drifted.
//
// Skipped unless ZERKER_TREESHIP_BIN is set, so CI spawns no processes and
// needs no Treeship keystore. It signs a real artifact into the local store
// when it does run.
func TestE2EAgainstRealTreeshipBinary(t *testing.T) {
	bin := os.Getenv("ZERKER_TREESHIP_BIN")
	if bin == "" {
		t.Skip("ZERKER_TREESHIP_BIN unset")
	}
	e := NewTreeshipCLIEmitter(bin, "agent://zerker-gateway", nil)
	r := Receipt{
		InvocationID:   "inv_e2e_probe",
		TenantID:       "tnt_e2e",
		AgentID:        "agt_e2e",
		Mode:           "transactional",
		Status:         "succeeded",
		UpstreamStatus: intPtr(200),
		LatencyMS:      i64Ptr(17),
		CompletedAt:    time.Now().UTC(),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := e.Emit(ctx, r); err != nil {
		t.Fatalf("Emit against the real binary failed: %v", err)
	}
	t.Logf("attested: %v", e.Args(r))
}
