import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQueryParams,
  deriveTrace,
  failureDiagnosis,
  filterLoadedPage,
  isInvocationId,
  liveInvocationsState,
  liveInvocationsView,
  normalizeInvocation,
  policyActionLabel,
  policyMatchLabel,
  rangeSince,
  retryabilityGuess,
} from './invocations-view.js';
import { liveAgentsState } from './agents-view.js';
import { normalizeAgent } from './api.js';

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

// --- normalizeInvocation -----------------------------------------------------

test('normalizeInvocation keeps the fields the table and detail view render', () => {
  const item = invocation({ mcp_method: 'tools/call', mcp_tool: 'search', model: 'gpt-x' });
  assert.equal(item.mcpMethod, 'tools/call');
  assert.equal(item.mcpTool, 'search');
  assert.equal(item.model, 'gpt-x');
  assert.equal(item.reqSize, 512);
  assert.equal(item.respSize, 2048);
});

test('body_captured is absent (null) on a list item, not false', () => {
  const item = invocation();
  assert.equal(item.bodyCaptured, null);
});

test('body_captured is carried through when the detail response includes it', () => {
  const item = normalizeInvocation({ id: 'inv_1', agent_id: 'agt_1', mode: 'transactional', status: 'succeeded', body_captured: false, created_at: '2026-08-30T00:00:00Z' });
  assert.equal(item.bodyCaptured, false);
});

test('a null error_class stays null rather than becoming a string', () => {
  const item = invocation({ error_class: null });
  assert.equal(item.errorClass, null);
});

test('a null policy_action stays null rather than becoming a string', () => {
  const item = invocation({ policy_action: null, policy_matched_rule: null });
  assert.equal(item.policyAction, null);
  assert.equal(item.policyMatchedRule, null);
});

test('an empty-string policy_matched_rule (tenant default matched) survives distinctly from null', () => {
  const item = invocation({ policy_action: 'allow', policy_matched_rule: '' });
  assert.equal(item.policyMatchedRule, '');
});

// --- buildQueryParams / rangeSince -------------------------------------------

test('buildQueryParams omits "all" filters rather than sending them literally', () => {
  const filters = { status: 'all', mode: 'all', agentId: 'all', errorClass: 'all', settlement: 'all', policy: 'all', range: 'all' };
  assert.deepEqual(buildQueryParams(filters, 20, 0), { limit: 20, offset: 0 });
});

test('buildQueryParams maps every filter to its gateway query param', () => {
  const filters = { status: 'failed', mode: 'streaming', agentId: 'agt_9', errorClass: 'timeout', settlement: 'settled', policy: 'warn', range: 'all' };
  const params = buildQueryParams(filters, 20, 40);
  assert.equal(params.status, 'failed');
  assert.equal(params.mode, 'streaming');
  assert.equal(params.agent_id, 'agt_9');
  assert.equal(params.error_class, 'timeout');
  assert.equal(params.settlement, 'settled');
  assert.equal(params.policy, 'warn');
  assert.equal(params.since, undefined);
  assert.equal(params.limit, 20);
  assert.equal(params.offset, 40);
});

test('buildQueryParams passes the allow policy filter through to the policy query parameter', () => {
  const filters = { status: 'all', mode: 'all', agentId: 'all', errorClass: 'all', settlement: 'all', policy: 'allow', range: 'all' };
  assert.equal(buildQueryParams(filters, 20, 0).policy, 'allow');
});

test('a time range becomes a since bound relative to now', () => {
  const now = new Date('2026-08-30T12:00:00Z');
  assert.equal(rangeSince('1h', now), '2026-08-30T11:00:00.000Z');
  assert.equal(rangeSince('24h', now), '2026-08-29T12:00:00.000Z');
  assert.equal(rangeSince('7d', now), '2026-08-23T12:00:00.000Z');
});

test('"all time" has no lower bound', () => {
  assert.equal(rangeSince('all'), undefined);
});

// --- isInvocationId / filterLoadedPage ---------------------------------------

test('isInvocationId recognizes the inv_ prefix and nothing else', () => {
  assert.equal(isInvocationId('inv_01930000-0000-7000-8000-000000000000'), true);
  assert.equal(isInvocationId('  inv_abc  '), true);
  assert.equal(isInvocationId('agt_1'), false);
  assert.equal(isInvocationId('search text'), false);
  assert.equal(isInvocationId(''), false);
});

test('filterLoadedPage narrows the loaded page by id, agent name, and operation', () => {
  const names = new Map([['agt_1', 'Support agent']]);
  const rows = [
    invocation({ id: 'inv_a', agent_id: 'agt_1', mcp_method: 'tools/call', mcp_tool: 'search' }),
    invocation({ id: 'inv_b', agent_id: 'agt_2', model: 'gpt-x' }),
  ];
  assert.deepEqual(filterLoadedPage(rows, 'support', names).map((r) => r.id), ['inv_a']);
  assert.deepEqual(filterLoadedPage(rows, 'gpt-x', names).map((r) => r.id), ['inv_b']);
  assert.deepEqual(filterLoadedPage(rows, 'nothing-matches', names).map((r) => r.id), []);
});

