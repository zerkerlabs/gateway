// The live Overview: the tenant's front page, wired to real reads instead of
// the fixture it replaces.
//
// What is wirable, and where it comes from:
//
//   calls / failed calls   — two GET /v1/invocations reads with limit=1,
//                            reading `total` for a fixed window. There is no
//                            aggregate endpoint that returns both a window and
//                            a total in one call, so this is two small reads
//                            rather than one (the same shape attention-view.js
//                            already uses for its settlement-failure counts).
//   latest invocation      — GET /v1/invocations?limit=5, rendered with
//   sample                   invocations-view.js's own row() so this page
//                            never carries a second copy of that markup.
//   runtime evidence        — GET /healthz and GET /version, reached through
//                            the BFF like everything else. Neither response
//                            carries a refresh timestamp, so the "as of" time
//                            shown is this console's own fetch clock, labelled
//                            as such — never presented as a Gateway value.
//   attention count         — the same six rules attention-view.js runs,
//                            replayed against the same public state
//                            (liveAgentsState / liveAttentionState) rather
//                            than a second attention subsystem.
//
// What this page does NOT show, on purpose: GET /v1/policy/decisions takes
// only `limit` (max 100) — no window, no total, no action filter — so there is
// no honest way to label a "policy decisions this window" metric. A payment
// volume figure has the same problem from a different direction: amounts are
// USDC smallest-unit strings with no server-side sum, and on a gate-only
// deployment collected revenue is genuinely zero while verified
// authorizations are not — one number cannot say both. Both are left off
// rather than mislabelled.
//
// Like invocations-view.js and attention-view.js, this module manages its own
// re-renders (guarded by `typeof document` so importing it under `node --test`
// stays side-effect free) rather than being pre-loaded in app.js's boot(). One
// consequence: app.js only (re)binds `[data-view]` clicks during its own
// render() cycle, not during this view's private re-renders, so in-page links
// use the sidebar's own nav buttons (bound once, never replaced) via a
// synthetic click instead of the `data-view` convention — see navigateTo().

import { analyticsTotals, api, ApiError } from './api.js';
import { count, duration, percent, timestamp, UNKNOWN } from './format.js';
import { liveAgentsState } from './agents-view.js';
import { normalizeInvocation, row as invocationRow } from './invocations-view.js';
import { ATTENTION_RULES, deriveAttentionQueue, ensureAttentionLoaded, liveAttentionState } from './attention-view.js';
import { renderSignIn } from './gate.js';
import { deriveDataState } from '../view-model.js';
import { renderCapabilitySection } from '../capability-section.js';

const SAMPLE_SIZE = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const WINDOW_LABEL = 'Last 24 hours';
const ATTENTION_PREVIEW_LIMIT = 4;
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function plural(n, word) {
  return `${count(n)} ${word}${n === 1 ? '' : 's'}`;
}

function statusChip(label, tone) {
  return `<span class="status ${esc(tone)}"><i aria-hidden="true"></i>${esc(label)}</span>`;
}

function unauthenticated() {
  renderSignIn(document.body, { reason: 'expired' });
}

// The window used for the calls / failed calls / failure rate metrics only —
// the "latest invocation sample" panel below is not window-scoped (see its
// own note in renderSamplePanel).
export function windowSince(now = new Date()) {
  return new Date(now.getTime() - WINDOW_MS).toISOString();
}

// --- state -------------------------------------------------------------------

const state = {
  status: 'idle', // idle | loading | ready
  fetchedAt: null, // this console's own clock; none of these reads echo one back
  totalCalls: { phase: 'loading', total: null },
  failedCalls: { phase: 'loading', total: null },
  sample: { phase: 'loading', items: [] },
  runtime: { phase: 'loading', healthz: null, version: null },
  // The executive band's four reads. Each carries its own phase because they
  // fail independently: a gateway that cannot aggregate can still report its
  // denials, and a page that blanks all four because one read failed tells an
  // operator less than it knows.
  latency: { phase: 'loading', totals: null },
  denials: { phase: 'loading', total: null },
  capabilities: { phase: 'loading', value: null },
  identity: { phase: 'loading', value: null },
};

