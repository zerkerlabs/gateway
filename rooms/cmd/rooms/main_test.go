package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/rooms/internal/auth/authtest"
	"github.com/zerkerlabs/gateway/rooms/internal/memory"
	"github.com/zerkerlabs/gateway/rooms/internal/room"
)

func TestOperationalRoutes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		method   string
		path     string
		wantCode int
		wantKeys []string
	}{
		{"healthz reports ok", http.MethodGet, "/healthz", http.StatusOK, []string{"status"}},
		{"version reports build metadata", http.MethodGet, "/version", http.StatusOK, []string{"version", "commit"}},
		{"unknown route is 404", http.MethodGet, "/nope", http.StatusNotFound, nil},
		{"healthz rejects POST", http.MethodPost, "/healthz", http.StatusMethodNotAllowed, nil},
	}

	// The operational route tests never exercise message delivery or memory
	// onboarding, so a nil gateway client (never called) and a fresh fake
	// memory store are fine here — the real client is exercised by the
	// memory package's own tests and the integration suite.
	mux, _ := newMux(slog.New(slog.NewTextHandler(io.Discard, nil)), room.NewMemoryStore(), nil, memory.NewFake(), memory.ContextPolicy{Risk: "medium", ContextBudgetTokens: 2_000})
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(tt.method, tt.path, nil))

			if rec.Code != tt.wantCode {
				t.Fatalf("status = %d, want %d", rec.Code, tt.wantCode)
			}
			if len(tt.wantKeys) == 0 {
				return
			}

			var body map[string]string
			if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			for _, k := range tt.wantKeys {
				if body[k] == "" {
					t.Errorf("body[%q] is empty, want a value", k)
				}
			}
		})
	}
}

// The room routes are only protected if the middleware is actually wired into
// what the server serves. Handler and middleware tests both pass with a
// perfectly good auth package that main.go never calls, so this exercises the
// composed handler: an unauthenticated room request must be refused, while the
// operational routes stay reachable.
func TestHandlerRequiresBearerTokenForRoomRoutes(t *testing.T) {
	oidc := authtest.New()
	t.Cleanup(oidc.Close)

	const (
		audience    = "rooms-test-audience"
		tenantClaim = "org_id"
	)

	t.Setenv("ROOMS_OIDC_ISSUER", oidc.URL)
	t.Setenv("ROOMS_OIDC_AUDIENCE", audience)
	t.Setenv("ROOMS_OIDC_TENANT_CLAIM", tenantClaim)

	// Nil gateway client: no test here posts an addressed message, the only
	// path that calls it.
	handler, _, err := newHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), room.NewMemoryStore(), nil, memory.NewFake(), memory.ContextPolicy{Risk: "medium", ContextBudgetTokens: 2_000})
	if err != nil {
		t.Fatalf("newHandler: %v", err)
	}

	token, err := oidc.Mint(oidc.Claims(audience, tenantClaim, "tenant-alpha", "sub", "user-xyz"))
	if err != nil {
		t.Fatalf("mint token: %v", err)
	}

	tests := []struct {
		name     string
		method   string
		path     string
		token    string
		wantCode int
	}{
		{"room route without a token is refused", http.MethodPost, "/v1/rooms", "", http.StatusUnauthorized},
		{"room route with a garbage token is refused", http.MethodPost, "/v1/rooms", "notavalidjwt", http.StatusUnauthorized},
		{"room route with a valid token reaches the handler", http.MethodPost, "/v1/rooms", token, http.StatusBadRequest},
		{"healthz stays open", http.MethodGet, "/healthz", "", http.StatusOK},
		{"version stays open", http.MethodGet, "/version", "", http.StatusOK},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			if tt.token != "" {
				req.Header.Set("Authorization", "Bearer "+tt.token)
			}

			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			// The valid-token case sends no body, so 400 from the handler is
			// the tell that authentication passed and the request got through.
			if rec.Code != tt.wantCode {
				t.Errorf("status = %d, want %d", rec.Code, tt.wantCode)
			}
		})
	}
}

// Rooms must not start without authentication configured: an operator who
// forgets the OIDC variables gets a failed start, never an open server.
func TestNewHandlerFailsWithoutOIDCConfig(t *testing.T) {
	t.Setenv("ROOMS_OIDC_ISSUER", "")
	t.Setenv("ROOMS_OIDC_AUDIENCE", "")

	if _, _, err := newHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), room.NewMemoryStore(), nil, memory.NewFake(), memory.ContextPolicy{Risk: "medium", ContextBudgetTokens: 2_000}); err == nil {
		t.Fatal("newHandler with no OIDC config: want error, got nil")
	}
}

