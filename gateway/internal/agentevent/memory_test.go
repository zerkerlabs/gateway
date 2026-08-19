package agentevent

import (
	"context"
	"testing"
	"time"
)

func TestMemorySummaryLastEventRespectsRequestedWindow(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore()
	now := time.Now().UTC()
	current := &Event{AgentID: "agent", ClientEventID: "current", Type: TypeSessionStarted, SessionRef: "sha256:current", OccurredAt: now}
	stale := &Event{AgentID: "agent", ClientEventID: "stale", Type: TypeSessionStarted, SessionRef: "sha256:stale", OccurredAt: now.Add(-2 * time.Hour)}
	if err := store.Create(context.Background(), "tenant", current); err != nil {
		t.Fatal(err)
	}
	if err := store.Create(context.Background(), "tenant", stale); err != nil {
		t.Fatal(err)
	}

	summary, err := store.Summary(context.Background(), "tenant", "agent", now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if summary.Sessions != 1 || summary.LastEventAt == nil || !summary.LastEventAt.Equal(current.ReceivedAt) {
		t.Fatalf("summary = %#v, current received_at = %s", summary, current.ReceivedAt)
	}
}

func TestMemorySummaryCostKnownRequiresEveryUsageEventCost(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore()
	now := time.Now().UTC()
	cost := 0.25
	input := int64(10)
	for _, event := range []*Event{
		{AgentID: "agent", ClientEventID: "known", Type: TypeModelUsage, SessionRef: "sha256:one", OccurredAt: now, InputTokens: &input, CostUSD: &cost},
		{AgentID: "agent", ClientEventID: "unknown", Type: TypeModelUsage, SessionRef: "sha256:two", OccurredAt: now, InputTokens: &input},
	} {
		if err := store.Create(context.Background(), "tenant", event); err != nil {
			t.Fatal(err)
		}
	}

	summary, err := store.Summary(context.Background(), "tenant", "agent", now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if summary.CostKnown || summary.CostUSD != cost || summary.InputTokens != 20 {
		t.Fatalf("summary = %#v, want partial cost marked unavailable", summary)
	}
}
