// The live Analytics view: GET /v1/analytics, scoped to exactly what that
// endpoint can honestly produce and nothing it cannot.
//
// The endpoint returns groups keyed by (agent_id, bucket_start), each with a
// count, an error rate, a by_error_class map, and latency/TTFT percentiles.
// Four things a fixture-era analytics page could get away with are not real
// here, and this view does not pretend otherwise:
//
//   a tenant-wide percentile strip — a p95 is not a quantity you can average
//                                    or max across cells into one number. The
//                                    only percentile this view ever shows is
//                                    a single group's own, carried through
//                                    unmodified (see summarizeAnalyticsByAgent
//                                    in api.js, which this view reuses rather
//                                    than re-deriving the same merge rule).
//   an operations/tool table       — group_by accepts only agent_id and
//                                    rejects anything else server-side. There
//                                    is no protocol, method, or tool grouping
//                                    to show.
//   three of the four error labels — policy_denied, rate_limited, and
//                                    payment_required are rejected before an
//                                    invocation record exists, so they can
//                                    never appear in by_error_class. Only
//                                    classes actually present in the response
//                                    are rendered; an absent class stays
//                                    absent rather than showing as zero.
//   a streaming-sample count       — would need a second, separate read
//                                    (listInvocations?mode=streaming) that
//                                    nothing else on this page needs. Cut
//                                    rather than added for a number this view
//                                    does not otherwise depend on.
//
// Counts and error counts are safe to sum across groups; percentiles are not.
// That distinction drives every rendering choice below.
//
// Like invocations-view.js and attention-view.js, this module manages its own
// re-renders (guarded by `typeof document` so importing it under `node --test`
// stays side-effect free) rather than being pre-loaded in app.js's boot().

import { api, ApiError, summarizeAnalyticsByAgent } from './api.js';
import { count, duration, percent, timestamp, UNKNOWN } from './format.js';
import { liveAgentsState } from './agents-view.js';
import { renderSignIn } from './gate.js';

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function statusChip(label, tone) {
  return `<span class="status ${esc(tone)}"><i aria-hidden="true"></i>${esc(label)}</span>`;
}

function unauthenticated() {
  renderSignIn(document.body, { reason: 'expired' });
}

// --- window --------------------------------------------------------------
//
// since is required and the [since, until] window is capped at 31 days
// server-side (gateway/internal/httpapi/analytics.go). Both are enforced here
// too, before any request is made, so an over-long window is refused with an
// explanation instead of round-tripping to a 400.

const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