// TestZmemDeploymentFromEnv covers the required fields, the documented
// defaults, and the failure modes an operator can hit: a missing base URL,
// a missing token (by either form), a missing tenant, and an out-of-range or
// unrecognized value for the two policy inputs.
func TestZmemDeploymentFromEnv(t *testing.T) {
	base := map[string]string{
		"ROOMS_ZMEM_BASE_URL":      "http://127.0.0.1:8766",
		"ROOMS_ZMEM_SERVICE_TOKEN": "s3cr3t",
		"ROOMS_ZMEM_TENANT_ID":     "tnt_123",
	}

	t.Run("required fields with documented defaults", func(t *testing.T) {
		for k, v := range base {
			t.Setenv(k, v)
		}
		t.Setenv("ROOMS_ZMEM_SERVICE_TOKEN_FILE", "")
		got, err := zmemDeploymentFromEnv()
		if err != nil {
			t.Fatalf("zmemDeploymentFromEnv: %v", err)
		}
		want := zmemDeployment{
			BaseURL:             "http://127.0.0.1:8766",
			ServiceToken:        "s3cr3t",
			TenantID:            "tnt_123",
			Timeout:             memory.DefaultTimeout,
			ContextBudgetTokens: defaultContextBudgetTokens,
			Risk:                defaultRisk,
		}
		if got != want {
			t.Errorf("zmemDeploymentFromEnv() = %+v, want %+v", got, want)
		}
	})

	t.Run("service token from a file, not the environment", func(t *testing.T) {
		for k, v := range base {
			t.Setenv(k, v)
		}
		t.Setenv("ROOMS_ZMEM_SERVICE_TOKEN", "")
		path := filepath.Join(t.TempDir(), "token")
		if err := os.WriteFile(path, []byte("file-token\n"), 0o600); err != nil {
			t.Fatalf("write token file: %v", err)
		}
		t.Setenv("ROOMS_ZMEM_SERVICE_TOKEN_FILE", path)

		got, err := zmemDeploymentFromEnv()
		if err != nil {
			t.Fatalf("zmemDeploymentFromEnv: %v", err)
		}
		if got.ServiceToken != "file-token" {
			t.Errorf("ServiceToken = %q, want %q (trimmed file contents)", got.ServiceToken, "file-token")
		}
	})

	t.Run("overriding timeout, budget, and risk", func(t *testing.T) {
		for k, v := range base {
			t.Setenv(k, v)
		}
		t.Setenv("ROOMS_ZMEM_SERVICE_TOKEN_FILE", "")
		t.Setenv("ROOMS_ZMEM_TIMEOUT", "500ms")
		t.Setenv("ROOMS_ZMEM_CONTEXT_BUDGET_TOKENS", "8000")
		t.Setenv("ROOMS_ZMEM_RISK", "high")

		got, err := zmemDeploymentFromEnv()
		if err != nil {
			t.Fatalf("zmemDeploymentFromEnv: %v", err)
		}
		if got.Timeout != 500*time.Millisecond {
			t.Errorf("Timeout = %v, want 500ms", got.Timeout)
		}
		if got.ContextBudgetTokens != 8000 {
			t.Errorf("ContextBudgetTokens = %d, want 8000", got.ContextBudgetTokens)
		}
		if got.Risk != "high" {
			t.Errorf("Risk = %q, want %q", got.Risk, "high")
		}
	})

	failureCases := []struct {
		name    string
		mutate  func(env map[string]string)
		wantErr string
	}{
		{
			name:    "missing base URL",
			mutate:  func(env map[string]string) { delete(env, "ROOMS_ZMEM_BASE_URL") },
			wantErr: "ROOMS_ZMEM_BASE_URL is required",
		},
		{
			name:    "missing token",
			mutate:  func(env map[string]string) { delete(env, "ROOMS_ZMEM_SERVICE_TOKEN") },
			wantErr: "ROOMS_ZMEM_SERVICE_TOKEN or ROOMS_ZMEM_SERVICE_TOKEN_FILE is required",
		},
		{
			name:    "missing tenant",
			mutate:  func(env map[string]string) { delete(env, "ROOMS_ZMEM_TENANT_ID") },
			wantErr: "ROOMS_ZMEM_TENANT_ID is required",
		},
	}
	for _, tt := range failureCases {
		t.Run(tt.name, func(t *testing.T) {
			env := make(map[string]string, len(base))
			for k, v := range base {
				env[k] = v
			}
			tt.mutate(env)
			for k, v := range env {
				t.Setenv(k, v)
			}
			t.Setenv("ROOMS_ZMEM_SERVICE_TOKEN_FILE", "")

			_, err := zmemDeploymentFromEnv()
			if err == nil || err.Error() != tt.wantErr {
				t.Fatalf("zmemDeploymentFromEnv() err = %v, want %q", err, tt.wantErr)
			}
		})
	}

	invalidValueCases := []struct {
		name string
		key  string
		val  string
	}{
		{"malformed timeout", "ROOMS_ZMEM_TIMEOUT", "not-a-duration"},
		{"non-numeric budget", "ROOMS_ZMEM_CONTEXT_BUDGET_TOKENS", "lots"},
		{"zero budget", "ROOMS_ZMEM_CONTEXT_BUDGET_TOKENS", "0"},
		{"budget above the backend's cap", "ROOMS_ZMEM_CONTEXT_BUDGET_TOKENS", "64001"},
		{"unrecognized risk", "ROOMS_ZMEM_RISK", "extreme"},
	}
	for _, tt := range invalidValueCases {
		t.Run(tt.name, func(t *testing.T) {
			for k, v := range base {
				t.Setenv(k, v)
			}
			t.Setenv("ROOMS_ZMEM_SERVICE_TOKEN_FILE", "")
			t.Setenv(tt.key, tt.val)

			if _, err := zmemDeploymentFromEnv(); err == nil {
				t.Fatalf("zmemDeploymentFromEnv() with %s=%q: want an error, got nil", tt.key, tt.val)
			}
		})
	}
}

