import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTENTION_RULES,
  badgeSummary,
  deriveAttentionQueue,
  failingAgents,
  liveAttentionState,
  liveAttentionView,
  pendingAgents,
  settlementFailures,
  suspendedAgents,
  unreferencedCredentials,
  unsettledPricedAgents,
} from './attention-view.js';
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

function ctx(over = {}) {
  return {
    agents: [],
    agentNames: new Map(),
    credentialNames: new Map(),
    analyticsGroups: [],
    settlementFailedTotal: 0,
    settledUpstreamFailedTotal: 0,
    settlementConfigured: true,
    ...over,
  };
}

// --- suspendedAgents / pendingAgents ------------------------------------------

test('suspendedAgents is unavailable, not empty, when the catalog read failed', () => {
  assert.equal(suspendedAgents(ctx({ agents: null })), null);
});

test('suspendedAgents flags only the suspended ones', () => {
  const agents = [agent({ id: 'a', suspended: false }), agent({ id: 'b', name: 'Billing agent', suspended: true })];
  const items = suspendedAgents(ctx({ agents }));
  assert.equal(items.length, 1);
  assert.match(items[0].detail, /Billing agent is suspended/);
});

test('an agent catalog with no suspensions is a real, reportable empty array', () => {
  const agents = [agent({ id: 'a', suspended: false })];
  assert.deepEqual(suspendedAgents(ctx({ agents })), []);
});

test('pendingAgents flags agents with no upstream configured', () => {
  const agents = [agent({ id: 'a', status: 'active' }), agent({ id: 'b', name: 'New agent', status: 'pending' })];
  const items = pendingAgents(ctx({ agents }));
  assert.equal(items.length, 1);
  assert.match(items[0].detail, /New agent was registered with no upstream/);
});

test('pendingAgents is unavailable when the catalog read failed', () => {
  assert.equal(pendingAgents(ctx({ agents: null })), null);
});

// --- failingAgents -------------------------------------------------------------

test('failingAgents is unavailable when analytics could not be read', () => {
  assert.equal(failingAgents(ctx({ analyticsGroups: null })), null);
});

test('failingAgents ignores a small sample even at 100% error', () => {
  const groups = [{ agent_id: 'agt_1', count: 2, error_rate: 1, by_error_class: { timeout: 2 } }];
  assert.deepEqual(failingAgents(ctx({ analyticsGroups: groups })), []);
});

test('failingAgents ignores a large sample under the error-rate threshold', () => {
  const groups = [{ agent_id: 'agt_1', count: 100, error_rate: 0.05, by_error_class: { timeout: 5 } }];
  assert.deepEqual(failingAgents(ctx({ analyticsGroups: groups })), []);
});

test('failingAgents names the dominant error class and uses the catalog name when known', () => {
  const groups = [
    { agent_id: 'agt_1', count: 20, error_rate: 0.5, by_error_class: { timeout: 8, credential_error: 2 } },
  ];
  const items = failingAgents(ctx({ analyticsGroups: groups, agentNames: new Map([['agt_1', 'Support agent']]) }));
  assert.equal(items.length, 1);
  assert.match(items[0].detail, /Support agent failed 50% of 20 calls today — mostly timeouts\./);
});

test('failingAgents falls back to the raw agent id when the name is unknown', () => {
  const groups = [{ agent_id: 'agt_9', count: 10, error_rate: 0.3, by_error_class: { internal: 3 } }];
  const items = failingAgents(ctx({ analyticsGroups: groups }));
  assert.match(items[0].detail, /^agt_9 failed/);
});

// --- settlementFailures ----------------------------------------------------

test('settlementFailures is unavailable when either invocation read failed', () => {
  assert.equal(settlementFailures(ctx({ settledUpstreamFailedTotal: null })), null);
  assert.equal(settlementFailures(ctx({ settlementFailedTotal: null })), null);
});

test('zero of either kind is a real, reportable empty array', () => {
  assert.deepEqual(settlementFailures(ctx({ settlementFailedTotal: 0, settledUpstreamFailedTotal: 0 })), []);
});

test('a settled-then-upstream-failed invocation is reported ahead of a plain settlement failure', () => {
  const items = settlementFailures(ctx({ settlementFailedTotal: 2, settledUpstreamFailedTotal: 1 }));
  assert.equal(items.length, 2);
  assert.match(items[0].detail, /collected payment and then failed upstream/);
  assert.match(items[1].detail, /could not be settled with the facilitator/);
});

test('only the failure kind that actually occurred is reported', () => {
  const items = settlementFailures(ctx({ settlementFailedTotal: 0, settledUpstreamFailedTotal: 3 }));
  assert.equal(items.length, 1);
  assert.match(items[0].detail, /3 invocations collected payment/);
});

// --- unsettledPricedAgents ---------------------------------------------------

test('unsettledPricedAgents is unavailable when the catalog or settlement-config read failed', () => {
  assert.equal(unsettledPricedAgents(ctx({ agents: null })), null);
  assert.equal(unsettledPricedAgents(ctx({ settlementConfigured: null })), null);
});

test('a configured settlement destination clears the rule regardless of pricing', () => {
  const agents = [agent({ id: 'a', pricing: { amount: '1', asset: 'USDC', network: 'base', pay_to: '0x1' } })];
  assert.deepEqual(unsettledPricedAgents(ctx({ agents, settlementConfigured: true })), []);
});

