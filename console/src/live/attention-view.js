// The live "Needs attention" queue.
//
// Six rules, each reading data the console already has reason to fetch, turn
// real tenant state into a list of things an operator should look at. There
// is no dedicated attention endpoint — every rule is derived from an existing
// read (or, where nothing else already fetches the field a rule needs, one
// small additional read; see loadAttentionData below). Nothing here is
// acknowledgeable: there is no dismissal state on the gateway, so a rule that
// still matches keeps showing up until the underlying tenant state changes.
//
// Two things this module refuses to blur, per UX_RUBRIC.md:
//
//   unavailable vs. clear — if a rule's underlying read fails, that rule
//                          renders as unavailable, never as "found nothing".
//                          An operator who sees a clean queue must be able to
//                          trust that every rule actually ran.
//   zero vs. absent       — the sidebar badge disappears on a real, confirmed
//                          zero. It never renders the digit 0.

import { api, ApiError } from './api.js';
import { liveAgentsState } from './agents-view.js';
import { count } from './format.js';
import { renderSignIn } from './gate.js';

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function plural(n, word) {
  return `${count(n)} ${word}${n === 1 ? '' : 's'}`;
}

// --- rule bodies --------------------------------------------------------------
//
// Each takes the shared context built by buildContext() and returns an array
// of items, or `null` if the read its judgement depends on is unavailable. A
// rule with an unfetched dependency must say so, not silently report zero.

export function suspendedAgents(ctx) {
  if (ctx.agents === null) return null;
  return ctx.agents
    .filter((a) => a.suspended)
    .map((a) => ({
      id: `suspended:${a.id}`,
      detail: `${a.name} is suspended. The catalog still lists it as active, but Gateway is blocking every invocation until an operator resumes it.`,
    }));
}

export function pendingAgents(ctx) {
  if (ctx.agents === null) return null;
  return ctx.agents
    .filter((a) => a.status === 'pending')
    .map((a) => ({
      id: `pending:${a.id}`,
      detail: `${a.name} was registered with no upstream URL and cannot serve traffic until one is set.`,
    }));
}

// This console's own judgement, not a gateway-reported boundary: an agent
// failing at least a fifth of a day's traffic is worth a look, and a sample
// under five calls is too small for one failure to mean anything.
const ERROR_RATE_THRESHOLD = 0.2;
const MIN_SAMPLE_CALLS = 5;

const ERROR_CLASS_LABELS = {
  timeout: 'timeouts',
  upstream_5xx: 'upstream 5xx',
  upstream_4xx: 'upstream 4xx',
  ssrf_blocked: 'SSRF blocks',
  credential_error: 'credential errors',
  cancelled: 'cancellations',
  internal: 'internal errors',
};

function dominantErrorClass(byErrorClass) {
  const entries = Object.entries(byErrorClass || {});
  if (!entries.length) return null;
  const [errorClass] = entries.toSorted((a, b) => b[1] - a[1])[0];
  return ERROR_CLASS_LABELS[errorClass] || errorClass;
}

export function failingAgents(ctx) {
  if (ctx.analyticsGroups === null) return null;
  return ctx.analyticsGroups
    .filter((g) => g.count >= MIN_SAMPLE_CALLS && g.error_rate >= ERROR_RATE_THRESHOLD)
    .map((g) => {
      const name = ctx.agentNames.get(g.agent_id) || g.agent_id;
      const dominant = dominantErrorClass(g.by_error_class);
      const rate = Math.round(g.error_rate * 100);
      return {
        id: `error-rate:${g.agent_id}`,
        detail: `${name} failed ${rate}% of ${plural(g.count, 'call')} today${dominant ? ` — mostly ${dominant}` : ''}.`,
      };
    });
}

