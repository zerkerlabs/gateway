import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateActivity, liveActivityState, liveActivityView, resolveWindow } from './activity-view.js';
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

function summary(over = {}) {
  return {
    sessions: 0,
    tool_calls: 0,
    tools_succeeded: 0,
    tools_failed: 0,
    tool_duration_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    cost_known: false,
    ...over,
  };
}

function entry(over = {}) {
  return {
    agentId: 'agt_1',
    name: 'Support agent',
    status: 'ready',
    response: { summary: summary(over.summary) },
    ...over,
  };
}

// --- resolveWindow -----------------------------------------------------------

test('resolveWindow defaults to the last 24 hours ending now', () => {
  const now = new Date('2026-08-30T12:00:00Z');
  const w = resolveWindow(now);
  assert.equal(w.until, '2026-08-30T12:00:00.000Z');
  assert.equal(w.since, '2026-08-29T12:00:00.000Z');
});

// --- aggregateActivity ---------------------------------------------------------

test('aggregateActivity sums sessions, tool calls, and tokens across several agents', () => {
  const totals = aggregateActivity([
    entry({ agentId: 'a', summary: { sessions: 3, tool_calls: 10, tools_succeeded: 9, input_tokens: 100, output_tokens: 50, last_event_at: '2026-08-30T00:00:00Z' } }),
    entry({ agentId: 'b', summary: { sessions: 2, tool_calls: 5, tools_succeeded: 5, input_tokens: 20, output_tokens: 10, last_event_at: '2026-08-30T01:00:00Z' } }),
  ]);
  assert.equal(totals.sessions, 5);
  assert.equal(totals.toolCalls, 15);
  assert.equal(totals.toolsSucceeded, 14);
  assert.equal(totals.inputTokens, 120);
  assert.equal(totals.outputTokens, 60);
  assert.equal(totals.measured, 2);
});

test('an agent with no last_event_at counts as awaiting setup, not a measured agent with zero activity', () => {
  const totals = aggregateActivity([
    entry({ agentId: 'a', summary: { sessions: 1, last_event_at: '2026-08-30T00:00:00Z' } }),
    entry({ agentId: 'b', summary: { sessions: 0 } }), // no last_event_at: never reported in
  ]);
  assert.equal(totals.measured, 1);
  assert.equal(totals.awaitingSetup, 1);
});

test('cost sums only across agents with cost_known, and flags when the total is partial', () => {
  const totals = aggregateActivity([
    entry({ agentId: 'a', summary: { cost_usd: 1.5, cost_known: true, last_event_at: '2026-08-30T00:00:00Z' } }),
    entry({ agentId: 'b', summary: { cost_usd: 0, cost_known: false, last_event_at: '2026-08-30T00:00:00Z' } }),
  ]);
  assert.equal(totals.costUsd, 1.5);
  assert.equal(totals.costKnownAgents, 1);
  assert.equal(totals.measured, 2);
});

test('a failed agent summary is counted as unknown and excluded from every sum, not zero', () => {
  const totals = aggregateActivity([
    entry({ agentId: 'a', summary: { sessions: 4, tool_calls: 8, last_event_at: '2026-08-30T00:00:00Z' } }),
    { agentId: 'b', name: 'Broken agent', status: 'error', response: null },
  ]);
  assert.equal(totals.unknownAgents, 1);
  assert.equal(totals.incomplete, true);
  // The failing agent contributes nothing, but it must not zero out the other
  // agent's real numbers either.
  assert.equal(totals.sessions, 4);
  assert.equal(totals.toolCalls, 8);
  assert.equal(totals.measured, 1);
});

test('aggregateActivity tolerates an empty catalog', () => {
  assert.deepEqual(aggregateActivity([]), {
    agentsLoaded: 0,
    measured: 0,
    awaitingSetup: 0,
    unknownAgents: 0,
    sessions: 0,
    toolCalls: 0,
    toolsSucceeded: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    costKnownAgents: 0,
    incomplete: false,
  });
});

// --- rendering -----------------------------------------------------------------

function withAgents(agents, fn, { total = agents.length, error = null } = {}) {
  const saved = { agents: liveAgentsState.agents, agentsTotal: liveAgentsState.agentsTotal, error: liveAgentsState.error };
  liveAgentsState.agents = agents;
  liveAgentsState.agentsTotal = total;
  liveAgentsState.error = error;
  try {
    return fn();
  } finally {
    liveAgentsState.agents = saved.agents;
    liveAgentsState.agentsTotal = saved.agentsTotal;
    liveAgentsState.error = saved.error;
  }
}

function withState(over, fn) {
  const saved = { ...liveActivityState };
  Object.assign(liveActivityState, {
    status: 'ready',
    window: { since: '2026-08-29T12:00:00.000Z', until: '2026-08-30T12:00:00.000Z' },
    entries: [],
    fetchedAt: null,
    ...over,
  });
  try {
    return fn(liveActivityView());
  } finally {
    Object.assign(liveActivityState, saved);
  }
}