// TestReadSecret covers the plain-value form, the file form, the file form
// taking precedence being irrelevant when only one is set, a missing file
// erroring rather than silently returning empty, and both unset returning
// "" with no error.
func TestReadSecret(t *testing.T) {
	t.Run("plain environment variable", func(t *testing.T) {
		t.Setenv("ROOMS_TEST_SECRET", "direct-value")
		got, err := readSecret("ROOMS_TEST_SECRET")
		if err != nil {
			t.Fatalf("readSecret: %v", err)
		}
		if got != "direct-value" {
			t.Errorf("readSecret() = %q, want %q", got, "direct-value")
		}
	})

	t.Run("file, trimmed", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "secret")
		if err := os.WriteFile(path, []byte("  file-value\n"), 0o600); err != nil {
			t.Fatalf("write secret file: %v", err)
		}
		t.Setenv("ROOMS_TEST_SECRET_FILE", path)
		got, err := readSecret("ROOMS_TEST_SECRET")
		if err != nil {
			t.Fatalf("readSecret: %v", err)
		}
		if got != "file-value" {
			t.Errorf("readSecret() = %q, want %q", got, "file-value")
		}
	})

	t.Run("neither set returns empty, no error", func(t *testing.T) {
		got, err := readSecret("ROOMS_TEST_SECRET")
		if err != nil {
			t.Fatalf("readSecret: %v", err)
		}
		if got != "" {
			t.Errorf("readSecret() = %q, want empty", got)
		}
	})

	t.Run("file set but unreadable errors rather than returning empty", func(t *testing.T) {
		t.Setenv("ROOMS_TEST_SECRET_FILE", filepath.Join(t.TempDir(), "does-not-exist"))
		if _, err := readSecret("ROOMS_TEST_SECRET"); err == nil {
			t.Fatal("readSecret() with an unreadable file: want an error, got nil")
		}
	})
}

// The operational routes must not leak configuration. /version reports build
// metadata and nothing else, so a listen address or env value can never appear
// there by accident as the service grows (AGENTS.md invariant #9).
func TestVersionExposesOnlyBuildMetadata(t *testing.T) {
	t.Parallel()

	mux, _ := newMux(slog.New(slog.NewTextHandler(io.Discard, nil)), room.NewMemoryStore(), nil, memory.NewFake(), memory.ContextPolicy{Risk: "medium", ContextBudgetTokens: 2_000})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/version", nil))

	var body map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	for k := range body {
		if k != "version" && k != "commit" {
			t.Errorf("unexpected key %q in /version response", k)
		}
	}
}

// Without ROOMS_DATABASE_URL, openStore must return the in-memory store and
// log an unmissable warning that the mode is non-durable — an operator
// scanning logs should not have to infer this from silence.
func TestOpenStoreEphemeralWithoutDatabaseURL(t *testing.T) {
	t.Setenv("ROOMS_DATABASE_URL", "")

	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))

	store, closeStore, err := openStore(context.Background(), logger)
	if err != nil {
		t.Fatalf("openStore: %v", err)
	}
	t.Cleanup(closeStore)

	if _, ok := store.(*room.MemoryStore); !ok {
		t.Fatalf("openStore() returned %T, want *room.MemoryStore", store)
	}

	log := buf.String()
	if !strings.Contains(log, "EPHEMERAL") || !strings.Contains(log, "NON-DURABLE") {
		t.Errorf("expected an explicit non-durable warning, got log output: %s", log)
	}
}