test('no priced agents means nothing to flag even with settlement unconfigured', () => {
  const agents = [agent({ id: 'a' })];
  assert.deepEqual(unsettledPricedAgents(ctx({ agents, settlementConfigured: false })), []);
});

test('priced agents with no settlement destination produce one item naming the count', () => {
  const agents = [
    agent({ id: 'a', pricing: { amount: '1', asset: 'USDC', network: 'base', pay_to: '0x1' } }),
    agent({ id: 'b', pricing: { amount: '1', asset: 'USDC', network: 'base', pay_to: '0x1' } }),
    agent({ id: 'c' }),
  ];
  const items = unsettledPricedAgents(ctx({ agents, settlementConfigured: false }));
  assert.equal(items.length, 1);
  assert.match(items[0].detail, /2 agents priced/);
});

// --- unreferencedCredentials -------------------------------------------------

test('unreferencedCredentials is unavailable when the catalog or credential list failed', () => {
  assert.equal(unreferencedCredentials(ctx({ agents: null })), null);
  assert.equal(unreferencedCredentials(ctx({ credentialNames: null })), null);
});

test('a credential referenced by an agent is not flagged; an orphaned one is', () => {
  const agents = [agent({ id: 'a', credential_ref: 'cred_used' })];
  const credentialNames = new Map([
    ['cred_used', 'support-production'],
    ['cred_orphan', 'staging-unused'],
  ]);
  const items = unreferencedCredentials(ctx({ agents, credentialNames }));
  assert.equal(items.length, 1);
  assert.match(items[0].detail, /staging-unused is not referenced/);
});

// --- deriveAttentionQueue / badgeSummary --------------------------------------

test('deriveAttentionQueue marks a rule unavailable without pretending it found nothing', () => {
  const queue = deriveAttentionQueue(ctx({ agents: null }));
  const catalogRules = queue.filter((r) => ['suspended-agents', 'pending-agents'].includes(r.id));
  for (const rule of catalogRules) {
    assert.equal(rule.available, false);
    assert.deepEqual(rule.items, []);
  }
  assert.equal(queue.length, ATTENTION_RULES.length);
});

test('badgeSummary hides the badge only on a confirmed, fully-evaluated zero', () => {
  const queue = deriveAttentionQueue(ctx());
  assert.deepEqual(badgeSummary(queue), { hidden: true, label: null, unknown: false });
});

test('badgeSummary never renders the digit 0 when a rule could not be evaluated', () => {
  const queue = deriveAttentionQueue(ctx({ agents: null }));
  const summary = badgeSummary(queue);
  assert.equal(summary.label, '?');
  assert.equal(summary.hidden, false);
  assert.equal(summary.unknown, true);
});

test('badgeSummary shows a known positive count even while another rule is unavailable', () => {
  const agents = [agent({ id: 'a', suspended: true })];
  const queue = deriveAttentionQueue(ctx({ agents, analyticsGroups: null }));
  assert.deepEqual(badgeSummary(queue), { hidden: false, label: '1', unknown: false });
});

// --- rendering -----------------------------------------------------------------

function withReady(attentionOver, agentsOver, fn) {
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
    return fn(liveAttentionView());
  } finally {
    Object.assign(liveAttentionState, savedAttention);
    Object.assign(liveAgentsState, savedAgents);
  }
}

test('a queue with no items in any rule says so plainly, as a good state', () => {
  withReady({}, {}, (html) => {
    assert.match(html, /Nothing needs attention/);
  });
});

test('the "Mark reviewed" button from the fixture card is gone', () => {
  withReady({}, {}, (html) => {
    assert.doesNotMatch(html, /Mark reviewed/);
    assert.doesNotMatch(html, /data-action="mark-reviewed"/);
  });
});

test('an idle/loading queue never claims the tenant is clean', () => {
  const html = liveAttentionView();
  assert.doesNotMatch(html, /Nothing needs attention/);
  assert.match(html, /Loading tenant state/);
});

test('a suspended agent renders as a card that deep-links to the agent catalog', () => {
  withReady({}, { agents: [agent({ id: 'a', name: 'Billing agent', suspended: true })] }, (html) => {
    assert.match(html, /Billing agent is suspended/);
    assert.match(html, /data-view="agents"/);
    assert.match(html, /class="severity high"/);
  });
});

test('a failed read renders its rule as unavailable, not as evidence of a clean queue', () => {
  withReady({}, { trafficState: 'unavailable', analyticsGroups: [] }, (html) => {
    assert.match(html, /Elevated error rate is unknown/);
    assert.doesNotMatch(html, /Nothing needs attention/);
  });
});

test('high-severity items are listed ahead of lower-severity ones', () => {
  withReady(
    { settlementConfig: { state: 'ready', configured: false } },
    {
      agents: [
        agent({ id: 'a', name: 'Pending agent', status: 'pending' }),
        agent({ id: 'b', name: 'Priced agent', pricing: { amount: '1', asset: 'USDC', network: 'base', pay_to: '0x1' } }),
        agent({ id: 'c', name: 'Suspended agent', suspended: true }),
      ],
    },
    (html) => {
      const suspendedAt = html.indexOf('Suspended agent is suspended');
      const pendingAt = html.indexOf('Pending agent was registered');
      assert.ok(suspendedAt !== -1 && pendingAt !== -1);
      assert.ok(suspendedAt < pendingAt, 'a high-severity suspension should render before a medium-severity pending agent');
    }
  );
});