async function loadOverview() {
  state.status = 'loading';
  const since = windowSince();
  const results = await Promise.allSettled([
    api.listInvocations({ since, limit: 1, offset: 0 }),
    api.listInvocations({ since, status: 'failed', limit: 1, offset: 0 }),
    api.listInvocations({ limit: SAMPLE_SIZE, offset: 0 }),
    api.healthz(),
    api.version(),
    // Window totals: the only place a multi-bucket p95 exists, because
    // percentiles do not merge across buckets (see analyticsTotals).
    api.getAnalytics({ since, bucket: 'day' }),
    // Denials in the same window. This read is the only record a refused call
    // leaves — it never became an invocation — and it only became answerable
    // when the decisions feed gained a time range and a total.
    api.listPolicyDecisions({ since, action: 'deny', limit: 1, offset: 0 }),
    api.getCapabilities(),
    api.me(),
  ]);
  const [total, failed, sample, healthz, version, analytics, denials, capabilities, identity] = results;

  if (results.some((r) => r.status === 'rejected' && r.reason instanceof ApiError && r.reason.status === 401)) {
    unauthenticated();
    return;
  }

  state.fetchedAt = new Date().toISOString();
  state.totalCalls = total.status === 'fulfilled' && Number.isFinite(total.value?.total)
    ? { phase: 'ready', total: total.value.total }
    : { phase: 'error', total: null };
  state.failedCalls = failed.status === 'fulfilled' && Number.isFinite(failed.value?.total)
    ? { phase: 'ready', total: failed.value.total }
    : { phase: 'error', total: null };
  state.sample = sample.status === 'fulfilled'
    ? { phase: 'ready', items: (sample.value?.data || []).map(normalizeInvocation) }
    : { phase: 'error', items: [] };
  state.runtime = healthz.status === 'fulfilled' && version.status === 'fulfilled'
    ? { phase: 'ready', healthz: healthz.value, version: version.value }
    : { phase: 'error', healthz: null, version: null };

  // A gateway that predates window totals answers 200 with no `totals` key.
  // That is 'unavailable', not zero: the deployment cannot tell us, which is
  // not the same fact as no traffic.
  const totals = analytics.status === 'fulfilled' ? analyticsTotals(analytics.value) : null;
  state.latency = totals?.available
    ? { phase: 'ready', totals }
    : { phase: analytics.status === 'fulfilled' ? 'unavailable' : 'error', totals: null };

  state.denials = denials.status === 'fulfilled' && Number.isFinite(denials.value?.total)
    ? { phase: 'ready', total: denials.value.total }
    : { phase: denialsUnsupported(denials) ? 'unavailable' : 'error', total: null };

  state.capabilities = capabilities.status === 'fulfilled'
    ? { phase: 'ready', value: capabilities.value }
    : { phase: capabilities.reason instanceof ApiError && capabilities.reason.status === 404 ? 'unavailable' : 'error', value: null };

  state.identity = identity.status === 'fulfilled'
    ? { phase: 'ready', value: identity.value }
    : { phase: identity.reason instanceof ApiError && identity.reason.status === 404 ? 'unavailable' : 'error', value: null };

  state.status = 'ready';
}

// A decisions read can fail two ways that mean different things. A 404 is a
// gateway with no policy surface mounted — nothing is being denied because
// nothing is being decided — while a 400 is this console asking for a filter
// the deployment does not support. Both are 'unavailable' rather than 'error':
// neither is a fault an operator can act on, and neither is a denial count of
// zero.
function denialsUnsupported(result) {
  return result.status === 'rejected'
    && result.reason instanceof ApiError
    && [400, 404].includes(result.reason.status);
}

