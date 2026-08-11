//go:build integration

package memory_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"

	"github.com/zerkerlabs/gateway/rooms/internal/memory"
	"github.com/zerkerlabs/gateway/rooms/internal/memory/memorytest"
)

// ciMarkerEnv is set by GitHub Actions (and most other CI providers) on
// every job. Its presence is how this test tells "a human ran `go test
// -tags=integration` on a laptop with no backend handy, skip" apart from "CI
// ran this job and the backend it is supposed to have started is missing" —
// the latter must fail loudly, not skip, or a broken CI step silently stops
// proving anything and nobody notices.
const ciMarkerEnv = "CI"

// TestZMemClient_Contract_Integration runs the full contract suite against
// a real backend, per the acceptance criterion that ZMemClient must pass
// memorytest.RunContract unchanged against one. It requires:
//
//   - ZMEM_TEST_BASE_URL — the backend's base URL, e.g. http://127.0.0.1:8766
//   - ZMEM_TEST_SERVICE_TOKEN — the bearer service token it accepts
//   - ZMEM_TEST_TENANT_ID — the tenant the backend is configured to serve
//
// Locally, it skips when any of them is unset, the same way the room
// package's Postgres integration tests skip without TEST_DATABASE_URL. In
// CI it fails instead: the integration job always starts a backend and sets
// these, so a missing one there means the job is broken, not that no
// backend is available — and a broken step that only produces a skip is
// indistinguishable from a green run.
func TestZMemClient_Contract_Integration(t *testing.T) {
	baseURL := os.Getenv("ZMEM_TEST_BASE_URL")
	token := os.Getenv("ZMEM_TEST_SERVICE_TOKEN")
	tenantID := os.Getenv("ZMEM_TEST_TENANT_ID")
	if baseURL == "" || token == "" || tenantID == "" {
		msg := "ZMEM_TEST_BASE_URL, ZMEM_TEST_SERVICE_TOKEN, and ZMEM_TEST_TENANT_ID not all set"
		if os.Getenv(ciMarkerEnv) != "" {
			t.Fatalf("%s, but %s is set — the integration job must start a backend and provide these", msg, ciMarkerEnv)
		}
		t.Skip(msg + "; skipping integration test")
	}

	// RunContract's subtests share a small, fixed set of room IDs (e.g.
	// "rom_1") across many independent t.Run blocks, run with t.Parallel().
	// memory.Fake makes that safe because NewFake() gives every newStore()
	// call its own isolated map. A real backend process has no such
	// per-call isolation — every client here talks to the same tenant-local
	// deployment — so without help every subtest would collide on the same
	// underlying room. newScopedStore restores the "fresh store per
	// newStore() call" property by namespacing room IDs and write keys with
	// a prefix unique to this call, so two stores behave as independent as
	// the fake's, on top of one shared real backend.
	memorytest.RunContract(t, func() memory.Store {
		c, err := memory.NewZMemClient(memory.ZMemConfig{
			BaseURL: baseURL, ServiceToken: token, TenantID: tenantID,
		}, nil)
		if err != nil {
			t.Fatalf("NewZMemClient: %v", err)
		}
		return newScopedStore(c)
	})
}

// scopedStore wraps a Store and namespaces every RoomID, SourceEventID, and
// IdempotencyKey it sees with a prefix fixed at construction. See
// TestZMemClient_Contract_Integration for why this exists: it gives a
// client pointed at a real, shared backend process the same "independent
// store per newStore() call" behaviour memory.Fake gets for free.
type scopedStore struct {
	memory.Store
	prefix string
}

// newScopedStore wraps inner with a prefix random enough that two calls
// never collide, even across parallel subtests in the same run.
func newScopedStore(inner memory.Store) memory.Store {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("memory: crypto/rand unavailable: " + err.Error())
	}
	return &scopedStore{Store: inner, prefix: hex.EncodeToString(b[:])}
}

func (s *scopedStore) scope(id string) string {
	if id == "" {
		return id
	}
	return s.prefix + "/" + id
}

func (s *scopedStore) PrepareContext(ctx context.Context, req memory.PrepareRequest) (memory.ContextResult, error) {
	req.RoomID = s.scope(req.RoomID)
	return s.Store.PrepareContext(ctx, req)
}

func (s *scopedStore) Propose(ctx context.Context, req memory.ProposeRequest) (memory.WriteResult, error) {
	req.RoomID = s.scope(req.RoomID)
	req.SourceEventID = s.scope(req.SourceEventID)
	req.IdempotencyKey = s.scope(req.IdempotencyKey)
	return s.Store.Propose(ctx, req)
}

func (s *scopedStore) Record(ctx context.Context, req memory.RecordRequest) (memory.WriteResult, error) {
	req.RoomID = s.scope(req.RoomID)
	req.SourceEventID = s.scope(req.SourceEventID)
	req.IdempotencyKey = s.scope(req.IdempotencyKey)
	return s.Store.Record(ctx, req)
}
