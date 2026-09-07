package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/invocation"
)

type apiAnalyticsTotals struct {
	Count        int            `json:"count"`
	ErrorRate    float64        `json:"error_rate"`
	ByErrorClass map[string]int `json:"by_error_class"`
	LatencyMS    struct {
		P50 *int64 `json:"p50"`
		P95 *int64 `json:"p95"`
		P99 *int64 `json:"p99"`
	} `json:"latency_ms"`
	RequestBytes  int64 `json:"request_bytes"`
	ResponseBytes int64 `json:"response_bytes"`
}

type apiAnalyticsWithTotals struct {
	Groups []json.RawMessage  `json:"groups"`
	Totals apiAnalyticsTotals `json:"totals"`
}

func seedForTotals(t *testing.T, store *invocation.MemoryStore, status invocation.Status, latency, reqSize, respSize int64) {
	t.Helper()
	inv := &invocation.Invocation{AgentID: "agt_a", Mode: invocation.ModeTransactional, Status: invocation.StatusPending}
	if err := store.Create(context.Background(), testTenant, inv); err != nil {
		t.Fatalf("seed: %v", err)
	}
	ec := invocation.ErrorClassTimeout
	fields := invocation.UpdateFields{
		Status:       &status,
		LatencyMS:    &latency,
		RequestSize:  &reqSize,
		ResponseSize: &respSize,
	}
	if status == invocation.StatusFailed {
		fields.ErrorClass = &ec
	}
	if _, err := store.Update(context.Background(), testTenant, inv.ID, fields); err != nil {
		t.Fatalf("seed update: %v", err)
	}
}

func decodeTotals(t *testing.T, body []byte) apiAnalyticsWithTotals {
	t.Helper()
	var got apiAnalyticsWithTotals
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode analytics: %v; body = %s", err, body)
	}
	return got
}

// The point of window totals: a p95 spanning several buckets is only
// computable from the samples, so it must come from the server. This seeds
// rows across two hours and asserts the total is over all of them, not over
// either bucket alone.
func TestAnalyticsTotals_PercentilesSpanEveryBucket(t *testing.T) {
	t.Parallel()
	mux, store := newAnalyticsHandler(t, nil)

	now := time.Now().UTC()
	for _, latency := range []int64{10, 20, 30, 40} {
		seedForTotals(t, store, invocation.StatusSucceeded, latency, 100, 200)
	}

	since := now.Add(-2 * time.Hour).Format(time.RFC3339)
	rec := getAnalytics(t, mux, "bucket=hour&since="+since)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	got := decodeTotals(t, rec.Body.Bytes())

	if got.Totals.Count != 4 {
		t.Errorf("totals.count = %d, want 4", got.Totals.Count)
	}
	if got.Totals.LatencyMS.P50 == nil || got.Totals.LatencyMS.P95 == nil {
		t.Fatalf("totals percentiles are null with 4 samples recorded: %+v", got.Totals.LatencyMS)
	}
	// Nearest-rank over [10,20,30,40]: p50 = 20, p95 = p99 = 40.
	if *got.Totals.LatencyMS.P50 != 20 {
		t.Errorf("totals p50 = %d, want 20", *got.Totals.LatencyMS.P50)
	}
	if *got.Totals.LatencyMS.P95 != 40 {
		t.Errorf("totals p95 = %d, want 40", *got.Totals.LatencyMS.P95)
	}
	if got.Totals.RequestBytes != 400 || got.Totals.ResponseBytes != 800 {
		t.Errorf("totals bytes = %d/%d, want 400/800", got.Totals.RequestBytes, got.Totals.ResponseBytes)
	}
}

func TestAnalyticsTotals_ErrorRateAndClasses(t *testing.T) {
	t.Parallel()
	mux, store := newAnalyticsHandler(t, nil)

	now := time.Now().UTC()
	seedForTotals(t, store, invocation.StatusSucceeded, 10, 1, 1)
	seedForTotals(t, store, invocation.StatusSucceeded, 10, 1, 1)
	seedForTotals(t, store, invocation.StatusFailed, 10, 1, 1)

	since := now.Add(-time.Hour).Format(time.RFC3339)
	got := decodeTotals(t, getAnalytics(t, mux, "since="+since).Body.Bytes())

	if got.Totals.Count != 3 {
		t.Fatalf("totals.count = %d, want 3", got.Totals.Count)
	}
	if got.Totals.ErrorRate < 0.33 || got.Totals.ErrorRate > 0.34 {
		t.Errorf("totals.error_rate = %v, want ~1/3", got.Totals.ErrorRate)
	}
	if got.Totals.ByErrorClass["timeout"] != 1 {
		t.Errorf("totals.by_error_class = %v, want one timeout", got.Totals.ByErrorClass)
	}
}

// An empty window must report zeroes and null percentiles, not absent fields:
// "no traffic" is a real answer and a client should be able to render it
// without distinguishing it from a malformed response.
func TestAnalyticsTotals_EmptyWindow(t *testing.T) {
	t.Parallel()
	mux, _ := newAnalyticsHandler(t, nil)

	since := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	got := decodeTotals(t, getAnalytics(t, mux, "since="+since).Body.Bytes())

	if got.Totals.Count != 0 || got.Totals.ErrorRate != 0 {
		t.Errorf("empty window totals = %+v, want zeroed", got.Totals)
	}
	if got.Totals.LatencyMS.P50 != nil {
		t.Errorf("empty window p50 = %v, want null", *got.Totals.LatencyMS.P50)
	}
}
