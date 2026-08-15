package onboarding

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/zerkerlabs/gateway/gateway/internal/discovery"
)

func TestObserveAllUsesPrivateFailSafeDefaultsAndIsIdempotent(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	created := make([]listedAgent, 0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer secret-token" {
			t.Errorf("Authorization = %q, want bearer token", got)
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/agents":
			mu.Lock()
			defer mu.Unlock()
			_ = json.NewEncoder(w).Encode(listResponse{Agents: created})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/agents":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode create: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			for key, want := range map[string]any{
				"capture_body":  false,
				"emit_receipts": false,
				"protocol":      "http",
			} {
				if body[key] != want {
					t.Errorf("%s = %#v, want %#v", key, body[key], want)
				}
			}
			if _, exists := body["upstream_url"]; exists {
				t.Error("observe-only create must not set upstream_url")
			}
			metadata, ok := body["metadata"].(map[string]any)
			if !ok {
				t.Errorf("metadata = %#v, want object", body["metadata"])
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if metadata["zerker_onboarding_mode"] != "observe" || metadata["zerker_exposure"] != "internal" || metadata["zerker_identity_status"] != "discovered" {
				t.Errorf("unsafe observe metadata: %#v", metadata)
			}
			name, ok := body["name"].(string)
			if !ok {
				t.Errorf("name = %#v, want string", body["name"])
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			mu.Lock()
			created = append(created, listedAgent{
				ID:       "agt_1",
				Name:     name,
				Metadata: metadata,
			})
			mu.Unlock()
			w.WriteHeader(http.StatusCreated)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "secret-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	report := discovery.Report{Schema: discovery.Schema, Agents: []discovery.Agent{
		{Key: "claude-code", Name: "Claude Code", Provider: "Anthropic", Installed: true, Configured: true},
		{Key: "hermes", Name: "Hermes", Provider: "Nous Research", Installed: true, Configured: true},
	}}

	first, err := client.ObserveAll(context.Background(), report)
	if err != nil {
		t.Fatalf("first ObserveAll() error = %v", err)
	}
	if strings.Join(first.Added, ",") != "Claude Code,Hermes" || len(first.AlreadyEnrolled) != 0 {
		t.Fatalf("first result = %#v", first)
	}

	second, err := client.ObserveAll(context.Background(), report)
	if err != nil {
		t.Fatalf("second ObserveAll() error = %v", err)
	}
	if len(second.Added) != 0 || strings.Join(second.AlreadyEnrolled, ",") != "Claude Code,Hermes" {
		t.Fatalf("second result = %#v", second)
	}
	if len(created) != 2 {
		t.Fatalf("created %d agents, want exactly 2", len(created))
	}
}

func TestTodayShowsActivityAndCollapsesUnconnectedAgents(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer token" {
			t.Errorf("Authorization = %q, want bearer token", got)
		}
		switch r.URL.Path {
		case "/v1/agents":
			_ = json.NewEncoder(w).Encode(listResponse{Agents: []listedAgent{
				{ID: "agt_pi", Name: "Pi", Metadata: map[string]any{"zerker_discovery_key": "pi"}},
				{ID: "agt_hermes", Name: "Hermes", Metadata: map[string]any{"zerker_discovery_key": "hermes"}},
				{ID: "agt_cursor", Name: "Cursor", Metadata: map[string]any{"zerker_discovery_key": "cursor"}},
			}})
		case "/v1/agent-events/summary":
			if r.URL.Query().Get("agent_id") == "agt_pi" {
				_ = json.NewEncoder(w).Encode(map[string]any{"summary": map[string]any{
					"sessions": 2, "tool_calls": 5, "tools_succeeded": 4,
					"tools_failed": 1, "tool_duration_ms": 90, "input_tokens": 100,
					"output_tokens": 20, "cost_usd": 0.25, "cost_known": true,
				}})
				return
			}
			if r.URL.Query().Get("agent_id") == "agt_cursor" {
				_ = json.NewEncoder(w).Encode(map[string]any{"summary": map[string]any{
					"last_event_at": "2026-08-13T12:00:00Z",
				}})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"summary": map[string]any{}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	today, err := client.Today(context.Background())
	if err != nil {
		t.Fatalf("Today() error = %v", err)
	}
	if today.Schema != "zerker.agent-today.v1" {
		t.Fatalf("schema = %q", today.Schema)
	}
	if len(today.Agents) != 1 || today.Agents[0].Name != "Pi" || today.Agents[0].ToolCalls != 5 || today.Agents[0].ToolsFailed != 1 {
		t.Fatalf("active agents = %#v", today.Agents)
	}
	if strings.Join(today.Quiet, ",") != "Cursor" {
		t.Fatalf("quiet = %#v, want Cursor", today.Quiet)
	}
	if strings.Join(today.Waiting, ",") != "Hermes" {
		t.Fatalf("waiting = %#v, want Hermes", today.Waiting)
	}
}

func TestNewClientRejectsTokenExfiltrationURLs(t *testing.T) {
	t.Parallel()

	for _, rawURL := range []string{
		"http://gateway.example.com",
		"http://localhost:8080",
		"ftp://127.0.0.1",
		"https://user:pass@gateway.example.com",
		"https://gateway.example.com?redirect=evil",
	} {
		if _, err := NewClient(rawURL, "secret-token", nil); err == nil {
			t.Errorf("NewClient(%q) succeeded, want rejection", rawURL)
		}
	}
	for _, rawURL := range []string{"http://127.0.0.1:8080", "http://[::1]:8080", "https://gateway.example.com"} {
		if _, err := NewClient(rawURL, "secret-token", nil); err != nil {
			t.Errorf("NewClient(%q) error = %v", rawURL, err)
		}
	}
}

func TestObserveAllPreflightsNameConflictsBeforeWriting(t *testing.T) {
	t.Parallel()

	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts++
			w.WriteHeader(http.StatusCreated)
			return
		}
		_ = json.NewEncoder(w).Encode(listResponse{Agents: []listedAgent{{
			ID: "agt_existing", Name: "Hermes", Metadata: map[string]any{},
		}}})
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	_, err = client.ObserveAll(context.Background(), discovery.Report{Agents: []discovery.Agent{
		{Key: "claude-code", Name: "Claude Code"},
		{Key: "hermes", Name: "Hermes"},
	}})
	if err == nil || !strings.Contains(err.Error(), "review it before importing") {
		t.Fatalf("ObserveAll() error = %v, want review conflict", err)
	}
	if posts != 0 {
		t.Fatalf("POST count = %d, want no partial writes", posts)
	}
}
