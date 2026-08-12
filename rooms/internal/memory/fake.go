package memory

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Reasons a Fake's PrepareContext reports in Omissions.Reasons for a memory
// it did not admit.
const (
	reasonPendingReview = "pending_review"
	reasonBudget        = "budget"
)

// abstainReason is the Omissions.Abstention text a Fake reports when a test
// has forced StateAbstained via SetAbstain.
const abstainReason = "evidence conflicted"

// fakeKey identifies one (room, agent) pair within a Fake.
type fakeKey struct {
	roomID, agentID string
}

// storedMemory is one memory item kept by a Fake, in the order it was
// written — the only order the fake keeps, and the order PrepareContext
// returns admitted items in.
type storedMemory struct {
	Memory
	// agentID scopes this memory to one member's private partition within
	// its room; empty means room-shared, visible to every agent's
	// PrepareContext call for that room. Propose and Record derive it from
	// the request's Visibility, not from AgentID directly — AgentID is
	// always the contributor and is required regardless of visibility, so a
	// room-shared write still names who wrote it, it just is not scoped to
	// them here.
	agentID string
	// eligible is fixed at write time: Record and Seed are eligible for
	// admission, Propose never is — proposed content is quarantined pending
	// review, so PrepareContext always reports it as withheld.
	eligible bool
}

// Fake is a thread-safe, in-memory Store. It stands in for one tenant-local
// backend deployment: Store's contract treats the tenant as backend
// configuration, never caller input, so a Fake instance is scoped to a
// single simulated tenant the same way a real deployment is. Two Fake
// instances never share state, even given identical room and agent IDs.
//
// The fake has no ranking or policy engine, but it is purpose-sensitive: a
// memory whose content shares no token with the request's Purpose is never
// retrieved at all, the same as a real backend's retrieval query returning
// nothing relevant. Among what matches, PrepareContext admits eligible
// memories in write order up to the requested budget and computes State from
// the result — except StateAbstained, which is a policy judgment about
// conflicting evidence no fake can derive from content, so a test drives it
// directly with SetAbstain.
type Fake struct {
	mu       sync.Mutex
	memories map[string][]storedMemory // keyed by RoomID, in write order
	abstain  map[fakeKey]bool
	nextID   int
}

// NewFake returns an empty Fake ready for use.
func NewFake() *Fake {
	return &Fake{
		memories: make(map[string][]storedMemory),
		abstain:  make(map[fakeKey]bool),
	}
}

// Seed installs an already-eligible memory directly into roomID's store, at
// whatever CreatedAt m carries, bypassing Propose and Record. It exists so a
// test can construct a specific returned order — including one that is not
// sorted by CreatedAt — since Propose and Record always timestamp with the
// current time and the fake has no ranking policy that would otherwise
// produce a non-chronological one. agentID scopes the memory to one member's
// private partition; empty means room-shared.
func (f *Fake) Seed(roomID, agentID string, m Memory) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.memories[roomID] = append(f.memories[roomID], storedMemory{Memory: m, agentID: agentID, eligible: true})
}

// SetAbstain forces PrepareContext to return StateAbstained for roomID and
// agentID, regardless of what is stored. Abstention is a policy judgment
// about conflicting evidence that the fake has no engine to derive from
// content, so a test drives it directly.
func (f *Fake) SetAbstain(roomID, agentID string) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.abstain[fakeKey{roomID, agentID}] = true
}

// PrepareContext implements Store.
func (f *Fake) PrepareContext(ctx context.Context, req PrepareRequest) (ContextResult, error) {
	if err := ctx.Err(); err != nil {
		return ContextResult{}, err
	}
	if req.Purpose == "" {
		return ContextResult{}, ErrPurposeRequired
	}

	f.mu.Lock()
	defer f.mu.Unlock()

	if f.abstain[fakeKey{req.RoomID, req.AgentID}] {
		result := ContextResult{
			State:     StateAbstained,
			Memories:  []Memory{},
			Omissions: Omissions{Abstention: abstainReason},
		}
		result.Commitment = commitmentFor(req.RoomID, req.AgentID, result)
		return result, nil
	}

	result := ContextResult{Memories: []Memory{}}
	reasons := make(map[string]struct{})
	var budgetSpent int
	for _, m := range f.memories[req.RoomID] {
		if m.agentID != "" && m.agentID != req.AgentID {
			continue
		}
		if !matchesPurpose(m.Content, req.Purpose) {
			// Not retrieved at all: a real backend's retrieval query found
			// nothing relevant here, which is a different outcome from
			// finding it and withholding it, and must not be counted as
			// either.
			continue
		}
		result.Counts.Retrieved++

		if !m.eligible {
			result.Counts.Withheld++
			reasons[reasonPendingReview] = struct{}{}
			continue
		}

		cost := len(m.Content) // a crude, deterministic token proxy — good enough for a fake
		if req.ContextBudgetTokens > 0 && budgetSpent+cost > req.ContextBudgetTokens {
			result.Counts.BudgetDropped++
			reasons[reasonBudget] = struct{}{}
			continue
		}

		budgetSpent += cost
		result.Counts.Admitted++
		result.Memories = append(result.Memories, m.Memory)
	}

	result.Omissions.Reasons = sortedReasons(reasons)
	result.State = stateFor(result.Counts)
	result.Commitment = commitmentFor(req.RoomID, req.AgentID, result)
	return result, nil
}