test('an empty query keeps every loaded row', () => {
  const rows = [invocation({ id: 'inv_a' }), invocation({ id: 'inv_b' })];
  assert.equal(filterLoadedPage(rows, '', new Map()).length, 2);
  assert.equal(filterLoadedPage(rows, '   ', new Map()).length, 2);
});

// --- retryabilityGuess / failureDiagnosis ------------------------------------

test('retryabilityGuess is a console-side read, distinct per error class', () => {
  assert.equal(retryabilityGuess('timeout'), 'Likely retryable');
  assert.equal(retryabilityGuess('upstream_5xx'), 'Likely retryable');
  assert.equal(retryabilityGuess('upstream_4xx'), 'Not retryable');
  assert.equal(retryabilityGuess('ssrf_blocked'), 'Not retryable');
  assert.equal(retryabilityGuess('credential_error'), 'Not retryable');
  assert.equal(retryabilityGuess('cancelled'), 'Not retryable');
  assert.equal(retryabilityGuess('internal'), 'Unknown');
});

test('an unrecognized error class reads as unknown rather than throwing', () => {
  assert.equal(retryabilityGuess('something_new'), 'Unknown');
  assert.equal(retryabilityGuess(null), 'Unknown');
});

test('failureDiagnosis is absent on a successful invocation', () => {
  assert.equal(failureDiagnosis(invocation({ error_class: null })), null);
});

test('failureDiagnosis carries the error class and upstream status, not a fabricated one', () => {
  const diagnosis = failureDiagnosis(invocation({ status: 'failed', error_class: 'upstream_5xx', upstream_status: 503 }));
  assert.equal(diagnosis.errorClass, 'upstream_5xx');
  assert.equal(diagnosis.upstreamStatus, 503);
  assert.equal(diagnosis.retryability, 'Likely retryable');
});

// --- deriveTrace ---------------------------------------------------------

test('deriveTrace skips the payment stage when the route is unpriced', () => {
  const stages = deriveTrace(invocation({ payment_amount: null }));
  const payment = stages.find((s) => s.label === 'Payment gate');
  assert.equal(payment.state, 'skipped');
});

test('deriveTrace reports settlement only when a settlement sub-record exists', () => {
  const withSettlement = deriveTrace(
    invocation({ payment_amount: '250000', payment_asset: 'USDC', payment_network: 'base', settlement: { status: 'settled' } })
  );
  assert.equal(withSettlement.find((s) => s.label === 'Settlement').state, 'completed');

  const gateOnly = deriveTrace(invocation({ payment_amount: '250000', settlement: null }));
  assert.equal(gateOnly.find((s) => s.label === 'Settlement').state, 'unknown');
});

test('deriveTrace reports the real policy_action, not a placeholder allow', () => {
  const allowed = deriveTrace(invocation({ policy_action: 'allow', policy_matched_rule: '2' }));
  const allowStage = allowed.find((s) => s.label === 'Policy');
  assert.equal(allowStage.state, 'completed');
  assert.match(allowStage.detail, /Allow/);
  assert.match(allowStage.detail, /Rule 2/);

  const warned = deriveTrace(invocation({ policy_action: 'warn', policy_matched_rule: '' }));
  const warnStage = warned.find((s) => s.label === 'Policy');
  assert.equal(warnStage.state, 'warning');
  assert.match(warnStage.detail, /Warn/);
  assert.match(warnStage.detail, /Tenant default/);

  const noPolicy = deriveTrace(invocation({ policy_action: null, policy_matched_rule: null }));
  const unconfiguredStage = noPolicy.find((s) => s.label === 'Policy');
  assert.equal(unconfiguredStage.state, 'unknown');
  assert.match(unconfiguredStage.detail, /No policy configured/);
});

// --- rendering ---------------------------------------------------------------

function withState(over, fn) {
  const saved = { ...liveInvocationsState };
  Object.assign(liveInvocationsState, {
    status: 'ready',
    error: null,
    invocations: [],
    total: 0,
    limit: 20,
    offset: 0,
    filters: { status: 'all', mode: 'all', agentId: 'all', errorClass: 'all', settlement: 'all', range: 'all' },
    query: '',
    detail: { id: null, status: 'idle', error: null, record: null },
    ...over,
  });
  try {
    return fn(liveInvocationsView());
  } finally {
    Object.assign(liveInvocationsState, saved);
  }
}

function withAgents(agents, fn) {
  const saved = [...liveAgentsState.agents];
  liveAgentsState.agents = agents;
  try {
    return fn();
  } finally {
    liveAgentsState.agents = saved;
  }
}

test('the page states plainly that denied and unpaid requests never appear here', () => {
  withState({}, (html) => {
    assert.match(html, /denied and unpaid requests never appear in this list/i);
  });
});

test('the Policy filter offers only allow and warn, never deny', () => {
  withState({}, (html) => {
    assert.match(html, /data-live-invocation-filter="policy"/);
    assert.match(html, /<option value="allow">Allow<\/option>/);
    assert.match(html, /<option value="warn">Warn<\/option>/);
    assert.doesNotMatch(html, /<option value="deny"/);
    assert.doesNotMatch(html, />Deny</);
  });
});

