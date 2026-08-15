package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/agent"
	"github.com/zerkerlabs/gateway/gateway/internal/agentevent"
	"github.com/zerkerlabs/gateway/gateway/internal/auth/authtest"
	"github.com/zerkerlabs/gateway/gateway/internal/httpapi"
)

func TestAgentEventIngestAndSummary(t *testing.T) {
	t.Parallel()

	mux, registered := agentEventMux(t)
	now := time.Now().UTC().Truncate(time.Second)
	events := []map[string]any{
		validAgentEvent(registered.ID, "evt-session", "session.started", now),
		validAgentEvent(registered.ID, "evt-session-retry", "session.started", now.Add(500*time.Millisecond)),
		func() map[string]any {
			event := validAgentEvent(registered.ID, "evt-tool-ok", "tool.completed", now.Add(time.Second))
			event["tool_name"] = "read"
			event["outcome"] = "succeeded"
			event["duration_ms"] = 25
			return event
		}(),
		func() map[string]any {
			event := validAgentEvent(registered.ID, "evt-tool-fail", "tool.completed", now.Add(2*time.Second))
			event["tool_name"] = "bash"
			event["outcome"] = "failed"
			event["duration_ms"] = 75
			return event
		}(),
		func() map[string]any {
			event := validAgentEvent(registered.ID, "evt-usage", "model.usage", now.Add(3*time.Second))
			event["provider"] = "anthropic"
			event["model"] = "claude-test"
			event["input_tokens"] = 100
			event["output_tokens"] = 20
			event["cost_usd"] = 0.01
			return event
		}(),
	}
	for _, event := range events {
		requestJSON(t, mux, http.MethodPost, "/v1/agent-events", event, http.StatusCreated)
	}
	requestJSON(t, mux, http.MethodPost, "/v1/agent-events", events[0], http.StatusOK)

	since := now.Add(-time.Minute).Format(time.RFC3339)
	until := now.Add(time.Minute).Format(time.RFC3339)
	req := httptest.NewRequest(http.MethodGet, "/v1/agent-events/summary?agent_id="+registered.ID+"&since="+since+"&until="+until, nil)
	req = req.WithContext(authtest.WithIdentity(req.Context(), testTenant, testUser))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("summary status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var response struct {
		Summary agentevent.Summary `json:"summary"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	if response.Summary.LastEventAt == nil {
		t.Fatal("last_event_at is nil after recorded activity")
	}
	response.Summary.LastEventAt = nil
	want := agentevent.Summary{Sessions: 1, ToolCalls: 2, ToolsSucceeded: 1, ToolsFailed: 1, DurationMS: 100, InputTokens: 100, OutputTokens: 20, CostUSD: 0.01}
	if response.Summary != want {
		t.Fatalf("summary = %#v, want %#v", response.Summary, want)
	}
}

func TestAgentEventRejectsContentFields(t *testing.T) {
	t.Parallel()

	mux, registered := agentEventMux(t)
	event := validAgentEvent(registered.ID, "evt-private", "session.started", time.Now().UTC())
	event["prompt"] = "this must never be accepted"
	requestJSON(t, mux, http.MethodPost, "/v1/agent-events", event, http.StatusBadRequest)
}

func TestAgentEventCannotCrossTenantBoundary(t *testing.T) {
	t.Parallel()

	mux, registered := agentEventMux(t)
	event := validAgentEvent(registered.ID, "evt-cross-tenant", "session.started", time.Now().UTC())
	body, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/agent-events", bytes.NewReader(body))
	req = req.WithContext(authtest.WithIdentity(req.Context(), "another-tenant", testUser))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func agentEventMux(t *testing.T) (*http.ServeMux, *agent.Agent) {
	t.Helper()
	store := agent.NewMemoryStore()
	registered := &agent.Agent{Name: "Pi", CreatedBy: testUser}
	if err := store.Create(context.Background(), testTenant, registered); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	handler := httpapi.NewHandler(store, slog.New(slog.NewTextHandler(io.Discard, nil))).WithAgentEvents(agentevent.NewMemoryStore())
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)
	return mux, registered
}

func validAgentEvent(agentID, eventID, eventType string, occurredAt time.Time) map[string]any {
	return map[string]any{
		"schema":         agentevent.SchemaV1,
		"event_id":       eventID,
		"agent_id":       agentID,
		"type":           eventType,
		"session_ref":    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"occurred_at":    occurredAt.Format(time.RFC3339Nano),
		"source":         "pi",
		"source_version": "0.1.0",
	}
}

func requestJSON(t *testing.T, mux *http.ServeMux, method, path string, payload any, wantStatus int) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(authtest.WithIdentity(req.Context(), testTenant, testUser))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != wantStatus {
		t.Fatalf("%s %s status = %d, want %d; body = %s", method, path, rec.Code, wantStatus, rec.Body.String())
	}
}
