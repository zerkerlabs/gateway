//go:build integration

package memory_test

import (
	"os"
	"testing"

	"github.com/zerkerlabs/gateway/rooms/internal/memory"
	"github.com/zerkerlabs/gateway/rooms/internal/memory/memorytest"
)

// TestZMemClient_Contract_Integration runs the full contract suite against
// a real backend, per the acceptance criterion that ZMemClient must pass
// memorytest.RunContract unchanged against one. It requires:
//
//   - ZMEM_TEST_BASE_URL — the backend's base URL, e.g. http://127.0.0.1:8766
//   - ZMEM_TEST_SERVICE_TOKEN — the bearer service token it accepts
//   - ZMEM_TEST_TENANT_ID — the tenant the backend is configured to serve
//
// and is skipped when any of them is unset, the same way the room package's
// Postgres integration tests skip without TEST_DATABASE_URL — this suite is
// not run by `make check`, only by `make integration-test` against a
// deployment set up for it.
//
// A fresh room ID is used per subtest via RunContract's own newStore
// contract (each call gets a fresh logical store), but a real backend has
// no notion of "a fresh backend instance" the way the in-process fake does:
// two calls to newStore here return clients pointed at the SAME backend, so
// this suite's cross-tenant isolation case is only meaningful when
// ZMEM_TEST_BASE_URL points at a backend with nothing else recorded — run
// it against a disposable instance, not a shared one.
func TestZMemClient_Contract_Integration(t *testing.T) {
	baseURL := os.Getenv("ZMEM_TEST_BASE_URL")
	token := os.Getenv("ZMEM_TEST_SERVICE_TOKEN")
	tenantID := os.Getenv("ZMEM_TEST_TENANT_ID")
	if baseURL == "" || token == "" || tenantID == "" {
		t.Skip("ZMEM_TEST_BASE_URL, ZMEM_TEST_SERVICE_TOKEN, and ZMEM_TEST_TENANT_ID not all set; skipping integration test")
	}

	memorytest.RunContract(t, func() memory.Store {
		c, err := memory.NewZMemClient(memory.ZMemConfig{
			BaseURL: baseURL, ServiceToken: token, TenantID: tenantID,
		}, nil)
		if err != nil {
			t.Fatalf("NewZMemClient: %v", err)
		}
		return c
	})
}
