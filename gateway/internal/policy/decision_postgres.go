package policy

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zerkerlabs/gateway/gateway/internal/resource"
)

// decisionCols is the canonical column list for policy_decisions reads, shared
// by Insert's RETURNING and List's SELECT.
const decisionCols = `id, tenant_id, agent_id, protocol, mcp_tool, action, matched_rule, reason, created_at,
	receipt_artifact_id, receipt_signed_at`

// PostgresDecisionStore is a PostgreSQL-backed, tenant-scoped DecisionStore.
// Use NewPostgresDecisionStore to construct one; do not copy by value.
type PostgresDecisionStore struct {
	pool *pgxpool.Pool
}

// NewPostgresDecisionStore returns a PostgresDecisionStore that uses pool for
// all queries. pool must already be open; the caller closes it.
func NewPostgresDecisionStore(pool *pgxpool.Pool) *PostgresDecisionStore {
	return &PostgresDecisionStore{pool: pool}
}

// rowScanner abstracts pgx.Row and a pgx.Rows cursor so one scan helper serves
// both Insert (single RETURNING row) and List (a cursor).
type rowScanner interface {
	Scan(dest ...any) error
}

func scanDecision(row rowScanner) (*StoredDecision, error) {
	var (
		d       StoredDecision
		action  string
		mcpTool *string
	)
	if err := row.Scan(
		&d.ID, &d.TenantID, &d.AgentID, &d.Protocol, &mcpTool,
		&action, &d.MatchedRule, &d.Reason, &d.CreatedAt,
		&d.ReceiptArtifactID, &d.ReceiptSignedAt,
	); err != nil {
		return nil, err
	}
	d.Action = Action(action)
	d.MCPTool = mcpTool
	return &d, nil
}

// Insert implements DecisionStore.
func (s *PostgresDecisionStore) Insert(ctx context.Context, rd RecordedDecision) (*StoredDecision, error) {
	id, err := resource.New(decisionIDPrefix)
	if err != nil {
		return nil, err
	}

	row := s.pool.QueryRow(
		ctx, `
		INSERT INTO policy_decisions (id, tenant_id, agent_id, protocol, mcp_tool, action, matched_rule, reason, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
		RETURNING `+decisionCols,
		id, rd.TenantID, rd.AgentID, rd.Protocol, rd.MCPTool,
		string(rd.Decision.Action), rd.Decision.MatchedRule, rd.Decision.Reason,
	)
	d, err := scanDecision(row)
	if err != nil {
		return nil, fmt.Errorf("insert policy decision: %w", err)
	}
	return d, nil
}

// List implements DecisionStore. Tenant scoping is the WHERE clause: a row
// belonging to another tenant is simply never selected (invariant #2).
//
// The filter is applied in SQL rather than in Go so paging stays correct on a
// tenant with more decisions than fit in memory, and so the total is a COUNT
// over the same predicate rather than a walk of every row.
func (s *PostgresDecisionStore) List(ctx context.Context, tenantID string, f DecisionFilter) ([]*StoredDecision, int, error) {
	limit := f.Limit
	if limit < 1 {
		limit = decisionDefaultLimit
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}

	// Placeholders are numbered as the predicate is built; every value travels
	// as a bound parameter, never interpolated into the statement text.
	where := "tenant_id=$1"
	args := []any{tenantID}
	if !f.Since.IsZero() {
		args = append(args, f.Since)
		where += fmt.Sprintf(" AND created_at>=$%d", len(args))
	}
	if !f.Until.IsZero() {
		args = append(args, f.Until)
		where += fmt.Sprintf(" AND created_at<=$%d", len(args))
	}
	if f.Action != "" {
		args = append(args, string(f.Action))
		where += fmt.Sprintf(" AND action=$%d", len(args))
	}
	if f.AgentID != "" {
		args = append(args, f.AgentID)
		where += fmt.Sprintf(" AND agent_id=$%d", len(args))
	}

	var total int
	if err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM policy_decisions WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count policy decisions: %w", err)
	}

	pageArgs := append(append([]any{}, args...), limit, offset)
	rows, err := s.pool.Query(
		ctx,
		`SELECT `+decisionCols+` FROM policy_decisions WHERE `+where+
			fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d OFFSET $%d", len(args)+1, len(args)+2),
		pageArgs...,
	)
	if err != nil {
		return nil, 0, fmt.Errorf("list policy decisions: %w", err)
	}
	defer rows.Close()

	var out []*StoredDecision
	for rows.Next() {
		d, err := scanDecision(rows)
		if err != nil {
			return nil, 0, fmt.Errorf("scan policy decision: %w", err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate policy decisions: %w", err)
	}
	return out, total, nil
}

// AttachReceipt implements DecisionStore. The tenant predicate is in the WHERE
// clause, so a decision belonging to another tenant is not updated and not
// reported — the same non-answer a cross-tenant read gets (invariant #2).
func (s *PostgresDecisionStore) AttachReceipt(ctx context.Context, tenantID, id, artifactID string, signedAt time.Time) error {
	_, err := s.pool.Exec(
		ctx,
		`UPDATE policy_decisions SET receipt_artifact_id=$3, receipt_signed_at=$4
		  WHERE id=$1 AND tenant_id=$2`,
		id, tenantID, artifactID, signedAt.UTC(),
	)
	if err != nil {
		return fmt.Errorf("attach decision receipt: %w", err)
	}
	return nil
}
