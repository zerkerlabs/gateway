package agentevent

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zerkerlabs/gateway/gateway/internal/resource"
)

// PostgresStore is the durable PostgreSQL implementation of Store.
type PostgresStore struct {
	pool *pgxpool.Pool
}

// NewPostgresStore returns a store backed by an open pool.
func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{pool: pool}
}

// Create records one event idempotently within a tenant.
func (s *PostgresStore) Create(ctx context.Context, tenantID string, event *Event) error {
	id, err := resource.New("evt")
	if err != nil {
		return err
	}
	row := s.pool.QueryRow(ctx, `
		INSERT INTO agent_events (
			id, tenant_id, agent_id, client_event_id, schema_name, event_type,
			session_ref, occurred_at, tool_name, outcome, duration_ms, provider,
			model, input_tokens, output_tokens, cache_read_tokens,
			cache_write_tokens, cost_usd, source, source_version
		) VALUES (
			$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
		)
		RETURNING received_at
	`, id, tenantID, event.AgentID, event.ClientEventID, event.Schema, string(event.Type),
		event.SessionRef, event.OccurredAt, event.ToolName, event.Outcome, event.DurationMS,
		event.Provider, event.Model, event.InputTokens, event.OutputTokens,
		event.CacheReadTokens, event.CacheWriteTokens, event.CostUSD, event.Source,
		event.SourceVersion)
	if err := row.Scan(&event.ReceivedAt); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			if pgErr.Code == "23505" && pgErr.ConstraintName == "agent_events_tenant_client_unique" {
				return ErrDuplicate
			}
			if pgErr.Code == "23503" {
				return ErrNotFound
			}
		}
		return fmt.Errorf("insert agent event: %w", err)
	}
	event.ID = id
	event.TenantID = tenantID
	return nil
}

// Summary aggregates one agent's events over the half-open time window.
func (s *PostgresStore) Summary(ctx context.Context, tenantID, agentID string, since, until time.Time) (Summary, error) {
	var summary Summary
	err := s.pool.QueryRow(ctx, `
		SELECT
			COUNT(DISTINCT session_ref) FILTER (WHERE event_type = 'session.started'),
			COUNT(*) FILTER (WHERE event_type = 'tool.completed'),
			COUNT(*) FILTER (WHERE event_type = 'tool.completed' AND outcome = 'succeeded'),
			COUNT(*) FILTER (WHERE event_type = 'tool.completed' AND outcome = 'failed'),
			COALESCE(SUM(duration_ms) FILTER (WHERE event_type = 'tool.completed'), 0),
			COALESCE(SUM(input_tokens) FILTER (WHERE event_type = 'model.usage'), 0),
			COALESCE(SUM(output_tokens) FILTER (WHERE event_type = 'model.usage'), 0),
			COALESCE(SUM(cost_usd) FILTER (WHERE event_type = 'model.usage'), 0),
			COUNT(cost_usd) FILTER (WHERE event_type = 'model.usage') > 0,
			(SELECT MAX(received_at) FROM agent_events all_events
			 WHERE all_events.tenant_id=$1 AND all_events.agent_id=$2)
		FROM agent_events
		WHERE tenant_id=$1 AND agent_id=$2 AND occurred_at >= $3 AND occurred_at < $4
	`, tenantID, agentID, since, until).Scan(
		&summary.Sessions, &summary.ToolCalls, &summary.ToolsSucceeded,
		&summary.ToolsFailed, &summary.DurationMS, &summary.InputTokens,
		&summary.OutputTokens, &summary.CostUSD, &summary.CostKnown, &summary.LastEventAt,
	)
	if err != nil {
		return Summary{}, fmt.Errorf("summarize agent events: %w", err)
	}
	return summary, nil
}
