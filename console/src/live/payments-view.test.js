import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildQueryParams, livePaymentsState, livePaymentsView, normalizeSettlementConfig, row } from './payments-view.js';
import { normalizeInvocation } from './invocations-view.js';
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
    settlement: null,
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

// --- normalizeSettlementConfig ------------------------------------------------

test('normalizeSettlementConfig passes the collapsed null straight through', () => {
  assert.equal(normalizeSettlementConfig(null), null);
});

test('normalizeSettlementConfig renames the wire fields', () => {
  const cfg = normalizeSettlementConfig({
    facilitator_url: 'https://facilitator.example/settle',
    facilitator_credential_ref: 'cred_9',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-20T00:00:00Z',
  });
  assert.equal(cfg.facilitatorUrl, 'https://facilitator.example/settle');
  assert.equal(cfg.facilitatorCredentialRef, 'cred_9');
  assert.equal(cfg.createdAt, '2026-08-01T00:00:00Z');
  assert.equal(cfg.updatedAt, '2026-08-20T00:00:00Z');
});

// --- buildQueryParams ---------------------------------------------------------

test('buildQueryParams omits an "all" settlement filter rather than sending it literally', () => {
  assert.deepEqual(buildQueryParams({ settlement: 'all' }, 20, 0), { limit: 20, offset: 0 });
});

test('the settlement filter passes straight through to the settlement query parameter', () => {
  assert.equal(buildQueryParams({ settlement: 'settled' }, 20, 0).settlement, 'settled');
  assert.equal(buildQueryParams({ settlement: 'pending' }, 20, 0).settlement, 'pending');
  assert.equal(buildQueryParams({ settlement: 'settlement_failed' }, 20, 40).settlement, 'settlement_failed');
  assert.equal(buildQueryParams({ settlement: 'settled_upstream_failed' }, 20, 40).settlement, 'settled_upstream_failed');
});

test('buildQueryParams carries limit and offset through unchanged', () => {
  const params = buildQueryParams({ settlement: 'all' }, 20, 40);
  assert.equal(params.limit, 20);
  assert.equal(params.offset, 40);
});

// --- row rendering -------------------------------------------------------------

const names = new Map([['agt_1', 'Support agent']]);

test('a settled row shows its settlement status and amounts, all through usdc()', () => {
  const html = row(
    invocation({
      id: 'inv_settled',
      payment_network: 'base',
      payment_asset: 'USDC',
      payment_amount: '250000',
      payment_payer: '0xabc',
      settlement: { status: 'settled', settled_amount: '250000', operator_amount: '245000', facilitator_fee: '5000', settled_at: '2026-08-30T00:05:00Z' },
    }),
    names
  );
  assert.match(html, /\$0\.25/);
  assert.match(html, /Settled/);
  assert.match(html, /Operator \$0\.245/);
  assert.match(html, /Fee \$0\.005/);
  assert.match(html, /base/);
  assert.match(html, /0xabc/);
});

test('a gate-only row (payment present, never settled) reads as gate-only, not pending or failed', () => {
  const html = row(
    invocation({
      id: 'inv_gate_only',
      payment_network: 'base',
      payment_asset: 'USDC',
      payment_amount: '10000',
      payment_payer: '0xdef',
      settlement: null,
    }),
    names
  );
  assert.match(html, /Gate-only · never settled/);
  assert.doesNotMatch(html, /class="status pending"/);
  assert.doesNotMatch(html, /class="status settled"/);
});

test('an invocation with no payment fields never renders as a $0 payment', () => {
  const html = row(invocation({ id: 'inv_unpriced', payment_amount: null, settlement: null }), names);
  assert.match(html, /No payment gate/);
  assert.doesNotMatch(html, /\$/);
});

test('a payer address renders verbatim, and an absent one reads as Unknown rather than blank', () => {
  const withPayer = row(invocation({ payment_amount: '1000', payment_payer: '0xabc' }), names);
  assert.match(withPayer, /0xabc/);

  const withoutPayer = row(invocation({ payment_amount: '1000', payment_payer: null }), names);
  assert.match(withoutPayer, /Unknown/);
});

test('agent names come from the cached catalog rather than the raw id', () => {
  const html = row(invocation({ agent_id: 'agt_1' }), names);
  assert.match(html, /Support agent/);
});

test('an agent missing from the cache still shows the raw id, not a blank', () => {
  const html = row(invocation({ agent_id: 'agt_unknown' }), new Map());
  assert.match(html, /agt_unknown/);
});

