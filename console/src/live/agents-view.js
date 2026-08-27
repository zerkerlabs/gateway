// The live agent catalog: the one console surface backed by a real tenant
// rather than a fixture. It renders what the Gateway record actually contains
// and registers new agents through POST /v1/agents.

import { api, normalizeAgent, ApiError } from './api.js';

const state = {
  agents: [],
  loading: true,
  error: null,
  form: { open: false, submitting: false, error: null },
};

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function when(iso) {
  if (!iso) return 'Unknown';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Unknown' : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// `pending` is not a failure. An agent with no upstream is a catalog entry
// that has not been pointed anywhere yet, which is exactly what registration
// without an upstream_url produces.
function statusChip(a) {
  if (a.suspended) return '<span class="status suspended">Suspended</span>';
  if (a.status === 'active') return '<span class="status available">Active</span>';
  if (a.status === 'pending') return '<span class="status planned">Pending upstream</span>';
  return `<span class="status">${esc(a.status || 'Unknown')}</span>`;
}

function row(a) {
  return `
    <article class="catalog-row live-agent-row">
      <div>
        <h3>${esc(a.name)}</h3>
        <p class="mono muted">${esc(a.id)}</p>
        ${a.description ? `<p>${esc(a.description)}</p>` : ''}
      </div>
      <div>${statusChip(a)}</div>
      <div>
        <p class="kicker">Protocol</p>
        <p>${esc(a.protocol.toUpperCase())}${a.mcpTransport ? ` · ${esc(a.mcpTransport)}` : ''}</p>
      </div>
      <div>
        <p class="kicker">Upstream</p>
        <p class="mono">${a.upstreamUrl ? esc(a.upstreamUrl) : 'Not configured'}</p>
      </div>
      <div>
        <p class="kicker">Registered</p>
        <p>${esc(when(a.createdAt))}</p>
      </div>
    </article>`;
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

export function liveAgentsView() {
  const header = `
    <header class="page-header">
      <div>
        <p class="kicker">Control · live tenant</p>
        <h1>Agent catalog</h1>
        <p>Registered against this Gateway tenant. Unlike the rest of this console, these
        records are real.</p>
      </div>
      <button class="button primary" data-live-action="add-agent">＋ Register agent</button>
    </header>`;

  if (state.loading) {
    return `${header}<section class="panel"><p>Loading the tenant catalog…</p></section>`;
  }
  if (state.error) {
    return `${header}<section class="panel"><p class="form-error" role="alert">${esc(state.error)}</p>
      <button class="button secondary" data-live-action="retry-agents">Retry</button></section>`;
  }

  const list = state.agents.length
    ? state.agents.map(row).join('')
    : `<div class="catalog-empty"><p class="kicker">Live tenant</p><h2>No agents registered yet</h2>
       <p>This is the real catalog for your tenant, and it is empty — not unavailable.</p></div>`;

  return `${header}${form()}<section class="catalog-list live-catalog">${list}</section>`;
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
  } finally {
    state.loading = false;
  }
}

// Wired from app.js so the live view participates in the existing render loop
// rather than owning its own.
export function bindLiveAgents({ rerender, onUnauthenticated }) {
  document.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-live-action]')?.dataset.liveAction;
    if (!action) return;

    if (action === 'add-agent') {
      state.form.open = true;
      state.form.error = null;
      rerender();
    } else if (action === 'cancel-agent') {
      state.form.open = false;
      rerender();
    } else if (action === 'retry-agents') {
      await guard(loadAgents(), onUnauthenticated);
      rerender();
    }
  });

  document.addEventListener('submit', async (event) => {
    if (event.target.id !== 'live-agent-form') return;
    event.preventDefault();

    const data = new FormData(event.target);
    const body = { name: String(data.get('name') || '').trim() };
    const description = String(data.get('description') || '').trim();
    const upstream = String(data.get('upstream_url') || '').trim();
    const protocol = String(data.get('protocol') || 'http');

    if (description) body.description = description;
    if (upstream) body.upstream_url = upstream;
    if (protocol === 'mcp') {
      body.protocol = 'mcp';
      // The gateway requires this pairing; sending protocol=mcp alone is a 400.
      body.mcp_transport = 'streamable_http';
    }

    state.form.submitting = true;
    state.form.error = null;
    rerender();

    try {
      await api.createAgent(body);
      state.form.open = false;
      await loadAgents();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthenticated();
      state.form.error =
        err instanceof ApiError && err.status === 409
          ? 'An agent with that name already exists in this tenant.'
          : err instanceof ApiError && err.status === 400
            ? 'Gateway rejected that configuration. Check the upstream URL.'
            : 'Registration failed.';
    } finally {
      state.form.submitting = false;
      rerender();
    }
  });
}

async function guard(promise, onUnauthenticated) {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) onUnauthenticated();
  }
}

export const liveAgentsState = state;
