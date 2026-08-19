// Package agentevent defines the metadata-only activity contract emitted by
// enrolled agent adapters. It intentionally has no prompt, argument, output,
// command-line, or file-path fields.
package agentevent

import (
	"context"
	"errors"
	"time"
)

// SchemaV1 identifies the stable metadata-only event contract.
const SchemaV1 = "zerker.agent-event.v1"

// Type identifies the lifecycle or measurement represented by an event.
type Type string

// Supported event types.
const (
	TypeSessionStarted Type = "session.started"
	TypeSessionEnded   Type = "session.ended"
	TypeToolCompleted  Type = "tool.completed"
	TypeModelUsage     Type = "model.usage"
)

// Outcome is the coarse terminal state of a tool call.
type Outcome string

// Supported tool outcomes.
const (
	OutcomeSucceeded Outcome = "succeeded"
	OutcomeFailed    Outcome = "failed"
	OutcomeCancelled Outcome = "cancelled"
)

var (
	// ErrDuplicate reports an idempotent retry of a client event ID.
	ErrDuplicate = errors.New("agent event already recorded")
	// ErrNotFound reports an event targeting an unavailable tenant agent.
	ErrNotFound = errors.New("agent not found")
)

// Event is one privacy-bounded lifecycle, tool, or usage observation.
type Event struct {
	ID               string
	TenantID         string
	AgentID          string
	ClientEventID    string
	Schema           string
	Type             Type
	SessionRef       string
	OccurredAt       time.Time
	ReceivedAt       time.Time
	ToolName         *string
	Outcome          *Outcome
	DurationMS       *int64
	Provider         *string
	Model            *string
	InputTokens      *int64
	OutputTokens     *int64
	CacheReadTokens  *int64
	CacheWriteTokens *int64
	CostUSD          *float64
	Source           string
	SourceVersion    string
}

// Summary is the compact measurement shown to an operator for a time window.
type Summary struct {
	Sessions       int64      `json:"sessions"`
	ToolCalls      int64      `json:"tool_calls"`
	ToolsSucceeded int64      `json:"tools_succeeded"`
	ToolsFailed    int64      `json:"tools_failed"`
	DurationMS     int64      `json:"tool_duration_ms"`
	InputTokens    int64      `json:"input_tokens"`
	OutputTokens   int64      `json:"output_tokens"`
	CostUSD        float64    `json:"cost_usd"`
	CostKnown      bool       `json:"cost_known"`
	LastEventAt    *time.Time `json:"last_event_at,omitempty"`
}

// Store persists events and computes tenant-scoped summaries.
type Store interface {
	Create(ctx context.Context, tenantID string, event *Event) error
	Summary(ctx context.Context, tenantID, agentID string, since, until time.Time) (Summary, error)
}