// --- attention -----------------------------------------------------------------
//
// Mirrors attention-view.js's own buildContext(), field for field, but reads
// it off the two pieces of state that module already exports rather than a
// third copy of the attention subsystem. Kept deliberately small so it is
// cheap to keep in sync if a rule's context shape changes.
function attentionContext() {
  return {
    agents: liveAgentsState.error ? null : liveAgentsState.agents,
    agentNames: new Map((liveAgentsState.agents || []).map((a) => [a.id, a.name])),
    credentialNames: liveAgentsState.credentialsState === 'ready' ? liveAgentsState.credentialNames : null,
    analyticsGroups: liveAgentsState.trafficState === 'ready' ? liveAgentsState.analyticsGroups : null,
    settlementFailedTotal: liveAttentionState.settlementFailed.state === 'ready' ? liveAttentionState.settlementFailed.total : null,
    settledUpstreamFailedTotal: liveAttentionState.settledUpstreamFailed.state === 'ready' ? liveAttentionState.settledUpstreamFailed.total : null,
    settlementConfigured: liveAttentionState.settlementConfig.state === 'ready' ? liveAttentionState.settlementConfig.configured : null,
  };
}

// A positive count from only some rules is a true lower bound (see
// attention-view.js's badgeSummary); a zero is only a real, reportable zero
// once every rule ran. Exported so the boundary is testable without a real
// attention queue.
export function summarizeAttentionQueue(queue) {
  const known = queue.filter((r) => r.available);
  const knownCount = known.reduce((n, r) => n + r.items.length, 0);
  const items = known
    .flatMap((rule) => rule.items.map((item) => ({ item, rule })))
    .toSorted((a, b) => SEVERITY_RANK[a.rule.severity] - SEVERITY_RANK[b.rule.severity]);
  return { knownCount, exact: known.length === queue.length, items, unavailableCount: queue.length - known.length, totalRules: queue.length };
}

function attentionModel() {
  if (liveAttentionState.status !== 'ready') {
    return { availability: 'loading', count: null, items: [], totalRules: ATTENTION_RULES.length, unavailableCount: null };
  }
  const summary = summarizeAttentionQueue(deriveAttentionQueue(attentionContext()));
  const { availability } = deriveDataState({
    phase: 'ready',
    completeness: summary.exact ? 'complete' : 'partial',
    recordCount: summary.knownCount,
    hasUsableData: summary.exact || summary.knownCount > 0,
    refreshedAt: state.fetchedAt,
    evaluatedAt: state.fetchedAt,
  });
  return { availability, count: summary.knownCount, items: summary.items, totalRules: summary.totalRules, unavailableCount: summary.unavailableCount };
}

function attentionDetail(a) {
  if (a.availability === 'loading') return 'Evaluating live tenant rules…';
  if (a.availability === 'unavailable') return 'The attention rules could not be evaluated.';
  if (a.availability === 'empty') return `All ${a.totalRules} rules evaluated · nothing flagged`;
  if (a.availability === 'partial') return `${a.unavailableCount} of ${a.totalRules} rules unavailable · showing a lower bound`;
  return `Across all ${a.totalRules} rules`;
}

// --- metric value states -------------------------------------------------------
//
// deriveDataState() (view-model.js) already models loading / empty / partial /
// unavailable / error and a genuine zero versus an unknown; this view points
// it at real reads rather than re-deriving that judgement.

function readAvailability(phase, recordCount) {
  return deriveDataState({
    phase,
    completeness: 'complete',
    recordCount,
    hasUsableData: true,
    refreshedAt: state.fetchedAt,
    evaluatedAt: state.fetchedAt,
  }).availability;
}

export function metricTone(availability) {
  if (availability === 'empty') return 'zero';
  if (availability === 'unavailable') return 'unavailable';
  if (availability === 'error' || availability === 'loading') return 'unknown';
  return 'available';
}

