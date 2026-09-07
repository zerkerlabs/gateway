package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/agent"
	"github.com/zerkerlabs/gateway/gateway/internal/auth/authtest"
	"github.com/zerkerlabs/gateway/gateway/internal/httpapi"
	"github.com/zerkerlabs/gateway/gateway/internal/invocation"
	"github.com/zerkerlabs/gateway/gateway/internal/receipt"
)

type apiInvocationReceipt struct {
	InvocationID string     `json:"invocation_id"`
	Attested     bool       `json:"attested"`
	Reason       string     `json:"reason"`
	ArtifactID   string     `json:"artifact_id"`
	Actor        string     `json:"actor"`
	SignedAt     *time.Time `json:"signed_at"`
	Verify       string     `json:"verify"`
}

// attestingEmitter records what it was asked to sign and reports a fixed
// artifact, standing in for the Treeship CLI.
type attestingEmitter struct {
	actor string
	id    string
}

func (e *attestingEmitter) Emit(ctx context.Context, r receipt.Receipt) error { return nil }

func (e *attestingEmitter) EmitAttested(ctx context.Context, r receipt.Receipt) (receipt.Attestation, error) {
	return receipt.Attestation{ArtifactID: e.id, Actor: e.actor, SignedAt: time.Now().UTC()}, nil
}

func (e *attestingEmitter) Actor() string { return e.actor }

func receiptMux(t *testing.T, emitter receipt.Emitter) (*http.ServeMux, *invocation.MemoryStore) {
	t.Helper()
	invStore := invocation.NewMemoryStore()
	h := httpapi.NewHandler(agent.NewMemoryStore(), slog.New(slog.NewTextHandler(io.Discard, nil))).
		WithProxy(&mockForwarder{}, invStore)
	if emitter != nil {
		h = h.WithReceipts(emitter)
	}
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux, invStore
}

func seedAttestedInvocation(t *testing.T, store *invocation.MemoryStore, artifactID string) *invocation.Invocation {
	t.Helper()
	inv := &invocation.Invocation{AgentID: "agt_1", Mode: invocation.ModeTransactional, Status: invocation.StatusSucceeded}
	if err := store.Create(context.Background(), testTenant, inv); err != nil {
		t.Fatalf("seed invocation: %v", err)
	}
	if artifactID != "" {
		signedAt := time.Now().UTC()
		if _, err := store.Update(context.Background(), testTenant, inv.ID, invocation.UpdateFields{
			ReceiptArtifactID: &artifactID,
			ReceiptSignedAt:   &signedAt,
		}); err != nil {
			t.Fatalf("attach receipt: %v", err)
		}
	}
	return inv
}

func getReceipt(t *testing.T, mux *http.ServeMux, id string) (*httptest.ResponseRecorder, apiInvocationReceipt) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/invocations/"+id+"/receipt", nil)
	req = req.WithContext(authtest.WithIdentity(req.Context(), testTenant, testUser))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var got apiInvocationReceipt
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode receipt: %v; body = %s", err, rec.Body.String())
		}
	}
	return rec, got
}

func TestInvocationReceipt_ReportsRecordedArtifact(t *testing.T) {
	t.Parallel()
	emitter := &attestingEmitter{actor: "agent://zerker-gateway", id: "art_abc123"}
	mux, store := receiptMux(t, emitter)
	inv := seedAttestedInvocation(t, store, "art_abc123")

	rec, got := getReceipt(t, mux, inv.ID)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if !got.Attested || got.ArtifactID != "art_abc123" {
		t.Errorf("attested/artifact = %v/%q, want true/art_abc123", got.Attested, got.ArtifactID)
	}
	if got.Actor != "agent://zerker-gateway" {
		t.Errorf("actor = %q, want the emitter's signing actor", got.Actor)
	}
	if got.Verify != "treeship verify art_abc123" {
		t.Errorf("verify = %q, want the artifact's verify command", got.Verify)
	}
	if got.SignedAt == nil {
		t.Error("signed_at = null on an attested receipt")
	}
	if got.Reason != "" {
		t.Errorf("reason = %q on an attested receipt, want empty", got.Reason)
	}
}

// A gateway that never signs must say so, rather than leaving the client to
// read a blank field as "the receipt is missing".
func TestInvocationReceipt_ReceiptsDisabled(t *testing.T) {
	t.Parallel()
	mux, store := receiptMux(t, nil)
	inv := seedAttestedInvocation(t, store, "")

	rec, got := getReceipt(t, mux, inv.ID)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got.Attested {
		t.Error("attested = true with no emitter attached")
	}
	if got.Reason != "receipts_disabled" {
		t.Errorf("reason = %q, want receipts_disabled", got.Reason)
	}
	if got.Verify != "" || got.ArtifactID != "" {
		t.Errorf("artifact/verify populated with nothing signed: %q/%q", got.ArtifactID, got.Verify)
	}
}

// Receipts on, but no reference for this row: a different fact from "this
// gateway does not sign", and reported as such.
func TestInvocationReceipt_NotRecorded(t *testing.T) {
	t.Parallel()
	mux, store := receiptMux(t, &attestingEmitter{actor: "agent://zerker-gateway", id: "art_x"})
	inv := seedAttestedInvocation(t, store, "")

	_, got := getReceipt(t, mux, inv.ID)
	if got.Attested {
		t.Error("attested = true with no artifact reference recorded")
	}
	if got.Reason != "not_recorded" {
		t.Errorf("reason = %q, want not_recorded", got.Reason)
	}
}

// Invariant #2: another tenant's invocation is not found, and the receipt
// route must not become the one place that confirms it exists.
func TestInvocationReceipt_CrossTenantIsNotFound(t *testing.T) {
	t.Parallel()
	mux, store := receiptMux(t, &attestingEmitter{actor: "agent://zerker-gateway", id: "art_x"})
	inv := seedAttestedInvocation(t, store, "art_x")

	req := httptest.NewRequest(http.MethodGet, "/v1/invocations/"+inv.ID+"/receipt", nil)
	req = req.WithContext(authtest.WithIdentity(req.Context(), "another-tenant", testUser))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant receipt read = %d, want 404", rec.Code)
	}
}

func TestInvocationReceipt_UnknownIDIsNotFound(t *testing.T) {
	t.Parallel()
	mux, _ := receiptMux(t, nil)
	rec, _ := getReceipt(t, mux, "inv_01J00000000000000000000000")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}