const PRESETS = {
  '1h': { label: 'Last hour', ms: 60 * 60 * 1000 },
  '24h': { label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  '7d': { label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  '31d': { label: 'Last 31 days', ms: MAX_WINDOW_MS },
};

export function resolveWindow(preset, custom, now = new Date()) {
  if (preset === 'custom') {
    return { since: custom?.since || null, until: custom?.until || now.toISOString() };
  }
  const p = PRESETS[preset] || PRESETS['24h'];
  return { since: new Date(now.getTime() - p.ms).toISOString(), until: now.toISOString() };
}

export function validateWindow(since, until) {
  if (!since) return { valid: false, reason: 'A start time (since) is required.' };
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) return { valid: false, reason: 'The start time is not a valid date.' };
  const untilMs = until ? Date.parse(until) : Date.now();
  if (until && !Number.isFinite(untilMs)) return { valid: false, reason: 'The end time is not a valid date.' };
  if (sinceMs > untilMs) return { valid: false, reason: 'The start time must not be after the end time.' };
  if (untilMs - sinceMs > MAX_WINDOW_MS) {
    return { valid: false, reason: 'This window is longer than 31 days. The endpoint rejects anything longer — narrow the range and try again.' };
  }
  return { valid: true };
}

// A window that fits inside a single hour or day keeps every group to one
// bucket, which is what keeps a percentile exact (see summarizeAnalyticsByAgent).
// A window longer than that is bucketed by day, which still merges most
// agents' cells but at least keeps the group count small.
export function bucketForWindow(since, until) {
  const span = Date.parse(until) - Date.parse(since);
  return Number.isFinite(span) && span > 2 * 24 * 60 * 60 * 1000 ? 'day' : 'hour';
}

function toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// --- aggregation -----------------------------------------------------------
//
// Counts and error counts sum safely across every group in the response.
// Error rate is computed from those two sums, never averaged from each
// group's own error_rate — an agent with 1000 calls and one with 2 calls do
// not deserve equal weight in a tenant-wide rate.

export function aggregateTotals(response) {
  let calls = 0;
  let errors = 0;
  for (const group of response?.groups || []) {
    calls += Number.isFinite(group.count) ? group.count : 0;
    for (const n of Object.values(group.by_error_class || {})) errors += n || 0;
  }
  return { calls, errors };
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

// Only classes that actually occurred are returned, sorted by count. A class
// with zero occurrences in the window — including the three that structurally
// can never appear — is simply not in this list, never listed with a 0.
export function aggregateErrorClasses(response) {
  const totals = {};
  for (const group of response?.groups || []) {
    for (const [cls, n] of Object.entries(group.by_error_class || {})) {
      if (!n) continue;
      totals[cls] = (totals[cls] || 0) + n;
    }
  }
  return Object.entries(totals).toSorted((a, b) => b[1] - a[1]);
}

// The by-agent table, built directly on top of api.js's own merge rule so
// this view never re-derives (and risks disagreeing with) it.
export function agentRows(response) {
  const byAgent = summarizeAnalyticsByAgent(response);
  const names = new Map(liveAgentsState.agents.map((a) => [a.id, a.name]));
  return [...byAgent.entries()]
    .map(([agentId, summary]) => ({ agentId, name: names.get(agentId) || agentId, ...summary }))
    .toSorted((a, b) => b.calls - a.calls);
}

// --- state -------------------------------------------------------------------

const state = {
  status: 'idle', // idle | loading | ready | invalid | rate_limited | error
  error: null,
  preset: '24h',
  custom: { since: null, until: null },
  window: null, // { since, until, bucket } — the window actually requested
  response: null,
  fetchedAt: null,
};

async function loadAnalytics() {
  const { since, until } = resolveWindow(state.preset, state.custom);
  const validation = validateWindow(since, until);
  if (!validation.valid) {
    state.status = 'invalid';
    state.error = validation.reason;
    return;
  }

  state.status = 'loading';
  const bucket = bucketForWindow(since, until);
  try {
    const response = await api.getAnalytics({ since, until, bucket, group_by: 'agent_id' });
    state.response = response;
    state.window = { since, until, bucket };
    state.fetchedAt = new Date().toISOString();
    state.status = 'ready';
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return unauthenticated();
    if (err instanceof ApiError && err.status === 429) {
      state.status = 'rate_limited';
      // The response carries a real Retry-After header, but the shared client
      // (api.js) does not expose response headers to callers, so this view has
      // no way to read the actual wait it names. 60 seconds is the endpoint's
      // documented worst case, not the true value for this response — say so
      // rather than presenting a guess as fact.
      state.error = "This endpoint carries its own, tighter rate limit and it was just hit. The console cannot read this response's actual Retry-After value; 60 seconds is the endpoint's worst case, not necessarily the real wait. Give it a moment, then retry.";
      return;
    }
    state.status = 'error';
    state.error = err instanceof ApiError && err.code === 'unreachable'
      ? 'Gateway is unreachable from the console.'
      : 'Analytics could not be loaded.';
  }
}

// --- rendering -----------------------------------------------------------------

function dataStateBlock(kind, title, message, compact = false) {
  const role = kind === 'error' ? 'alert' : 'status';
  const busy = kind === 'loading' ? ' aria-busy="true"' : '';
  const label = kind === 'loading' ? 'Loading' : kind === 'error' ? 'Error' : kind === 'unavailable' ? 'Unavailable' : 'Empty';
  const skeleton = kind === 'loading' && !compact ? '<div class="state-skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>' : '';
  return `<div class="data-state ${kind}${compact ? ' compact' : ''}" role="${role}"${busy}>${statusChip(label, kind)}<div><h2>${esc(title)}</h2><p>${esc(message)}</p></div>${skeleton}</div>`;
}

function renderHeader() {
  return `<header class="page-heading">
    <div>
      <p class="kicker">Traffic · live tenant</p>
      <h1 id="page-title">Analytics</h1>
      <p class="page-description">Counts, error rates, and per-agent latency read live from this tenant's
      <code>GET /v1/analytics</code>. <code>since</code> is required and the window is capped at 31 days.</p>
    </div>
    <div class="page-actions"><button class="button secondary" data-live-analytics-action="refresh">Refresh</button></div>
  </header>`;
}

function renderControls() {
  const isCustom = state.preset === 'custom';
  const customFields = isCustom
    ? `<label><span>Since</span><input type="datetime-local" data-live-analytics-control="since" value="${esc(toLocalInputValue(state.custom.since))}"></label>
       <label><span>Until</span><input type="datetime-local" data-live-analytics-control="until" value="${esc(toLocalInputValue(state.custom.until))}"></label>`
    : `<div class="analytics-window-proof"><span>Required <code>since</code></span><strong>${state.window ? esc(timestamp(state.window.since)) : 'Not yet requested'}</strong><small>Until ${state.window ? esc(timestamp(state.window.until)) : UNKNOWN}</small></div>`;

  return `<section class="analytics-controls" aria-label="Live analytics window">
    <label><span>Window</span><select data-live-analytics-control="preset">
      ${Object.entries(PRESETS).map(([id, p]) => `<option value="${esc(id)}"${id === state.preset ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
      <option value="custom"${isCustom ? ' selected' : ''}>Custom range</option>
    </select><small>In-memory · maximum 31 days</small></label>
    ${customFields}
    <div class="analytics-window-proof"><span>Endpoint contract</span><strong>Dedicated analytics limiter</strong><small>Bucket ${state.window ? esc(state.window.bucket) : 'hour/day'} · capped at 31 days</small></div>
  </section>`;
}

function renderStateBanner(response) {
  const { calls } = aggregateTotals(response);
  if (calls > 0) return '';
  return `<section class="state-banner empty" role="status">${statusChip('Empty', 'empty')}<div><strong>Complete window · known zero calls</strong><small>The read succeeded and the window is valid — this tenant had no invocations in it.</small></div></section>`;
}

function renderTotals(response) {
  const { calls, errors } = aggregateTotals(response);
  return `<section class="metric-strip analytics-metrics compact" aria-label="Live analytics totals">
    <div><span>${count(calls)}</span><small>Calls</small><em>Summed across groups</em></div>
    <div><span>${count(errors)}</span><small>Errors</small><em>Summed across groups</em></div>
    <div><span>${percent(errors, calls)}</span><small>Error rate</small><em>Errors ÷ calls, not a mean of per-group rates</em></div>
  </section>`;
}

function renderTaxonomy(response) {
  const classes = aggregateErrorClasses(response);
  if (!classes.length) {
    return dataStateBlock('empty', 'No classified errors in this window', 'by_error_class carried no entries across any group. A class with zero occurrences is left off, not shown as zero.', true);
  }
  return `<section class="panel analytics-taxonomy"><div class="panel-heading"><div><p class="kicker">Error taxonomy</p><h2>Classes present in this window</h2></div>${statusChip('Caller-safe', 'available')}</div>
    <div>${classes.map(([cls, n]) => `<span><strong>${count(n)}</strong><small>${esc(ERROR_CLASS_LABELS[cls] || cls)}</small></span>`).join('')}</div></section>`;
}

// A merged cell never shows a number — it says why. This is the one place a
// percentile can appear at all, and only when a group's own bucket count is 1.
function percentileCell(row, key) {
  if (row.buckets > 1) return `<small>Merged across ${count(row.buckets)} buckets — not shown</small>`;
  const ms = row[key];
  return Number.isFinite(ms) ? `<strong>${duration(ms)}</strong>` : '<small>No samples</small>';
}

function renderAgentTable(response) {
  const rows = agentRows(response);
  if (!rows.length) {
    return dataStateBlock('empty', 'No agent activity in this window', 'The window is valid and the read succeeded; no group had a count above zero.', true);
  }
  return `<section class="panel analytics-table-panel"><div class="panel-heading"><div><p class="kicker">By agent</p><h2>Calls, errors, and latency per agent</h2></div><span class="mono muted">${rows.length} agent${rows.length === 1 ? '' : 's'} with traffic</span></div>
  <div class="analytics-table" role="table" aria-label="Live analytics by agent">
    <div class="analytics-row analytics-head" role="row"><span>Agent</span><span>Calls</span><span>Errors</span><span>Error rate</span><span>Latency p95</span><span>TTFT p95</span></div>
    ${rows.map((row) => `<div class="analytics-row" role="row">
      <span data-label="Agent"><strong>${esc(row.name)}</strong></span>
      <span data-label="Calls">${count(row.calls)}</span>
      <span data-label="Errors">${count(row.errors)}</span>
      <span data-label="Error rate">${percent(row.errors, row.calls)}</span>
      <span data-label="Latency p95">${percentileCell(row, 'latencyP95Ms')}</span>
      <span data-label="TTFT p95">${percentileCell(row, 'ttftP95Ms')}</span>
    </div>`).join('')}
  </div></section>`;
}

function renderContract() {
  return `<section class="analytics-contract"><div><p class="kicker">Contract boundary</p><h2>Bounded aggregates, not content.</h2></div><div>
    <span><b>Window</b><code>since</code> required · inclusive maximum 31 days, checked here before the request is sent</span>
    <span><b>Limiter</b>Dedicated analytics rate limit, tighter than the general API limiter · a 429 surfaces the wait, never an empty chart</span>
    <span><b>Grouping</b><code>group_by</code> accepts only <code>agent_id</code> — no protocol, method, or tool breakdown exists</span>
    <span><b>Percentiles</b>Exact only when a group spans a single bucket; never averaged or maxed across buckets into a tenant-wide figure</span>
    <span><b>Taxonomy</b>Only <code>timeout</code>, <code>upstream_5xx</code>, <code>upstream_4xx</code>, <code>ssrf_blocked</code>, <code>credential_error</code>, <code>cancelled</code>, <code>internal</code> can appear — a denied or unpaid call never becomes an invocation</span>
    <span><b>Content</b>No bodies, prompts, arguments, outputs, paths, headers, or raw errors</span>
  </div></section>`;
}

export function liveAnalyticsView() {
  if (state.status === 'idle' && typeof document !== 'undefined') {
    state.status = 'loading';
    loadAnalytics().then(rerenderIfMounted);
  }

  const header = renderHeader();
  const controls = renderControls();

  if (state.status === 'idle' || state.status === 'loading') {
    return `<section class="page-enter analytics-page" data-live-analytics-root>${header}${controls}
      ${dataStateBlock('loading', 'Loading live analytics', "Reading aggregate counts, error taxonomy, and per-agent percentiles from this tenant's Gateway.")}
      ${renderContract()}
    </section>`;
  }

  if (state.status === 'invalid') {
    return `<section class="page-enter analytics-page" data-live-analytics-root>${header}${controls}
      ${dataStateBlock('unavailable', 'Window refused before it was sent', state.error, true)}
      ${renderContract()}
    </section>`;
  }

  if (state.status === 'rate_limited' || state.status === 'error') {
    return `<section class="page-enter analytics-page" data-live-analytics-root>${header}${controls}
      <section class="panel"><p class="form-error" role="alert">${esc(state.error)}</p>
      <button class="button secondary" data-live-analytics-action="retry">Retry</button></section>
      ${renderContract()}
    </section>`;
  }

  const response = state.response;
  return `<section class="page-enter analytics-page" data-live-analytics-root>
    ${header}
    ${controls}
    ${renderStateBanner(response)}
    ${renderTotals(response)}
    ${renderTaxonomy(response)}
    ${renderAgentTable(response)}
    ${renderContract()}
  </section>`;
}

// --- events ------------------------------------------------------------------
//
// Not pre-bound from app.js's boot() — app.js only imports this module and
// routes the `analytics` view to it, same as invocations-view.js — so this
// module wires its own delegated listeners and re-renders itself, guarded by
// `typeof document` so importing this file under `node --test` (no DOM) stays
// side-effect free.

function rerenderIfMounted() {
  const root = document.querySelector('[data-live-analytics-root]');
  if (!root) return;
  root.outerHTML = liveAnalyticsView();
}

if (typeof document !== 'undefined') {
  document.addEventListener('change', async (event) => {
    const control = event.target.dataset?.liveAnalyticsControl;
    if (!control) return;

    if (control === 'preset') {
      state.preset = event.target.value;
      if (state.preset === 'custom' && !state.custom.since) {
        const now = new Date();
        state.custom = { since: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), until: now.toISOString() };
      }
    } else if (control === 'since') {
      state.custom = { ...state.custom, since: fromLocalInputValue(event.target.value) };
    } else if (control === 'until') {
      state.custom = { ...state.custom, until: fromLocalInputValue(event.target.value) };
    } else {
      return;
    }

    await loadAnalytics();
    rerenderIfMounted();
  });

  document.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-live-analytics-action]');
    if (!el) return;
    if (el.dataset.liveAnalyticsAction !== 'refresh' && el.dataset.liveAnalyticsAction !== 'retry') return;
    await loadAnalytics();
    rerenderIfMounted();
  });
}

export const liveAnalyticsState = state;
