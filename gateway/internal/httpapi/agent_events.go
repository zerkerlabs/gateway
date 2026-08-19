package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/agent"
	"github.com/zerkerlabs/gateway/gateway/internal/agentevent"
	"github.com/zerkerlabs/gateway/gateway/internal/auth"
)

var sessionRefPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

type agentEventRequest struct {
	Schema           string              `json:"schema"`
	ClientEventID    string              `json:"event_id"`
	AgentID          string              `json:"agent_id"`
	Type             agentevent.Type     `json:"type"`
	SessionRef       string              `json:"session_ref"`
	OccurredAt       time.Time           `json:"occurred_at"`
	ToolName         *string             `json:"tool_name,omitempty"`
	Outcome          *agentevent.Outcome `json:"outcome,omitempty"`
	DurationMS       *int64              `json:"duration_ms,omitempty"`
	Provider         *string             `json:"provider,omitempty"`
	Model            *string             `json:"model,omitempty"`
	InputTokens      *int64              `json:"input_tokens,omitempty"`
	OutputTokens     *int64              `json:"output_tokens,omitempty"`
	CacheReadTokens  *int64              `json:"cache_read_tokens,omitempty"`
	CacheWriteTokens *int64              `json:"cache_write_tokens,omitempty"`
	CostUSD          *float64            `json:"cost_usd,omitempty"`
	Source           string              `json:"source"`
	SourceVersion    string              `json:"source_version"`
}

