// The live payments view: GET /v1/invocations, filtered on the server by
// `settlement` and paginated by `limit`/`offset`, plus GET /v1/settlement/config
// for the tenant's facilitator posture. Both read-only.
//
// Two facts this view must not blur:
//
//   what "payment" means here — an invocation record is only created once a
//                        request cleared policy and paid. The gate issues a
//                        402 challenge *before* that record exists, so a
//                        challenged request that never paid never becomes a
//                        row. There is deliberately no "402 challenges" metric
//                        on this page and no filter that could match one —
//                        both would promise a count that can only ever be
//                        zero, which reads as "nothing is being challenged"
//                        when the truth is this list simply cannot see it.
//   gate-only vs settled — a priced invocation with no `settlement` sub-record
//                        is not a failure and not "pending" in the queued
//                        sense; it is what every invocation on a gate-only
//                        tenant looks like, because nothing ever attempts to
//                        settle it. That state is rendered as its own
//                        "Gate-only · never settled" fact, distinct from the
//                        four real settlement statuses. The same distinction
//                        applies to GET /v1/settlement/config: a tenant that
//                        never configured settlement gets a 404, which api.js
//                        already collapses to `null` — a real, expected
//                        "gate-only" state, not an error.
//
// This module wires its own document-level listeners and kicks off its own
// first load, guarded by `typeof document`, the same way invocations-view.js
// does — see that file's header for why.

import { api, ApiError } from './api.js';
import { count, relative, timestamp, usdc, UNKNOWN } from './format.js';
import { normalizeInvocation } from './invocations-view.js';
import { liveAgentsState } from './agents-view.js';
import { renderSignIn } from './gate.js';

const PAGE_SIZE = 20;

// Enumerated from gateway/openapi.yaml's `settlement` query parameter — the
// only four real values. There is no fifth option for "gate-only" or "no
// payment": those are not settlement states the server can filter on, they
// are read from `payment_amount` and `settlement` on each row instead.
const SETTLEMENT_STATUSES = ['pending', 'settled', 'settlement_failed', 'settled_upstream_failed'];

const SETTLEMENT_LABELS = {
  pending: 'Pending',
  settled: 'Settled',
  settlement_failed: 'Settlement failed',
  settled_upstream_failed: 'Settled, upstream failed',
};

