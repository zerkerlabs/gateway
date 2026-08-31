import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateErrorClasses,
  aggregateTotals,
  agentRows,
  bucketForWindow,
  liveAnalyticsState,
  liveAnalyticsView,
  resolveWindow,
  validateWindow,
} from './analytics-view.js';
import { liveAgentsState } from './agents-view.js';
import { normalizeAgent } from './api.js';

function agent(over = {}) {
  return normalizeAgent({
    id: 'agt_1',
    name: 'Support agent',
    status: 'active',
    suspended: false,
    protocol: 'http',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...over,
  });
}

// --- resolveWindow -------------------------------------------------------------

test('resolveWindow maps a preset to a since/until pair ending now', () => {
  const now = new Date('2026-08-30T12:00:00Z');
  const w = resolveWindow('24h', {}, now);
  assert.equal(w.until, '2026-08-30T12:00:00.000Z');
  assert.equal(w.since, '2026-08-29T12:00:00.000Z');
});

test('resolveWindow falls back to the 24h preset for an unknown id', () => {
  const now = new Date('2026-08-30T12:00:00Z');
  assert.deepEqual(resolveWindow('nonsense', {}, now), resolveWindow('24h', {}, now));
});

test('resolveWindow passes a custom range through untouched', () => {
  const w = resolveWindow('custom', { since: '2026-08-01T00:00:00Z', until: '2026-08-02T00:00:00Z' });
  assert.equal(w.since, '2026-08-01T00:00:00Z');
  assert.equal(w.until, '2026-08-02T00:00:00Z');
});

test('resolveWindow defaults a custom until to now when absent', () => {
  const now = new Date('2026-08-30T12:00:00Z');
  const w = resolveWindow('custom', { since: '2026-08-01T00:00:00Z' }, now);
  assert.equal(w.until, now.toISOString());
});

// --- validateWindow --------------------------------------------------------------
//
// The 31-day cap and the required `since` are enforced here, client-side,
// before any request — this is what keeps an over-long window from ever
// reaching the gateway as a 400.

test('a missing since is refused with an explanation', () => {
  const v = validateWindow(null, '2026-08-30T00:00:00Z');
  assert.equal(v.valid, false);
  assert.match(v.reason, /since.*required/i);
});

test('a window longer than 31 days is refused before the request', () => {
  const v = validateWindow('2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z');
  assert.equal(v.valid, false);
  assert.match(v.reason, /31 days/);
});

