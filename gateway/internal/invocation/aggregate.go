package invocation

import (
	"math"
	"sort"
	"time"
)

// Bucket is the time-bucket granularity for analytics aggregation (spec 0003).
type Bucket string

const (
	// BucketHour groups invocations by the UTC hour of their created_at.
	BucketHour Bucket = "hour"
	// BucketDay groups invocations by the UTC calendar day of their created_at.
	BucketDay Bucket = "day"
)

// AggregateQuery parameterises Store.Aggregate. The MVP groups by agent_id plus
// a time bucket (spec 0003 scoping decision 2); Since/Until bound created_at
// inclusively. Since is required and validated at the API boundary; Until
// defaults to "now" at the call site.
type AggregateQuery struct {
	Bucket Bucket
	Since  time.Time
	Until  time.Time
}

// Percentiles holds p50/p95/p99 of a metric, in the metric's unit (milliseconds
// for both latency and ttft). A field is nil when no sample contributed — e.g.
// a group whose rows are all in-flight (no latency), or non-streaming rows for
// ttft.
type Percentiles struct {
	P50 *int64 `json:"p50"`
	P95 *int64 `json:"p95"`
	P99 *int64 `json:"p99"`
}

// AggregateGroup is one (agent_id, bucket-start) cell of the analytics result.
// ErrorCount counts rows in StatusFailed; ByErrorClass breaks those down by the
// recorded error_class (failed rows whose error_class is nil are counted in
// ErrorCount but not in ByErrorClass). Latency/TTFT percentiles are computed
// only over rows that carry the metric, so in-flight rows count toward Count
// but never skew the percentiles (spec 0003).
type AggregateGroup struct {
	AgentID      string
	BucketStart  time.Time
	Count        int
	ErrorCount   int
	ByErrorClass map[ErrorClass]int
	LatencyMS    Percentiles
	TTFTMS       Percentiles
}

// AggregateTotals is one window-level aggregate over the whole [Since, Until]
// range: every row, in one cell, independent of bucketing.
//
// It exists because percentiles do not add up. A client holding per-bucket
// groups can sum counts across them, but it cannot merge a p95 — the merge is
// not defined without the underlying samples, which it does not have. So a
// seven-day p95 latency is not a number a client can compute from a bucketed
// response at all, however it aggregates: it has to be measured here, over the
// same rows, at the same time. Counting is the easy half; the percentiles are
// the reason this type exists.
//
// RequestBytes and ResponseBytes sum only rows that recorded a size, which is
// the same rule the percentiles follow: an in-flight row contributes to Count
// and to nothing else.
type AggregateTotals struct {
	Count         int
	ErrorCount    int
	ByErrorClass  map[ErrorClass]int
	LatencyMS     Percentiles
	TTFTMS        Percentiles
	RequestBytes  int64
	ResponseBytes int64
}

// AggregateResult is the complete answer to one analytics query: the bucketed
// cells, plus the window total computed over the same rows in the same pass.
type AggregateResult struct {
	Groups []AggregateGroup
	Totals AggregateTotals
}

// aggregateRows groups rows by (AgentID, bucket-start), computes per-group
// metrics, and computes the window totals over every row in one pass. rows must
// already be tenant-scoped and time-filtered by the caller; this is the single
// aggregation code path shared by every Store implementation so memory and
// Postgres produce identical results. Groups are sorted by agent_id, then
// bucket-start, for deterministic output.
func aggregateRows(rows []*Invocation, bucket Bucket) AggregateResult {
	type key struct {
		agentID string
		bucket  time.Time
	}
	groups := make(map[key]*AggregateGroup)
	latencies := make(map[key][]int64)
	ttfts := make(map[key][]int64)

	totals := AggregateTotals{ByErrorClass: make(map[ErrorClass]int)}
	var allLatencies, allTTFTs []int64

	for _, r := range rows {
		k := key{agentID: r.AgentID, bucket: truncateToBucket(r.CreatedAt, bucket)}
		g, ok := groups[k]
		if !ok {
			g = &AggregateGroup{
				AgentID:      k.agentID,
				BucketStart:  k.bucket,
				ByErrorClass: make(map[ErrorClass]int),
			}
			groups[k] = g
		}
		g.Count++
		totals.Count++
		if r.Status == StatusFailed {
			g.ErrorCount++
			totals.ErrorCount++
			if r.ErrorClass != nil {
				g.ByErrorClass[*r.ErrorClass]++
				totals.ByErrorClass[*r.ErrorClass]++
			}
		}
		if r.RequestSize != nil {
			totals.RequestBytes += *r.RequestSize
		}
		if r.ResponseSize != nil {
			totals.ResponseBytes += *r.ResponseSize
		}
		// Percentiles are computed only over rows that recorded the metric.
		// In-flight rows (pending/running) have nil latency, so they are counted
		// above but excluded here (spec 0003).
		if r.LatencyMS != nil {
			latencies[k] = append(latencies[k], *r.LatencyMS)
			allLatencies = append(allLatencies, *r.LatencyMS)
		}
		if r.TTFTMS != nil {
			ttfts[k] = append(ttfts[k], *r.TTFTMS)
			allTTFTs = append(allTTFTs, *r.TTFTMS)
		}
	}

	// Window percentiles come from every sample in the range, not from the
	// per-bucket ones: that is the whole reason they are computed here.
	totals.LatencyMS = percentiles(allLatencies)
	totals.TTFTMS = percentiles(allTTFTs)

	out := make([]AggregateGroup, 0, len(groups))
	for k, g := range groups {
		g.LatencyMS = percentiles(latencies[k])
		g.TTFTMS = percentiles(ttfts[k])
		out = append(out, *g)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].AgentID != out[j].AgentID {
			return out[i].AgentID < out[j].AgentID
		}
		return out[i].BucketStart.Before(out[j].BucketStart)
	})
	return AggregateResult{Groups: out, Totals: totals}
}

// truncateToBucket returns the UTC start of the bucket containing t.
func truncateToBucket(t time.Time, b Bucket) time.Time {
	u := t.UTC()
	if b == BucketDay {
		return time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
	}
	return time.Date(u.Year(), u.Month(), u.Day(), u.Hour(), 0, 0, 0, time.UTC)
}

// percentiles returns p50/p95/p99 of vals using the nearest-rank method. The
// result fields are nil when vals is empty.
func percentiles(vals []int64) Percentiles {
	if len(vals) == 0 {
		return Percentiles{}
	}
	s := make([]int64, len(vals))
	copy(s, vals)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	p50 := nearestRank(s, 50)
	p95 := nearestRank(s, 95)
	p99 := nearestRank(s, 99)
	return Percentiles{P50: &p50, P95: &p95, P99: &p99}
}

// nearestRank returns the p-th percentile (1..100) of the ascending-sorted
// slice using the nearest-rank method: rank = ceil(p/100 * N), value at the
// 1-based rank. sorted must be non-empty.
func nearestRank(sorted []int64, p int) int64 {
	n := len(sorted)
	rank := int(math.Ceil(float64(p) / 100 * float64(n)))
	if rank < 1 {
		rank = 1
	}
	if rank > n {
		rank = n
	}
	return sorted[rank-1]
}