func (h *Handler) handleCreateAgentEvent(w http.ResponseWriter, r *http.Request) {
	tenant := auth.TenantFromContext(r.Context())
	if tenant == "" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	var req agentEventRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid agent event")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid agent event")
		return
	}
	if err := validateAgentEvent(req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := h.store.Get(r.Context(), tenant, req.AgentID); err != nil {
		if errors.Is(err, agent.ErrNotFound) {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		h.logger.Error("create agent event: agent lookup", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	event := &agentevent.Event{
		AgentID:          req.AgentID,
		ClientEventID:    req.ClientEventID,
		Schema:           req.Schema,
		Type:             req.Type,
		SessionRef:       req.SessionRef,
		OccurredAt:       req.OccurredAt.UTC(),
		ToolName:         req.ToolName,
		Outcome:          req.Outcome,
		DurationMS:       req.DurationMS,
		Provider:         req.Provider,
		Model:            req.Model,
		InputTokens:      req.InputTokens,
		OutputTokens:     req.OutputTokens,
		CacheReadTokens:  req.CacheReadTokens,
		CacheWriteTokens: req.CacheWriteTokens,
		CostUSD:          req.CostUSD,
		Source:           req.Source,
		SourceVersion:    req.SourceVersion,
	}
	if err := h.agentEvents.Create(r.Context(), tenant, event); err != nil {
		if errors.Is(err, agentevent.ErrDuplicate) {
			writeJSON(w, http.StatusOK, map[string]any{"recorded": true, "duplicate": true})
			return
		}
		if errors.Is(err, agentevent.ErrNotFound) {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		h.logger.Error("create agent event: store", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"recorded": true, "duplicate": false})
}

func validateAgentEvent(req agentEventRequest) error {
	if req.Schema != agentevent.SchemaV1 {
		return fmt.Errorf("schema must be %q", agentevent.SchemaV1)
	}
	if !validShortValue(req.ClientEventID, 128) || !validShortValue(req.AgentID, 128) {
		return errors.New("event_id and agent_id are required and must be at most 128 characters")
	}
	if !sessionRefPattern.MatchString(req.SessionRef) {
		return errors.New("session_ref must be a SHA-256 digest")
	}
	if req.OccurredAt.IsZero() {
		return errors.New("occurred_at is required")
	}
	now := time.Now().UTC()
	if req.OccurredAt.Before(now.Add(-31*24*time.Hour)) || req.OccurredAt.After(now.Add(5*time.Minute)) {
		return errors.New("occurred_at must be within the accepted 31-day ingestion window")
	}
	if !validShortValue(req.Source, 64) || !validShortValue(req.SourceVersion, 64) {
		return errors.New("source and source_version are required and must be at most 64 characters")
	}
	if req.DurationMS != nil && *req.DurationMS < 0 || anyNegative(req.InputTokens, req.OutputTokens, req.CacheReadTokens, req.CacheWriteTokens) || req.CostUSD != nil && *req.CostUSD < 0 {
		return errors.New("duration, token counts, and cost must be non-negative")
	}

	switch req.Type {
	case agentevent.TypeSessionStarted, agentevent.TypeSessionEnded:
		if req.ToolName != nil || req.Outcome != nil || req.DurationMS != nil || hasUsage(req) {
			return errors.New("session events cannot contain tool or model usage fields")
		}
	case agentevent.TypeToolCompleted:
		if req.ToolName == nil || !validShortValue(*req.ToolName, 128) || req.Outcome == nil || req.DurationMS == nil {
			return errors.New("tool.completed requires tool_name, outcome, and duration_ms")
		}
		if *req.Outcome != agentevent.OutcomeSucceeded && *req.Outcome != agentevent.OutcomeFailed && *req.Outcome != agentevent.OutcomeCancelled {
			return errors.New("invalid tool outcome")
		}
		if hasUsage(req) {
			return errors.New("tool.completed cannot contain model usage fields")
		}
	case agentevent.TypeModelUsage:
		if req.Provider == nil || !validShortValue(*req.Provider, 128) || req.Model == nil || !validShortValue(*req.Model, 256) {
			return errors.New("model.usage requires provider and model")
		}
		if req.ToolName != nil || req.Outcome != nil || req.DurationMS != nil {
			return errors.New("model.usage cannot contain tool fields")
		}
	default:
		return errors.New("unsupported agent event type")
	}
	return nil
}

func (h *Handler) handleAgentEventSummary(w http.ResponseWriter, r *http.Request) {
	tenant := auth.TenantFromContext(r.Context())
	if tenant == "" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	agentID := r.URL.Query().Get("agent_id")
	if !validShortValue(agentID, 128) {
		writeError(w, http.StatusBadRequest, "agent_id is required")
		return
	}
	if _, err := h.store.Get(r.Context(), tenant, agentID); err != nil {
		if errors.Is(err, agent.ErrNotFound) {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		h.logger.Error("agent event summary: agent lookup", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	until := time.Now().UTC()
	var err error
	if value := r.URL.Query().Get("until"); value != "" {
		until, err = time.Parse(time.RFC3339, value)
		if err != nil {
			writeError(w, http.StatusBadRequest, "until must be RFC3339")
			return
		}
	}
	since := until.Add(-24 * time.Hour)
	if value := r.URL.Query().Get("since"); value != "" {
		since, err = time.Parse(time.RFC3339, value)
		if err != nil {
			writeError(w, http.StatusBadRequest, "since must be RFC3339")
			return
		}
	}
	if !since.Before(until) || until.Sub(since) > 31*24*time.Hour {
		writeError(w, http.StatusBadRequest, "summary window must be positive and at most 31 days")
		return
	}

	summary, err := h.agentEvents.Summary(r.Context(), tenant, agentID, since, until)
	if err != nil {
		h.logger.Error("agent event summary: store", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	summary.CostUSD = math.Round(summary.CostUSD*1_000_000) / 1_000_000
	writeJSON(w, http.StatusOK, map[string]any{
		"schema":   "zerker.agent-event-summary.v1",
		"agent_id": agentID,
		"since":    since.UTC().Format(time.RFC3339),
		"until":    until.UTC().Format(time.RFC3339),
		"summary":  summary,
	})
}

func validShortValue(value string, maxLength int) bool {
	return value != "" && len(value) <= maxLength && strings.TrimSpace(value) == value
}

func anyNegative(values ...*int64) bool {
	for _, value := range values {
		if value != nil && *value < 0 {
			return true
		}
	}
	return false
}

func hasUsage(req agentEventRequest) bool {
	return req.Provider != nil || req.Model != nil || req.InputTokens != nil || req.OutputTokens != nil || req.CacheReadTokens != nil || req.CacheWriteTokens != nil || req.CostUSD != nil
}