// A failed read never renders as zero: 'error' and 'unavailable' both format
// to UNKNOWN, never to formatValue(0). Only a genuine 'empty' does that.
export function metricDisplay(availability, value, formatValue) {
  if (availability === 'loading') return 'Loading…';
  if (availability === 'error' || availability === 'unavailable') return UNKNOWN;
  if (availability === 'empty') return formatValue(0);
  if (availability === 'partial') return `${formatValue(value)}+`;
  return formatValue(value);
}

// --- the executive band --------------------------------------------------------
//
// Five answers, in the order an operator who is not debugging asks them:
// where am I, is anything wrong, what did the agents do, what was refused,
// what can I prove. Everything below the band is the same builder-grade detail
// this page always had; the band exists so the first screen answers the
// questions without a table.
//
// Every answer carries its own availability, because these reads fail
// independently and the rubric's load-bearing rule applies hardest here: an
// unknown is never rendered as a zero. "No denials in this window" and "this
// gateway cannot tell me about denials" are different sentences.
function executiveModel(model) {
  const cap = state.capabilities.value;
  const posture = cap?.posture || null;
  const identity = state.identity.value;

  const tenant = state.identity.phase === 'ready' && identity?.tenant_id
    ? identity.tenant_id
    : state.identity.phase === 'loading' ? 'Loading…' : UNKNOWN;

  const latencyReady = state.latency.phase === 'ready' && state.latency.totals;
  const p95 = latencyReady ? state.latency.totals.latencyP95Ms : null;

  return {
    tenant,
    // Posture is what makes an empty console legible: a memory-backed gateway
    // with an ephemeral key is not misconfigured, it is a demo, and saying so
    // is kinder than leaving an operator to infer it from a catalog that
    // empties itself on restart.
    posture: {
      availability: state.capabilities.phase === 'ready' ? 'available' : state.capabilities.phase === 'loading' ? 'unknown' : 'unavailable',
      store: posture?.store || null,
      durable: posture ? posture.store === 'postgres' : null,
      kmsConfigured: posture ? Boolean(posture.kms_key_configured) : null,
      receipts: posture ? Boolean(posture.receipts_enabled) : null,
      receiptActor: posture?.receipt_actor || null,
      reason: cap?.surfaces ? Boolean(cap.surfaces.reason_enforcement) : null,
    },
    answers: [
      {
        id: 'attention',
        question: 'Is anything wrong?',
        target: 'attention',
        tone: metricTone(model.attention.availability),
        display: metricDisplay(model.attention.availability, model.attention.count, count),
        unit: model.attention.count === 1 ? 'item needs attention' : 'items need attention',
        detail: attentionDetail(model.attention),
      },
      {
        id: 'calls',
        question: 'What did the agents do?',
        target: 'invocations',
        tone: latencyReady ? 'available' : state.latency.phase === 'loading' ? 'unknown' : 'unavailable',
        display: latencyReady ? count(state.latency.totals.calls) : state.latency.phase === 'loading' ? 'Loading…' : UNKNOWN,
        unit: `calls · ${WINDOW_LABEL.toLowerCase()}`,
        detail: latencyReady
          ? state.latency.totals.calls === 0
            // A window with no traffic is a known zero, and must not read the
            // same as a window this gateway could not aggregate.
            ? `Known zero · ${WINDOW_LABEL}`
            : `${percent(Math.round((state.latency.totals.errorRate || 0) * state.latency.totals.calls), state.latency.totals.calls)} failed · p95 ${p95 == null ? UNKNOWN : duration(p95)}`
          : state.latency.phase === 'unavailable'
            ? 'This Gateway does not report window totals.'
            : 'The traffic aggregate could not be read from Gateway.',
      },
      {
        id: 'denials',
        question: 'What was refused?',
        target: 'policies',
        tone: state.denials.phase === 'ready' ? (state.denials.total > 0 ? 'attention' : 'available') : state.denials.phase === 'loading' ? 'unknown' : 'unavailable',
        display: state.denials.phase === 'ready' ? count(state.denials.total) : state.denials.phase === 'loading' ? 'Loading…' : UNKNOWN,
        unit: state.denials.total === 1 ? 'call denied by policy' : 'calls denied by policy',
        detail: state.denials.phase === 'ready'
          ? `${WINDOW_LABEL} · a denied call never becomes an invocation, so this is the only record of it`
          : state.denials.phase === 'unavailable'
            ? 'No policy surface on this Gateway.'
            : 'The decision log could not be read from Gateway.',
      },
      {
        id: 'proof',
        question: 'What can I prove?',
        target: 'invocations',
        tone: posture?.receipts_enabled ? 'available' : state.capabilities.phase === 'ready' ? 'unavailable' : 'unknown',
        display: posture?.receipts_enabled ? 'Signed' : state.capabilities.phase === 'ready' ? 'Off' : 'Loading…',
        unit: 'trust receipts',
        // Deliberately not a count. The gateway records an artifact per call
        // but exposes no window total of attested ones, and a page-scoped
        // tally rendered as a window figure would be exactly the kind of
        // plausible-looking number this console refuses to invent.
        detail: posture?.receipts_enabled
          ? `Every completed and refused call is signed as ${posture.receipt_actor || 'this gateway'}`
          : state.capabilities.phase === 'ready'
            ? 'Receipts are not enabled on this deployment.'
            : 'Checking whether this Gateway signs receipts…',
      },
    ],
  };
}

