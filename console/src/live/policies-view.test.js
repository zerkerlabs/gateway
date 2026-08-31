import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterLoadedDecisions,
  livePoliciesState,
  livePoliciesView,
  normalizeDecision,
  normalizePolicy,
  normalizeRule,
  ruleLabel,
  sampleMatchCounts,
} from './policies-view.js';
import { liveAgentsState } from './agents-view.js';
import { normalizeAgent } from './api.js';

function agent(over = {}) {
  return normalizeAgent({
    id: 'agt_1',
    name: 'Support agent',
    status: 'active',
    protocol: 'http',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...over,
  });
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

// --- normalization -----------------------------------------------------------

test('normalizePolicy carries version 0 through untouched, not coerced to a default', () => {
  const p = normalizePolicy({ version: 0, rules: [] });
  assert.equal(p.version, 0);
  assert.equal(p.default, null);
  assert.equal(p.rules.length, 0);
});

test('normalizeRule assigns a 1-based position matching matched_rule\'s own convention', () => {
  const p = normalizePolicy({
    version: 3,
    default: 'allow',
    on_error: 'deny',
    rules: [{ action: 'deny', match: {} }, { action: 'warn', match: {} }],
  });
  assert.equal(p.rules[0].position, 1);
  assert.equal(p.rules[1].position, 2);
});

test('a rule with no classifier field normalizes to null, not an empty object', () => {
  const rule = normalizeRule({ action: 'allow', match: {} }, 0);
  assert.equal(rule.classifier, null);
});

test('a rule carrying a classifier keeps its webhook url', () => {
  const rule = normalizeRule({ action: 'deny', match: {}, classifier: { url: 'https://classifier.example/verdict' } }, 0);
  assert.equal(rule.classifier.url, 'https://classifier.example/verdict');
});

test('normalizeDecision keeps matched_rule as the raw position string, empty meaning default/on_error', () => {
  const withRule = normalizeDecision({ id: 'pdec_1', agent_id: 'agt_1', protocol: 'http', action: 'deny', matched_rule: '2', reason: 'blocked', created_at: '2026-08-30T00:00:00Z' });
  assert.equal(withRule.matchedRule, '2');
  const fromDefault = normalizeDecision({ id: 'pdec_2', agent_id: 'agt_1', protocol: 'http', action: 'allow', matched_rule: '', reason: 'default', created_at: '2026-08-30T00:00:00Z' });
  assert.equal(fromDefault.matchedRule, '');
});

// --- ruleLabel ---------------------------------------------------------------

test('ruleLabel synthesizes a description from match conditions, never a stored name', () => {
  const rule = normalizeRule({ action: 'deny', match: { tools: ['delete_*'], rate_per_min: 60 } }, 0);
  const label = ruleLabel(rule);
  assert.match(label, /delete_\*/);
  assert.match(label, /60\/min/);
});

test('ruleLabel resolves agent ids in the match to names when known', () => {
  const rule = normalizeRule({ action: 'warn', match: { agents: ['agt_1'] } }, 0);
  const names = new Map([['agt_1', 'Support agent']]);
  assert.match(ruleLabel(rule, names), /Support agent/);
});

test('an unresolvable agent id in the match falls back to the raw id', () => {
  const rule = normalizeRule({ action: 'warn', match: { agents: ['agt_ghost'] } }, 0);
  assert.match(ruleLabel(rule, new Map()), /agt_ghost/);
});

test('a rule with no match conditions reads as matching every call', () => {
  const rule = normalizeRule({ action: 'deny', match: {} }, 0);
  assert.equal(ruleLabel(rule), 'Matches every call');
});

// --- sampleMatchCounts ---------------------------------------------------

test('sampleMatchCounts counts only within the given sample, keyed by position string', () => {
  const decisions = [
    normalizeDecision({ id: 'pdec_1', agent_id: 'a', protocol: 'http', action: 'deny', matched_rule: '2', reason: '', created_at: 't' }),
    normalizeDecision({ id: 'pdec_2', agent_id: 'a', protocol: 'http', action: 'deny', matched_rule: '2', reason: '', created_at: 't' }),
    normalizeDecision({ id: 'pdec_3', agent_id: 'a', protocol: 'http', action: 'allow', matched_rule: '', reason: '', created_at: 't' }),
  ];
  const counts = sampleMatchCounts(decisions);
  assert.equal(counts.get('2'), 2);
  // Decisions with no matched_rule (default/on_error) are not counted against any rule.
  assert.equal(counts.get(''), undefined);
});

// --- filterLoadedDecisions ---------------------------------------------------

test('filterLoadedDecisions narrows the loaded sample by action and free text', () => {
  const decisions = [
    normalizeDecision({ id: 'pdec_1', agent_id: 'agt_1', protocol: 'mcp', mcp_tool: 'search', action: 'deny', matched_rule: '1', reason: 'blocked', created_at: 't' }),
    normalizeDecision({ id: 'pdec_2', agent_id: 'agt_2', protocol: 'http', action: 'allow', matched_rule: '', reason: 'default', created_at: 't' }),
  ];
  const ids = (f) => filterLoadedDecisions(decisions, { query: '', action: 'all', ...f }).map((d) => d.id);
  assert.deepEqual(ids({ action: 'deny' }), ['pdec_1']);
  assert.deepEqual(ids({ query: 'search' }), ['pdec_1']);
  assert.deepEqual(ids({ query: 'nothing-matches' }), []);
});

// --- rendering ---------------------------------------------------------------

function withState(over, fn) {
  const saved = { ...livePoliciesState };
  Object.assign(livePoliciesState, {
    status: 'ready',
    error: null,
    policy: normalizePolicy({ version: 1, default: 'allow', on_error: 'deny', rules: [], updated_at: '2026-08-01T00:00:00Z' }),
    decisions: { status: 'ready', error: null, items: [], limit: 20 },
    decisionFilters: { query: '', action: 'all' },
    ...over,
  });
  try {
    return fn(livePoliciesView());
  } finally {
    Object.assign(livePoliciesState, saved);
  }
}

test('version 0 renders as "no policy configured", not an error or an empty table', () => {
  withAgents([], () => {
    withState({ policy: normalizePolicy({ version: 0, rules: [] }) }, (html) => {
      assert.match(html, /No policy configured/i);
      assert.doesNotMatch(html, /form-error/);
    });
  });
});

test('a configured policy shows the live default, on_error, version and updated_at', () => {
  withAgents([], () => {
    withState({ policy: normalizePolicy({ version: 4, default: 'warn', on_error: 'deny', rules: [], updated_at: '2026-08-20T00:00:00Z' }) }, (html) => {
      assert.match(html, />Warn</);
      assert.match(html, />Deny</);
      assert.match(html, />4</);
    });
  });
});

test('rules render in document order labelled as the evaluation order', () => {
  withAgents([], () => {
    const policy = normalizePolicy({
      version: 2,
      default: 'allow',
      on_error: 'deny',
      rules: [{ action: 'deny', match: { tools: ['delete_*'] } }, { action: 'warn', match: { rate_per_min: 30 } }],
    });
    withState({ policy }, (html) => {
      assert.match(html, /first match wins/i);
      assert.match(html, /Evaluated 1 of 2/);
      assert.match(html, /Evaluated 2 of 2/);
    });
  });
});

test('a rule with a classifier is visibly marked as delegating, and its own action is not shown as if it applied', () => {
  withAgents([], () => {
    const policy = normalizePolicy({
      version: 1,
      default: 'allow',
      on_error: 'deny',
      rules: [{ action: 'allow', match: {}, classifier: { url: 'https://classifier.example/verdict' } }],
    });
    withState({ policy }, (html) => {
      assert.match(html, /Classifier decides/i);
      assert.match(html, /classifier\.example\/verdict/);
    });
  });
});

test('a deterministic rule with no classifier shows its plain action', () => {
  withAgents([], () => {
    const policy = normalizePolicy({ version: 1, default: 'allow', on_error: 'deny', rules: [{ action: 'deny', match: { tools: ['x'] } }] });
    withState({ policy }, (html) => {
      assert.match(html, />Deny</);
      assert.doesNotMatch(html, /Classifier decides/);
    });
  });
});

test('per-rule decision counts are scoped to the loaded sample, not presented as a lifetime total', () => {
  withAgents([], () => {
    const policy = normalizePolicy({ version: 1, default: 'allow', on_error: 'deny', rules: [{ action: 'deny', match: { tools: ['x'] } }] });
    const decisions = {
      status: 'ready',
      error: null,
      items: [normalizeDecision({ id: 'pdec_1', agent_id: 'agt_1', protocol: 'http', action: 'deny', matched_rule: '1', reason: '', created_at: 't' })],
      limit: 20,
    };
    withState({ policy, decisions }, (html) => {
      assert.match(html, /of the last 1/);
      assert.match(html, /reordering the document would misattribute/i);
    });
  });
});

test('decisions render newest-first, labelled by the newest N rather than a time window', () => {
  withAgents([agent()], () => {
    const decisions = {
      status: 'ready',
      error: null,
      items: [
        normalizeDecision({ id: 'pdec_1', agent_id: 'agt_1', protocol: 'mcp', mcp_tool: 'search', action: 'allow', matched_rule: '', reason: 'no rule matched', created_at: '2026-08-30T00:00:00Z' }),
      ],
      limit: 20,
    };
    withState({ decisions }, (html) => {
      assert.match(html, /newest 20/i);
      assert.match(html, /Newest first/i);
      assert.doesNotMatch(html, /Last \d+ (minutes|hours|days)/i);
    });
  });
});

test('there is no pagination control on the decisions list', () => {
  withAgents([], () => {
    withState({}, (html) => {
      assert.doesNotMatch(html, /Previous|Next →/);
      assert.doesNotMatch(html, /data-live-policy-action="(prev|next)-page"/);
    });
  });
});

test('a decision with no matched rule reads as the default action, not rule zero', () => {
  withAgents([], () => {
    const decisions = {
      status: 'ready',
      error: null,
      items: [normalizeDecision({ id: 'pdec_1', agent_id: 'agt_1', protocol: 'http', action: 'allow', matched_rule: '', reason: 'default', created_at: 't' })],
      limit: 20,
    };
    withState({ decisions }, (html) => {
      assert.match(html, /Default action/);
    });
  });
});

test('a decision whose matched_rule position no longer exists in the document says so rather than guessing', () => {
  withAgents([], () => {
    const policy = normalizePolicy({ version: 1, default: 'allow', on_error: 'deny', rules: [] });
    const decisions = {
      status: 'ready',
      error: null,
      items: [normalizeDecision({ id: 'pdec_1', agent_id: 'agt_1', protocol: 'http', action: 'deny', matched_rule: '3', reason: '', created_at: 't' })],
      limit: 20,
    };
    withState({ policy, decisions }, (html) => {
      assert.match(html, /No rule sits there/i);
    });
  });
});

test('no policy editor, PUT, or simulate control exists anywhere on the page', () => {
  withAgents([], () => {
    withState({}, (html) => {
      // The page description says plainly that there is no simulate control
      // (see the header copy); what must never appear is an actual one.
      assert.doesNotMatch(html, /<button[^>]*>\s*Simulate/i);
      assert.doesNotMatch(html, /<form/i);
      assert.doesNotMatch(html, /data-action="edit-policy"/);
      assert.doesNotMatch(html, /Save policy|Publish policy/i);
    });
  });
});

test('an error state offers a retry', () => {
  withState({ status: 'error', error: 'Gateway is unreachable from the console.' }, (html) => {
    assert.match(html, /unreachable/);
    assert.match(html, /data-live-policy-action="retry"/);
  });
});

test('policy-supplied text is escaped, not injected', () => {
  withAgents([], () => {
    const decisions = {
      status: 'ready',
      error: null,
      items: [normalizeDecision({ id: 'pdec_1', agent_id: 'agt_1', protocol: 'http', action: 'deny', matched_rule: '', reason: '<img src=x onerror=alert(1)>', created_at: 't' })],
      limit: 20,
    };
    withState({ decisions }, (html) => {
      assert.doesNotMatch(html, /<img src=x/);
      assert.match(html, /&lt;img src=x/);
    });
  });
});
