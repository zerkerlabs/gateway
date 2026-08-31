import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  liveOverviewState,
  liveOverviewView,
  metricDisplay,
  metricTone,
  summarizeAttentionQueue,
  windowSince,
} from './overview-view.js';
import { liveAgentsState } from './agents-view.js';
import { liveAttentionState } from './attention-view.js';
import { normalizeAgent } from './api.js';
import { normalizeInvocation } from './invocations-view.js';

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

function invocation(over = {}) {
  return normalizeInvocation({
    id: 'inv_1',
    agent_id: 'agt_1',
    mode: 'transactional',
    status: 'succeeded',
    error_class: null,
    model: null,
    mcp_method: null,
    mcp_tool: null,
    payment_network: null,
    payment_asset: null,
    payment_amount: null,
    payment_payer: null,
    payment_nonce: null,
    upstream_status: 200,
    latency_ms: 120,
    ttft_ms: null,
    req_size: 512,
    resp_size: 2048,
    created_at: '2026-08-30T00:00:00Z',
    completed_at: '2026-08-30T00:00:01Z',
    ...over,
  });
}

// --- windowSince ---------------------------------------------------------------

test('windowSince is a fixed 24h lower bound relative to now', () => {
  const now = new Date('2026-08-30T12:00:00Z');
  assert.equal(windowSince(now), '2026-08-29T12:00:00.000Z');
});

// --- metricTone / metricDisplay -------------------------------------------------

test('a loading read shows a pending display, never a value', () => {
  assert.equal(metricDisplay('loading', 5, (v) => String(v)), 'Loading…');
});

test('a failed read never renders as zero', () => {
  assert.equal(metricDisplay('error', 0, (v) => String(v)), 'Unknown');
  assert.equal(metricDisplay('unavailable', 0, (v) => String(v)), 'Unknown');
});

test('a genuine empty read renders the real zero, not Unknown', () => {
  assert.equal(metricDisplay('empty', null, (v) => String(v)), '0');
});

test('a partial read renders its known lower bound, marked as one', () => {
  assert.equal(metricDisplay('partial', 3, (v) => String(v)), '3+');
});

test('a ready read renders the value as-is', () => {
  assert.equal(metricDisplay('ready', 7, (v) => String(v)), '7');
});

test('metricTone keeps zero, unavailable, unknown, and available visually distinct', () => {
  assert.equal(metricTone('empty'), 'zero');
  assert.equal(metricTone('unavailable'), 'unavailable');
  assert.equal(metricTone('error'), 'unknown');
  assert.equal(metricTone('loading'), 'unknown');
  assert.equal(metricTone('ready'), 'available');
  assert.equal(metricTone('partial'), 'available');
});

// --- summarizeAttentionQueue -----------------------------------------------------

function rule(over = {}) {
  return { id: 'r', title: 'Rule', severity: 'medium', target: 'agents', action: 'Review', available: true, items: [], ...over };
}

test('a queue every rule evaluated is exact, even at zero', () => {
  const summary = summarizeAttentionQueue([rule({ items: [] }), rule({ items: [] })]);
  assert.deepEqual(summary, { knownCount: 0, exact: true, items: [], unavailableCount: 0, totalRules: 2 });
});

test('a queue with an unavailable rule and a positive known count is a lower bound, not exact', () => {
  const summary = summarizeAttentionQueue([
    rule({ severity: 'high', items: [{ detail: 'a' }] }),
    rule({ available: false, items: [] }),
  ]);
  assert.equal(summary.exact, false);
  assert.equal(summary.knownCount, 1);
  assert.equal(summary.unavailableCount, 1);
});

test('items sort by severity, high first', () => {
  const summary = summarizeAttentionQueue([
    rule({ severity: 'low', items: [{ detail: 'low item' }] }),
    rule({ severity: 'high', items: [{ detail: 'high item' }] }),
  ]);
  assert.deepEqual(summary.items.map((i) => i.item.detail), ['high item', 'low item']);
});

// --- rendering -----------------------------------------------------------------

function withReady(overviewOver, attentionOver, agentsOver, fn) {
  const savedOverview = { ...liveOverviewState };
  const savedAttention = {
    status: liveAttentionState.status,
    settlementFailed: liveAttentionState.settlementFailed,
    settledUpstreamFailed: liveAttentionState.settledUpstreamFailed,
    settlementConfig: liveAttentionState.settlementConfig,
  };
  const savedAgents = {
    agents: liveAgentsState.agents,
    error: liveAgentsState.error,
    credentialsState: liveAgentsState.credentialsState,
    credentialNames: liveAgentsState.credentialNames,
    trafficState: liveAgentsState.trafficState,
    analyticsGroups: liveAgentsState.analyticsGroups,
  };

  Object.assign(liveOverviewState, {
    status: 'ready',
    fetchedAt: '2026-08-30T12:00:00Z',
    totalCalls: { phase: 'ready', total: 10 },
    failedCalls: { phase: 'ready', total: 2 },
    sample: { phase: 'ready', items: [] },
    runtime: { phase: 'ready', healthz: { status: 'ok' }, version: { version: '1.2.3', commit: 'abc1234' } },
    ...overviewOver,
  });
  Object.assign(liveAttentionState, {
    status: 'ready',
    settlementFailed: { state: 'ready', total: 0 },
    settledUpstreamFailed: { state: 'ready', total: 0 },
    settlementConfig: { state: 'ready', configured: true },
    ...attentionOver,
  });
  Object.assign(liveAgentsState, {
    agents: [],
    error: null,
    credentialsState: 'ready',
    credentialNames: new Map(),
    trafficState: 'ready',
    analyticsGroups: [],
    ...agentsOver,
  });

  try {
    return fn(liveOverviewView());
  } finally {
    Object.assign(liveOverviewState, savedOverview);
    Object.assign(liveAttentionState, savedAttention);
    Object.assign(liveAgentsState, savedAgents);
  }
}

