// The live policy surface: GET /v1/policy (the document) and
// GET /v1/policy/decisions (the audit sample), strictly read-only.
//
// Three things the fixture this view replaces claimed that the real document
// does not carry, and this view is deliberately built around not
// re-inventing them:
//
//   rule identity   — a PolicyRule is exactly `{action, match, classifier?}`.
//                     There is no stored name, id, or description to render,
//                     so ruleLabel() below synthesizes a readable summary
//                     from the match conditions. It is a description this
//                     console generated, never a value Gateway sent.
//   the classifier   — a rule may carry `classifier: {url}`, which delegates
//   webhook            that rule's decision to an external webhook instead of
//                     its own fixed `action` (see gateway/internal/httpapi/
//                     policy_enforce.go: matchedClassifierRule /
//                     invokeClassifier). Once a rule has a classifier, its
//                     `action` field is not a fallback — a failed webhook
//                     call falls back to the policy's own `on_error`, not to
//                     the rule's action. This view marks a classifier rule
//                     plainly rather than showing `action` as if it still
//                     applied.
//   matched_rule      — PolicyDecision.matched_rule is the 1-based *position*
//                     of the rule that produced a decision at the time it was
//                     recorded, not a stable rule id (rules have none). If the
//                     document is reordered afterward, position 2 today is
//                     not the rule that actually produced an older decision
//                     recorded when position 2 meant something else. Per-rule
//                     decision counts are therefore never presented as
//                     lifetime totals — see sampleMatchCounts() below.
//
// GET /v1/policy/decisions takes only `limit` (max 100) — no offset, no time
// window, no total. So the decisions list is labelled by exactly what it is
// ("the newest N decisions") and has no pagination control, because there is
// nothing on the wire to paginate with.

import { api, ApiError } from './api.js';
import { count, relative, timestamp, UNKNOWN } from './format.js';
import { liveAgentsState } from './agents-view.js';
import { renderSignIn } from './gate.js';

const DECISION_LIMITS = [20, 50, 100];
const DEFAULT_DECISION_LIMIT = 20;

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function unauthenticated() {
  renderSignIn(document.body, { reason: 'expired' });
}

// --- normalization -----------------------------------------------------------

// index is the rule's position in the document array, 1-based to match
// PolicyDecision.matched_rule's own convention.
export function normalizeRule(raw, index) {
  return {
    position: index + 1,
    action: raw?.action || null,
    match: {
      agents: raw?.match?.agents || [],
      tools: raw?.match?.tools || [],
      maxBodyBytes: Number.isFinite(raw?.match?.max_body_bytes) ? raw.match.max_body_bytes : null,
      ratePerMin: Number.isFinite(raw?.match?.rate_per_min) ? raw.match.rate_per_min : null,
    },
    classifier: raw?.classifier?.url ? { url: raw.classifier.url } : null,
  };
}

export function normalizePolicy(raw) {
  return {
    version: Number.isFinite(raw?.version) ? raw.version : 0,
    default: raw?.default || null,
    onError: raw?.on_error || null,
    updatedAt: raw?.updated_at || null,
    rules: (raw?.rules || []).map(normalizeRule),
  };
}

export function normalizeDecision(raw) {
  return {
    id: raw.id,
    agentId: raw.agent_id,
    protocol: raw.protocol || null,
    mcpTool: raw.mcp_tool ?? null,
    action: raw.action,
    matchedRule: raw.matched_rule || '', // '' = came from default/on_error, not a rule
    reason: raw.reason || '',
    createdAt: raw.created_at,
  };
}

// --- state ---------------------------------------------------------------

function defaultDecisionFilters() {
  return { query: '', action: 'all' };
}

const state = {
  status: 'idle', // idle | loading | ready | error
  error: null,
  policy: null,
  decisions: { status: 'idle', error: null, items: [], limit: DEFAULT_DECISION_LIMIT },
  decisionFilters: defaultDecisionFilters(),
};

// --- rule labels -------------------------------------------------------------