function buildModel() {
  const totalAvailability = readAvailability(state.totalCalls.phase, state.totalCalls.total ?? 0);
  const failedAvailability = readAvailability(state.failedCalls.phase, state.failedCalls.total ?? 0);
  const sampleAvailability = readAvailability(state.sample.phase, state.sample.items.length);
  const runtimeAvailability = readAvailability(state.runtime.phase, 1);
  const attention = attentionModel();

  const bothTrafficReady = ['ready', 'empty'].includes(totalAvailability) && ['ready', 'empty'].includes(failedAvailability);
  const eitherLoading = totalAvailability === 'loading' || failedAvailability === 'loading';
  const failureRateDisplay = bothTrafficReady ? percent(state.failedCalls.total, state.totalCalls.total) : eitherLoading ? 'Loading…' : UNKNOWN;
  const failureRateTone = bothTrafficReady ? 'available' : eitherLoading ? 'unknown' : 'unavailable';

  const metrics = [
    {
      id: 'traffic',
      label: `Calls · ${WINDOW_LABEL}`,
      target: 'invocations',
      tone: metricTone(totalAvailability),
      display: metricDisplay(totalAvailability, state.totalCalls.total, count),
      detail: totalAvailability === 'error'
        ? 'The call count could not be read from Gateway.'
        : totalAvailability === 'empty' ? `Known zero · ${WINDOW_LABEL}` : `Total invocations · ${WINDOW_LABEL}`,
    },
    {
      id: 'failures',
      label: 'Failed calls',
      target: 'invocations',
      tone: metricTone(failedAvailability),
      display: metricDisplay(failedAvailability, state.failedCalls.total, count),
      detail: failedAvailability === 'error'
        ? 'The failure count could not be read from Gateway.'
        : failedAvailability === 'empty'
          ? `Known zero · ${WINDOW_LABEL}`
          : bothTrafficReady ? `${failureRateDisplay} of calls in this window` : `Failed invocations · ${WINDOW_LABEL}`,
    },
    {
      id: 'failure-rate',
      label: 'Failure rate',
      target: 'invocations',
      tone: failureRateTone,
      display: failureRateDisplay,
      detail: bothTrafficReady ? WINDOW_LABEL : eitherLoading ? 'Loading…' : 'Needs both call counts',
    },
    {
      id: 'attention',
      label: 'Needs attention',
      target: 'attention',
      tone: metricTone(attention.availability),
      display: metricDisplay(attention.availability, attention.count, count),
      detail: attentionDetail(attention),
    },
  ];

  const model = {
    metrics,
    attention,
    sample: { availability: sampleAvailability, items: state.sample.items },
    runtime: { availability: runtimeAvailability, healthz: state.runtime.healthz, version: state.runtime.version },
  };
  model.executive = executiveModel(model);
  return model;
}