test('exactly 31 days is accepted, matching the gateway boundary', () => {
  const v = validateWindow('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
  assert.equal(v.valid, true);
});

test('since after until is refused', () => {
  const v = validateWindow('2026-08-30T00:00:00Z', '2026-08-29T00:00:00Z');
  assert.equal(v.valid, false);
  assert.match(v.reason, /must not be after/);
});

test('an unparsable start time is refused rather than sent as-is', () => {
  const v = validateWindow('not-a-date', '2026-08-30T00:00:00Z');
  assert.equal(v.valid, false);
  assert.match(v.reason, /not a valid date/);
});

// --- bucketForWindow -------------------------------------------------------------

test('a short window buckets by hour, so a single-bucket window is reachable', () => {
  assert.equal(bucketForWindow('2026-08-30T00:00:00Z', '2026-08-30T01:00:00Z'), 'hour');
});

test('a window longer than two days buckets by day', () => {
  assert.equal(bucketForWindow('2026-08-01T00:00:00Z', '2026-08-10T00:00:00Z'), 'day');
});

// --- aggregateTotals ---------------------------------------------------------------
//
// Counts and error counts are safe to sum across every group; this is the one
// place that summation happens for the tenant-wide figures at the top of the
// page.

test('aggregateTotals sums count and by_error_class across every group', () => {
  const response = {
    groups: [
      { agent_id: 'a', count: 10, by_error_class: { timeout: 1 } },
      { agent_id: 'b', count: 5, by_error_class: { internal: 1, timeout: 1 } },
    ],
  };
  assert.deepEqual(aggregateTotals(response), { calls: 15, errors: 3 });
});

test('aggregateTotals tolerates an empty or malformed response', () => {
  assert.deepEqual(aggregateTotals(null), { calls: 0, errors: 0 });
  assert.deepEqual(aggregateTotals({}), { calls: 0, errors: 0 });
});

// --- aggregateErrorClasses -----------------------------------------------------

test('aggregateErrorClasses lists only classes that actually occurred', () => {
  const response = {
    groups: [
      { agent_id: 'a', by_error_class: { timeout: 2, upstream_5xx: 0 } },
      { agent_id: 'b', by_error_class: { timeout: 1 } },
    ],
  };
  const classes = aggregateErrorClasses(response);
  assert.deepEqual(classes, [['timeout', 3]]);
  // policy_denied, rate_limited, and payment_required can never appear on an
  // invocation, so a response that never mentions them must never surface
  // them either — there is nothing here to filter them out of, which is the
  // point.
  assert.equal(classes.some(([cls]) => cls === 'policy_denied'), false);
});

test('aggregateErrorClasses is empty, not zero-filled, when there are no errors', () => {
  assert.deepEqual(aggregateErrorClasses({ groups: [{ agent_id: 'a', by_error_class: {} }] }), []);
});

// --- agentRows ---------------------------------------------------------------

function withAgents(agents, fn) {
  const saved = liveAgentsState.agents;
  liveAgentsState.agents = agents;
  try {
    return fn();
  } finally {
    liveAgentsState.agents = saved;
  }
}

test('agentRows resolves names, sums per agent, and sorts by call volume', () => {
  withAgents([agent({ id: 'agt_1', name: 'Support agent' }), agent({ id: 'agt_2', name: 'Docs search' })], () => {
    const response = {
      groups: [
        { agent_id: 'agt_2', count: 3, by_error_class: {}, latency_ms: { p95: 200 }, ttft_ms: { p95: null } },
        { agent_id: 'agt_1', count: 40, by_error_class: { timeout: 2 }, latency_ms: { p95: 900 }, ttft_ms: { p95: 300 } },
      ],
    };
    const rows = agentRows(response);
    assert.equal(rows[0].name, 'Support agent');
    assert.equal(rows[0].calls, 40);
    assert.equal(rows[0].errors, 2);
    assert.equal(rows[1].name, 'Docs search');
  });
});

test('agentRows falls back to the raw id for an agent missing from the catalog', () => {
  withAgents([], () => {
    const rows = agentRows({ groups: [{ agent_id: 'agt_ghost', count: 1, by_error_class: {} }] });
    assert.equal(rows[0].name, 'agt_ghost');
  });
});

test('an agent spanning multiple buckets keeps its counts but drops its percentile', () => {
  withAgents([agent({ id: 'agt_1' })], () => {
    const response = {
      groups: [
        { agent_id: 'agt_1', count: 10, by_error_class: {}, latency_ms: { p95: 100 }, ttft_ms: { p95: 40 } },
        { agent_id: 'agt_1', count: 5, by_error_class: {}, latency_ms: { p95: 900 }, ttft_ms: { p95: 80 } },
      ],
    };
    const rows = agentRows(response);
    assert.equal(rows[0].calls, 15);
    assert.equal(rows[0].latencyP95Ms, null);
    assert.equal(rows[0].percentilesMerged, true);
  });
});

// --- rendering -----------------------------------------------------------------
//
// The view returns a string, so the rules that matter — no tenant-wide
// percentile strip, no operations table, and a merged percentile that reads
// as merged rather than as an invented number — can be asserted directly
// against the markup without a DOM.

function withState(over, fn) {
  const saved = { ...liveAnalyticsState };
  Object.assign(liveAnalyticsState, {
    status: 'idle',
    error: null,
    preset: '24h',
    custom: { since: null, until: null },
    window: null,
    response: null,
    fetchedAt: null,
    ...over,
  });
  try {
    return fn(liveAnalyticsView());
  } finally {
    Object.assign(liveAnalyticsState, saved);
  }
}

test('a ready response with a single bucket per agent shows its exact percentile', () => {
  withAgents([agent({ id: 'agt_1', name: 'Support agent' })], () => {
    withState(
      {
        status: 'ready',
        window: { since: '2026-08-30T00:00:00Z', until: '2026-08-30T01:00:00Z', bucket: 'hour' },
        response: {
          groups: [{ agent_id: 'agt_1', count: 20, by_error_class: { timeout: 1 }, latency_ms: { p95: 850 }, ttft_ms: { p95: 220 } }],
        },
      },
      (html) => {
        assert.match(html, /Support agent/);
        assert.match(html, /850ms/);
        assert.match(html, /220ms/);
        assert.doesNotMatch(html, /Merged across/);
      }
    );
  });
});

test('a multi-bucket group states the merge reason instead of a number', () => {
  withAgents([agent({ id: 'agt_1', name: 'Support agent' })], () => {
    withState(
      {
        status: 'ready',
        window: { since: '2026-08-01T00:00:00Z', until: '2026-08-10T00:00:00Z', bucket: 'day' },
        response: {
          groups: [
            { agent_id: 'agt_1', count: 10, by_error_class: {}, latency_ms: { p95: 100 }, ttft_ms: { p95: 40 } },
            { agent_id: 'agt_1', count: 5, by_error_class: {}, latency_ms: { p95: 900 }, ttft_ms: { p95: 80 } },
          ],
        },
      },
      (html) => {
        assert.match(html, /Merged across 2 buckets/);
      }
    );
  });
});

test('the view never renders a tenant-wide percentile strip or an operations table', () => {
  withAgents([agent({ id: 'agt_1', name: 'Support agent' })], () => {
    withState(
      {
        status: 'ready',
        window: { since: '2026-08-30T00:00:00Z', until: '2026-08-30T01:00:00Z', bucket: 'hour' },
        response: { groups: [{ agent_id: 'agt_1', count: 1, by_error_class: {}, latency_ms: { p95: 10 }, ttft_ms: { p95: null } }] },
      },
      (html) => {
        assert.doesNotMatch(html, /Aggregate percentiles/);
        assert.doesNotMatch(html, /MCP method and tool/);
        assert.doesNotMatch(html, /Protocol \/ operation/);
      }
    );
  });
});

test('only error classes present in by_error_class are rendered, never the three that cannot occur', () => {
  withAgents([agent({ id: 'agt_1' })], () => {
    withState(
      {
        status: 'ready',
        window: { since: '2026-08-30T00:00:00Z', until: '2026-08-30T01:00:00Z', bucket: 'hour' },
        response: { groups: [{ agent_id: 'agt_1', count: 5, by_error_class: { ssrf_blocked: 1 }, latency_ms: { p95: 10 }, ttft_ms: { p95: null } }] },
      },
      (html) => {
        assert.match(html, /SSRF blocked/);
        assert.doesNotMatch(html, /Policy denied/i);
        assert.doesNotMatch(html, /Rate limited/i);
        assert.doesNotMatch(html, /Payment required/i);
      }
    );
  });
});

test('a window with zero calls reads as a known empty window, not as unavailable', () => {
  withAgents([], () => {
    withState(
      {
        status: 'ready',
        window: { since: '2026-08-30T00:00:00Z', until: '2026-08-30T01:00:00Z', bucket: 'hour' },
        response: { groups: [] },
      },
      (html) => {
        assert.match(html, /known zero calls/);
        assert.doesNotMatch(html, /Unavailable/);
      }
    );
  });
});

test('an invalid window is refused in the UI, with no data rendered', () => {
  withState({ status: 'invalid', error: 'This window is longer than 31 days. The endpoint rejects anything longer — narrow the range and try again.' }, (html) => {
    assert.match(html, /longer than 31 days/);
    assert.doesNotMatch(html, /analytics-table/);
  });
});

test('a 429 surfaces the wait instead of an empty chart, without claiming to know the real Retry-After', () => {
  withState({ status: 'rate_limited', error: "This endpoint carries its own, tighter rate limit and it was just hit. The console cannot read this response's actual Retry-After value; 60 seconds is the endpoint's worst case, not necessarily the real wait. Give it a moment, then retry." }, (html) => {
    assert.match(html, /rate limit/);
    assert.match(html, /worst case/);
    assert.match(html, /data-live-analytics-action="retry"/);
  });
});

test('there is no preview-scenario dropdown', () => {
  withState({ status: 'ready', window: { since: '2026-08-30T00:00:00Z', until: '2026-08-30T01:00:00Z', bucket: 'hour' }, response: { groups: [] } }, (html) => {
    assert.doesNotMatch(html, /Preview scenario/);
    assert.doesNotMatch(html, /analytics-scenario/);
  });
});

test('the contract boundary copy is present and states the real taxonomy', () => {
  withState({ status: 'ready', window: { since: '2026-08-30T00:00:00Z', until: '2026-08-30T01:00:00Z', bucket: 'hour' }, response: { groups: [] } }, (html) => {
    assert.match(html, /Contract boundary/);
    assert.match(html, /inclusive maximum 31 days/);
    assert.match(html, /group_by.*agent_id/);
  });
});

test('agent-supplied text is escaped, not injected', () => {
  withAgents([agent({ id: 'agt_1', name: '<img src=x onerror=alert(1)>' })], () => {
    withState(
      {
        status: 'ready',
        window: { since: '2026-08-30T00:00:00Z', until: '2026-08-30T01:00:00Z', bucket: 'hour' },
        response: { groups: [{ agent_id: 'agt_1', count: 1, by_error_class: {}, latency_ms: { p95: 10 }, ttft_ms: { p95: null } }] },
      },
      (html) => {
        assert.doesNotMatch(html, /<img src=x/);
        assert.match(html, /&lt;img src=x/);
      }
    );
  });
});
