import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCreateBody, catalogComplete, filterAgents, liveAgentsState, liveAgentsView, windowSince } from './agents-view.js';
import { normalizeAgent, summarizeAnalyticsByAgent } from './api.js';

function agent(over = {}) {
  return normalizeAgent({
    id: 'agt_1',
    name: 'Support agent',
    description: '',
    tags: [],
    status: 'active',
    suspended: false,
    protocol: 'http',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...over,
  });
}

// A FormData stand-in, so the create-body shape can be tested without a DOM.
function fields(map) {
  return { get: (k) => (k in map ? map[k] : null) };
}

test('catalogComplete is false when the loaded page is short of the tenant total', () => {
  const saved = { agents: liveAgentsState.agents, agentsTotal: liveAgentsState.agentsTotal };
  try {
    liveAgentsState.agents = [agent({ id: 'agt_1' })];
    liveAgentsState.agentsTotal = 150;
    assert.equal(catalogComplete(), false);

    liveAgentsState.agentsTotal = 1;
    assert.equal(catalogComplete(), true);
  } finally {
    liveAgentsState.agents = saved.agents;
    liveAgentsState.agentsTotal = saved.agentsTotal;
  }
});

test('normalizeAgent keeps the fields the catalog renders', () => {
  const a = normalizeAgent({
    id: 'agt_1',
    name: 'Research agent',
    status: 'active',
    protocol: 'mcp',
    mcp_transport: 'streamable_http',
    credential_ref: 'cred_9',
    invocation_rate_limit: 0.5,
    invocation_burst: 10,
    tags: ['internal'],
    pricing: { amount: '250000', asset: 'USDC', network: 'base', pay_to: '0xabc' },
  });
  assert.equal(a.mcpTransport, 'streamable_http');
  assert.equal(a.credentialRef, 'cred_9');
  assert.equal(a.rateLimit, 0.5);
  assert.equal(a.burst, 10);
  assert.deepEqual(a.tags, ['internal']);
  assert.equal(a.pricing.amount, '250000');
});

test('an absent rate limit stays null rather than becoming zero', () => {
  const a = normalizeAgent({ id: 'agt_1', name: 'x', status: 'pending', protocol: 'http' });
  assert.equal(a.rateLimit, null);
  assert.equal(a.burst, null);
  assert.equal(a.pricing, null);
});

test('filterAgents narrows by status, protocol and suspension independently', () => {
  const agents = [
    agent({ id: 'a', status: 'active', suspended: false, protocol: 'http' }),
    agent({ id: 'b', status: 'pending', suspended: false, protocol: 'mcp', mcp_transport: 'streamable_http' }),
    agent({ id: 'c', status: 'active', suspended: true, protocol: 'http' }),
  ];
  const ids = (f) => filterAgents(agents, { query: '', status: 'all', protocol: 'all', suspension: 'all', ...f }).map((a) => a.id);

  assert.deepEqual(ids({ status: 'pending' }), ['b']);
  assert.deepEqual(ids({ protocol: 'mcp' }), ['b']);
  assert.deepEqual(ids({ suspension: 'suspended' }), ['c']);
  // A suspended agent still has catalog status "active" — the two filters are
  // independent, and this is the pairing most likely to be wrongly collapsed.
  assert.deepEqual(ids({ status: 'active', suspension: 'active' }), ['a']);
});

test('filterAgents searches id, name, protocol and tags', () => {
  const agents = [
    agent({ id: 'agt_support', name: 'Support agent', tags: ['internal'] }),
    agent({ id: 'agt_docs', name: 'Docs search', tags: ['public'] }),
  ];
  const ids = (q) => filterAgents(agents, { query: q, status: 'all', protocol: 'all', suspension: 'all' }).map((a) => a.id);

  assert.deepEqual(ids('docs'), ['agt_docs']);
  assert.deepEqual(ids('AGT_SUPPORT'), ['agt_support']);
  assert.deepEqual(ids('internal'), ['agt_support']);
  assert.deepEqual(ids('nothing-matches'), []);
});