// --- rendering -----------------------------------------------------------------

function dataStateBlock(kind, title, message, compact = false) {
  const role = kind === 'error' ? 'alert' : 'status';
  const busy = kind === 'loading' ? ' aria-busy="true"' : '';
  const label = kind === 'loading' ? 'Loading' : kind === 'error' ? 'Error' : kind === 'unavailable' ? 'Unavailable' : 'Empty';
  const skeleton = kind === 'loading' && !compact ? '<div class="state-skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>' : '';
  return `<div class="data-state ${kind}${compact ? ' compact' : ''}" role="${role}"${busy}>${statusChip(label, kind)}<div><h2>${esc(title)}</h2><p>${esc(message)}</p></div>${skeleton}</div>`;
}

function renderAttentionPanel(model) {
  const a = model.attention;
  const heading = a.availability === 'loading'
    ? 'Evaluating tenant rules…'
    : a.availability === 'unavailable'
      ? 'Attention is Unknown'
      : a.availability === 'empty'
        ? 'No attention items'
        : a.availability === 'partial'
          ? `At least ${plural(a.count, 'item')} need review`
          : `${plural(a.count, 'item')} need review`;

  let body;
  if (a.availability === 'loading') {
    body = dataStateBlock('loading', 'Reading tenant rules', 'The attention rules are still reading live tenant state.', true);
  } else if (a.availability === 'unavailable') {
    body = dataStateBlock('unavailable', 'Reads unavailable', 'The reads these rules depend on failed. That is not the same as a clean queue.', true);
  } else if (a.items.length) {
    body = `<div class="attention-list">${a.items.slice(0, ATTENTION_PREVIEW_LIMIT).map(({ item, rule }) => `<button class="attention-row" data-live-overview-nav="${esc(rule.target)}"><span class="severity ${esc(rule.severity)}"></span><span><strong>${esc(rule.title)}</strong><small>${esc(item.detail)}</small></span><span>→</span></button>`).join('')}</div>`;
  } else {
    body = dataStateBlock('empty', 'Nothing needs attention', `All ${a.totalRules} rules read live tenant data and found nothing to flag.`, true);
  }

  const action = a.items.length ? `<button class="text-button" data-live-overview-nav="attention">View queue →</button>` : '';
  return `<section class="panel attention-panel"><div class="panel-heading"><div><p class="kicker">Needs attention</p><h2>${esc(heading)}</h2></div>${action}</div>${body}</section>`;
}

// The executive band. Four answers, one deployment line, no table.
//
// The tone classes are the same ones the metric strip uses, so an unavailable
// answer here looks like an unavailable answer everywhere else in the console
// rather than like a styling accident.
function renderExecutiveBand(model) {
  const x = model.executive;

  const answers = x.answers.map((a) => `
    <button class="exec-answer exec-${esc(a.tone)}" data-live-overview-nav="${esc(a.target)}">
      <p class="exec-question">${esc(a.question)}</p>
      <strong class="exec-value">${esc(a.display)}</strong>
      <span class="exec-unit">${esc(a.unit)}</span>
      <em class="exec-detail">${esc(a.detail)}</em>
    </button>`).join('');

  return `<section class="exec-band" aria-label="Executive summary">
    <div class="exec-answers">${answers}</div>
    ${renderPostureLine(x)}
  </section>`;
}