test('allow, warn, and no-policy rows render distinctly rather than collapsing into one state', () => {
  withState(
    {
      invocations: [
        invocation({ id: 'inv_allow', policy_action: 'allow', policy_matched_rule: '1' }),
        invocation({ id: 'inv_warn', policy_action: 'warn', policy_matched_rule: '' }),
        invocation({ id: 'inv_none', policy_action: null, policy_matched_rule: null }),
      ],
      total: 3,
    },
    (html) => {
      assert.match(html, /<span class="status allow">Allow<\/span>/);
      assert.match(html, /<span class="status warn">Warn<\/span>/);
      assert.match(html, /<span class="status empty">No policy configured<\/span>/);
    }
  );
});

test('a null policy_action reads as "No policy configured", never as Allow', () => {
  assert.equal(policyActionLabel(null), 'No policy configured');
  assert.notEqual(policyActionLabel(null), policyActionLabel('allow'));
});

test('policyMatchLabel reports the matched rule position, the tenant default, or not applicable', () => {
  assert.equal(policyMatchLabel(invocation({ policy_action: 'allow', policy_matched_rule: '3' })), 'Rule 3');
  assert.equal(policyMatchLabel(invocation({ policy_action: 'warn', policy_matched_rule: '' })), 'Tenant default · no rule matched');
  assert.equal(policyMatchLabel(invocation({ policy_action: null, policy_matched_rule: null })), 'Not applicable');
});

test('the search box is labelled as filtering only the loaded page', () => {
  withState({}, (html) => {
    assert.match(html, /Filters only the .* rows already loaded/);
  });
});

test('the result filter offers pending and running, not just succeeded and failed', () => {
  withState({}, (html) => {
    assert.match(html, /<option value="pending">Pending<\/option>/);
    assert.match(html, /<option value="running">Running<\/option>/);
  });
});

test('error_class and settlement are exposed as filters', () => {
  withState({}, (html) => {
    assert.match(html, /data-live-invocation-filter="errorClass"/);
    assert.match(html, /data-live-invocation-filter="settlement"/);
  });
});

test('pagination states the current range and the total', () => {
  withState({ invocations: [invocation()], total: 143, limit: 20, offset: 20 }, (html) => {
    assert.match(html, /Showing 21–40 of 143/);
  });
});

test('agent names come from the cached catalog rather than the raw id', () => {
  withAgents([normalizeAgent({ id: 'agt_1', name: 'Support agent', status: 'active', protocol: 'http' })], () => {
    withState({ invocations: [invocation({ agent_id: 'agt_1' })], total: 1 }, (html) => {
      assert.match(html, /Support agent/);
    });
  });
});

test('an invocation for an agent missing from the cache still shows the raw id, not a blank', () => {
  withAgents([], () => {
    withState({ invocations: [invocation({ agent_id: 'agt_unknown' })], total: 1 }, (html) => {
      assert.match(html, /agt_unknown/);
    });
  });
});

test('a failed invocation reports its error class, and a succeeded one says so rather than leaving it blank', () => {
  withState(
    { invocations: [invocation({ status: 'failed', error_class: 'timeout' }), invocation({ id: 'inv_2', status: 'succeeded', error_class: null })], total: 2 },
    (html) => {
      assert.match(html, /Timeout/);
      assert.match(html, /No error/);
    }
  );
});

test('an unreachable gateway offers a retry rather than an empty list', () => {
  withState({ status: 'error', error: 'Gateway is unreachable from the console.' }, (html) => {
    assert.match(html, /unreachable/);
    assert.match(html, /data-live-invocation-action="retry"/);
  });
});

test('the detail panel shows the capture boundary for the actual invocation, not a generic notice', () => {
  withState(
    { detail: { id: 'inv_1', status: 'ready', error: null, record: invocation({ id: 'inv_1' }) } },
    (html) => {
      assert.match(html, /body_captured/);
      assert.match(html, /invocations:read_body/);
    }
  );
});

test('the detail panel reports retryability as the console\'s own reading, not a gateway fact', () => {
  withState(
    { detail: { id: 'inv_1', status: 'ready', error: null, record: invocation({ id: 'inv_1', status: 'failed', error_class: 'upstream_5xx', upstream_status: 503 }) } },
    (html) => {
      assert.match(html, /console's own reading of the error class/);
    }
  );
});

test('a not-found direct lookup says the invocation does not exist, not "not found on this page"', () => {
  withState({ detail: { id: 'inv_missing', status: 'not_found', error: null, record: null } }, (html) => {
    assert.match(html, /No invocation with id inv_missing exists in this tenant/);
  });
});

test('invocation ids and other record text are escaped, not injected', () => {
  withAgents([normalizeAgent({ id: 'agt_1', name: '<img src=x onerror=alert(1)>', status: 'active', protocol: 'http' })], () => {
    withState({ invocations: [invocation({ agent_id: 'agt_1' })], total: 1 }, (html) => {
      assert.doesNotMatch(html, /<img src=x/);
      assert.match(html, /&lt;img src=x/);
    });
  });
});
