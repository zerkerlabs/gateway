// The live Agent activity view: GET /v1/agent-events/summary, scoped to
// exactly what that endpoint can honestly produce.
//
// There is no GET that lists individual agent events — POST /v1/agent-events
// records them, and nothing reads them back one at a time. The only read is a
// per-agent aggregate over a window of at most 31 days (sessions, tool calls,
// succeeded/failed, tokens, cost, and the latest event time). The fixture this
// view replaces had an "Event stream / Metadata only" panel listing individual
// events — that panel has no endpoint behind it and is not reproduced here.
// Synthesizing rows from an aggregate would be inventing data this console
// does not have.
//
// Two things this view refuses to blur, per UX_RUBRIC.md:
//
//   awaiting setup vs. measured — an agent summary with no last_event_at has
//                                 never reported in, which is a different fact
//                                 from "reported in and did nothing". Only the
//                                 former counts as "awaiting setup"; the
//                                 latter is a measured agent with a real zero.
//   unknown vs. zero cost       — cost_known is false unless some usage event
//                                 supplied an explicit cost. A cost_usd of 0
//                                 with cost_known: false means unknown, not
//                                 free, and renders as Unknown accordingly.
//
// The strip is one request per agent in the loaded catalog (see
// catalogComplete() in agents-view.js — that catalog is itself capped at one
// 100-agent page), so the totals cover the agents this page actually loaded,
// not necessarily every agent in the tenant. One agent's request failing
// renders that agent as unknown and excludes it from the sums; it does not
// blank the page or the other agents' totals.
//
// Like analytics-view.js and the other live views, this module manages its
// own re-renders (guarded by `typeof document` so importing it under
// `node --test` stays side-effect free) rather than being pre-loaded in
// app.js's boot().

import { api, ApiError } from './api.js';
import { count, relative, timestamp, UNKNOWN } from './format.js';
import { catalogComplete, liveAgentsState } from './agents-view.js';
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
// The endpoint itself defaults `since` to 24 hours before `until`, but this
// view passes both explicitly so every per-agent request in one load shares
// the exact same window and the page can name it precisely.

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function resolveWindow(now = new Date()) {
  const until = now.toISOString();
  return { since: new Date(now.getTime() - WINDOW_MS).toISOString(), until };
}

// --- aggregation -----------------------------------------------------------
//
// Sessions, tool calls, and tokens sum safely across every agent whose read
// succeeded. An agent whose read failed contributes nothing to the sums and
// is counted separately as unknown — it must never fall in as a silent zero.

export function aggregateActivity(entries) {
  const totals = {
    agentsLoaded: entries.length,
    measured: 0,
    awaitingSetup: 0,
    unknownAgents: 0,
    sessions: 0,
    toolCalls: 0,
    toolsSucceeded: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    costKnownAgents: 0,
    incomplete: false,
  };

  for (const entry of entries) {
    if (entry.status !== 'ready') {
      totals.unknownAgents += 1;
      totals.incomplete = true;
      continue;
    }
    const s = entry.response?.summary || {};
    if (s.last_event_at) totals.measured += 1;
    else totals.awaitingSetup += 1;

    totals.sessions += s.sessions || 0;
    totals.toolCalls += s.tool_calls || 0;
    totals.toolsSucceeded += s.tools_succeeded || 0;
    totals.inputTokens += s.input_tokens || 0;
    totals.outputTokens += s.output_tokens || 0;
    if (s.cost_known) {
      totals.costUsd += s.cost_usd || 0;
      totals.costKnownAgents += 1;
    }
  }

  return totals;
}

// --- state -------------------------------------------------------------------

const state = {
  status: 'idle', // idle | loading | catalog_unavailable | ready
  window: null, // { since, until } — the window actually requested
  entries: [], // [{ agentId, name, status: 'ready'|'error', response }]
  fetchedAt: null,
};

