package policy

import (
	"context"
	"sync"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/resource"
)

// MemoryDecisionStore is a thread-safe, tenant-scoped, in-memory
// DecisionStore. Intended for unit tests and the in-memory dev server; it does
// not persist across restarts.
type MemoryDecisionStore struct {
	mu sync.RWMutex
	// records holds each tenant's decisions in insertion order (oldest first),
	// so List can walk from the end for most-recent-first without relying
	// on timestamp resolution to order decisions recorded in the same instant.
	records map[string][]*StoredDecision
}

// NewMemoryDecisionStore returns an empty MemoryDecisionStore ready for use.
func NewMemoryDecisionStore() *MemoryDecisionStore {
	return &MemoryDecisionStore{records: make(map[string][]*StoredDecision)}
}

// Insert implements DecisionStore.
func (s *MemoryDecisionStore) Insert(ctx context.Context, d RecordedDecision) (*StoredDecision, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id, err := resource.New(decisionIDPrefix)
	if err != nil {
		return nil, err
	}

	rec := storedFromRecorded(id, d, time.Now().UTC())

	s.mu.Lock()
	defer s.mu.Unlock()
	s.records[d.TenantID] = append(s.records[d.TenantID], rec)
	return cloneStoredDecision(rec), nil
}

// List implements DecisionStore. It walks the tenant's records newest-first,
// applies the filter, and pages the survivors — counting every match so the
// caller learns how many decisions the window holds, not just how many fit on
// this page.
func (s *MemoryDecisionStore) List(ctx context.Context, tenantID string, f DecisionFilter) ([]*StoredDecision, int, error) {
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	limit := f.Limit
	if limit < 1 {
		limit = decisionDefaultLimit
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	all := s.records[tenantID]
	out := make([]*StoredDecision, 0, min(limit, len(all)))
	total := 0
	// Walk newest → oldest (records is oldest-first). Counting continues past
	// the page so total reflects the filter, not the page size.
	for i := len(all) - 1; i >= 0; i-- {
		d := all[i]
		if !decisionMatches(d, f) {
			continue
		}
		total++
		if total <= offset || len(out) >= limit {
			continue
		}
		out = append(out, cloneStoredDecision(d))
	}
	return out, total, nil
}

// AttachReceipt implements DecisionStore.
func (s *MemoryDecisionStore) AttachReceipt(ctx context.Context, tenantID, id, artifactID string, signedAt time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, d := range s.records[tenantID] {
		if d.ID == id {
			d.ReceiptArtifactID = &artifactID
			t := signedAt.UTC()
			d.ReceiptSignedAt = &t
			return nil
		}
	}
	return nil
}

// decisionMatches reports whether d satisfies every set field of f. An unset
// field never excludes a row.
func decisionMatches(d *StoredDecision, f DecisionFilter) bool {
	if !f.Since.IsZero() && d.CreatedAt.Before(f.Since) {
		return false
	}
	if !f.Until.IsZero() && d.CreatedAt.After(f.Until) {
		return false
	}
	if f.Action != "" && d.Action != f.Action {
		return false
	}
	if f.AgentID != "" && d.AgentID != f.AgentID {
		return false
	}
	return true
}

// cloneStoredDecision returns a copy of d, including its MCPTool pointer, so a
// stored record never aliases a caller's memory.
func cloneStoredDecision(d *StoredDecision) *StoredDecision {
	c := *d
	if d.ReceiptArtifactID != nil {
		id := *d.ReceiptArtifactID
		c.ReceiptArtifactID = &id
	}
	if d.ReceiptSignedAt != nil {
		t := *d.ReceiptSignedAt
		c.ReceiptSignedAt = &t
	}
	if d.MCPTool != nil {
		tool := *d.MCPTool
		c.MCPTool = &tool
	}
	return &c
}