test('invocation and agent text is escaped, not injected', () => {
  const html = row(invocation({ id: '<img src=x onerror=alert(1)>' }), new Map());
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

// --- full-page rendering -------------------------------------------------------

function withState(over, fn) {
  const saved = { ...livePaymentsState, filters: { ...livePaymentsState.filters }, settlement: { ...livePaymentsState.settlement } };
  Object.assign(livePaymentsState, {
    status: 'ready',
    error: null,
    invocations: [],
    total: 0,
    limit: 20,
    offset: 0,
    filters: { settlement: 'all' },
    settlement: { status: 'ready', error: null, config: null },
    ...over,
  });
  try {
    return fn(livePaymentsView());
  } finally {
    Object.assign(livePaymentsState, saved);
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

test('the not-configured settlement posture reads as gate-only, not as an error or an empty table', () => {
  withAgents([], () => {
    withState({ settlement: { status: 'ready', error: null, config: null } }, (html) => {
      assert.match(html, /Settlement not configured · gate-only/);
      assert.doesNotMatch(html, /form-error/);
    });
  });
});

test('a configured settlement posture is described, with no edit control', () => {
  withAgents([], () => {
    withState(
      {
        settlement: {
          status: 'ready',
          error: null,
          config: normalizeSettlementConfig({
            facilitator_url: 'https://facilitator.example/settle',
            facilitator_credential_ref: 'cred_9',
            created_at: '2026-08-01T00:00:00Z',
            updated_at: '2026-08-20T00:00:00Z',
          }),
        },
      },
      (html) => {
        assert.match(html, /facilitator\.example\/settle/);
        assert.match(html, /cred_9/);
        assert.doesNotMatch(html, /<form/i);
        assert.doesNotMatch(html, /data-live-payment-action="(save|edit|configure)"/);
      }
    );
  });
});

test('the settlement filter offers only the four real values, and no option that can never match', () => {
  withAgents([], () => {
    withState({}, (html) => {
      assert.match(html, /data-live-payment-filter="settlement"/);
      assert.match(html, /<option value="pending">Pending<\/option>/);
      assert.match(html, /<option value="settled">Settled<\/option>/);
      assert.match(html, /<option value="settlement_failed">Settlement failed<\/option>/);
      assert.match(html, /<option value="settled_upstream_failed">Settled, upstream failed<\/option>/);
      // No option value could ever match a 402 challenge — there is only prose
      // explaining why, never a selectable filter for it.
      assert.doesNotMatch(html, /<option[^>]*>[^<]*(402|challenge)/i);
    });
  });
});

test('the copy explains why there is no 402-challenge filter or metric, rather than silently omitting one', () => {
  withAgents([], () => {
    withState({}, (html) => {
      assert.match(html, /challenged request that never paid/i);
      assert.doesNotMatch(html, /402 challenges?<\/small>/i);
    });
  });
});

test('the page states plainly that a challenged, unpaid request never becomes a row here', () => {
  withAgents([], () => {
    withState({}, (html) => {
      assert.match(html, /never paid never becomes a row here/i);
    });
  });
});

test('pagination states the current range and the total, and never claims the loaded page is every payment', () => {
  withAgents([], () => {
    withState({ invocations: [invocation()], total: 143, limit: 20, offset: 20 }, (html) => {
      assert.match(html, /Showing 21–40 of 143/);
      assert.match(html, /not every invocation carried a payment/i);
    });
  });
});

test('an unreachable gateway offers a retry rather than an empty list', () => {
  withAgents([], () => {
    withState({ status: 'error', error: 'Gateway is unreachable from the console.' }, (html) => {
      assert.match(html, /unreachable/);
      assert.match(html, /data-live-payment-action="retry"/);
    });
  });
});

test('a settlement posture load failure offers its own retry, distinct from the invocation list', () => {
  withAgents([], () => {
    withState({ settlement: { status: 'error', error: 'Settlement posture could not be loaded.', config: null } }, (html) => {
      assert.match(html, /Settlement posture could not be loaded/);
      assert.match(html, /data-live-payment-action="retry-settlement"/);
    });
  });
});

test('no write control exists anywhere on the page', () => {
  withAgents([], () => {
    withState({ invocations: [invocation({ payment_amount: '1000' })], total: 1 }, (html) => {
      assert.doesNotMatch(html, /<button[^>]*>\s*(Retry payment|Refund|Configure settlement|Retry settlement|Save)/i);
      assert.doesNotMatch(html, /data-live-payment-action="(configure|retry-payment|refund|save|delete)"/);
      assert.doesNotMatch(html, /<form/i);
    });
  });
});