function agentNameMap() {
  return new Map(liveAgentsState.agents.map((a) => [a.id, a.name]));
}

function namesFor(ids, names) {
  return ids.map((id) => names.get(id) || id).join(', ');
}

// A rule carries no name, id, or description — only match conditions. This
// synthesizes a human-readable summary of those conditions; it is this
// console's own description, never a value Gateway returned, and callers
// must not present it as a stored name.
export function ruleLabel(rule, agentNames = new Map()) {
  const parts = [];
  if (rule.match.agents.length) parts.push(`agent ${namesFor(rule.match.agents, agentNames)}`);
  if (rule.match.tools.length) parts.push(`tool ${rule.match.tools.join(', ')}`);
  if (rule.match.maxBodyBytes !== null) parts.push(`body ≥ ${count(rule.match.maxBodyBytes)} bytes`);
  if (rule.match.ratePerMin !== null) parts.push(`rate > ${count(rule.match.ratePerMin)}/min`);
  if (!parts.length) return 'Matches every call';
  return parts.join(' · ');
}

function actionLabel(action) {
  if (action === 'allow') return 'Allow';
  if (action === 'warn') return 'Warn';
  if (action === 'deny') return 'Deny';
  return UNKNOWN;
}

// --- per-rule sample counts --------------------------------------------------

// Counts, within the decisions sample already loaded, how many carried each
// matched_rule position. This is deliberately not a lifetime total: it is
// scoped to exactly the N decisions on screen, and it silently misattributes
// history if the document has been reordered since an older decision in the
// sample was recorded — matched_rule is a position, not a stable rule
// identity, and there is nothing in the response that would let this view
// detect a reorder. The label built from this (see decisionsCell below)
// spells that scoping out rather than presenting the number as a total.
export function sampleMatchCounts(decisions) {
  const counts = new Map();
  for (const d of decisions) {
    if (!d.matchedRule) continue;
    counts.set(d.matchedRule, (counts.get(d.matchedRule) || 0) + 1);
  }
  return counts;
}

// --- rule rows ---------------------------------------------------------------

function decisionCell(rule) {
  if (rule.classifier) {
    return `<span class="status review">Classifier decides</span><small class="mono">${esc(rule.classifier.url)}</small>`;
  }
  return `<span class="status ${esc(rule.action || '')}">${esc(actionLabel(rule.action))}</span><small>Deterministic</small>`;
}

function sampleCell(rule, sampleCounts, sampleSize) {
  if (!sampleSize) return `<strong>${UNKNOWN}</strong><small>No decision sample loaded</small>`;
  const n = sampleCounts.get(String(rule.position)) || 0;
  return `<strong>${count(n)}</strong><small>of the last ${count(sampleSize)}, at this position now — reordering the document would misattribute this</small>`;
}

function ruleRow(rule, totalRules, agentNames, sampleCounts, sampleSize) {
  return `<article class="policy-rule-row live-policy-rule-row">
    <span class="rule-order">${String(rule.position).padStart(2, '0')}</span>
    <span data-label="Rule"><strong>${esc(ruleLabel(rule, agentNames))}</strong><small>Evaluated ${count(rule.position)} of ${count(totalRules)} · first match wins</small></span>
    <span data-label="Decision">${decisionCell(rule)}</span>
    <span data-label="Sample matches">${sampleCell(rule, sampleCounts, sampleSize)}</span>
  </article>`;
}

// --- decision rows -------------------------------------------------------

function matchedRuleCell(decision, rules, agentNames) {
  if (!decision.matchedRule) {
    return `<strong>Default action</strong><small>No rule matched, or on_error applied</small>`;
  }
  const position = Number(decision.matchedRule);
  const rule = rules.find((r) => r.position === position);
  if (!rule) {
    return `<strong>Position ${esc(decision.matchedRule)}</strong><small>No rule sits there in the current document — it may have been reordered or removed since</small>`;
  }
  return `<strong>Position ${esc(decision.matchedRule)}</strong><small>${esc(ruleLabel(rule, agentNames))}</small>`;
}