async function loadActivity() {
  if (liveAgentsState.error) {
    state.status = 'catalog_unavailable';
    return;
  }

  state.status = 'loading';
  const { since, until } = resolveWindow();
  state.window = { since, until };

  const agentsSnapshot = liveAgentsState.agents;
  const settled = await Promise.allSettled(
    agentsSnapshot.map((a) => api.summarizeAgentEvents(a.id, { since, until }))
  );

  if (settled.some((r) => r.status === 'rejected' && r.reason instanceof ApiError && r.reason.status === 401)) {
    return unauthenticated();
  }

  state.entries = agentsSnapshot.map((a, i) => {
    const result = settled[i];
    return result.status === 'fulfilled'
      ? { agentId: a.id, name: a.name, status: 'ready', response: result.value }
      : { agentId: a.id, name: a.name, status: 'error', response: null };
  });
  state.fetchedAt = new Date().toISOString();
  state.status = 'ready';
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
      <p class="kicker">Operate · live tenant</p>
      <h1 id="page-title">Agent activity</h1>
      <p class="page-description">Per-agent aggregates read live from this tenant's
      <code>GET /v1/agent-events/summary</code>, one request per agent in the loaded catalog.
      There is no endpoint that lists individual events, so this page shows totals over a window, not a feed.</p>
    </div>
    <div class="page-actions"><button class="button secondary" data-live-activity-action="refresh">Refresh</button></div>
  </header>`;
}

function renderWindow() {
  const w = state.window;
  return `<section class="analytics-controls" aria-label="Live activity window">
    <div class="analytics-window-proof"><span>Window</span><strong>Last 24 hours</strong><small>${w ? `${esc(timestamp(w.since))} → ${esc(timestamp(w.until))}` : 'Not yet requested'}</small></div>
    <div class="analytics-window-proof"><span>Requests</span><strong>${count(state.entries.length)} agent ${state.entries.length === 1 ? 'read' : 'reads'}</strong><small>One summary call per loaded agent</small></div>
  </section>`;
}

function renderCatalogNote() {
  if (catalogComplete()) return '';
  return `<section class="state-banner partial" role="status">${statusChip('Partial', 'warning')}<div><strong>Catalog capped at ${count(liveAgentsState.agents.length)} of ${count(liveAgentsState.agentsTotal)} agents</strong><small>The totals below cover only the agents this page loaded — not necessarily every agent in the tenant.</small></div></section>`;
}

function renderPartialNote(totals) {
  if (!totals.incomplete) return '';
  return `<section class="state-banner partial" role="status">${statusChip('Partial', 'warning')}<div><strong>${count(totals.unknownAgents)} of ${count(totals.agentsLoaded)} agents' summaries failed to load</strong><small>Those agents are excluded from the totals below as unknown, not counted as zero activity. The other agents' totals are unaffected.</small></div></section>`;
}

function measuredDetail(totals) {
  const bits = [];
  if (totals.awaitingSetup) bits.push(`${count(totals.awaitingSetup)} awaiting setup`);
  if (totals.unknownAgents) bits.push(`${count(totals.unknownAgents)} unknown`);
  return bits.length ? bits.join(' · ') : 'All loaded agents measured';
}

function costCell(totals) {
  return totals.costKnownAgents ? `$${totals.costUsd.toFixed(2)}` : UNKNOWN;
}

function costDetail(totals) {
  if (!totals.costKnownAgents) return 'No agent reported an explicit cost';
  const reporting = totals.measured + totals.awaitingSetup;
  if (totals.costKnownAgents < reporting) return `Only ${count(totals.costKnownAgents)} of ${count(reporting)} agents reported a cost`;
  return 'Summed from agents with a known cost';
}

function renderMetricStrip(totals) {
  const tokens = totals.inputTokens + totals.outputTokens;
  return `<section class="metric-strip activity-metrics" aria-label="Live agent activity totals">
    <div><span>${count(totals.measured)}</span><small>Measured agents</small><em>${esc(measuredDetail(totals))}</em></div>
    <div><span>${count(totals.sessions)}</span><small>Sessions</small><em>Summed across measured agents</em></div>
    <div><span>${count(totals.toolCalls)}</span><small>Tool calls</small><em>${count(totals.toolsSucceeded)} succeeded</em></div>
    <div><span>${count(tokens)}</span><small>Tokens</small><em>${count(totals.inputTokens)} in · ${count(totals.outputTokens)} out</em></div>
    <div><span>${costCell(totals)}</span><small>Cost</small><em>${esc(costDetail(totals))}</em></div>
  </section>`;
}

function agentStatusChip(entry) {
  if (entry.status !== 'ready') return statusChip('Unknown', 'unavailable');
  return entry.response?.summary?.last_event_at ? statusChip('Measured', 'available') : statusChip('Awaiting setup', 'planned');
}

function renderAgentTable(entries) {
  const rows = entries.toSorted((a, b) => a.name.localeCompare(b.name));
  return `<section class="panel analytics-table-panel"><div class="panel-heading"><div><p class="kicker">By agent</p><h2>One summary read per agent</h2></div><span class="mono muted">${rows.length} agent${rows.length === 1 ? '' : 's'} loaded</span></div>
  <div class="analytics-table" role="table" aria-label="Live agent activity by agent">
    <div class="analytics-row analytics-head" role="row"><span>Agent</span><span>Status</span><span>Sessions</span><span>Tool calls</span><span>Tokens</span><span>Cost</span><span>Last event</span></div>
    ${rows.map((entry) => {
      const s = entry.response?.summary;
      const known = entry.status === 'ready';
      return `<div class="analytics-row" role="row">
        <span data-label="Agent"><strong>${esc(entry.name)}</strong><small class="mono">${esc(entry.agentId)}</small></span>
        <span data-label="Status">${agentStatusChip(entry)}</span>
        <span data-label="Sessions">${known ? count(s.sessions) : UNKNOWN}</span>
        <span data-label="Tool calls">${known ? count(s.tool_calls) : UNKNOWN}<small>${known ? `${count(s.tools_succeeded)} succeeded` : ''}</small></span>
        <span data-label="Tokens">${known ? count((s.input_tokens || 0) + (s.output_tokens || 0)) : UNKNOWN}</span>
        <span data-label="Cost">${known ? (s.cost_known ? `$${s.cost_usd.toFixed(2)}` : UNKNOWN) : UNKNOWN}</span>
        <span data-label="Last event">${known ? (s.last_event_at ? esc(relative(s.last_event_at)) : 'Awaiting setup') : UNKNOWN}</span>
      </div>`;
    }).join('')}
  </div></section>`;
}

// Static contract copy — the fields AgentEvent actually accepts and the ones
// its schema rejects (additionalProperties: false). Not sourced from the
// fixture's data.js: this view has no dependency on fixture data, live or not.
const PRIVACY_COLLECTED = ['Session lifecycle', 'Tool name and outcome', 'Duration', 'Model identity', 'Token counts', 'Reported cost'];
const PRIVACY_EXCLUDED = ['Prompts and messages', 'Tool arguments and outputs', 'Commands and file paths', 'Files and environment values', 'Credentials'];

function renderPrivacyPanel() {
  return `<section class="panel privacy-card">
    <p class="kicker">Privacy contract</p>
    <h2>Know the work.<br>Not the conversation.</h2>
    <h3>Collected</h3><p>${PRIVACY_COLLECTED.map(esc).join(' · ')}</p>
    <h3>Never collected</h3><p>${PRIVACY_EXCLUDED.map(esc).join(' · ')}</p>
    <p class="sample-note">Native adapters fail open: Gateway telemetry never delays or blocks agent work.
    <code>AgentEvent</code> rejects any field outside this contract at write time — there is nothing else here to leak.</p>
  </section>`;
}

function renderContract() {
  const population = catalogComplete()
    ? 'One summary per agent in the loaded catalog'
    : `One summary per agent in the loaded catalog — capped at ${count(liveAgentsState.agents.length)} of ${count(liveAgentsState.agentsTotal)} tenant agents`;
  return `<section class="analytics-contract"><div><p class="kicker">Contract boundary</p><h2>Bounded aggregates over a window, not a feed.</h2></div><div>
    <span><b>Source</b><code>GET /v1/agent-events/summary</code> · no endpoint lists individual events</span>
    <span><b>Window</b>Last 24 hours by default · the endpoint caps any window at 31 days</span>
    <span><b>Population</b>${population}</span>
    <span><b>Unmeasured agents</b>No <code>last_event_at</code> means awaiting setup, not zero activity</span>
    <span><b>Cost</b><code>cost_known: false</code> renders Unknown, not a false zero</span>
    <span><b>Content</b>No prompts, arguments, outputs, commands, paths, files, environment values, or credentials</span>
  </div></section>`;
}

export function liveActivityView() {
  if (state.status === 'idle' && typeof document !== 'undefined') {
    state.status = 'loading';
    loadActivity().then(rerenderIfMounted);
  }

  const header = renderHeader();

  if (state.status === 'catalog_unavailable') {
    return `<section class="page-enter" data-live-activity-root>${header}
      ${dataStateBlock('unavailable', 'Agent catalog unavailable', 'The tenant agent catalog could not be loaded, so no per-agent activity summary can be requested. Retry the catalog first.', true)}
      ${renderPrivacyPanel()}
    </section>`;
  }

  if (state.status === 'idle' || state.status === 'loading') {
    return `<section class="page-enter" data-live-activity-root>${header}
      ${dataStateBlock('loading', 'Loading agent activity', "Reading a per-agent activity summary from this tenant's Gateway, one request per loaded agent.")}
      ${renderPrivacyPanel()}
    </section>`;
  }

  if (!state.entries.length) {
    return `<section class="page-enter" data-live-activity-root>${header}
      <div class="catalog-empty"><p class="kicker">Live tenant</p><h2>No agents registered yet</h2><p>There is nothing to summarize until at least one agent exists in the catalog.</p></div>
      ${renderPrivacyPanel()}
    </section>`;
  }

  const totals = aggregateActivity(state.entries);
  return `<section class="page-enter" data-live-activity-root>
    ${header}
    ${renderWindow()}
    ${renderCatalogNote()}
    ${renderPartialNote(totals)}
    ${renderMetricStrip(totals)}
    ${renderAgentTable(state.entries)}
    ${renderPrivacyPanel()}
    ${renderContract()}
  </section>`;
}

// --- events ------------------------------------------------------------------
//
// Not pre-bound from app.js's boot() — app.js only imports this module and
// routes the `activity` view to it, same as analytics-view.js — so this
// module wires its own delegated listener and re-renders itself, guarded by
// `typeof document` so importing this file under `node --test` (no DOM) stays
// side-effect free.

function rerenderIfMounted() {
  const root = document.querySelector('[data-live-activity-root]');
  if (!root) return;
  root.outerHTML = liveActivityView();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-live-activity-action]');
    if (!el || el.dataset.liveActivityAction !== 'refresh') return;
    await loadActivity();
    rerenderIfMounted();
  });
}

export const liveActivityState = state;