// A malformed ROOMS_DATABASE_URL must fail startup rather than silently
// falling back to the in-memory store — a self-hoster who configured a
// database and got an ephemeral one would lose data believing it was safe.
func TestOpenStoreFailsOnMalformedDatabaseURL(t *testing.T) {
	t.Setenv("ROOMS_DATABASE_URL", "://not a valid url")

	store, closeStore, err := openStore(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil {
		t.Fatal("openStore() with a malformed URL: want an error, got nil")
	}
	if store != nil || closeStore != nil {
		t.Errorf("openStore() with a malformed URL: want (nil, nil, err), got store=%v closeStore=%t", store, closeStore != nil)
	}
}

// An unreachable (but syntactically valid) ROOMS_DATABASE_URL must also fail
// startup loudly, not fall back to the in-memory store.
func TestOpenStoreFailsOnUnreachableDatabaseURL(t *testing.T) {
	t.Setenv("ROOMS_DATABASE_URL", "postgres://user:pass@127.0.0.1:1/nonexistent?connect_timeout=1&sslmode=disable")

	store, closeStore, err := openStore(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil {
		t.Fatal("openStore() with an unreachable database: want an error, got nil")
	}
	if store != nil || closeStore != nil {
		t.Errorf("openStore() with an unreachable database: want (nil, nil, err), got store=%v closeStore=%t", store, closeStore != nil)
	}
}

// TestPoolConfigFromEnv covers the documented defaults, valid overrides, and
// the failure modes an operator can hit: non-numeric, negative, or
// zero MaxConns, a negative MinConns, MinConns exceeding MaxConns, and an
// unparseable idle-time duration.
func TestPoolConfigFromEnv(t *testing.T) {
	t.Run("defaults when unset", func(t *testing.T) {
		t.Setenv("ROOMS_DATABASE_MAX_CONNS", "")
		t.Setenv("ROOMS_DATABASE_MIN_CONNS", "")
		t.Setenv("ROOMS_DATABASE_MAX_CONN_IDLE_TIME", "")

		got, err := poolConfigFromEnv()
		if err != nil {
			t.Fatalf("poolConfigFromEnv: %v", err)
		}
		want := poolConfig{
			MaxConns:        defaultDatabaseMaxConns,
			MinConns:        defaultDatabaseMinConns,
			MaxConnIdleTime: defaultDatabaseMaxConnIdleTime,
		}
		if got != want {
			t.Errorf("poolConfigFromEnv() = %+v, want %+v", got, want)
		}
	})

	t.Run("valid overrides", func(t *testing.T) {
		t.Setenv("ROOMS_DATABASE_MAX_CONNS", "20")
		t.Setenv("ROOMS_DATABASE_MIN_CONNS", "5")
		t.Setenv("ROOMS_DATABASE_MAX_CONN_IDLE_TIME", "1m")

		got, err := poolConfigFromEnv()
		if err != nil {
			t.Fatalf("poolConfigFromEnv: %v", err)
		}
		want := poolConfig{MaxConns: 20, MinConns: 5, MaxConnIdleTime: time.Minute}
		if got != want {
			t.Errorf("poolConfigFromEnv() = %+v, want %+v", got, want)
		}
	})

	failureCases := []struct {
		name string
		env  map[string]string
	}{
		{"non-numeric max conns", map[string]string{"ROOMS_DATABASE_MAX_CONNS": "lots"}},
		{"zero max conns", map[string]string{"ROOMS_DATABASE_MAX_CONNS": "0"}},
		{"negative max conns", map[string]string{"ROOMS_DATABASE_MAX_CONNS": "-1"}},
		{"non-numeric min conns", map[string]string{"ROOMS_DATABASE_MIN_CONNS": "many"}},
		{"negative min conns", map[string]string{"ROOMS_DATABASE_MIN_CONNS": "-1"}},
		{"min conns exceeds max conns", map[string]string{"ROOMS_DATABASE_MAX_CONNS": "2", "ROOMS_DATABASE_MIN_CONNS": "3"}},
		{"malformed idle time", map[string]string{"ROOMS_DATABASE_MAX_CONN_IDLE_TIME": "not-a-duration"}},
	}
	for _, tt := range failureCases {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("ROOMS_DATABASE_MAX_CONNS", "")
			t.Setenv("ROOMS_DATABASE_MIN_CONNS", "")
			t.Setenv("ROOMS_DATABASE_MAX_CONN_IDLE_TIME", "")
			for k, v := range tt.env {
				t.Setenv(k, v)
			}

			if _, err := poolConfigFromEnv(); err == nil {
				t.Fatal("poolConfigFromEnv(): want an error, got nil")
			}
		})
	}
}