function decisionRow(decision, rules, agentNames) {
  const name = agentNames.get(decision.agentId);
  return `<article class="policy-decision-row live-policy-decision-row">
    <span data-label="Time"><strong title="${esc(timestamp(decision.createdAt))}">${esc(relative(decision.createdAt))}</strong><small class="mono">${esc(decision.id)}</small></span>
    <span data-label="Action"><span class="status ${esc(decision.action)}">${esc(actionLabel(decision.action))}</span></span>
    <span data-label="Agent / operation"><strong>${name ? esc(name) : `<span class="mono">${esc(decision.agentId)}</span>`}</strong><small>${esc((decision.protocol || UNKNOWN).toUpperCase())}${decision.mcpTool ? ` · ${esc(decision.mcpTool)}` : ''}</small></span>
    <span data-label="Rule">${matchedRuleCell(decision, rules, agentNames)}<small>${esc(decision.reason || 'No reason recorded')}</small></span>
  </article>`;
}

// --- policy posture --------------------------------------------------------

function posturePanel(policy) {
  return `<section class="policy-posture">
    <div><p class="kicker">Default</p><strong>${policy.default ? esc(actionLabel(policy.default)) : UNKNOWN}</strong><small>Applied when no rule matches</small></div>
    <div><p class="kicker">On error</p><strong>${policy.onError ? esc(actionLabel(policy.onError)) : UNKNOWN}</strong><small>Applied on an evaluation or store error</small></div>
    <div><p class="kicker">Version</p><strong>${count(policy.version)}</strong><small>Increments on every replace</small></div>
    <div><p class="kicker">Updated</p><strong>${policy.updatedAt ? esc(relative(policy.updatedAt)) : UNKNOWN}</strong><small title="${policy.updatedAt ? esc(timestamp(policy.updatedAt)) : ''}">Last <code>PUT /v1/policy</code></small></div>
  </section>`;
}

function unconfiguredPanel() {
  return `<div class="data-state empty" role="status">
    <span class="status empty"><i aria-hidden="true"></i>No policy configured</span>
    <div><h2>This tenant has no policy document</h2>
    <p><code>version: 0</code> is Gateway's documented "unconfigured" state, not an error and not an empty
    table — the endpoint never 404s here. With no policy in place, every call is currently evaluated as if
    no rule and no default existed: Gateway applies no policy behavior change until one is written.</p></div>
  </div>`;
}

// --- rules section -----------------------------------------------------------

function rulesSection(policy) {
  if (!policy.rules.length) {
    return `<section class="panel policy-rules-panel"><div class="panel-heading"><div><p class="kicker">Ordered policy document</p><h2>No rules</h2></div></div>
      <div class="governance-empty"><p class="kicker">Live tenant</p><h2>The document has a default and on_error posture, but no rules</h2>
      <p>Every call falls straight through to the default action above.</p></div></section>`;
  }
  const agentNames = agentNameMap();
  const sampleDecisions = state.decisions.status === 'ready' ? state.decisions.items : [];
  const sampleCounts = sampleMatchCounts(sampleDecisions);
  return `<section class="panel policy-rules-panel">
    <div class="panel-heading"><div><p class="kicker">Ordered policy document</p><h2>${count(policy.rules.length)} ${policy.rules.length === 1 ? 'rule' : 'rules'}</h2></div>
    <p>Rendered in document order — Gateway evaluates rules top to bottom and stops at the first match.</p></div>
    <div class="policy-rule-columns live-policy-rule-columns" aria-hidden="true"><span>Order</span><span>Rule</span><span>Decision</span><span>Sample matches</span></div>
    <div class="policy-rule-list">${policy.rules.map((r) => ruleRow(r, policy.rules.length, agentNames, sampleCounts, sampleDecisions.length)).join('')}</div>
  </section>`;
}

// --- decisions section ---------------------------------------------------