// Ordered worst case first: a settlement that failed outright cost nothing,
// but one recorded settled_upstream_failed means the tenant already
// collected payment for a call the upstream never completed.
export function settlementFailures(ctx) {
  if (ctx.settledUpstreamFailedTotal === null || ctx.settlementFailedTotal === null) return null;
  const items = [];
  if (ctx.settledUpstreamFailedTotal > 0) {
    items.push({
      id: 'settlement:settled-upstream-failed',
      detail: `${plural(ctx.settledUpstreamFailedTotal, 'invocation')} collected payment and then failed upstream — the tenant was charged for a call that did not complete.`,
    });
  }
  if (ctx.settlementFailedTotal > 0) {
    items.push({
      id: 'settlement:settlement-failed',
      detail: `${plural(ctx.settlementFailedTotal, 'invocation')} could not be settled with the facilitator.`,
    });
  }
  return items;
}

export function unsettledPricedAgents(ctx) {
  if (ctx.agents === null || ctx.settlementConfigured === null) return null;
  if (ctx.settlementConfigured) return [];
  const priced = ctx.agents.filter((a) => a.pricing);
  if (!priced.length) return [];
  return [
    {
      id: 'settlement-config:missing',
      detail: `${plural(priced.length, 'agent')} priced, but no settlement destination is configured. Gateway is gating those calls, not charging for them.`,
    },
  ];
}

export function unreferencedCredentials(ctx) {
  if (ctx.agents === null || ctx.credentialNames === null) return null;
  const referenced = new Set(ctx.agents.map((a) => a.credentialRef).filter(Boolean));
  return [...ctx.credentialNames.entries()]
    .filter(([id]) => !referenced.has(id))
    .map(([id, name]) => ({
      id: `credential:${id}`,
      detail: `${name} is not referenced by any agent's credential_ref — a leftover, or a mistake.`,
    }));
}

// --- rule table ----------------------------------------------------------------
//
// The one place severity is decided. Nothing the gateway returns carries a
// severity field — this ranking is entirely this console's judgement about
// which of these six situations deserves a human first.
export const ATTENTION_RULES = [
  { id: 'suspended-agents', title: 'Suspended agent', severity: 'high', target: 'agents', action: 'Review catalog', run: suspendedAgents },
  { id: 'settlement-failures', title: 'Settlement failure', severity: 'high', target: 'invocations', action: 'Inspect invocations', run: settlementFailures },
  { id: 'failing-agents', title: 'Elevated error rate', severity: 'high', target: 'analytics', action: 'Open analytics', run: failingAgents },
  { id: 'unsettled-priced-agents', title: 'Priced with no settlement destination', severity: 'medium', target: 'payments', action: 'Review settlement', run: unsettledPricedAgents },
  { id: 'pending-agents', title: 'Pending agent', severity: 'medium', target: 'agents', action: 'Review catalog', run: pendingAgents },
  { id: 'unreferenced-credentials', title: 'Unreferenced credential', severity: 'low', target: 'credentials', action: 'Review credentials', run: unreferencedCredentials },
];

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

// Runs every rule against a context and reports, per rule, whether its read
// succeeded and what it found. A rule whose dependency is unavailable is
// never conflated with one that ran and found nothing.
export function deriveAttentionQueue(ctx) {
  return ATTENTION_RULES.map((rule) => {
    const items = rule.run(ctx);
    return items === null ? { ...rule, available: false, items: [] } : { ...rule, available: true, items };
  });
}

// What the sidebar badge should say. Absent on a confirmed zero — never "0" —
// and "?" only when every rule's dependency failed, so there is no known
// count at all, not even a lower bound.
export function badgeSummary(queue) {
  const known = queue.filter((r) => r.available);
  const knownCount = known.reduce((n, r) => n + r.items.length, 0);
  // A positive known count is a truthful lower bound even if another rule
  // failed to evaluate, so it is always safe to show. A zero is only safe to
  // show — as "absent", never as the digit 0 — once every rule confirmed it.
  if (knownCount > 0) return { hidden: false, label: String(knownCount), unknown: false };
  if (known.length === queue.length) return { hidden: true, label: null, unknown: false };
  return { hidden: false, label: '?', unknown: true };
}

// --- data loading ----------------------------------------------------------

const state = {
  status: 'idle', // idle | loading | ready
  settlementFailed: { state: 'unknown', total: 0 },
  settledUpstreamFailed: { state: 'unknown', total: 0 },
  settlementConfig: { state: 'unknown', configured: null },
};