// One line of deployment truth under the answers. It exists because an empty
// console on a memory-backed gateway is not a broken console, and an operator
// should not have to deduce that from a catalog that empties itself.
function renderPostureLine(x) {
  const p = x.posture;
  if (p.availability !== 'available') {
    const message = p.availability === 'unknown'
      ? 'Reading this deployment’s capabilities…'
      : 'This Gateway does not report its capabilities, so posture is unknown.';
    return `<p class="exec-posture unknown">${esc(`Tenant ${x.tenant}`)} · ${esc(message)}</p>`;
  }

  const facts = [
    p.durable === null ? null : p.durable
      ? { tone: 'ok', text: 'Durable store' }
      : { tone: 'warn', text: 'In-memory store · not durable' },
    p.kmsConfigured === null ? null : p.kmsConfigured
      ? { tone: 'ok', text: 'KMS key configured' }
      : { tone: 'warn', text: 'Ephemeral KMS key · credentials break on restart' },
    p.receipts ? { tone: 'ok', text: 'Trust receipts on' } : { tone: 'off', text: 'Trust receipts off' },
    p.reason ? { tone: 'ok', text: 'Reason enforcement on' } : null,
  ].filter(Boolean);

  return `<p class="exec-posture">
    <span class="exec-tenant">Tenant ${esc(x.tenant)}</span>
    ${facts.map((f) => `<span class="exec-fact ${esc(f.tone)}">${esc(f.text)}</span>`).join('')}
  </p>`;
}

function renderRuntimePanel(model) {
  const r = model.runtime;
  if (r.availability === 'loading') {
    return `<section class="panel system-card"><div class="panel-heading"><div><p class="kicker">Runtime evidence</p><h2>Gateway</h2></div>${statusChip('Loading', 'loading')}</div><p class="sample-note">Reading <code>/healthz</code> and <code>/version</code>…</p></section>`;
  }
  if (r.availability === 'error') {
    return `<section class="panel system-card"><div class="panel-heading"><div><p class="kicker">Runtime evidence</p><h2>Gateway</h2></div>${statusChip('Unavailable', 'unavailable')}</div><p class="sample-note"><code>/healthz</code> and <code>/version</code> could not both be read on this session.</p></section>`;
  }
  const healthy = r.healthz?.status === 'ok';
  return `<section class="panel system-card">
    <div class="panel-heading"><div><p class="kicker">Runtime evidence</p><h2>Gateway</h2></div>${statusChip(r.healthz?.status ? esc(r.healthz.status) : UNKNOWN, healthy ? 'healthy' : 'warning')}</div>
    <dl class="system-facts">
      <div><dt>Version</dt><dd>${esc(r.version?.version || UNKNOWN)}</dd></div>
      <div><dt>Commit</dt><dd class="mono">${esc(r.version?.commit || UNKNOWN)}</dd></div>
      <div><dt>Console fetched</dt><dd>${esc(timestamp(state.fetchedAt))}</dd></div>
    </dl>
    <p class="sample-note"><code>/healthz</code> and <code>/version</code> carry no refresh timestamp of their own — the time above is when this console fetched them, not a Gateway-reported value.</p>
  </section>`;
}

function columnsHeader() {
  const columns = ['Time', 'Invocation', 'Agent / operation', 'Mode', 'Result', 'Policy', 'Latency', 'Sizes', 'Error class', 'Action'];
  return `<div class="catalog-columns" aria-hidden="true">${columns.map((c) => `<span>${esc(c)}</span>`).join('')}</div>`;
}