// Client-side filtering over the loaded sample only — mirrors
// invocations-view.js's filterLoadedPage(). There is no server-side filter on
// this endpoint at all (just `limit`), so this is the only filtering
// possible, and the copy below says "loaded sample" rather than implying a
// query against the tenant's full decision history.
export function filterLoadedDecisions(decisions, filters) {
  const q = (filters.query || '').trim().toLowerCase();
  return decisions.filter((d) => {
    if (filters.action !== 'all' && d.action !== filters.action) return false;
    if (!q) return true;
    return `${d.id} ${d.agentId} ${d.protocol || ''} ${d.mcpTool || ''} ${d.reason || ''}`.toLowerCase().includes(q);
  });
}

function decisionsFilterBar() {
  const f = state.decisionFilters;
  return `<section class="governance-filters" aria-label="Filter the loaded decision sample">
    <label class="governance-search"><span>Filter this sample</span>
      <input id="live-policy-decision-search" type="search" value="${esc(f.query)}" autocomplete="off"
        placeholder="ID, agent, tool or reason" />
      <small>Filters only the ${state.decisions.items.length} decisions already loaded, never the tenant's
      full history.</small>
    </label>
    <label><span>Action</span><select data-live-policy-decision-filter="action">
      ${['all', 'allow', 'warn', 'deny'].map((v) => `<option value="${v}"${v === f.action ? ' selected' : ''}>${v === 'all' ? 'All' : esc(actionLabel(v))}</option>`).join('')}
    </select></label>
    <label><span>Sample size</span><select data-live-policy-decision-limit>
      ${DECISION_LIMITS.map((n) => `<option value="${n}"${n === state.decisions.limit ? ' selected' : ''}>Newest ${n}</option>`).join('')}
    </select></label>
    <button class="button secondary" data-live-policy-action="clear-decision-filters">Clear filters</button>
  </section>`;
}

function decisionsSection(policy) {
  const agentNames = agentNameMap();
  const d = state.decisions;

  let body;
  if (d.status === 'loading') {
    body = `<section class="panel" aria-busy="true"><p>Loading recent policy decisions…</p></section>`;
  } else if (d.status === 'error') {
    body = `<section class="panel"><p class="form-error" role="alert">${esc(d.error)}</p>
      <button class="button secondary" data-live-policy-action="retry-decisions">Retry</button></section>`;
  } else if (!d.items.length) {
    body = `<div class="governance-empty"><p class="kicker">Live tenant</p><h2>No policy decisions recorded yet</h2>
      <p>This tenant has made no policy-gated calls, or none have been captured yet.</p></div>`;
  } else {
    const rows = filterLoadedDecisions(d.items, state.decisionFilters);
    body = rows.length
      ? `<div class="policy-decision-list live-policy-decision-list">${rows.map((dec) => decisionRow(dec, policy.rules, agentNames)).join('')}</div>`
      : `<div class="governance-empty"><p class="kicker">Filtered sample</p><h2>No loaded decisions match</h2>
         <p>Adjust the filter above. This does not mean the tenant has no matching decisions overall — only this loaded sample.</p></div>`;
  }

  return `<section class="policy-decision-section">
    <div class="section-heading compact-heading">
      <div><p class="kicker">Decision audit</p><h2>The newest ${count(d.limit)} decisions</h2></div>
      <p>Newest first · not a time window · no pagination, because <code>GET /v1/policy/decisions</code> takes only <code>limit</code>, no offset.</p>
    </div>
    ${decisionsFilterBar()}
    ${body}
  </section>`;
}

// --- view --------------------------------------------------------------------

function renderHeader() {
  return `<header class="page-heading">
    <div>
      <p class="kicker">Control · live tenant</p>
      <h1 id="page-title">Policies</h1>
      <p class="page-description">This tenant's policy document and its recent decisions, both read-only.
      There is no policy editor, no <code>PUT</code>, and no simulate control here.</p>
    </div>
    <div class="page-actions">
      <button class="button secondary" data-live-policy-action="refresh">Refresh</button>
    </div>
  </header>`;
}

