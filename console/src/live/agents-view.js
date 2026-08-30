// The live agent catalog: the one console surface backed by a real tenant
// rather than a fixture. It renders what the Gateway record actually contains,
// registers new agents through POST /v1/agents, and suspends or resumes them
// through PATCH.
//
// Three facts about an agent are deliberately kept visually separate, because
// they are independent and an operator who conflates them will misdiagnose:
//
//   catalog status  — pending until an upstream is set, then active; inactive
//                     after a delete. Derived by the gateway from upstream_url.
//   suspension      — a separate flag. A suspended agent stays in the catalog,
//                     still reads as "active", and rejects every invocation.
//   traffic         — what actually happened, from analytics. An agent can be
//                     active, unsuspended, and completely idle.
//
// Traffic comes from ONE analytics call covering the whole table rather than a
// request per row; credential names come from one credentials list. Both are
// best-effort: if either fails the catalog still renders, with those columns
// reporting unknown rather than blanking the page or implying zero.

import { api, normalizeAgent, summarizeAnalyticsByAgent, ApiError } from './api.js';
import { UNKNOWN, count, duration, percent, pricing, rateLimit, relative, timestamp } from './format.js';

// The traffic window is one whole UTC day, and that is a deliberate choice
// rather than a convenience. Analytics returns percentiles per (agent, bucket)
// cell, and percentiles from different cells cannot be combined into one — so
// a rolling 24-hour window, which straddles UTC midnight and therefore spans
// two day buckets, would force the p95 to be discarded on almost every row.
// Asking for a window that fits inside a single bucket is what makes the
// latency figure exact and reportable at all.
const WINDOW_LABEL = 'today (UTC)';

const state = {
  agents: [],
  traffic: new Map(),
  analyticsGroups: [],
  trafficState: 'unknown', // 'ready' | 'unavailable' | 'unknown'
  credentialNames: new Map(),
  credentialsState: 'unknown',
  loading: true,
  error: null,
  filters: { query: '', status: 'all', protocol: 'all', suspension: 'all' },
  form: { open: false, submitting: false, error: null },
  pending: new Set(), // agent ids with an in-flight suspend/resume
};

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// --- filtering ---------------------------------------------------------------

// Filtering happens in the browser over the fetched page. The gateway supports
// `protocol` server-side but not status, suspension or text search, so rather
// than half the filters querying and half not — which would make "no matches"
// mean two different things — all four filter the loaded set, and the UI says
// so. Exported for tests.
export function filterAgents(agents, filters) {
  const q = (filters.query || '').trim().toLowerCase();
  return agents.filter((a) => {
    if (filters.status !== 'all' && a.status !== filters.status) return false;
    if (filters.protocol !== 'all' && a.protocol !== filters.protocol) return false;
    if (filters.suspension === 'suspended' && !a.suspended) return false;
    if (filters.suspension === 'active' && a.suspended) return false;
    if (!q) return true;
    return `${a.id} ${a.name} ${a.description} ${a.protocol} ${(a.tags || []).join(' ')}`
      .toLowerCase()
      .includes(q);
  });
}

// --- row pieces --------------------------------------------------------------

function statusChip(a) {
  if (a.status === 'active') return '<span class="status available">Active</span>';
  if (a.status === 'pending') return '<span class="status planned">Pending upstream</span>';
  if (a.status === 'inactive') return '<span class="status empty">Inactive</span>';
  return `<span class="status">${esc(a.status || UNKNOWN)}</span>`;
}

// Suspension is rendered on every row, not only when true. "Not suspended" is
// information; an absent chip would leave the reader guessing whether the
// console checked.
function suspensionChip(a) {
  return a.suspended
    ? '<span class="status suspended">Suspended</span><small>Invocations blocked</small>'
    : '<strong>Not suspended</strong><small>Separate from catalog status</small>';
}

function protocolLabel(a) {
  if (a.protocol === 'mcp') {
    return `<strong>MCP</strong><small>${esc(a.mcpTransport || UNKNOWN)}</small>`;
  }
  return '<strong>HTTP</strong><small>Routing proxy</small>';
}

