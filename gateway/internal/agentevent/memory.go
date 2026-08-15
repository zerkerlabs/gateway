package agentevent

import (
	"context"
	"sync"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/resource"
)

// MemoryStore is the development and test implementation of Store.
type MemoryStore struct {
	mu     sync.RWMutex
	events map[string]map[string]Event
}

// NewMemoryStore returns an empty event store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{events: make(map[string]map[string]Event)}
}

// Create records one event idempotently within a tenant.
func (s *MemoryStore) Create(ctx context.Context, tenantID string, event *Event) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	id, err := resource.New("evt")
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.events[tenantID] == nil {
		s.events[tenantID] = make(map[string]Event)
	}
	if _, exists := s.events[tenantID][event.ClientEventID]; exists {
		return ErrDuplicate
	}
	event.ID = id
	event.TenantID = tenantID
	event.ReceivedAt = time.Now().UTC()
	s.events[tenantID][event.ClientEventID] = *event
	return nil
}

// Summary aggregates one agent's events over the half-open time window.
func (s *MemoryStore) Summary(ctx context.Context, tenantID, agentID string, since, until time.Time) (Summary, error) {
	if err := ctx.Err(); err != nil {
		return Summary{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()

	var summary Summary
	sessions := make(map[string]struct{})
	for _, event := range s.events[tenantID] {
		if event.AgentID != agentID {
			continue
		}
		if summary.LastEventAt == nil || event.ReceivedAt.After(*summary.LastEventAt) {
			lastEventAt := event.ReceivedAt
			summary.LastEventAt = &lastEventAt
		}
		if event.OccurredAt.Before(since) || !event.OccurredAt.Before(until) {
			continue
		}
		switch event.Type {
		case TypeSessionStarted:
			sessions[event.SessionRef] = struct{}{}
		case TypeToolCompleted:
			summary.ToolCalls++
			if event.Outcome != nil && *event.Outcome == OutcomeSucceeded {
				summary.ToolsSucceeded++
			}
			if event.Outcome != nil && *event.Outcome == OutcomeFailed {
				summary.ToolsFailed++
			}
			if event.DurationMS != nil {
				summary.DurationMS += *event.DurationMS
			}
		case TypeModelUsage:
			if event.InputTokens != nil {
				summary.InputTokens += *event.InputTokens
			}
			if event.OutputTokens != nil {
				summary.OutputTokens += *event.OutputTokens
			}
			if event.CostUSD != nil {
				summary.CostUSD += *event.CostUSD
				summary.CostKnown = true
			}
		case TypeSessionEnded:
		}
	}
	summary.Sessions = int64(len(sessions))
	return summary, nil
}
