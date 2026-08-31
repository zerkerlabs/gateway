// The live invocation explorer: filters and paginates GET /v1/invocations
// server-side, and looks a single invocation up by id through
// GET /v1/invocations/{id} for the detail view.
//
// Three facts this view must not blur:
//
//   traffic shown here — an invocation record is only created once a request
//                        clears policy and payment. A denial or an unpaid x402
//                        challenge returns before that happens, so this table
//                        is "traffic that was allowed to proceed", not all
//                        traffic. The page says so in running copy, not a
//                        tooltip.
//   retryability        — the gateway records `error_class` and
//                        `upstream_status`; it does not record whether a
//                        retry would succeed. Any retryability shown here is
//                        this console's own reading of the error class, and
//                        is labelled as such.
//   the Policy column   — `policy_action` is only ever `allow` or `warn`: a
//                        denial returns before the invocation record is
//                        created, so `deny` can never appear here and the
//                        filter never offers it. A null `policy_action` means
//                        the tenant has no policy configured, which is a
//                        different fact from `allow` and is rendered as its
//                        own "No policy configured" state rather than folded
//                        into allow.
//
// This module wires its own document-level listeners and kicks off its own
// first load, guarded by `typeof document`, because unlike the agent catalog
// it is not pre-loaded in app.js's boot() — app.js only imports this module
// and routes the `invocations` view to it. That guard also keeps this file
// safe to import under `node --test`, which has no DOM.

import { api, ApiError } from './api.js';
import { count, duration, relative, timestamp, UNKNOWN } from './format.js';
import { liveAgentsState } from './agents-view.js';
import { renderSignIn } from './gate.js';

const PAGE_SIZE = 20;

// How long the search box waits after the last keystroke before treating an
// inv_-shaped query as a lookup. Without this, every intermediate prefix of
// an id the operator is still typing would fire its own GET, almost always
// 404 first, and flash "not found" for an id that in fact exists.
const LOOKUP_DEBOUNCE_MS = 400;

// Enumerated straight from gateway/openapi.yaml's InvocationListItem — the
// gateway returns no results for an unrecognized error_class rather than
// rejecting it, but offering only the real taxonomy keeps the filter useful.
const ERROR_CLASSES = ['timeout', 'upstream_5xx', 'upstream_4xx', 'ssrf_blocked', 'credential_error', 'cancelled', 'internal'];
const SETTLEMENT_STATUSES = ['pending', 'settled', 'settlement_failed', 'settled_upstream_failed'];

// `deny` is deliberately absent: a policy denial returns before the
// invocation is created, so it can never be the value on a row and offering
// it as a filter option would promise a result that can never come back.
const POLICY_ACTIONS = ['allow', 'warn'];

// `inv_<uuidv7>`. Loose on purpose: this only decides whether the search box
// behaves as a direct id lookup, not whether the id is well-formed — the
// gateway is the one system allowed to say an id doesn't exist.
const ID_PATTERN = /^inv_\S+$/i;

function defaultFilters() {
  return { status: 'all', mode: 'all', agentId: 'all', errorClass: 'all', settlement: 'all', policy: 'all', range: 'all' };
}

const state = {
  status: 'idle', // idle | loading | ready | error
  error: null,
  invocations: [],
  total: 0,
  limit: PAGE_SIZE,
  offset: 0,
  filters: defaultFilters(),
  query: '',
  // A single open detail, whether reached by "Inspect" on a loaded row or by
  // typing a full id into search. Only GET /v1/invocations/{id} carries
  // body_captured, so this is the one place that call is made — once, for
  // the record the operator asked about, never per row.
  detail: { id: null, status: 'idle', error: null, record: null },
};

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function unauthenticated() {
  renderSignIn(document.body, { reason: 'expired' });
}

// --- normalization -----------------------------------------------------------