function credentialLabel(a) {
  if (!a.credentialRef) return `<strong>None</strong><small>No credential injected</small>`;
  const name = state.credentialNames.get(a.credentialRef);
  if (name) return `<strong>${esc(name)}</strong><small class="mono">${esc(a.credentialRef)}</small>`;
  // The reference exists but we could not resolve it to a name. That is not
  // the same as "no credential", and it is not the same as a dangling
  // reference either — we simply did not load the list.
  const why = state.credentialsState === 'unavailable' ? 'Name unavailable' : 'Not in credential list';
  return `<strong class="mono">${esc(a.credentialRef)}</strong><small>${why}</small>`;
}

// Traffic is the column most at risk of inventing a zero: an agent missing
// from the analytics response made no calls in the window, but a failed
// analytics call means we do not know. Those render differently on purpose.
function trafficLabel(a) {
  if (state.trafficState === 'unavailable') {
    return `<strong>${UNKNOWN}</strong><small>Analytics unavailable</small>`;
  }
  const t = state.traffic.get(a.id);
  if (!t) return `<strong>No calls</strong><small>Nothing ${WINDOW_LABEL}</small>`;

  const latency = t.percentilesMerged
    ? 'p95 unavailable across buckets'
    : `p95 ${duration(t.latencyP95Ms)}`;
  return `<strong>${count(t.calls)} calls</strong><small>${percent(t.errors, t.calls)} errors · ${latency}</small>`;
}

function tagList(a) {
  if (!a.tags?.length) return '';
  return `<span class="agent-tags">${a.tags.map((t) => `<em>${esc(t)}</em>`).join('')}</span>`;
}

function row(a) {
  const busy = state.pending.has(a.id);
  const action = a.suspended ? 'resume' : 'suspend';
  return `
    <article class="catalog-row live-agent-row${a.suspended ? ' is-suspended' : ''}">
      <span class="agent-identity" data-label="Agent">
        <strong>${esc(a.name)}</strong>
        <small class="mono">${esc(a.id)}</small>
        ${a.description ? `<small>${esc(a.description)}</small>` : ''}
        <small title="${esc(timestamp(a.createdAt))}">Registered ${esc(relative(a.createdAt))}</small>
        ${tagList(a)}
      </span>
      <span data-label="Catalog status">${statusChip(a)}<small>${
        a.status === 'pending' ? 'No upstream configured' : 'Derived from upstream'
      }</small></span>
      <span data-label="Suspension">${suspensionChip(a)}</span>
      <span data-label="Routing">${protocolLabel(a)}<small class="mono">${
        a.upstreamUrl ? esc(a.upstreamUrl) : 'No upstream'
      }</small></span>
      <span data-label="Rate boundary"><strong>${esc(rateLimit(a.rateLimit, a.burst))}</strong><small>Per agent, per process</small></span>
      <span data-label="Credential">${credentialLabel(a)}</span>
      <span data-label="Pricing"><strong>${esc(pricing(a.pricing))}</strong><small>${
        a.pricing ? 'x402 gate on' : 'Unpriced'
      }</small></span>
      <span data-label="Traffic">${trafficLabel(a)}</span>
      <span class="catalog-inspect">
        <button class="button secondary" data-live-action="${action}" data-agent-id="${esc(a.id)}"
          ${busy ? 'disabled' : ''} aria-label="${a.suspended ? 'Resume' : 'Suspend'} ${esc(a.name)}">
          ${busy ? '…' : a.suspended ? 'Resume' : 'Suspend'}
        </button>
      </span>
    </article>`;
}

// --- form --------------------------------------------------------------------