function buildContext() {
  return {
    agents: liveAgentsState.error ? null : liveAgentsState.agents,
    agentNames: new Map((liveAgentsState.agents || []).map((a) => [a.id, a.name])),
    credentialNames: liveAgentsState.credentialsState === 'ready' ? liveAgentsState.credentialNames : null,
    analyticsGroups: liveAgentsState.trafficState === 'ready' ? liveAgentsState.analyticsGroups : null,
    settlementFailedTotal: state.settlementFailed.state === 'ready' ? state.settlementFailed.total : null,
    settledUpstreamFailedTotal: state.settledUpstreamFailed.state === 'ready' ? state.settledUpstreamFailed.total : null,
    settlementConfigured: state.settlementConfig.state === 'ready' ? state.settlementConfig.configured : null,
  };
}

function unauthenticated() {
  renderSignIn(document.body, { reason: 'expired' });
}

// Suspended and pending agents come free — liveAgentsState.agents is already
// loaded before any view first renders (see app.js's boot()), and
// credentialNames is the same list agents-view already fetched for its own
// credential column. The error-rate rule's analytics groups come free too —
// agents-view.js's loadTraffic() already fetches them for the traffic column
// (see buildContext above). Only the three reads below have no other
// consumer in this console, so they are fetched once here rather than per
// rule.
async function loadAttentionData() {
  const results = await Promise.allSettled([
    api.listInvocations({ settlement: 'settlement_failed', limit: 1, offset: 0 }),
    api.listInvocations({ settlement: 'settled_upstream_failed', limit: 1, offset: 0 }),
    api.getSettlementConfig(),
  ]);
  const [settlementFailed, settledUpstreamFailed, settlementConfig] = results;

  if (results.some((r) => r.status === 'rejected' && r.reason instanceof ApiError && r.reason.status === 401)) {
    unauthenticated();
    return;
  }

  state.settlementFailed = settlementFailed.status === 'fulfilled'
    ? { state: 'ready', total: settlementFailed.value?.total ?? 0 }
    : { state: 'unavailable', total: 0 };
  state.settledUpstreamFailed = settledUpstreamFailed.status === 'fulfilled'
    ? { state: 'ready', total: settledUpstreamFailed.value?.total ?? 0 }
    : { state: 'unavailable', total: 0 };
  state.settlementConfig = settlementConfig.status === 'fulfilled'
    ? { state: 'ready', configured: settlementConfig.value !== null }
    : { state: 'unavailable', configured: null };
  state.status = 'ready';
}

// Exported so app.js's boot() can start this alongside loadAgents(), rather
// than waiting for the operator to open the Needs attention tab. Every rule
// and the sidebar badge would otherwise sit unevaluated for the whole
// session until that first visit — which defeats the badge's job of
// alerting someone who hasn't looked yet. Idempotent: a later call from
// liveAttentionView() (someone opening the tab before this settles) is a
// no-op once loading has started.
export function ensureAttentionLoaded() {
  if (state.status !== 'idle') return;
  state.status = 'loading';
  loadAttentionData().then(() => {
    rerenderIfMounted();
    syncBadge();
  });
}

// --- rendering -----------------------------------------------------------------

const SEVERITY_KICKER = { high: 'Action required', medium: 'Setup', low: 'Review' };

function itemCard(rule, item, index) {
  return `<article class="queue-card">
    <span class="queue-index">${String(index + 1).padStart(2, '0')}</span>
    <span class="severity ${esc(rule.severity)}"></span>
    <div>
      <p class="kicker">${esc(SEVERITY_KICKER[rule.severity] || 'Review')} · ${esc(rule.title)}</p>
      <p>${esc(item.detail)}</p>
      <button class="button ${rule.severity === 'high' ? 'primary' : 'secondary'}" data-view="${esc(rule.target)}">${esc(rule.action)} →</button>
    </div>
  </article>`;
}

function unavailableCard(rule) {
  return `<div class="data-state unavailable compact" role="status">
    <span class="status unavailable"><i aria-hidden="true"></i>Unavailable</span>
    <div><h2>${esc(rule.title)} is unknown</h2>
    <p>The read this rule depends on failed, so it could not be evaluated. This is not the same as finding nothing — retry to check again.</p></div>
  </div>`;
}