// api.js owns normalizeAgent but not an invocation equivalent — this view is
// the only consumer so far, so an invocation-specific normalizer lives here
// rather than as a single-caller addition to api.js.
export function normalizeInvocation(raw) {
  return {
    id: raw.id,
    agentId: raw.agent_id,
    mode: raw.mode,
    status: raw.status,
    errorClass: raw.error_class || null,
    // Null means the tenant has no policy configured, not "allowed" — see the
    // file header. `deny` is impossible: a denied call never reaches this
    // record. policyMatchedRule uses `??` rather than `||` because `''` (the
    // tenant default matched, no explicit rule) is a meaningful, distinct
    // value from null and must survive.
    policyAction: raw.policy_action ?? null,
    policyMatchedRule: raw.policy_matched_rule ?? null,
    model: raw.model || null,
    mcpMethod: raw.mcp_method || null,
    mcpTool: raw.mcp_tool || null,
    paymentNetwork: raw.payment_network || null,
    paymentAsset: raw.payment_asset || null,
    paymentAmount: raw.payment_amount || null,
    paymentPayer: raw.payment_payer || null,
    paymentNonce: raw.payment_nonce || null,
    settlement: raw.settlement || null,
    upstreamStatus: Number.isFinite(raw.upstream_status) ? raw.upstream_status : null,
    latencyMs: Number.isFinite(raw.latency_ms) ? raw.latency_ms : null,
    ttftMs: Number.isFinite(raw.ttft_ms) ? raw.ttft_ms : null,
    reqSize: Number.isFinite(raw.req_size) ? raw.req_size : null,
    respSize: Number.isFinite(raw.resp_size) ? raw.resp_size : null,
    // Only present on InvocationDetail; absent (not false) on a list item.
    bodyCaptured: typeof raw.body_captured === 'boolean' ? raw.body_captured : null,
    createdAt: raw.created_at,
    completedAt: raw.completed_at || null,
  };
}

// --- server-side filtering & pagination --------------------------------------

// A day count long enough that "Last 7 days" reads as a real boundary rather
// than an arbitrary one, and short enough to stay well under the gateway's
// unrelated 31-day analytics cap (a different endpoint, but no reason to
// invite the comparison).
const RANGE_MS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 };

export function rangeSince(range, now = new Date()) {
  const ms = RANGE_MS[range];
  return ms ? new Date(now.getTime() - ms).toISOString() : undefined;
}

// Exported so the mapping from UI filter state to gateway query params is
// testable without a network call.
export function buildQueryParams(filters, limit, offset) {
  const params = { limit, offset };
  if (filters.status !== 'all') params.status = filters.status;
  if (filters.mode !== 'all') params.mode = filters.mode;
  if (filters.agentId !== 'all') params.agent_id = filters.agentId;
  if (filters.errorClass !== 'all') params.error_class = filters.errorClass;
  if (filters.settlement !== 'all') params.settlement = filters.settlement;
  if (filters.policy !== 'all') params.policy = filters.policy;
  const since = rangeSince(filters.range);
  if (since) params.since = since;
  return params;
}

export function isInvocationId(query) {
  return ID_PATTERN.test((query || '').trim());
}