function credentialOptions() {
  if (!state.credentialNames.size) return '';
  return [...state.credentialNames.entries()]
    .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`)
    .join('');
}

function form() {
  if (!state.form.open) return '';
  return `
    <section class="panel live-agent-form">
      <div class="panel-heading"><div><p class="kicker">Control</p><h2>Register an agent</h2></div></div>
      ${state.form.error ? `<p class="form-error" role="alert">${esc(state.form.error)}</p>` : ''}
      <form id="live-agent-form">
        <label><span>Name</span>
          <input name="name" required maxlength="120" autocomplete="off" placeholder="echo-http" />
        </label>
        <label><span>Description</span>
          <input name="description" maxlength="240" autocomplete="off" placeholder="What this agent does" />
        </label>
        <label><span>Upstream URL</span>
          <input name="upstream_url" type="url" autocomplete="off" placeholder="https://example.com/api" />
          <small>Leave blank to register a pending catalog entry. Private, loopback and link-local
          hosts are rejected by Gateway for SSRF hygiene.</small>
        </label>
        <label><span>Protocol</span>
          <select name="protocol"><option value="http">HTTP</option><option value="mcp">MCP</option></select>
          <small>MCP agents are registered with the Streamable HTTP transport, the only one Gateway accepts.</small>
        </label>
        <label><span>Credential</span>
          <select name="credential_ref"><option value="">None</option>${credentialOptions()}</select>
          <small>Injected into upstream calls after policy allows the request. The caller's own
          authorization is stripped first.</small>
        </label>
        <label><span>Tags</span>
          <input name="tags" maxlength="240" autocomplete="off" placeholder="internal, staging" />
          <small>Comma-separated.</small>
        </label>
        <div class="form-actions">
          <button class="button primary" type="submit" ${state.form.submitting ? 'disabled' : ''}>
            ${state.form.submitting ? 'Registering…' : 'Register agent'}
          </button>
          <button class="button secondary" type="button" data-live-action="cancel-agent">Cancel</button>
        </div>
      </form>
    </section>`;
}

// --- view --------------------------------------------------------------------

function summaryStrip() {
  const a = state.agents;
  const cell = (n, label, detail) =>
    `<div><span>${count(n)}</span><small>${label}</small><em>${detail}</em></div>`;
  return `<section class="metric-strip catalog-metrics" aria-label="Catalog summary">
    ${cell(a.length, 'Catalog records', 'This tenant')}
    ${cell(a.filter((x) => x.status === 'active').length, 'Active', 'Upstream configured')}
    ${cell(a.filter((x) => x.status === 'pending').length, 'Pending', 'No upstream yet')}
    ${cell(a.filter((x) => x.suspended).length, 'Suspended', 'Counted separately · blocked')}
    ${cell(a.filter((x) => x.pricing).length, 'Priced', 'x402 gate on')}
  </section>`;
}

function filterBar() {
  const f = state.filters;
  const sel = (name, options, current) =>
    `<select data-agent-filter="${name}">${options
      .map(([v, l]) => `<option value="${v}"${v === current ? ' selected' : ''}>${l}</option>`)
      .join('')}</select>`;
  return `<section class="catalog-filters" aria-label="Filter the loaded catalog">
    <label class="catalog-search"><span>Filter these results</span>
      <input id="agent-filter" type="search" value="${esc(f.query)}" autocomplete="off"
        placeholder="Name, ID, protocol or tag" />
      <small>Filters the records already loaded — it does not query Gateway.</small>
    </label>
    <label><span>Catalog status</span>${sel('status', [['all', 'All'], ['active', 'Active'], ['pending', 'Pending'], ['inactive', 'Inactive']], f.status)}</label>
    <label><span>Protocol</span>${sel('protocol', [['all', 'All'], ['http', 'HTTP'], ['mcp', 'MCP']], f.protocol)}</label>
    <label><span>Suspension</span>${sel('suspension', [['all', 'All'], ['suspended', 'Suspended'], ['active', 'Not suspended']], f.suspension)}</label>
    <button class="button secondary" data-live-action="clear-filters">Clear filters</button>
  </section>`;
}

function trafficNote() {
  if (state.trafficState === 'unavailable') {
    return `<p class="sample-note"><strong>Traffic is unknown.</strong> The analytics read failed, so
      the traffic column reports unknown rather than zero. Catalog configuration below is current.</p>`;
  }
  if (state.trafficState === 'ready') {
    return `<p class="sample-note">Traffic covers ${WINDOW_LABEL}, measured from midnight UTC.
      Catalog status, suspension and traffic are three separate facts — an active, unsuspended
      agent can be idle.</p>`;
  }
  return '';
}

export function liveAgentsView() {
  const header = `
    <header class="page-heading">
      <div>
        <p class="kicker">Control · live tenant</p>
        <h1 id="page-title">Agent catalog</h1>
        <p class="page-description">Registered against this Gateway tenant. Unlike the rest of this
        console, these records are real.</p>
      </div>
      <div class="page-actions">
        <button class="button secondary" data-live-action="refresh-agents">Refresh</button>
        <button class="button primary" data-live-action="add-agent">＋ Register agent</button>
      </div>
    </header>`;

  if (state.loading) {
    return `${header}<section class="panel" aria-busy="true"><p>Loading the tenant catalog…</p></section>`;
  }
  if (state.error) {
    return `${header}<section class="panel"><p class="form-error" role="alert">${esc(state.error)}</p>
      <button class="button secondary" data-live-action="retry-agents">Retry</button></section>`;
  }
  if (!state.agents.length) {
    return `${header}${form()}
      <div class="catalog-empty"><p class="kicker">Live tenant</p><h2>No agents registered yet</h2>
      <p>This is the real catalog for your tenant, and it is empty — not unavailable.</p></div>`;
  }

  const rows = filterAgents(state.agents, state.filters);
  const list = rows.length
    ? rows.map(row).join('')
    : `<div class="catalog-empty"><p class="kicker">Filtered</p><h2>No loaded records match</h2>
       <p>Adjust the filters above. This does not mean the tenant catalog is empty.</p>
       <button class="button secondary" data-live-action="clear-filters">Clear filters</button></div>`;

  return `${header}${form()}${summaryStrip()}${filterBar()}
    <div class="catalog-results-heading">
      <p aria-live="polite"><strong>${rows.length} of ${state.agents.length} records</strong></p>
      <span>Catalog status ≠ suspension ≠ traffic</span>
    </div>
    ${trafficNote()}
    <div class="catalog-columns" aria-hidden="true"><span>Agent</span><span>Catalog status</span><span>Suspension</span><span>Routing</span><span>Rate boundary</span><span>Credential</span><span>Pricing</span><span>Traffic</span><span>Action</span></div>
    <section class="catalog-list live-catalog">${list}</section>`;
}

// --- loading -----------------------------------------------------------------

// Midnight UTC today. See WINDOW_LABEL: this is what keeps the response to a
// single day bucket per agent, and therefore keeps the percentile exact.
export function windowSince(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export async function loadAgents() {
  state.loading = true;
  state.error = null;
  try {
    const res = await api.listAgents();
    state.agents = (res?.agents || []).map(normalizeAgent);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw err;
    state.error =
      err instanceof ApiError && err.code === 'unreachable'
        ? 'Gateway is unreachable from the console.'
        : 'The tenant catalog could not be loaded.';
    return;
  } finally {
    state.loading = false;
  }

  // Evidence reads are deliberately not awaited together with the catalog: the
  // catalog is the page, and neither of these failing should stop it rendering
  // or turn into a sign-out. A 401 here is left to the next catalog read.
  await Promise.all([loadTraffic(), loadCredentialNames()]);
}

// The attention view's failing-agents rule reuses these same raw groups
// (see attention-view.js's buildContext) rather than issuing its own
// getAnalytics call for the identical window and grouping.
async function loadTraffic() {
  try {
    const res = await api.getAnalytics({ since: windowSince(), bucket: 'day', group_by: 'agent_id' });
    state.traffic = summarizeAnalyticsByAgent(res);
    state.analyticsGroups = res?.groups || [];
    state.trafficState = 'ready';
  } catch {
    state.traffic = new Map();
    state.analyticsGroups = [];
    state.trafficState = 'unavailable';
  }
}

async function loadCredentialNames() {
  try {
    const res = await api.listCredentials();
    state.credentialNames = new Map((res?.credentials || []).map((c) => [c.id, c.name]));
    state.credentialsState = 'ready';
  } catch {
    state.credentialNames = new Map();
    state.credentialsState = 'unavailable';
  }
}

// --- events ------------------------------------------------------------------

// Wired from app.js so the live view participates in the existing render loop
// rather than owning its own.
export function bindLiveAgents({ rerender, onUnauthenticated }) {
  document.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-live-action]');
    const action = el?.dataset.liveAction;
    if (!action) return;

    if (action === 'add-agent') {
      state.form.open = true;
      state.form.error = null;
      rerender();
    } else if (action === 'cancel-agent') {
      state.form.open = false;
      rerender();
    } else if (action === 'retry-agents' || action === 'refresh-agents') {
      await guard(loadAgents(), onUnauthenticated);
      rerender();
    } else if (action === 'clear-filters') {
      state.filters = { query: '', status: 'all', protocol: 'all', suspension: 'all' };
      rerender();
    } else if (action === 'suspend' || action === 'resume') {
      await toggleSuspension(el.dataset.agentId, action === 'suspend', { rerender, onUnauthenticated });
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.id !== 'agent-filter') return;
    state.filters.query = event.target.value;
    rerender();
    // Re-rendering replaces the input, so put the caret back where it was.
    const next = document.querySelector('#agent-filter');
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  });

  document.addEventListener('change', (event) => {
    const key = event.target.dataset?.agentFilter;
    if (!key) return;
    state.filters[key] = event.target.value;
    rerender();
  });

  document.addEventListener('submit', async (event) => {
    if (event.target.id !== 'live-agent-form') return;
    event.preventDefault();
    await submitAgent(new FormData(event.target), { rerender, onUnauthenticated });
  });
}

// Suspension is a one-field PATCH. Nothing else about the agent is sent —
// PATCH is tri-state, so spreading the record we happen to be holding would
// overwrite every field on the server with a possibly-stale browser copy.
async function toggleSuspension(id, suspended, { rerender, onUnauthenticated }) {
  if (!id || state.pending.has(id)) return;
  state.pending.add(id);
  rerender();
  try {
    const updated = await api.updateAgent(id, { suspended });
    const next = normalizeAgent(updated);
    state.agents = state.agents.map((a) => (a.id === id ? next : a));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return onUnauthenticated();
    state.error =
      err instanceof ApiError && err.status === 404
        ? 'That agent no longer exists in this tenant.'
        : `Gateway rejected the ${suspended ? 'suspend' : 'resume'}.`;
  } finally {
    state.pending.delete(id);
    rerender();
  }
}

export function buildCreateBody(data) {
  const body = { name: String(data.get('name') || '').trim() };
  const description = String(data.get('description') || '').trim();
  const upstream = String(data.get('upstream_url') || '').trim();
  const protocol = String(data.get('protocol') || 'http');
  const credential = String(data.get('credential_ref') || '').trim();
  const tags = String(data.get('tags') || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  if (description) body.description = description;
  if (upstream) body.upstream_url = upstream;
  if (credential) body.credential_ref = credential;
  if (tags.length) body.tags = tags;
  if (protocol === 'mcp') {
    body.protocol = 'mcp';
    // The gateway requires this pairing; sending protocol=mcp alone is a 400.
    body.mcp_transport = 'streamable_http';
  }
  return body;
}

async function submitAgent(data, { rerender, onUnauthenticated }) {
  state.form.submitting = true;
  state.form.error = null;
  rerender();

  try {
    await api.createAgent(buildCreateBody(data));
    state.form.open = false;
    await loadAgents();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return onUnauthenticated();
    state.form.error =
      err instanceof ApiError && err.status === 409
        ? 'An agent with that name already exists in this tenant.'
        : err instanceof ApiError && err.status === 400
          ? // The gateway's 400 body says which combination it rejected, and that
            // is more useful than any guess this layer could make.
            err.message
          : 'Registration failed.';
  } finally {
    state.form.submitting = false;
    rerender();
  }
}

async function guard(promise, onUnauthenticated) {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) onUnauthenticated();
  }
}

export const liveAgentsState = state;