function renderSamplePanel(model) {
  const s = model.sample;
  const names = new Map(liveAgentsState.agents.map((a) => [a.id, a.name]));
  let body;
  if (s.availability === 'loading') {
    body = dataStateBlock('loading', 'Loading the latest invocations', 'Reading the most recent tenant invocations.', true);
  } else if (s.availability === 'error' || s.availability === 'unavailable') {
    body = dataStateBlock('unavailable', 'Invocation evidence is unavailable', 'The latest-invocation read did not return usable records.', true);
  } else if (s.items.length) {
    body = `${columnsHeader()}<div class="catalog-list live-catalog">${s.items.map((item) => invocationRow(item, names)).join('')}</div>`;
  } else {
    body = dataStateBlock('empty', 'No invocations yet', 'This tenant has no recorded invocations.', true);
  }
  const evidence = s.items.length ? statusChip(`${s.items.length} most recent`, 'review') : '';
  return `<section class="panel traffic-panel">
    <div class="panel-heading"><div><p class="kicker">Live tenant</p><h2>Latest invocation sample</h2></div><div class="panel-heading-actions">${evidence}<button class="text-button" data-live-overview-nav="invocations">Open traffic explorer →</button></div></div>
    ${body}
    <p class="sample-note">The newest ${SAMPLE_SIZE} invocations across the tenant, independent of the window above. A policy denial or an unpaid x402 challenge returns before an invocation record exists, so denied and unpaid requests never appear here.</p>
  </section>`;
}

function renderHeader() {
  const fetchedNote = state.fetchedAt ? ` Data fetched ${esc(timestamp(state.fetchedAt))}.` : '';
  return `<header class="page-heading operational-heading">
    <div>
      <p class="kicker">Operate · live tenant</p>
      <h1 id="page-title">Overview</h1>
      <p class="page-description">Traffic, attention, and runtime evidence read live from this tenant's Gateway.${fetchedNote}</p>
    </div>
    <div class="page-actions"><button class="button secondary" data-live-overview-action="refresh">Refresh</button></div>
  </header>`;
}

export function liveOverviewView() {
  if (state.status === 'idle' && typeof document !== 'undefined') {
    state.status = 'loading';
    loadOverview().then(rerenderIfMounted);
  }
  if (typeof document !== 'undefined') ensureAttentionLoaded();

  const header = renderHeader();

  if (state.status === 'idle' || state.status === 'loading') {
    return `<section class="page-enter overview-page" data-live-overview-root>${header}
      ${dataStateBlock('loading', 'Loading live overview', "Reading traffic, attention, and runtime evidence from this tenant's Gateway.")}
      ${renderCapabilitySection('data-live-overview-nav')}
    </section>`;
  }

  const model = buildModel();
  return `<section class="page-enter overview-page" data-live-overview-root>
    ${header}
    ${renderExecutiveBand(model)}
    <div class="overview-grid">${renderAttentionPanel(model)}${renderRuntimePanel(model)}</div>
    ${renderSamplePanel(model)}
    ${renderCapabilitySection('data-live-overview-nav')}
  </section>`;
}

// --- navigation & refresh ------------------------------------------------------
//
// This view manages its own re-renders (see the file header), so app.js's
// bindPageEvents() never runs against markup this module writes on its own —
// only against whatever was on the page the last time app.js itself called
// render(). A `data-view` button written here would therefore work the first
// time and go dead after the first self-triggered refresh. The sidebar's own
// nav buttons are bound once, at boot, directly by app.js and are never
// replaced, so routing an in-page link through a synthetic click on the
// matching sidebar button is the one path guaranteed to still work.
function navigateTo(view) {
  document.querySelector(`.side-nav [data-view="${view}"]`)?.click();
}

function rerenderIfMounted() {
  const root = document.querySelector('[data-live-overview-root]');
  if (!root) return;
  root.outerHTML = liveOverviewView();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', async (event) => {
    const navEl = event.target.closest('[data-live-overview-nav]');
    if (navEl) {
      navigateTo(navEl.dataset.liveOverviewNav);
      return;
    }
    const actionEl = event.target.closest('[data-live-overview-action]');
    if (actionEl?.dataset.liveOverviewAction !== 'refresh') return;
    state.status = 'loading';
    await loadOverview();
    rerenderIfMounted();
  });
}

export const liveOverviewState = state;