// The search box filters only the page already in hand — the gateway has no
// full-text search, and pretending otherwise would make "no matches" mean two
// different things depending on which filter produced it.
export function filterLoadedPage(invocations, query, names = new Map()) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return invocations;
  return invocations.filter((item) => {
    const haystack = [
      item.id,
      item.agentId,
      names.get(item.agentId) || '',
      item.mcpMethod,
      item.mcpTool,
      item.model,
      item.errorClass,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

// --- labels --------------------------------------------------------------

function agentNameMap() {
  return new Map(liveAgentsState.agents.map((a) => [a.id, a.name]));
}

function statusChip(status) {
  const cls = { succeeded: 'succeeded', failed: 'failed', pending: 'pending', running: 'loading' }[status] || 'empty';
  return `<span class="status ${cls}">${esc(status || UNKNOWN)}</span>`;
}

function modeLabel(mode) {
  if (mode === 'streaming') return 'Streaming';
  if (mode === 'transactional') return 'Transactional';
  return UNKNOWN;
}

const ERROR_CLASS_LABELS = {
  timeout: 'Timeout',
  upstream_5xx: 'Upstream 5xx',
  upstream_4xx: 'Upstream 4xx',
  ssrf_blocked: 'SSRF blocked',
  credential_error: 'Credential error',
  cancelled: 'Cancelled',
  internal: 'Internal',
};

function errorClassLabel(value) {
  return ERROR_CLASS_LABELS[value] || value;
}

const SETTLEMENT_LABELS = {
  pending: 'Pending',
  settled: 'Settled',
  settlement_failed: 'Settlement failed',
  settled_upstream_failed: 'Settled, upstream failed',
};

function settlementStatusLabel(value) {
  return SETTLEMENT_LABELS[value] || value;
}

const POLICY_ACTION_LABELS = { allow: 'Allow', warn: 'Warn' };

// Distinct from UNKNOWN on purpose — UNKNOWN means "the gateway didn't tell
// us"; a null policy_action is the gateway telling us plainly that this
// tenant has no policy document, which is a known fact and not an absence of
// one. Collapsing it into "Allow" would tell an operator a call was vetted
// and cleared when in fact nothing ever evaluated it.
export function policyActionLabel(action) {
  if (action === null) return 'No policy configured';
  return POLICY_ACTION_LABELS[action] || action;
}

// `allow` and `warn` reuse the shared .status colour classes; a null action
// gets the same neutral "empty" treatment as an unrecognized status chip
// elsewhere in this file, never the green used for an actual allow.
function policyChip(action) {
  if (action === null) return `<span class="status empty">${esc(policyActionLabel(action))}</span>`;
  return `<span class="status ${esc(action)}">${esc(policyActionLabel(action))}</span>`;
}

export function policyMatchLabel(item) {
  if (item.policyAction === null) return 'Not applicable';
  if (item.policyMatchedRule === '') return 'Tenant default · no rule matched';
  return item.policyMatchedRule ? `Rule ${item.policyMatchedRule}` : UNKNOWN;
}

function sizeLabel(n) {
  return Number.isFinite(n) ? `${count(n)} B` : UNKNOWN;
}

function mcpLabel(item) {
  if (item.mcpMethod) return `${esc(item.mcpMethod)}${item.mcpTool ? ` · ${esc(item.mcpTool)}` : ''}`;
  if (item.model) return esc(item.model);
  return 'No operation metadata';
}

// This console's own read of the error class — the gateway reports
// error_class and upstream_status, never a retryability verdict, and
// presenting a guess as gateway fact would misdiagnose the next failure.
const RETRY_GUESS = {
  timeout: 'Likely retryable',
  upstream_5xx: 'Likely retryable',
  upstream_4xx: 'Not retryable',
  ssrf_blocked: 'Not retryable',
  credential_error: 'Not retryable',
  cancelled: 'Not retryable',
  internal: 'Unknown',
};

export function retryabilityGuess(errorClass) {
  return RETRY_GUESS[errorClass] || UNKNOWN;
}

export function failureDiagnosis(item) {
  if (!item.errorClass) return null;
  return {
    errorClass: item.errorClass,
    upstreamStatus: item.upstreamStatus,
    retryability: retryabilityGuess(item.errorClass),
  };
}

// The stages an invocation record can actually evidence: what policy decided,
// whether a payment gate ran, whether settlement resolved, what the upstream
// call did, and the terminal result. There is no Identity stage here — an
// invocation carries no identity field to report one from. The Policy stage
// uses the real policy_action rather than assuming allow; a deny can never
// appear because a denied call never becomes an invocation.
export function deriveTrace(item) {
  const paymentPresent = Boolean(item.paymentAmount);
  const stages = [
    {
      label: 'Policy',
      state: item.policyAction === 'warn' ? 'warning' : item.policyAction === 'allow' ? 'completed' : 'unknown',
      detail: item.policyAction === null ? 'No policy configured for this tenant' : `${policyActionLabel(item.policyAction)} · ${policyMatchLabel(item)}`,
    },
    {
      label: 'Payment gate',
      state: paymentPresent ? 'completed' : 'skipped',
      detail: paymentPresent
        ? `${item.paymentAmount} ${item.paymentAsset || ''} on ${item.paymentNetwork || UNKNOWN}`.trim()
        : 'No payment gate on this route',
    },
  ];

  if (item.settlement) {
    const s = item.settlement.status;
    stages.push({
      label: 'Settlement',
      state: s === 'settled' ? 'completed' : s === 'pending' ? 'pending' : s ? 'failed' : 'unknown',
      detail: s ? settlementStatusLabel(s) : UNKNOWN,
    });
  } else if (paymentPresent) {
    stages.push({ label: 'Settlement', state: 'unknown', detail: 'No settlement record on this invocation' });
  }

  stages.push({
    label: 'Upstream call',
    state: item.status === 'succeeded' ? 'completed' : item.status === 'failed' ? 'failed' : 'pending',
    detail: Number.isFinite(item.upstreamStatus)
      ? `Upstream responded ${item.upstreamStatus}`
      : item.status === 'failed'
        ? 'No upstream response recorded'
        : 'Awaiting upstream',
  });

  stages.push({
    label: 'Result',
    state: item.status === 'succeeded' ? 'completed' : item.status === 'failed' ? 'failed' : 'pending',
    detail: item.completedAt ? `Completed ${timestamp(item.completedAt)}` : 'Not yet completed',
  });

  return stages;
}

// --- rows ----------------------------------------------------------------

// Exported so the Overview page's "latest invocation sample" panel can render
// the exact same row rather than keeping a second copy of this markup — see
// live/overview-view.js.
export function row(item, names) {
  const name = names.get(item.agentId);
  return `
    <article class="catalog-row live-invocation-row${item.status === 'failed' ? ' is-failed' : ''}">
      <span data-label="Time">
        <strong title="${esc(timestamp(item.createdAt))}">${esc(relative(item.createdAt))}</strong>
        <small>${item.completedAt ? `Completed ${esc(relative(item.completedAt))}` : 'Not yet completed'}</small>
      </span>
      <span class="mono" data-label="Invocation">${esc(item.id)}</span>
      <span data-label="Agent / operation">
        <strong>${name ? esc(name) : `<span class="mono">${esc(item.agentId)}</span>`}</strong>
        <small>${mcpLabel(item)}</small>
      </span>
      <span data-label="Mode"><strong>${modeLabel(item.mode)}</strong></span>
      <span data-label="Result">${statusChip(item.status)}</span>
      <span data-label="Policy">${policyChip(item.policyAction)}</span>
      <span data-label="Latency"><strong>${duration(item.latencyMs)}</strong></span>
      <span data-label="Sizes"><small>Req ${sizeLabel(item.reqSize)}</small><small>Resp ${sizeLabel(item.respSize)}</small></span>
      <span data-label="Error class">${item.errorClass ? `<span class="status failed">${esc(errorClassLabel(item.errorClass))}</span>` : '<strong>No error</strong>'}</span>
      <span class="catalog-inspect">
        <button class="button secondary" data-live-invocation-action="inspect" data-invocation-id="${esc(item.id)}"
          aria-label="Inspect invocation ${esc(item.id)}">Inspect</button>
      </span>
    </article>`;
}

// --- filter bar & pagination ----------------------------------------------

function rangeDescription(range) {
  const since = rangeSince(range);
  return since ? `Since ${timestamp(since)}` : 'No lower time bound';
}

function filterBar() {
  const f = state.filters;
  const sel = (name, options, current) =>
    `<select data-live-invocation-filter="${name}">${options
      .map(([v, l]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(l)}</option>`)
      .join('')}</select>`;
  const agentOptions = [
    ['all', 'All'],
    ...liveAgentsState.agents.map((a) => [a.id, a.name]).toSorted((a, b) => a[1].localeCompare(b[1])),
  ];

  return `<section class="catalog-filters" aria-label="Filter tenant invocations (applied on Gateway)">
    <label class="catalog-search"><span>Search this page</span>
      <input id="invocation-query" type="search" value="${esc(state.query)}" autocomplete="off"
        placeholder="Filter this page, or paste an inv_ id to look it up directly" />
      <small>Filters only the ${state.invocations.length} rows already loaded. An <code>inv_</code> id instead looks
      that invocation up directly, so it is never missed just because it is on another page.</small>
    </label>
    <label><span>Result</span>${sel(
      'status',
      [
        ['all', 'All'],
        ['pending', 'Pending'],
        ['running', 'Running'],
        ['succeeded', 'Succeeded'],
        ['failed', 'Failed'],
      ],
      f.status
    )}</label>
    <label><span>Mode</span>${sel(
      'mode',
      [
        ['all', 'All'],
        ['transactional', 'Transactional'],
        ['streaming', 'Streaming'],
      ],
      f.mode
    )}</label>
    <label><span>Agent</span>${sel('agentId', agentOptions, f.agentId)}</label>
    <label><span>Error class</span>${sel(
      'errorClass',
      [['all', 'All'], ...ERROR_CLASSES.map((v) => [v, errorClassLabel(v)])],
      f.errorClass
    )}</label>
    <label><span>Settlement</span>${sel(
      'settlement',
      [['all', 'All'], ...SETTLEMENT_STATUSES.map((v) => [v, settlementStatusLabel(v)])],
      f.settlement
    )}</label>
    <label><span>Policy</span>${sel(
      'policy',
      [['all', 'All'], ...POLICY_ACTIONS.map((v) => [v, policyActionLabel(v)])],
      f.policy
    )}<small>Denied calls never create an invocation, so there is no "Deny" option here — filter the policy decision
      log instead.</small></label>
    <label><span>Time range</span>${sel(
      'range',
      [
        ['all', 'All time'],
        ['1h', 'Last hour'],
        ['24h', 'Last 24 hours'],
        ['7d', 'Last 7 days'],
      ],
      f.range
    )}<small>${rangeDescription(f.range)}</small></label>
    <button class="button secondary" data-live-invocation-action="clear-filters">Clear filters</button>
  </section>`;
}

function paginationBar() {
  const { limit, offset, total } = state;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return `<div class="catalog-results-heading pagination-bar">
    <p aria-live="polite"><strong>Showing ${count(from)}–${count(to)} of ${count(total)}</strong></p>
    <div class="pagination-actions">
      <button class="button secondary" data-live-invocation-action="prev-page" ${offset <= 0 ? 'disabled' : ''}>← Previous</button>
      <button class="button secondary" data-live-invocation-action="next-page" ${offset + limit >= total ? 'disabled' : ''}>Next →</button>
    </div>
  </div>`;
}

function resultsHeading(rows) {
  return `<div class="catalog-results-heading">
    <p aria-live="polite"><strong>${rows.length} of ${state.invocations.length} loaded rows shown</strong></p>
    <span>Newest first</span>
  </div>`;
}

// --- detail panel ----------------------------------------------------------

function detailRows(rows) {
  return `<dl class="detail-rows">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`).join('')}</dl>`;
}

function diagnosisMarkup(diagnosis) {
  if (!diagnosis) return '';
  return `<section class="failure-diagnosis" aria-labelledby="failure-title">
    <div><p class="kicker">Failure diagnosis</p><h3 id="failure-title">${esc(errorClassLabel(diagnosis.errorClass))}</h3>
    <p>Built from error_class and upstream_status only.</p></div>
    <dl>
      <div><dt>Upstream status</dt><dd>${Number.isFinite(diagnosis.upstreamStatus) ? diagnosis.upstreamStatus : 'No upstream response'}</dd></div>
      <div><dt>Retryability</dt><dd>${esc(diagnosis.retryability)}</dd></div>
    </dl>
    <small>Retryability is this console's own reading of the error class — Gateway does not report it.</small>
  </section>`;
}

function traceMarkup(item) {
  const stages = deriveTrace(item);
  return `<h3>Request path</h3><div class="trace" aria-label="Ordered invocation trace">${stages
    .map(
      (stage, i) => `<div class="trace-stage ${stage.state}">
        <span class="trace-order">0${i + 1}</span>
        <span><strong>${esc(stage.label)}</strong><small>${esc(stage.detail)}</small></span>
      </div>`
    )
    .join('')}</div>`;
}

function captureBoundaryPanel(item) {
  const captured = item.bodyCaptured;
  const headline =
    captured === true
      ? 'Body capture was on for this invocation'
      : captured === false
        ? 'Body capture was off for this invocation'
        : 'Body capture state unknown';
  return `<section class="capture-boundary compact" aria-label="Capture boundary">
    <div><p class="kicker">Capture boundary</p><h2>${esc(headline)}</h2></div>
    <div class="capture-facts">
      <span><b>body_captured</b>${captured === null ? UNKNOWN : String(captured)}</span>
      <span><b>Reading a body</b>Requires the <code>invocations:read_body</code> scope. Console sessions are not
      assumed to hold it, so reading a captured request or response body is out of scope for this view.</span>
    </div>
  </section>`;
}

function detailPanel() {
  const d = state.detail;
  if (!d.id) return '';

  if (d.status === 'loading') {
    return `<section class="panel" aria-busy="true"><p>Loading invocation ${esc(d.id)}…</p></section>`;
  }
  if (d.status === 'not_found') {
    return `<section class="panel"><p class="form-error" role="alert">No invocation with id ${esc(d.id)} exists in this tenant.</p>
      <button class="button secondary" data-live-invocation-action="close-detail">Close</button></section>`;
  }
  if (d.status === 'error') {
    return `<section class="panel"><p class="form-error" role="alert">${esc(d.error)}</p>
      <button class="button secondary" data-live-invocation-action="close-detail">Close</button></section>`;
  }

  const item = d.record;
  const names = agentNameMap();
  const agentDisplay = names.get(item.agentId) ? `${names.get(item.agentId)} (${item.agentId})` : item.agentId;

  return `<section class="panel invocation-detail" aria-label="Invocation detail">
    <div class="panel-heading"><div><p class="kicker">Detail</p><h2>${esc(item.id)}</h2></div>
      <button class="button secondary" data-live-invocation-action="close-detail">Close</button></div>
    <div class="panel-body">
    ${diagnosisMarkup(failureDiagnosis(item))}
    ${traceMarkup(item)}
    <h3>Invocation metadata</h3>
    ${detailRows([
      ['Agent', agentDisplay],
      ['Mode', modeLabel(item.mode)],
      ['Result', item.status],
      ['Policy decision', policyActionLabel(item.policyAction)],
      ['Policy matched rule', policyMatchLabel(item)],
      ['Model', item.model || 'Not supplied'],
      ['MCP method', item.mcpMethod || 'Not applicable'],
      ['MCP tool', item.mcpTool || 'Not applicable'],
      ['Latency', duration(item.latencyMs)],
      ['Time to first byte', item.mode === 'streaming' ? duration(item.ttftMs) : 'Not applicable'],
      ['Request size', sizeLabel(item.reqSize)],
      ['Response size', sizeLabel(item.respSize)],
      [
        'Payment',
        item.paymentAmount ? `${item.paymentAmount} ${item.paymentAsset || ''} on ${item.paymentNetwork || UNKNOWN}` : 'No payment gate',
      ],
      ['Settlement', item.settlement ? settlementStatusLabel(item.settlement.status) : 'Not applicable'],
      ['Created', timestamp(item.createdAt)],
      ['Completed', item.completedAt ? timestamp(item.completedAt) : 'Not yet completed'],
    ])}
    ${captureBoundaryPanel(item)}
    </div>
  </section>`;
}

// --- view --------------------------------------------------------------------

function renderHeader() {
  return `<header class="page-heading">
    <div>
      <p class="kicker">Traffic · live tenant</p>
      <h1 id="page-title">Invocations</h1>
      <p class="page-description">Every proxied call this tenant's Gateway allowed to proceed, filtered and
      paginated on the server. A policy denial or an unpaid x402 challenge returns before an invocation record
      exists, so denied and unpaid requests never appear in this list — only calls that reached the upstream.</p>
    </div>
    <div class="page-actions">
      <button class="button secondary" data-live-invocation-action="refresh">Refresh</button>
    </div>
  </header>`;
}

export function liveInvocationsView() {
  if (state.status === 'idle' && typeof document !== 'undefined') {
    state.status = 'loading';
    loadInvocations().then(rerenderIfMounted);
  }

  const header = renderHeader();

  if (state.status === 'idle' || state.status === 'loading') {
    return `<section class="page-enter traffic-page" data-live-invocations-root>${header}
      <section class="panel" aria-busy="true"><p>Loading tenant invocations…</p></section></section>`;
  }
  if (state.status === 'error') {
    return `<section class="page-enter traffic-page" data-live-invocations-root>${header}
      <section class="panel"><p class="form-error" role="alert">${esc(state.error)}</p>
      <button class="button secondary" data-live-invocation-action="retry">Retry</button></section></section>`;
  }

  const names = agentNameMap();
  const lookupMode = isInvocationId(state.query);
  const rows = lookupMode ? [] : filterLoadedPage(state.invocations, state.query, names);

  const body = lookupMode
    ? ''
    : rows.length
      ? `${resultsHeading(rows)}
         <div class="catalog-columns" aria-hidden="true"><span>Time</span><span>Invocation</span><span>Agent / operation</span><span>Mode</span><span>Result</span><span>Policy</span><span>Latency</span><span>Sizes</span><span>Error class</span><span>Action</span></div>
         <section class="catalog-list live-catalog">${rows.map((item) => row(item, names)).join('')}</section>
         ${paginationBar()}`
      : `<div class="catalog-empty"><p class="kicker">${state.invocations.length ? 'Filtered page' : 'Live tenant'}</p>
         <h2>${state.invocations.length ? 'No loaded rows match' : 'No invocations match these filters'}</h2>
         <p>${
           state.invocations.length
             ? 'Adjust the page filter above, or clear it. This does not mean the tenant has no matching traffic — only this page.'
             : 'Adjust the filters above. Denied and unpaid requests never appear here regardless of filters.'
         }</p></div>`;

  return `<section class="page-enter traffic-page" data-live-invocations-root>
    ${header}
    ${filterBar()}
    ${detailPanel()}
    ${body}
  </section>`;
}

// --- loading -----------------------------------------------------------------

async function loadInvocations() {
  state.status = 'loading';
  state.error = null;
  try {
    const res = await api.listInvocations(buildQueryParams(state.filters, state.limit, state.offset));
    state.invocations = (res?.data || []).map(normalizeInvocation);
    state.total = Number.isFinite(res?.total) ? res.total : state.invocations.length;
    state.limit = Number.isFinite(res?.limit) ? res.limit : state.limit;
    state.offset = Number.isFinite(res?.offset) ? res.offset : state.offset;
    state.status = 'ready';
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return unauthenticated();
    state.status = 'error';
    state.error =
      err instanceof ApiError && err.code === 'unreachable'
        ? 'Gateway is unreachable from the console.'
        : 'Tenant invocations could not be loaded.';
  }
}

// The `input` listener below debounces calls into this by
// LOOKUP_DEBOUNCE_MS, so only the id the operator has settled on is fetched.
// This also checks state.detail.id is still its own id before writing a
// result, so a slow response to a stale id can never clobber a newer one.
async function openDetail(id) {
  state.detail = { id, status: 'loading', error: null, record: null };
  rerenderIfMounted();
  try {
    const record = normalizeInvocation(await api.getInvocation(id));
    if (state.detail.id !== id) return;
    state.detail = { id, status: 'ready', error: null, record };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return unauthenticated();
    if (state.detail.id !== id) return;
    state.detail = {
      id,
      status: err instanceof ApiError && err.status === 404 ? 'not_found' : 'error',
      error:
        err instanceof ApiError && err.status !== 404
          ? err.code === 'unreachable'
            ? 'Gateway is unreachable from the console.'
            : 'The invocation could not be loaded.'
          : null,
      record: null,
    };
  }
  rerenderIfMounted();
}

// This view is not pre-bound from app.js's boot() the way the agent catalog
// is — app.js only imports this module and routes the `invocations` view to
// it (see the file header). So the module wires its own delegated listeners
// and re-renders itself by replacing the section it rendered, guarded by
// `typeof document` so importing this file under `node --test` (no DOM)
// stays side-effect free.
function rerenderIfMounted() {
  const root = document.querySelector('[data-live-invocations-root]');
  if (!root) return;
  root.outerHTML = liveInvocationsView();
}

// Pending debounce timer for the id-lookup search box; cancelled and
// replaced on every keystroke so only the value the operator stops typing on
// ever reaches openDetail.
let lookupTimer = null;

if (typeof document !== 'undefined') {
  document.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-live-invocation-action]');
    if (!el) return;
    const action = el.dataset.liveInvocationAction;

    if (action === 'retry' || action === 'refresh') {
      await loadInvocations();
      rerenderIfMounted();
    } else if (action === 'clear-filters') {
      state.filters = defaultFilters();
      state.query = '';
      state.offset = 0;
      await loadInvocations();
      rerenderIfMounted();
    } else if (action === 'prev-page') {
      state.offset = Math.max(0, state.offset - state.limit);
      await loadInvocations();
      rerenderIfMounted();
    } else if (action === 'next-page') {
      state.offset = state.offset + state.limit;
      await loadInvocations();
      rerenderIfMounted();
    } else if (action === 'inspect') {
      await openDetail(el.dataset.invocationId);
    } else if (action === 'close-detail') {
      state.detail = { id: null, status: 'idle', error: null, record: null };
      rerenderIfMounted();
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.id !== 'invocation-query') return;
    state.query = event.target.value;
    if (lookupTimer) {
      clearTimeout(lookupTimer);
      lookupTimer = null;
    }
    if (isInvocationId(state.query)) {
      const id = state.query.trim();
      lookupTimer = setTimeout(() => {
        lookupTimer = null;
        openDetail(id);
      }, LOOKUP_DEBOUNCE_MS);
    }
    rerenderIfMounted();
    // Re-rendering replaces the input, so put the caret back where it was.
    const next = document.querySelector('#invocation-query');
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  });

  document.addEventListener('change', async (event) => {
    const key = event.target.dataset?.liveInvocationFilter;
    if (!key) return;
    state.filters = { ...state.filters, [key]: event.target.value };
    state.offset = 0;
    await loadInvocations();
    rerenderIfMounted();
  });
}

export const liveInvocationsState = state;