export function livePoliciesView() {
  if (state.status === 'idle' && typeof document !== 'undefined') {
    state.status = 'loading';
    loadPolicy().then(rerenderIfMounted);
    loadDecisions().then(rerenderIfMounted);
  }

  const header = renderHeader();

  if (state.status === 'idle' || state.status === 'loading') {
    return `<section class="page-enter governance-page policy-page" data-live-policies-root>${header}
      <section class="panel" aria-busy="true"><p>Loading tenant policy…</p></section></section>`;
  }
  if (state.status === 'error') {
    return `<section class="page-enter governance-page policy-page" data-live-policies-root>${header}
      <section class="panel"><p class="form-error" role="alert">${esc(state.error)}</p>
      <button class="button secondary" data-live-policy-action="retry">Retry</button></section></section>`;
  }

  const policy = state.policy;

  if (policy.version === 0) {
    return `<section class="page-enter governance-page policy-page" data-live-policies-root>
      ${header}
      ${unconfiguredPanel()}
      ${decisionsSection(policy)}
    </section>`;
  }

  return `<section class="page-enter governance-page policy-page" data-live-policies-root>
    ${header}
    ${posturePanel(policy)}
    ${rulesSection(policy)}
    ${decisionsSection(policy)}
  </section>`;
}

// --- loading -----------------------------------------------------------------

async function loadPolicy() {
  state.status = 'loading';
  state.error = null;
  try {
    state.policy = normalizePolicy(await api.getPolicy());
    state.status = 'ready';
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return unauthenticated();
    state.status = 'error';
    state.error =
      err instanceof ApiError && err.code === 'unreachable'
        ? 'Gateway is unreachable from the console.'
        : 'The tenant policy could not be loaded.';
  }
}

async function loadDecisions() {
  state.decisions = { ...state.decisions, status: 'loading', error: null };
  try {
    const res = await api.listPolicyDecisions({ limit: state.decisions.limit });
    state.decisions = {
      status: 'ready',
      error: null,
      items: (res?.data || []).map(normalizeDecision),
      limit: Number.isFinite(res?.limit) ? res.limit : state.decisions.limit,
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return unauthenticated();
    state.decisions = {
      ...state.decisions,
      status: 'error',
      error:
        err instanceof ApiError && err.code === 'unreachable'
          ? 'Gateway is unreachable from the console.'
          : 'Recent policy decisions could not be loaded.',
      items: [],
    };
  }
}

function rerenderIfMounted() {
  const root = document.querySelector('[data-live-policies-root]');
  if (!root) return;
  root.outerHTML = livePoliciesView();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-live-policy-action]');
    if (!el) return;
    const action = el.dataset.livePolicyAction;

    if (action === 'retry' || action === 'refresh') {
      await Promise.all([loadPolicy(), loadDecisions()]);
      rerenderIfMounted();
    } else if (action === 'retry-decisions') {
      await loadDecisions();
      rerenderIfMounted();
    } else if (action === 'clear-decision-filters') {
      state.decisionFilters = defaultDecisionFilters();
      rerenderIfMounted();
      document.querySelector('#live-policy-decision-search')?.focus();
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.id !== 'live-policy-decision-search') return;
    state.decisionFilters = { ...state.decisionFilters, query: event.target.value };
    rerenderIfMounted();
    const next = document.querySelector('#live-policy-decision-search');
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  });

  document.addEventListener('change', async (event) => {
    if (event.target.dataset?.livePolicyDecisionFilter === 'action') {
      state.decisionFilters = { ...state.decisionFilters, action: event.target.value };
      rerenderIfMounted();
      return;
    }
    if (event.target.matches('[data-live-policy-decision-limit]')) {
      state.decisions = { ...state.decisions, limit: Number(event.target.value) || DEFAULT_DECISION_LIMIT };
      await loadDecisions();
      rerenderIfMounted();
    }
  });
}

export const livePoliciesState = state;