test('there is no event stream panel — no list of individual events anywhere', () => {
  withAgents([agent()], () => {
    withState({ entries: [entry({ summary: { last_event_at: '2026-08-30T00:00:00Z' } })] }, (html) => {
      assert.doesNotMatch(html, /Event stream/i);
      assert.doesNotMatch(html, /event-list/);
      assert.doesNotMatch(html, /event-row/);
    });
  });
});

test('the page names the window and states its population', () => {
  withAgents([agent()], () => {
    withState({ entries: [entry({ summary: { last_event_at: '2026-08-30T00:00:00Z' } })] }, (html) => {
      assert.match(html, /Last 24 hours/);
      assert.match(html, /agent-events\/summary/);
      assert.match(html, /loaded catalog/i);
    });
  });
});

test('cost renders Unknown, never 0 or $0.00, when no agent reported a known cost', () => {
  withAgents([agent()], () => {
    withState({ entries: [entry({ summary: { cost_usd: 0, cost_known: false, last_event_at: '2026-08-30T00:00:00Z' } })] }, (html) => {
      assert.doesNotMatch(html, /\$0\.00/);
      assert.match(html, /Unknown/);
    });
  });
});

test('a known zero cost still renders as a real cost, not Unknown', () => {
  withAgents([agent()], () => {
    withState({ entries: [entry({ summary: { cost_usd: 0, cost_known: true, last_event_at: '2026-08-30T00:00:00Z' } })] }, (html) => {
      assert.match(html, /\$0\.00/);
    });
  });
});

test('awaiting setup is distinguished from a measured agent in the metric strip', () => {
  withAgents([agent({ id: 'agt_1', name: 'Support agent' })], () => {
    withState({ entries: [entry({ agentId: 'agt_1', name: 'Support agent', summary: {} })] }, (html) => {
      assert.match(html, />0<\/span>\s*<small>Measured agents/);
      assert.match(html, /1 awaiting setup/);
      assert.match(html, /Awaiting setup/);
    });
  });
});

test('one agent failing renders that agent as unknown and still renders the rest', () => {
  withAgents([agent({ id: 'agt_1', name: 'Support agent' }), agent({ id: 'agt_2', name: 'Docs agent' })], () => {
    withState(
      {
        entries: [
          entry({ agentId: 'agt_1', name: 'Support agent', summary: { sessions: 6, last_event_at: '2026-08-30T00:00:00Z' } }),
          { agentId: 'agt_2', name: 'Docs agent', status: 'error', response: null },
        ],
      },
      (html) => {
        assert.match(html, /Support agent/);
        assert.match(html, /Docs agent/);
        assert.match(html, /1 of 2 agents. summaries failed to load/);
        // The failing agent's row reads unknown, not a blank page or a zero.
        assert.match(html, /Unknown/);
        // The other agent's real total survives.
        assert.match(html, />6<\/span>\s*<small>Sessions/);
      }
    );
  });
});

test('a partial catalog page says so rather than presenting the totals as tenant-wide', () => {
  withAgents([agent({ id: 'agt_1', name: 'Support agent' })], () => {
    withState({ entries: [entry({ agentId: 'agt_1', name: 'Support agent', summary: { last_event_at: '2026-08-30T00:00:00Z' } })] }, (html) => {
      assert.match(html, /Catalog capped at 1 of 150 agents/);
    });
  }, { total: 150 });
});

test('an unavailable agent catalog is reported rather than silently showing zero agents', () => {
  withAgents([], () => {
    withState({ status: 'catalog_unavailable', entries: [] }, (html) => {
      assert.match(html, /catalog unavailable/i);
    });
  }, { error: 'boom' });
});

test('an empty tenant catalog reads as empty, not unavailable', () => {
  withAgents([], () => {
    withState({ entries: [] }, (html) => {
      assert.match(html, /No agents registered yet/);
    });
  });
});

test('the privacy contract panel is present and static, with no claim of an event stream', () => {
  withAgents([agent()], () => {
    withState({ entries: [entry({ summary: { last_event_at: '2026-08-30T00:00:00Z' } })] }, (html) => {
      assert.match(html, /Privacy contract/);
      assert.match(html, /Session lifecycle/);
      assert.match(html, /Prompts and messages/);
    });
  });
});

test('agent-supplied text is escaped, not injected', () => {
  withAgents([agent({ id: 'agt_1', name: '<img src=x onerror=alert(1)>' })], () => {
    withState({ entries: [entry({ agentId: 'agt_1', name: '<img src=x onerror=alert(1)>', summary: { last_event_at: '2026-08-30T00:00:00Z' } })] }, (html) => {
      assert.doesNotMatch(html, /<img src=x/);
      assert.match(html, /&lt;img src=x/);
    });
  });
});
