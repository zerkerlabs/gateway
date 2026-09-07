package httpapi

import (
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/auth"
	"github.com/zerkerlabs/gateway/gateway/internal/invocation"
)

// maxAnalyticsRange caps the [since, until] window a single /v1/analytics query
// may span. Percentile aggregation scans every row in the range, so an unbounded
// window is an availability risk; 31 days is the v1 cap (spec 0003 decision 4).
const maxAnalyticsRange = 31 * 24 * time.Hour

// analyticsResponse is the body returned by GET /v1/analytics.
type analyticsResponse struct {
	Range  analyticsRange   `json:"range"`
	Bucket string           `json:"bucket"`
	Groups []analyticsGroup `json:"groups"`

	// Totals aggregates the whole window in one cell. It is not the sum of
	// Groups and a client must not try to derive it from them: counts would
	// add up, but percentiles do not merge without the samples behind them, so
	// a multi-bucket p95 is only available here.
	Totals analyticsTotals `json:"totals"`
}

type analyticsRange struct {
	Since time.Time `json:"since"`
	Until time.Time `json:"until"`
}

// analyticsGroup is one (agent_id, bucket_start) cell. ErrorRate is
// ErrorCount/Count in [0,1]. Latency/TTFT percentiles are null when no row in
// the group carried the metric (e.g. all rows in-flight).
type analyticsGroup struct {
	AgentID      string                 `json:"agent_id"`
	BucketStart  time.Time              `json:"bucket_start"`
	Count        int                    `json:"count"`
	ErrorRate    float64                `json:"error_rate"`
	ByErrorClass map[string]int         `json:"by_error_class"`
	LatencyMS    invocation.Percentiles `json:"latency_ms"`
	TTFTMS       invocation.Percentiles `json:"ttft_ms"`
}

// analyticsTotals is the window-level aggregate: every invocation in
// [since, until], regardless of bucket. Percentiles are computed over every
// sample in the range, which is what makes a 7-day p95 a number the caller can
// render rather than one it has to refuse to guess at.
//
// Bytes sum only rows that recorded a size, matching the percentile rule: an
// in-flight invocation counts once in Count and contributes to nothing else.
type analyticsTotals struct {
	Count         int                    `json:"count"`
	ErrorRate     float64                `json:"error_rate"`
	ByErrorClass  map[string]int         `json:"by_error_class"`
	LatencyMS     invocation.Percentiles `json:"latency_ms"`
	TTFTMS        invocation.Percentiles `json:"ttft_ms"`
	RequestBytes  int64                  `json:"request_bytes"`
	ResponseBytes int64                  `json:"response_bytes"`
}

// handleAnalytics handles GET /v1/analytics. It returns aggregate metrics over
// the caller's tenant, grouped by agent_id and a time bucket (spec 0003). The
// endpoint is OAuth-gated, tenant-scoped, carries its own tighter per-caller
// rate limit, and requires a `since` bound with a capped range.
func (h *Handler) handleAnalytics(w http.ResponseWriter, r *http.Request) {
	tenant := auth.TenantFromContext(r.Context())
	user := auth.UserFromContext(r.Context())
	if tenant == "" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	// Tighter per-caller rate limit than the global /v1 limiter: percentile
	// aggregation is heavier than a row fetch (spec 0003 decision 4).
	if h.analyticsLimiter != nil {
		if delay := h.analyticsLimiter.Allow(tenant + "\x00" + user); delay > 0 {
			retryAfter := int(math.Ceil(delay.Seconds()))
			if retryAfter > proxyRetryAfterCap {
				retryAfter = proxyRetryAfterCap
			}
			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			writeError(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
	}

	q := r.URL.Query()

	// group_by: agent_id is the only supported dimension in v1 (spec 0003
	// decision 2). An explicit other value is rejected rather than ignored.
	if gb := q.Get("group_by"); gb != "" && gb != "agent_id" {
		writeError(w, http.StatusBadRequest, "invalid group_by: only agent_id is supported")
		return
	}

	// bucket: hour (default) or day.
	var bucket invocation.Bucket
	switch q.Get("bucket") {
	case "", "hour":
		bucket = invocation.BucketHour
	case "day":
		bucket = invocation.BucketDay
	default:
		writeError(w, http.StatusBadRequest, "invalid bucket: must be one of hour, day")
		return
	}

	// since is required (spec 0003 decision 3).
	sinceStr := q.Get("since")
	if sinceStr == "" {
		writeError(w, http.StatusBadRequest, "since is required (RFC 3339 timestamp)")
		return
	}
	since, err := time.Parse(time.RFC3339, sinceStr)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid since: must be RFC 3339 timestamp")
		return
	}

	// until defaults to now when absent.
	until := time.Now().UTC()
	if uv := q.Get("until"); uv != "" {
		until, err = time.Parse(time.RFC3339, uv)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid until: must be RFC 3339 timestamp")
			return
		}
	}

	if since.After(until) {
		writeError(w, http.StatusBadRequest, "since must not be after until")
		return
	}
	if until.Sub(since) > maxAnalyticsRange {
		writeError(w, http.StatusBadRequest, "range exceeds the maximum of 31 days")
		return
	}

	result, err := h.invocations.Aggregate(r.Context(), tenant, invocation.AggregateQuery{
		Bucket: bucket,
		Since:  since,
		Until:  until,
	})
	if err != nil {
		h.logger.Error("analytics: aggregate", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	totalsByErrorClass := make(map[string]int, len(result.Totals.ByErrorClass))
	for ec, n := range result.Totals.ByErrorClass {
		totalsByErrorClass[string(ec)] = n
	}
	var totalsErrorRate float64
	if result.Totals.Count > 0 {
		totalsErrorRate = float64(result.Totals.ErrorCount) / float64(result.Totals.Count)
	}

	resp := analyticsResponse{
		Range:  analyticsRange{Since: since, Until: until},
		Bucket: string(bucket),
		Groups: make([]analyticsGroup, 0, len(result.Groups)),
		Totals: analyticsTotals{
			Count:         result.Totals.Count,
			ErrorRate:     totalsErrorRate,
			ByErrorClass:  totalsByErrorClass,
			LatencyMS:     result.Totals.LatencyMS,
			TTFTMS:        result.Totals.TTFTMS,
			RequestBytes:  result.Totals.RequestBytes,
			ResponseBytes: result.Totals.ResponseBytes,
		},
	}
	for _, g := range result.Groups {
		byErrorClass := make(map[string]int, len(g.ByErrorClass))
		for ec, n := range g.ByErrorClass {
			byErrorClass[string(ec)] = n
		}
		var errorRate float64
		if g.Count > 0 {
			errorRate = float64(g.ErrorCount) / float64(g.Count)
		}
		resp.Groups = append(resp.Groups, analyticsGroup{
			AgentID:      g.AgentID,
			BucketStart:  g.BucketStart,
			Count:        g.Count,
			ErrorRate:    errorRate,
			ByErrorClass: byErrorClass,
			LatencyMS:    g.LatencyMS,
			TTFTMS:       g.TTFTMS,
		})
	}

	writeJSON(w, http.StatusOK, resp)
}