function emptyBanner() {
  return `<div class="data-state empty" role="status">
    <span class="status empty"><i aria-hidden="true"></i>Empty</span>
    <div><h2>Nothing needs attention</h2>
    <p>All six rules read live tenant data and found nothing to flag. That is a real, confirmed state, not a page that failed to load.</p></div>
  </div>`;
}

function partialNote(unavailable) {
  if (!unavailable.length) return '';
  return `<p class="sample-note">${plural(unavailable.length, 'rule')} of ${ATTENTION_RULES.length} could not be evaluated right now — see below. That does not mean those areas are clear.</p>`;
}

function renderHeader() {
  return `<header class="page-heading">
    <div>
      <p class="kicker">Operate · live tenant</p>
      <h1 id="page-title">Needs attention</h1>
      <p class="page-description">Six rules, derived from live tenant state, surface what actually needs a human decision. There is no acknowledgement state — an item stays listed until the tenant state it is reporting on changes.</p>
    </div>
    <div class="page-actions">
      <button class="button secondary" data-live-attention-action="refresh">Refresh</button>
    </div>
  </header>`;
}

export function liveAttentionView() {
  if (typeof document !== 'undefined') ensureAttentionLoaded();

  const header = renderHeader();

  if (state.status !== 'ready') {
    return `<section class="page-enter narrow-page" data-live-attention-root>${header}
      <section class="panel" aria-busy="true"><p>Loading tenant state…</p></section></section>`;
  }

  const queue = deriveAttentionQueue(buildContext());
  const available = queue.filter((r) => r.available);
  const unavailable = queue.filter((r) => !r.available);
  const items = available
    .flatMap((rule) => rule.items.map((item) => ({ item, rule })))
    .toSorted((a, b) => SEVERITY_RANK[a.rule.severity] - SEVERITY_RANK[b.rule.severity]);

  const body = !items.length && !unavailable.length
    ? emptyBanner()
    : `${partialNote(unavailable)}${items.length ? `<div class="attention-queue">${items.map(({ item, rule }, i) => itemCard(rule, item, i)).join('')}</div>` : ''}${unavailable.map(unavailableCard).join('')}`;

  return `<section class="page-enter narrow-page" data-live-attention-root>${header}${body}</section>`;
}

// --- badge sync ------------------------------------------------------------
//
// The sidebar badge is static markup in index.html, outside anything this
// view returns, so it cannot be kept live by returning better HTML — it has
// to be written to directly. This module owns that write. A MutationObserver
// on #main-content, rather than a click listener, is what makes it correct
// after every navigation (hash changes, filter changes, the initial render)
// and not only after clicks on a nav button.

function syncBadge() {
  if (typeof document === 'undefined') return;
  const button = document.querySelector(".side-nav [data-view='attention']");
  const badge = button?.querySelector('.nav-badge');
  if (!button || !badge) return;

  const summary = badgeSummary(deriveAttentionQueue(buildContext()));
  badge.hidden = summary.hidden;
  badge.textContent = summary.hidden ? '' : summary.label;
  button.setAttribute(
    'aria-label',
    summary.hidden
      ? 'Needs attention: nothing needs attention right now'
      : summary.unknown
        ? 'Needs attention: unknown — some tenant reads failed'
        : `Needs attention: at least ${summary.label} live ${summary.label === '1' ? 'item' : 'items'}`
  );
}

function rerenderIfMounted() {
  const root = document.querySelector('[data-live-attention-root]');
  if (!root) return;
  root.outerHTML = liveAttentionView();
}

if (typeof document !== 'undefined') {
  if (typeof MutationObserver !== 'undefined') {
    const main = document.querySelector('#main-content');
    if (main) new MutationObserver(syncBadge).observe(main, { childList: true });
  }

  document.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-live-attention-action]');
    if (!el || el.dataset.liveAttentionAction !== 'refresh') return;
    state.status = 'loading';
    await loadAttentionData();
    rerenderIfMounted();
    syncBadge();
  });
}

export const liveAttentionState = state;