test('summarizeAnalyticsByAgent sums counts and errors across buckets', () => {
  const summary = summarizeAnalyticsByAgent({
    groups: [
      { agent_id: 'a', count: 10, by_error_class: { timeout: 1 }, latency_ms: { p95: 100 }, ttft_ms: { p95: 40 } },
      { agent_id: 'a', count: 5, by_error_class: { timeout: 1, internal: 1 }, latency_ms: { p95: 900 }, ttft_ms: { p95: 80 } },
    ],
  });
  assert.equal(summary.get('a').calls, 15);
  assert.equal(summary.get('a').errors, 3);
});

test('percentiles are discarded across buckets rather than merged', () => {
  const summary = summarizeAnalyticsByAgent({
    groups: [
      { agent_id: 'a', count: 10, by_error_class: {}, latency_ms: { p95: 100 }, ttft_ms: { p95: 40 } },
      { agent_id: 'a', count: 5, by_error_class: {}, latency_ms: { p95: 900 }, ttft_ms: { p95: 80 } },
    ],
  });
  // Averaging or maxing two p95s produces a number that is not a percentile of
  // anything, so the summary reports it as unknown instead.
  assert.equal(summary.get('a').latencyP95Ms, null);
  assert.equal(summary.get('a').ttftP95Ms, null);
  assert.equal(summary.get('a').percentilesMerged, true);
});

test('a single-bucket window keeps its exact percentile', () => {
  const summary = summarizeAnalyticsByAgent({
    groups: [{ agent_id: 'a', count: 10, by_error_class: {}, latency_ms: { p95: 1400 }, ttft_ms: { p95: 480 } }],
  });
  assert.equal(summary.get('a').latencyP95Ms, 1400);
  assert.equal(summary.get('a').percentilesMerged, undefined);
});

test('an agent absent from analytics is absent from the summary, not zeroed', () => {
  const summary = summarizeAnalyticsByAgent({ groups: [] });
  assert.equal(summary.get('agt_quiet'), undefined);
});

test('summarizeAnalyticsByAgent tolerates an empty or malformed response', () => {
  assert.equal(summarizeAnalyticsByAgent(null).size, 0);
  assert.equal(summarizeAnalyticsByAgent({}).size, 0);
});

test('MCP registration pairs the protocol with the transport Gateway requires', () => {
  const body = buildCreateBody(fields({ name: 'mcp-agent', protocol: 'mcp' }));
  assert.equal(body.protocol, 'mcp');
  assert.equal(body.mcp_transport, 'streamable_http');
});

test('HTTP registration omits protocol and transport, letting the gateway default', () => {
  const body = buildCreateBody(fields({ name: 'http-agent', protocol: 'http' }));
  assert.equal(body.mcp_transport, undefined);
  assert.equal(body.protocol, undefined);
});

test('empty optional fields are omitted rather than sent blank', () => {
  const body = buildCreateBody(fields({ name: '  spaced  ', description: '', upstream_url: '', credential_ref: '', tags: '' }));
  assert.deepEqual(body, { name: 'spaced' });
});

test('tags are split, trimmed and emptied entries dropped', () => {
  const body = buildCreateBody(fields({ name: 'x', tags: 'internal, staging , , local' }));
  assert.deepEqual(body.tags, ['internal', 'staging', 'local']);
});

test('a chosen credential is sent by id', () => {
  const body = buildCreateBody(fields({ name: 'x', credential_ref: 'cred_9' }));
  assert.equal(body.credential_ref, 'cred_9');
});

// --- rendering ---------------------------------------------------------------
//
// The view returns a string, so the rules that matter most — an unknown value
// never rendering as zero, and the three agent facts staying separate — can be
// asserted directly against the markup without a DOM.

function withState(over, fn) {
  const saved = { ...liveAgentsState };
  Object.assign(liveAgentsState, {
    agents: [],
    traffic: new Map(),
    trafficState: 'unknown',
    credentialNames: new Map(),
    credentialsState: 'unknown',
    loading: false,
    error: null,
    filters: { query: '', status: 'all', protocol: 'all', suspension: 'all' },
    form: { open: false, submitting: false, error: null },
    pending: new Set(),
    ...over,
  });
  try {
    return fn(liveAgentsView());
  } finally {
    Object.assign(liveAgentsState, saved);
  }
}