test('an idle/loading overview never claims to have data', () => {
  const html = liveOverviewView();
  assert.match(html, /Loading live overview/);
  assert.doesNotMatch(html, /Calls ·/);
});

test('the window is stated on the calls metric', () => {
  withReady({}, {}, {}, (html) => {
    assert.match(html, /Calls · Last 24 hours/);
  });
});

test('a failed calls read renders Unknown, never a zero call count', () => {
  withReady({ totalCalls: { phase: 'error', total: null } }, {}, {}, (html) => {
    const card = html.slice(html.indexOf('Calls · Last 24 hours') - 200, html.indexOf('Calls · Last 24 hours'));
    assert.match(card, /Unknown/);
  });
});

test('a genuine zero-call window renders as a known zero, not Unknown', () => {
  withReady({ totalCalls: { phase: 'ready', total: 0 }, failedCalls: { phase: 'ready', total: 0 } }, {}, {}, (html) => {
    assert.match(html, /Known zero · Last 24 hours/);
  });
});

test('the preview scenario dropdown is gone', () => {
  withReady({}, {}, {}, (html) => {
    assert.doesNotMatch(html, /overview-scenario/);
    assert.doesNotMatch(html, /Preview scenario/);
  });
});

test('policy decisions and payment volume are not presented as live metrics', () => {
  withReady({}, {}, {}, (html) => {
    // Scoped to the metric-label markup (metricCard's `<small>`) rather than
    // the whole page: the static capability map at the bottom legitimately
    // mentions "Policy decisions" as roadmap copy, not as a live metric.
    assert.doesNotMatch(html, /<small>Policy decisions<\/small>/);
    assert.doesNotMatch(html, /<small>Payment volume<\/small>/);
  });
});

test('the context strip never claims fixture or preview data', () => {
  withReady({}, {}, {}, (html) => {
    assert.doesNotMatch(html, /Preview data/);
    assert.doesNotMatch(html, /Not connected to Gateway/i);
  });
});

test('no workspace placeholder is printed when the session carries no tenant', () => {
  withReady({}, {}, {}, (html) => {
    assert.doesNotMatch(html, /Workspace/);
  });
});

test('the capability map stays in place at the bottom of the live overview page', () => {
  withReady({}, {}, {}, (html) => {
    assert.match(html, /class="capability-section"/);
    assert.match(html, /Capability delivery status/);
    assert.match(html, /data-live-overview-nav="agents"/);
  });
});

test('the latest invocation sample reuses the live invocations row, not a second copy', () => {
  withReady({ sample: { phase: 'ready', items: [invocation({ id: 'inv_live_1' })] } }, {}, {}, (html) => {
    assert.match(html, /live-invocation-row/);
    assert.match(html, /inv_live_1/);
  });
});

test('a failed sample read is unavailable, never an empty table', () => {
  withReady({ sample: { phase: 'error', items: [] } }, {}, {}, (html) => {
    assert.match(html, /Invocation evidence is unavailable/);
  });
});

test('runtime evidence states the console\'s own fetch time, not a Gateway timestamp', () => {
  withReady({}, {}, {}, (html) => {
    assert.match(html, /Console fetched/);
    assert.match(html, /carry no refresh timestamp of their own/);
    assert.match(html, />ok</);
    assert.match(html, /1\.2\.3/);
    assert.match(html, /abc1234/);
  });
});

test('a failed runtime read never claims the gateway is healthy', () => {
  withReady({ runtime: { phase: 'error', healthz: null, version: null } }, {}, {}, (html) => {
    assert.doesNotMatch(html, />ok</);
    assert.match(html, /could not both be read/);
  });
});

test('the attention count comes from the same six rules attention-view.js runs', () => {
  withReady({}, {}, { agents: [agent({ id: 'a', name: 'Billing agent', suspended: true })] }, (html) => {
    assert.match(html, /1 item need review/);
    assert.match(html, /Billing agent is suspended/);
  });
});

test('an attention queue with an unavailable rule shows a lower bound, not a false zero', () => {
  withReady(
    {},
    { settlementFailed: { state: 'unavailable', total: 0 } },
    { agents: [agent({ id: 'a', name: 'Billing agent', suspended: true })] },
    (html) => {
      assert.match(html, /At least/);
    }
  );
});

test('attention still loading independently of the rest of the page renders its own loading state', () => {
  withReady({}, { status: 'loading' }, {}, (html) => {
    assert.match(html, /Evaluating tenant rules/);
    assert.match(html, /Calls · Last 24 hours/);
  });
});
