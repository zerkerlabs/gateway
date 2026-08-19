package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/discovery"
	"github.com/zerkerlabs/gateway/gateway/internal/onboarding"
)

func TestStatusPrintsEvidenceWithoutClaimingPersistentConnection(t *testing.T) {
	t.Setenv("ZERKER_TOKEN", "test-token")
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/v1/agents":
			_ = json.NewEncoder(w).Encode(map[string]any{"agents": []map[string]any{
				{"id": "agt_hermes", "name": "Hermes", "metadata": map[string]any{"zerker_discovery_key": "hermes"}},
				{"id": "agt_pi", "name": "Pi", "metadata": map[string]any{"zerker_discovery_key": "pi"}},
			}})
		case "/v1/agent-events/summary":
			if r.URL.Query().Get("agent_id") == "agt_hermes" {
				_ = json.NewEncoder(w).Encode(map[string]any{"summary": map[string]any{
					"last_event_at": now.Add(-2 * time.Minute),
				}})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"summary": map[string]any{}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	report := discovery.Report{Schema: discovery.Schema, Agents: []discovery.Agent{
		{Key: "hermes", Name: "Hermes"},
		{Key: "pi", Name: "Pi"},
		{Key: "cursor", Name: "Cursor"},
	}}
	var output bytes.Buffer
	err := run(
		[]string{"status", "--gateway", server.URL},
		&output,
		&bytes.Buffer{},
		func() time.Time { return now },
		func() (discovery.Report, error) { return report, nil },
	)
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}
	for _, want := range []string{
		"Gateway\n  Connected", "Hermes · enrolled · reporting · last event 2m ago",
		"Pi · enrolled · no recent events", "Cursor · not enrolled", "Observe · no blocking",
		"Never collected", "prompts", "credentials",
	} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("output missing %q:\n%s", want, output.String())
		}
	}
}

func TestStatusJSONCanFilterOneAgent(t *testing.T) {
	t.Setenv("ZERKER_TOKEN", "test-token")
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/agents":
			_ = json.NewEncoder(w).Encode(map[string]any{"agents": []map[string]any{
				{"id": "agt_hermes", "name": "Hermes", "metadata": map[string]any{"zerker_discovery_key": "hermes"}},
			}})
		case "/v1/agent-events/summary":
			_ = json.NewEncoder(w).Encode(map[string]any{"summary": map[string]any{}})
		}
	}))
	defer server.Close()

	var output bytes.Buffer
	err := run(
		[]string{"status", "--json", "--agent", "hermes", "--gateway", server.URL},
		&output,
		&bytes.Buffer{},
		func() time.Time { return now },
		func() (discovery.Report, error) {
			return discovery.Report{Agents: []discovery.Agent{{Key: "hermes", Name: "Hermes"}, {Key: "pi", Name: "Pi"}}}, nil
		},
	)
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}
	var status onboarding.Status
	if err := json.Unmarshal(output.Bytes(), &status); err != nil {
		t.Fatalf("decode output: %v", err)
	}
	if status.Schema != "zerker.agent-status.v1" || len(status.Agents) != 1 || status.Agents[0].Name != "Hermes" {
		t.Fatalf("status = %#v", status)
	}
}

func TestLoadTokenTrimsFile(t *testing.T) {
	t.Setenv("ZERKER_TOKEN", "")
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("  token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := loadToken(path)
	if err != nil || got != "token" {
		t.Fatalf("loadToken() = %q, %v", got, err)
	}
}