// stateFor derives a State from a Fake's naturally computed Counts. It never
// returns StateAbstained: PrepareContext handles that case before counting,
// since abstention is not something these counts can express.
func stateFor(c Counts) State {
	switch {
	case c.Retrieved == 0:
		return StateEmpty
	case c.Admitted == c.Retrieved:
		return StateReady
	case c.Admitted > 0:
		return StatePartial
	case c.BudgetDropped == c.Retrieved:
		return StateBudgetExhausted
	default:
		return StateBlocked
	}
}

// matchesPurpose reports whether content is relevant to purpose, standing in
// for a real backend's FTS retrieval: purpose is split into lowercase word
// tokens, and content matches if it contains any one of them as a substring.
// This has none of a real backend's ranking, but it is enough to make the
// fake reject what a real retrieval query would never surface, which is the
// property that matters here — see the package doc.
func matchesPurpose(content, purpose string) bool {
	lowerContent := strings.ToLower(content)
	for _, tok := range strings.Fields(strings.ToLower(purpose)) {
		tok = strings.Trim(tok, ".,!?;:\"'()")
		if tok == "" {
			continue
		}
		if strings.Contains(lowerContent, tok) {
			return true
		}
	}
	return false
}

func sortedReasons(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for r := range set {
		out = append(out, r)
	}
	sort.Strings(out)
	return out
}

// commitmentFor computes a deterministic, opaque digest over a prepared
// context. It has no relationship to a real backend's wire format — pinning
// that is the concern of the client that speaks to one, not this fake.
func commitmentFor(roomID, agentID string, result ContextResult) Commitment {
	h := sha256.New()
	h.Write([]byte(roomID + "\x00" + agentID + "\x00" + string(result.State)))
	for _, m := range result.Memories {
		h.Write([]byte("\x00" + m.ID))
	}
	return Commitment{Digest: "sha256:" + hex.EncodeToString(h.Sum(nil))}
}

// Propose implements Store: it records content as a candidate memory,
// quarantined until reviewed. The fake reports it as withheld pending review
// rather than admitting it — Propose never makes content authoritative on
// its own.
func (f *Fake) Propose(ctx context.Context, req ProposeRequest) (WriteResult, error) {
	return f.write(ctx, req.RoomID, req.AgentID, req.Visibility, req.Content, "proposed", false)
}

// Record implements Store: it records content as an accepted transition,
// active immediately — Record is for content Rooms itself is asserting, so
// it carries no review step.
func (f *Fake) Record(ctx context.Context, req RecordRequest) (WriteResult, error) {
	return f.write(ctx, req.RoomID, req.AgentID, req.Visibility, req.Content, "recorded", true)
}

func (f *Fake) write(ctx context.Context, roomID, agentID string, visibility Visibility, content, provenance string, eligible bool) (WriteResult, error) {
	if err := ctx.Err(); err != nil {
		return WriteResult{}, err
	}
	if agentID == "" {
		return WriteResult{}, ErrAgentIDRequired
	}

	// scopeAgentID is the storedMemory visibility scope, not the
	// contributor: room-shared content is still attributed to agentID, it is
	// just not restricted to their own PrepareContext calls.
	scopeAgentID := ""
	if visibility == VisibilityMember {
		scopeAgentID = agentID
	}

	f.mu.Lock()
	defer f.mu.Unlock()

	f.nextID++
	result := WriteResult{ID: fmt.Sprintf("mem_%d", f.nextID), CreatedAt: time.Now().UTC()}
	f.memories[roomID] = append(f.memories[roomID], storedMemory{
		Memory:   Memory{ID: result.ID, Content: content, Provenance: provenance, CreatedAt: result.CreatedAt},
		agentID:  scopeAgentID,
		eligible: eligible,
	})
	return result, nil
}
