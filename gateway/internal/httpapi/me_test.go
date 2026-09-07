package httpapi_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zerkerlabs/gateway/gateway/internal/agent"
	"github.com/zerkerlabs/gateway/gateway/internal/auth/authtest"
	"github.com/zerkerlabs/gateway/gateway/internal/httpapi"
)

type apiMe struct {
	TenantID                string   `json:"tenant_id"`
	UserID                  string   `json:"user_id"`
	Scopes                  []string `json:"scopes"`
	CanReadInvocationBodies bool     `json:"can_read_invocation_bodies"`
}

func getMe(t *testing.T, mux *http.ServeMux, scopes []string) apiMe {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	ctx := authtest.WithIdentity(req.Context(), testTenant, testUser)
	if scopes != nil {
		ctx = authtest.WithScopes(ctx, scopes)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req.WithContext(ctx))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/me = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	var got apiMe
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode me: %v; body = %s", err, rec.Body.String())
	}
	return got
}

func meMux(t *testing.T) *http.ServeMux {
	t.Helper()
	h := httpapi.NewHandler(agent.NewMemoryStore(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux
}

func TestMe_EchoesCallerIdentity(t *testing.T) {
	t.Parallel()
	got := getMe(t, meMux(t), nil)
	if got.TenantID != testTenant || got.UserID != testUser {
		t.Errorf("identity = %q/%q, want %q/%q", got.TenantID, got.UserID, testTenant, testUser)
	}
}

// A token with no scope claim must report an empty list, not null: "no scopes"
// is a fact, and a client should not have to handle two spellings of it.
func TestMe_NoScopesIsEmptyList(t *testing.T) {
	t.Parallel()
	got := getMe(t, meMux(t), nil)
	if got.Scopes == nil {
		t.Error("scopes = null with no scope claim, want []")
	}
	if len(got.Scopes) != 0 {
		t.Errorf("scopes = %v, want empty", got.Scopes)
	}
	if got.CanReadInvocationBodies {
		t.Error("can_read_invocation_bodies = true without the scope")
	}
}

// The body-read flag is the whole reason a console can render that control
// honestly instead of discovering the answer from a failure.
func TestMe_ReportsBodyReadScope(t *testing.T) {
	t.Parallel()
	got := getMe(t, meMux(t), []string{"invocations:read_body", "something:else"})
	if !got.CanReadInvocationBodies {
		t.Error("can_read_invocation_bodies = false with invocations:read_body granted")
	}
	if len(got.Scopes) != 2 {
		t.Errorf("scopes = %v, want both echoed", got.Scopes)
	}
}

// A scope that merely looks similar must not be read as the real one.
func TestMe_SimilarScopeIsNotTheBodyScope(t *testing.T) {
	t.Parallel()
	got := getMe(t, meMux(t), []string{"invocations:read", "invocations:read_bodyx"})
	if got.CanReadInvocationBodies {
		t.Error("can_read_invocation_bodies = true for a scope that is not invocations:read_body")
	}
}