test('an agent with no traffic in the window reads as no calls, not as zero calls', () => {
  withState({ agents: [agent({ id: 'agt_quiet' })], trafficState: 'ready' }, (html) => {
    assert.match(html, /No calls/);
    assert.doesNotMatch(html, /0 calls/);
  });
});

test('a failed analytics read reads as unknown, never as zero', () => {
  withState({ agents: [agent()], trafficState: 'unavailable' }, (html) => {
    assert.match(html, /Unknown/);
    assert.match(html, /Analytics unavailable/);
    assert.doesNotMatch(html, /0 calls/);
    assert.doesNotMatch(html, /No calls/);
  });
});

test('a real traffic count renders with its error rate', () => {
  const traffic = new Map([['agt_1', { calls: 486, errors: 4, buckets: 1, latencyP95Ms: 1400 }]]);
  withState({ agents: [agent()], traffic, trafficState: 'ready' }, (html) => {
    assert.match(html, /486 calls/);
    assert.match(html, /0\.8% errors/);
    assert.match(html, /p95 1\.4s/);
  });
});

test('an empty catalog says empty, not unavailable', () => {
  withState({ agents: [] }, (html) => {
    assert.match(html, /empty — not unavailable/);
  });
});

test('a suspended agent shows both its catalog status and its suspension', () => {
  withState({ agents: [agent({ suspended: true, status: 'active' })] }, (html) => {
    // Both facts, not one collapsed into the other.
    assert.match(html, /Active</);
    assert.match(html, /Suspended</);
    assert.match(html, /Invocations blocked/);
    assert.match(html, /Resume<\/button>|Resume\s*<\/button>/);
  });
});

test('an unsuspended agent still states that it is not suspended', () => {
  withState({ agents: [agent()] }, (html) => {
    assert.match(html, /Not suspended/);
    assert.match(html, /Separate from catalog status/);
  });
});

test('an unresolvable credential reference is not reported as having no credential', () => {
  withState({ agents: [agent({ credential_ref: 'cred_9' })], credentialsState: 'unavailable' }, (html) => {
    assert.match(html, /cred_9/);
    assert.match(html, /Name unavailable/);
    assert.doesNotMatch(html, /No credential injected/);
  });
});

test('an agent with no credential says so plainly', () => {
  withState({ agents: [agent()] }, (html) => {
    assert.match(html, /No credential injected/);
  });
});

test('an unpriced agent reports the gate is off rather than unknown', () => {
  withState({ agents: [agent()] }, (html) => {
    assert.match(html, /No payment gate/);
    assert.match(html, /Unpriced/);
  });
});

test('the search box says it filters loaded records rather than querying', () => {
  withState({ agents: [agent()] }, (html) => {
    assert.match(html, /does not query Gateway/);
  });
});

test('agent-supplied text is escaped, not injected', () => {
  withState({ agents: [agent({ name: '<img src=x onerror=alert(1)>' })] }, (html) => {
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x/);
  });
});

test('an error state offers a retry instead of an empty catalog', () => {
  withState({ error: 'Gateway is unreachable from the console.' }, (html) => {
    assert.match(html, /unreachable/);
    assert.match(html, /retry-agents/);
  });
});

test('the traffic window starts at midnight UTC so it fits one day bucket', () => {
  // A rolling 24h window would straddle UTC midnight and split every agent
  // across two buckets, which forces the percentile to be discarded. Anchoring
  // to midnight keeps the response to one cell per agent.
  assert.equal(windowSince(new Date('2026-08-30T19:54:00Z')), '2026-08-30T00:00:00.000Z');
  assert.equal(windowSince(new Date('2026-08-30T00:00:01Z')), '2026-08-30T00:00:00.000Z');
  assert.equal(windowSince(new Date('2026-01-01T23:59:59Z')), '2026-01-01T00:00:00.000Z');
});

test('the traffic column says nothing happened today rather than implying a rolling window', () => {
  withState({ agents: [agent()], trafficState: 'ready' }, (html) => {
    assert.match(html, /Nothing today \(UTC\)/);
    assert.match(html, /measured from midnight UTC/);
  });
});