function settlementStatusLabel(value) {
  return SETTLEMENT_LABELS[value] || value;
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function unauthenticated() {
  renderSignIn(document.body, { reason: 'expired' });
}

// --- settlement config normalization -----------------------------------------

// `raw` is already collapsed to `null` by api.js when the tenant has no
// settlement configured (a 404). That case is passed straight through — it
// is a real, expected posture, not something to coerce into an object.
export function normalizeSettlementConfig(raw) {
  if (!raw) return null;
  return {
    facilitatorUrl: raw.facilitator_url,
    facilitatorCredentialRef: raw.facilitator_credential_ref,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

// --- state ---------------------------------------------------------------

function defaultFilters() {
  return { settlement: 'all' };
}

const state = {
  status: 'idle', // idle | loading | ready | error
  error: null,
  invocations: [],
  total: 0,
  limit: PAGE_SIZE,
  offset: 0,
  filters: defaultFilters(),
  settlement: { status: 'idle', error: null, config: null }, // config: null while loading/error too; only meaningful once status is 'ready'
};

// --- server-side filtering & pagination --------------------------------------

// Exported so the mapping from UI filter state to the gateway query is
// testable without a network call.
export function buildQueryParams(filters, limit, offset) {
  const params = { limit, offset };
  if (filters.settlement !== 'all') params.settlement = filters.settlement;
  return params;
}

// --- labels ----------------------------------------------------------------

function agentNameMap() {
  return new Map(liveAgentsState.agents.map((a) => [a.id, a.name]));
}

// --- rows ----------------------------------------------------------------

function amountCell(item) {
  if (item.paymentAmount === null) return `<strong>No payment gate</strong><small>Unpriced route</small>`;
  return `<strong>${esc(usdc(item.paymentAmount, item.paymentAsset || 'USDC'))}</strong><small>${esc(item.paymentNetwork || UNKNOWN)}</small>`;
}

function payerCell(item) {
  if (item.paymentAmount === null) return `<span>Not applicable</span>`;
  return item.paymentPayer ? `<span class="mono">${esc(item.paymentPayer)}</span>` : `<span>${UNKNOWN}</span>`;
}

// The three-way state a row can be in: no payment gate at all, gate-only
// (paid but nothing ever attempted settlement), or one of the four real
// settlement statuses. Collapsing gate-only into "Pending" would claim
// settlement is in flight when in fact nothing is watching this invocation.
function settlementCell(item) {
  if (item.paymentAmount === null) {
    return `<span class="status empty">Not applicable</span><small>No payment gate on this route</small>`;
  }
  if (!item.settlement) {
    return `<span class="status empty">Gate-only · never settled</span><small>No settlement record on this invocation</small>`;
  }
  const s = item.settlement;
  const tone =
    s.status === 'settled' ? 'settled' : s.status === 'pending' ? 'pending' : s.status === 'settlement_failed' ? 'settlement_failed' : 'failed';
  const when = s.settled_at ? `Settled ${esc(relative(s.settled_at))}` : 'Not yet settled';
  return `<span class="status ${tone}">${esc(settlementStatusLabel(s.status))}</span><small title="${esc(timestamp(s.settled_at))}">${when}</small>`;
}

// settled_amount, operator_amount and facilitator_fee all run through usdc(),
// so an absent value (never settled, or a self-hosted facilitator that
// reports no fee) reads as Unknown rather than $0 — usdc() already refuses to
// render a missing amount as zero.
function settlementAmountsCell(item) {
  if (!item.settlement) return `<small>${item.paymentAmount === null ? 'Not applicable' : 'Not settled yet'}</small>`;
  const s = item.settlement;
  return `<small>Settled ${esc(usdc(s.settled_amount))}</small><small>Operator ${esc(usdc(s.operator_amount))}</small><small>Fee ${esc(usdc(s.facilitator_fee))}</small>`;
}

// Exported so a settled row, a gate-only row, and a no-payment row can each
// be asserted on directly without re-deriving the whole page.
export function row(item, names) {
  const name = names.get(item.agentId);
  return `<article class="payment-row live-payment-row">
    <span data-label="Time / invocation"><strong title="${esc(timestamp(item.createdAt))}">${esc(relative(item.createdAt))}</strong><small class="mono">${esc(item.id)}</small></span>
    <span data-label="Agent">${name ? `<strong>${esc(name)}</strong>` : `<strong class="mono">${esc(item.agentId)}</strong>`}</span>
    <span data-label="Amount">${amountCell(item)}</span>
    <span data-label="Payer">${payerCell(item)}</span>
    <span data-label="Settlement">${settlementCell(item)}</span>
    <span data-label="Settlement amounts">${settlementAmountsCell(item)}</span>
  </article>`;
}

// --- filter bar & pagination ----------------------------------------------

function filterBar() {
  const f = state.filters;
  const sel = (name, options, current) =>
    `<select data-live-payment-filter="${name}">${options
      .map(([v, l]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(l)}</option>`)
      .join('')}</select>`;
  return `<section class="governance-filters payment-filters" aria-label="Filter tenant payments (applied on Gateway)">
    <label><span>Settlement</span>${sel(
      'settlement',
      [['all', 'All'], ...SETTLEMENT_STATUSES.map((v) => [v, settlementStatusLabel(v)])],
      f.settlement
    )}<small>The only four settlement states the gateway can filter on. There is no "402 challenge" option — a
      challenged request that never paid never creates an invocation, so no filter here could ever match one.</small></label>
    <button class="button secondary" data-live-payment-action="clear-filters">Clear filters</button>
  </section>`;
}

function resultsHeading() {
  return `<div class="catalog-results-heading">
    <p aria-live="polite"><strong>${count(state.invocations.length)} invocations loaded on this page</strong>
    <small>${count(state.total)} total for this tenant under the current filters — not every invocation carried a payment, so this is never a full payment count.</small></p>
    <span>Newest first</span>
  </div>`;
}

function paginationBar() {
  const { limit, offset, total } = state;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return `<div class="catalog-results-heading pagination-bar">
    <p aria-live="polite"><strong>Showing ${count(from)}–${count(to)} of ${count(total)}</strong></p>
    <div class="pagination-actions">
      <button class="button secondary" data-live-payment-action="prev-page" ${offset <= 0 ? 'disabled' : ''}>← Previous</button>
      <button class="button secondary" data-live-payment-action="next-page" ${offset + limit >= total ? 'disabled' : ''}>Next →</button>
    </div>
  </div>`;
}

// --- settlement posture ------------------------------------------------------

// Reuses the fixture's `.facilitator-posture` / `.facilitator-facts` layout —
// the settlement config this describes is the same tenant facilitator
// relationship that page named, just read live instead of fixed. There is no
// third grid column here because there is nothing to inspect or edit: the
// config is described, never offered for editing.
function settlementPosturePanel() {
  const s = state.settlement;
  if (s.status === 'idle' || s.status === 'loading') {
    return `<section class="panel" aria-busy="true"><p>Loading settlement posture…</p></section>`;
  }
  if (s.status === 'error') {
    return `<section class="panel"><p class="form-error" role="alert">${esc(s.error)}</p>
      <button class="button secondary" data-live-payment-action="retry-settlement">Retry</button></section>`;
  }
  if (!s.config) {
    return `<section class="facilitator-posture"><div><p class="kicker">Settlement posture · live tenant</p>
      <h2>Settlement not configured · gate-only</h2>
      <p>This tenant has no facilitator configured. Payments are still gated by x402, but nothing here will ever
      settle on-chain through this Gateway. That is a valid deployment, not an error.</p></div>
      <div class="facilitator-facts"><span><b>Facilitator</b>Not configured</span><span><b>Mode</b>Gate-only</span></div></section>`;
  }
  return `<section class="facilitator-posture"><div><p class="kicker">Settlement posture · live tenant</p>
    <h2>Facilitator configured</h2>
    <p>Real tenant state, described here — this page has no control to edit it.</p></div>
    <div class="facilitator-facts">
      <span><b>Facilitator URL</b>${esc(s.config.facilitatorUrl)}</span>
      <span><b>Credential reference</b>${esc(s.config.facilitatorCredentialRef)}</span>
      <span><b>Configured</b>${esc(timestamp(s.config.createdAt))}</span>
      <span><b>Last updated</b>${esc(timestamp(s.config.updatedAt))}</span>
    </div></section>`;
}

// --- view --------------------------------------------------------------------

function renderHeader() {
  return `<header class="page-heading">
    <div>
      <p class="kicker">Revenue · live tenant</p>
      <h1 id="page-title">Payments</h1>
      <p class="page-description">Payment and settlement state for every invocation this tenant's Gateway recorded,
      filtered and paginated on the server. An invocation only exists once a request cleared policy and paid — a
      policy denial or an unpaid x402 challenge returns before that happens, so a challenged request that never paid never becomes a row here and is absent from every count on this page.</p>
    </div>
    <div class="page-actions">
      <button class="button secondary" data-live-payment-action="refresh">Refresh</button>
    </div>
  </header>`;
}

export function livePaymentsView() {
  if (state.status === 'idle' && typeof document !== 'undefined') {
    state.status = 'loading';
    loadPayments().then(rerenderIfMounted);
  }
  if (state.settlement.status === 'idle' && typeof document !== 'undefined') {
    state.settlement.status = 'loading';
    loadSettlementPosture().then(rerenderIfMounted);
  }

  const header = renderHeader();
  const posture = settlementPosturePanel();

  if (state.status === 'idle' || state.status === 'loading') {
    return `<section class="page-enter governance-page payments-page" data-live-payments-root>${header}
      ${posture}
      <section class="panel" aria-busy="true"><p>Loading tenant payments…</p></section></section>`;
  }
  if (state.status === 'error') {
    return `<section class="page-enter governance-page payments-page" data-live-payments-root>${header}
      ${posture}
      <section class="panel"><p class="form-error" role="alert">${esc(state.error)}</p>
      <button class="button secondary" data-live-payment-action="retry">Retry</button></section></section>`;
  }

  const names = agentNameMap();
  const rows = state.invocations;
  const body = rows.length
    ? `${resultsHeading()}
       <div class="payment-columns" aria-hidden="true"><span>Time / invocation</span><span>Agent</span><span>Amount</span><span>Payer</span><span>Settlement</span><span>Settlement amounts</span></div>
       <section class="payment-list">${rows.map((item) => row(item, names)).join('')}</section>
       ${paginationBar()}`
    : `<div class="catalog-empty"><p class="kicker">Live tenant</p><h2>No invocations match these filters</h2>
       <p>Adjust the filters above, or clear them. This does not mean the tenant has no matching traffic — only
       this page.</p></div>`;

  return `<section class="page-enter governance-page payments-page" data-live-payments-root>
    ${header}
    ${posture}
    ${filterBar()}
    ${body}
  </section>`;
}

// --- loading -----------------------------------------------------------------

async function loadPayments() {
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
        : 'Tenant payments could not be loaded.';
  }
}

async function loadSettlementPosture() {
  state.settlement.status = 'loading';
  state.settlement.error = null;
  try {
    const raw = await api.getSettlementConfig();
    state.settlement.config = normalizeSettlementConfig(raw);
    state.settlement.status = 'ready';
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return unauthenticated();
    state.settlement.status = 'error';
    state.settlement.error =
      err instanceof ApiError && err.code === 'unreachable'
        ? 'Gateway is unreachable from the console.'
        : 'Settlement posture could not be loaded.';
  }
}

// This view is not pre-bound from app.js's boot() — app.js only imports this
// module and routes the `payments` view to it, the same arrangement
// invocations-view.js and credentials-view.js use. So the module wires its
// own delegated listeners and re-renders itself by replacing the section it
// rendered, guarded by `typeof document` so importing this file under
// `node --test` (no DOM) stays side-effect free.
function rerenderIfMounted() {
  const root = document.querySelector('[data-live-payments-root]');
  if (!root) return;
  root.outerHTML = livePaymentsView();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-live-payment-action]');
    if (!el) return;
    const action = el.dataset.livePaymentAction;

    if (action === 'refresh') {
      await Promise.all([loadPayments(), loadSettlementPosture()]);
      rerenderIfMounted();
    } else if (action === 'retry') {
      await loadPayments();
      rerenderIfMounted();
    } else if (action === 'retry-settlement') {
      await loadSettlementPosture();
      rerenderIfMounted();
    } else if (action === 'clear-filters') {
      state.filters = defaultFilters();
      state.offset = 0;
      await loadPayments();
      rerenderIfMounted();
    } else if (action === 'prev-page') {
      state.offset = Math.max(0, state.offset - state.limit);
      await loadPayments();
      rerenderIfMounted();
    } else if (action === 'next-page') {
      state.offset = state.offset + state.limit;
      await loadPayments();
      rerenderIfMounted();
    }
  });

  document.addEventListener('change', async (event) => {
    const key = event.target.dataset?.livePaymentFilter;
    if (!key) return;
    state.filters = { ...state.filters, [key]: event.target.value };
    state.offset = 0;
    await loadPayments();
    rerenderIfMounted();
  });
}

export const livePaymentsState = state;
