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
	"github.com/zerkerlabs/gateway/gateway/internal/invocation"
	"github.com/zerkerlabs/gateway/gateway/internal/policy"
)

type apiCapabilities struct {
	Surfaces map[string]bool `json:"surfaces"`
	Limits   map[string]int  `json:"limits"`
	Posture  struct {
		Store                   string `json:"store"`
		KMSKeyConfigured        bool   `json:"kms_key_configured"`
		ReceiptsEnabled         bool   `json:"receipts_enabled"`
		ReceiptActor            string `json:"receipt_actor"`
		SettlementOrchestration bool   `json:"settlement_orchestration"`
	} `json:"posture"`
}

func getJSON(t *testing.T, mux *http.ServeMux, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req = req.WithContext(authtest.WithIdentity(req.Context(), testTenant, testUser))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func decodeCapabilities(t *testing.T, rec *httptest.ResponseRecorder) apiCapabilities {
	t.Helper()
	var got apiCapabilities
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode capabilities: %v; body = %s", err, rec.Body.String())
	}
	return got
}

// A gateway with nothing optional wired must say so, rather than leaving a
// client to infer it from 404s that mean three different things.
func TestCapabilities_BareGatewayReportsUnmountedSurfaces(t *testing.T) {
	t.Parallel()
	h := httpapi.NewHandler(agent.NewMemoryStore(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	rec := getJSON(t, mux, "/v1/capabilities")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	got := decodeCapabilities(t, rec)

	for _, surface := range []string{
		"credentials", "invocations", "analytics", "proxy", "agent_events",
		"settlement", "policy", "policy_decisions", "receipts", "reason_enforcement",
	} {
		if got.Surfaces[surface] {
			t.Errorf("surfaces[%q] = true on a bare handler, want false", surface)
		}
	}
	if got.Posture.ReceiptsEnabled {
		t.Error("posture.receipts_enabled = true with no emitter attached")
	}
	if got.Posture.ReceiptActor != "" {
		t.Errorf("posture.receipt_actor = %q with receipts off, want empty", got.Posture.ReceiptActor)
	}
}

// Wiring a dependency must flip exactly the surfaces that dependency mounts.
func TestCapabilities_ReflectsWiring(t *testing.T) {
	t.Parallel()
	h := httpapi.NewHandler(agent.NewMemoryStore(), slog.New(slog.NewTextHandler(io.Discard, nil))).
		WithProxy(&mockForwarder{}, invocation.NewMemoryStore()).
		WithPolicy(policy.NewMemoryStore()).
		WithPolicyDecisions(policy.NewMemoryDecisionStore()).
		WithPosture(httpapi.Posture{Store: "postgres", KMSKeyConfigured: true})
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	got := decodeCapabilities(t, getJSON(t, mux, "/v1/capabilities"))

	for _, surface := range []string{"invocations", "analytics", "proxy", "policy", "policy_decisions"} {
		if !got.Surfaces[surface] {
			t.Errorf("surfaces[%q] = false after wiring it, want true", surface)
		}
	}
	// Credentials were not wired, and settlement needs them, so both stay off.
	if got.Surfaces["credentials"] || got.Surfaces["settlement"] {
		t.Error("credentials/settlement reported as mounted without a credential service")
	}
	if got.Posture.Store != "postgres" || !got.Posture.KMSKeyConfigured {
		t.Errorf("posture = %+v, want the configured store and key reported", got.Posture)
	}
}

// The limits a client must respect have to be the constants the handlers
// enforce, not plausible-looking numbers.
func TestCapabilities_ReportsEnforcedLimits(t *testing.T) {
	t.Parallel()
	h := httpapi.NewHandler(agent.NewMemoryStore(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	got := decodeCapabilities(t, getJSON(t, mux, "/v1/capabilities"))

	want := map[string]int{
		"analytics_max_range_days":   31,
		"invocations_max_limit":      100,
		"policy_decision_max_limit":  100,
		"agent_event_max_range_days": 31,
		"model_header_max_bytes":     256,
		"transact_max_body_bytes":    32 << 20,
		"captured_body_max_bytes":    1 << 20,
	}
	for k, v := range want {
		if got.Limits[k] != v {
			t.Errorf("limits[%q] = %d, want %d", k, got.Limits[k], v)
		}
	}
}

// Invariant #1: the exemption list is /healthz and /version, and nothing else.
// A deployment inventory is exactly the sort of thing that must not be
// readable without a token.
func TestCapabilitiesAndMe_RequireAuth(t *testing.T) {
	t.Parallel()
	h := httpapi.NewHandler(agent.NewMemoryStore(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	for _, path := range []string{"/v1/capabilities", "/v1/me"} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("GET %s without identity = %d, want 401", path, rec.Code)
		}
	}
}
