//go:build integration

package agentevent

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zerkerlabs/gateway/gateway/db"
	"github.com/zerkerlabs/gateway/gateway/internal/agent"
)

func TestPostgresSummaryWindowAndPartialCost(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `TRUNCATE TABLE agents CASCADE`); err != nil {
		t.Fatal(err)
	}

	agentStore := agent.NewPostgresStore(pool)
	registered := &agent.Agent{Name: "Hermes", CreatedBy: "tester"}
	if err := agentStore.Create(ctx, "tenant", registered); err != nil {
		t.Fatal(err)
	}
	store := NewPostgresStore(pool)
	now := time.Now().UTC().Truncate(time.Second)
	cost := 0.25
	input := int64(10)
	events := []*Event{
		{AgentID: registered.ID, ClientEventID: "current", Schema: SchemaV1, Type: TypeSessionStarted, SessionRef: "sha256:current", OccurredAt: now, Source: "test", SourceVersion: "1"},
		{AgentID: registered.ID, ClientEventID: "known", Schema: SchemaV1, Type: TypeModelUsage, SessionRef: "sha256:current", OccurredAt: now, InputTokens: &input, CostUSD: &cost, Source: "test", SourceVersion: "1"},
		{AgentID: registered.ID, ClientEventID: "unknown", Schema: SchemaV1, Type: TypeModelUsage, SessionRef: "sha256:current", OccurredAt: now, InputTokens: &input, Source: "test", SourceVersion: "1"},
		{AgentID: registered.ID, ClientEventID: "stale", Schema: SchemaV1, Type: TypeSessionStarted, SessionRef: "sha256:stale", OccurredAt: now.Add(-2 * time.Hour), Source: "test", SourceVersion: "1"},
	}
	for _, event := range events {
		if err := store.Create(ctx, "tenant", event); err != nil {
			t.Fatal(err)
		}
	}
	staleReceivedAt := now.Add(time.Hour)
	if _, err := pool.Exec(ctx, `UPDATE agent_events SET received_at=$1 WHERE tenant_id=$2 AND client_event_id=$3`, staleReceivedAt, "tenant", "stale"); err != nil {
		t.Fatal(err)
	}

	summary, err := store.Summary(ctx, "tenant", registered.ID, now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if summary.Sessions != 1 || summary.LastEventAt == nil || !summary.LastEventAt.Before(staleReceivedAt) || summary.CostKnown || summary.CostUSD != cost || summary.InputTokens != 20 {
		t.Fatalf("summary = %#v", summary)
	}
}
