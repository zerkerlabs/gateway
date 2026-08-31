// The live credential catalog: GET /v1/credentials, strictly read-only.
//
// GET /v1/credentials takes no parameters at all — no pagination, no
// server-side filter — and always returns every credential the tenant has.
// That is what makes the filters below correct as pure client-side
// narrowing: there is no "matches something on another page" case to worry
// about, unlike agents-view.js or invocations-view.js, where the loaded page
// is only ever a slice of the tenant's records and the UI has to say so. Here
// the loaded set IS the tenant's full credential list, so "no matches"
// unambiguously means no matches.
//
// Two renames from the fixture this view replaces: the hint field is
// `masked_hint` — a redacted hint, not necessarily four characters, so it is
// shown verbatim rather than forced into a "•••• XXXX" template — and the
// source enum is `managed | vault`, not `external_vault`.
//
// The References column joins the agent catalog on `credential_ref` by id —
// the fixture joined by name. It reads liveAgentsState (agents-view.js),
// which app.js's boot() already loads and awaits before any view first
// renders, so this view never has to fetch the catalog itself.
//
// No write control exists anywhere on this page: no create, rotate, delete,
// reveal, or copy. A referenced credential's delete-conflict (409, "still
// referenced by one or more agents") is real Gateway behavior and is
// described in the protection panel below, but there is no delete button to
// trigger it.

import { api, ApiError } from './api.js';
import { count, relative, timestamp, UNKNOWN } from './format.js';
import { liveAgentsState, catalogComplete } from './agents-view.js';
import { renderSignIn } from './gate.js';

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function unauthenticated() {
  renderSignIn(document.body, { reason: 'expired' });
}

// --- normalization -----------------------------------------------------------

export function normalizeCredential(raw) {
  return {
    id: raw.id,
    name: raw.name,
    authType: raw.auth_type,
    source: raw.source, // 'managed' | 'vault'
    maskedHint: raw.masked_hint ?? null,
    vaultRef: raw.vault_ref ?? null,
    version: Number.isInteger(raw.version) ? raw.version : null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

// --- state ---------------------------------------------------------------

function defaultFilters() {
  return { query: '', source: 'all', authType: 'all', reference: 'all' };
}

const state = {
  status: 'idle', // idle | loading | ready | error
  error: null,
  credentials: [],
  filters: defaultFilters(),
};

// --- references ------------------------------------------------------------

// Exported so the id-based join can be tested without agents-view.js's own
// fetch machinery.
export function referencingAgents(credentialId, agents) {
  return agents.filter((a) => a.credentialRef === credentialId);
}

// Three outcomes, not two: an agent catalog that failed to load, or that
// only partially loaded (agents-view.js fetches a single page and never
// follows further pages), makes the reference state genuinely unknown, and
// that must never collapse into "unreferenced" — that would tell an
// operator a credential is safe to delete when the truth is the console
// simply couldn't check every agent.
function referenceState(credentialId) {
  if (liveAgentsState.error || !catalogComplete()) return { id: 'unknown', label: 'Unknown', agents: [] };
  const agents = referencingAgents(credentialId, liveAgentsState.agents);
  if (!agents.length) return { id: 'unreferenced', label: 'Not referenced', agents: [] };
  return { id: 'referenced', label: `Referenced · ${agents.length}`, agents };
}

// --- filtering ---------------------------------------------------------------

// Filters the full, already-complete credential list fetched above — see the
// file header for why that is correct here and not a "this page only" caveat
// like every other filtered view in this console.
export function filterCredentials(credentials, filters) {
  const q = (filters.query || '').trim().toLowerCase();
  return credentials.filter((c) => {
    if (filters.source !== 'all' && c.source !== filters.source) return false;
    if (filters.authType !== 'all' && c.authType !== filters.authType) return false;
    if (filters.reference !== 'all' && referenceState(c.id).id !== filters.reference) return false;
    if (!q) return true;
    return `${c.id} ${c.name} ${c.authType} ${c.source}`.toLowerCase().includes(q);
  });
}

// --- labels ----------------------------------------------------------------

function sourceLabel(source) {
  if (source === 'managed') return 'Managed';
  if (source === 'vault') return 'Vault';
  return UNKNOWN;
}

function sourceTone(source) {
  if (source === 'managed') return 'managed';
  if (source === 'vault') return 'vault';
  return 'unavailable';
}

function authLabel(authType) {
  if (authType === 'bearer') return 'Bearer';
  if (authType === 'api_key') return 'API key';
  if (authType === 'none') return 'None';
  return UNKNOWN;
}

function secretReferenceCell(c) {
  if (c.source === 'managed') {
    return c.maskedHint
      ? `<strong class="mono">${esc(c.maskedHint)}</strong><small>Masked hint</small>`
      : `<strong>${UNKNOWN}</strong><small>No hint returned</small>`;
  }
  if (c.source === 'vault') {
    return c.vaultRef
      ? `<strong class="mono">${esc(c.vaultRef)}</strong><small>Vault reference</small>`
      : `<strong>${UNKNOWN}</strong><small>No reference returned</small>`;
  }
  return `<strong>${UNKNOWN}</strong>`;
}

function referenceCell(c) {
  const ref = referenceState(c.id);
  if (ref.id === 'unknown') {
    return `<span class="status unavailable">Unknown</span><small>Agent catalog unavailable or incomplete</small>`;
  }
  if (ref.id === 'unreferenced') {
    return `<span class="status empty">Not referenced</span><small>No agent's credential_ref points here</small>`;
  }
  const names = ref.agents.map((a) => esc(a.name)).join(', ');
  return `<span class="status review">${esc(ref.label)}</span><small>${names}</small>`;
}

// --- rows ----------------------------------------------------------------

// Reuses the fixture's .credential-columns/.credential-row grid (7 tracks,
// the last sized for an action button). This view fills only the first six —
// there is no write action to put in the seventh, and leaving it empty says
// that more plainly than adding a button that would do nothing.
function row(c) {
  return `<article class="credential-row live-credential-row">
    <span data-label="Credential"><strong>${esc(c.name)}</strong><small class="mono">${esc(c.id)}</small></span>
    <span data-label="Source"><span class="status ${sourceTone(c.source)}">${esc(sourceLabel(c.source))}</span></span>
    <span data-label="Auth type"><strong>${esc(authLabel(c.authType))}</strong></span>
    <span data-label="Secret reference">${secretReferenceCell(c)}</span>
    <span data-label="Version"><strong>${Number.isInteger(c.version) ? `v${c.version}` : UNKNOWN}</strong><small title="${esc(timestamp(c.updatedAt))}">Updated ${esc(relative(c.updatedAt))}</small></span>
    <span data-label="References">${referenceCell(c)}</span>
  </article>`;
}

// --- filter bar & summary ----------------------------------------------------

function summaryStrip(credentials) {
  const managed = credentials.filter((c) => c.source === 'managed').length;
  const vault = credentials.filter((c) => c.source === 'vault').length;
  const referenced = credentials.filter((c) => referenceState(c.id).id === 'referenced').length;
  const unreferenced = credentials.filter((c) => referenceState(c.id).id === 'unreferenced').length;
  const cell = (n, label, detail) => `<div><span>${count(n)}</span><small>${esc(label)}</small><em>${esc(detail)}</em></div>`;
  return `<section class="metric-strip governance-metrics" aria-label="Credential summary">
    ${cell(credentials.length, 'Credential records', 'This tenant')}
    ${cell(managed, 'Managed', 'Envelope-encrypted')}
    ${cell(vault, 'Vault', 'External reference')}
    ${cell(referenced, 'Referenced', 'Delete would conflict')}
    ${cell(unreferenced, 'Unreferenced', 'Delete is not offered here')}
  </section>`;
}

function filterBar() {
  const f = state.filters;
  const sel = (name, options, current) =>
    `<select data-live-credential-filter="${name}">${options
      .map(([v, l]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(l)}</option>`)
      .join('')}</select>`;
  return `<section class="governance-filters credential-filters" aria-label="Filter tenant credential metadata">
    <label class="governance-search"><span>Filter</span>
      <input id="live-credential-search" type="search" value="${esc(f.query)}" autocomplete="off"
        placeholder="ID, name, auth type or source" />
      <small>Filters the tenant's full credential list — Gateway returns every credential on this
      endpoint, so there is nothing unfiltered sitting on another page.</small>
    </label>
    <label><span>Source</span>${sel('source', [['all', 'All'], ['managed', 'Managed'], ['vault', 'Vault']], f.source)}</label>
    <label><span>Auth type</span>${sel(
      'authType',
      [['all', 'All'], ['bearer', 'Bearer'], ['api_key', 'API key'], ['none', 'None']],
      f.authType
    )}</label>
    <label><span>References</span>${sel(
      'reference',
      [['all', 'All'], ['referenced', 'Referenced'], ['unreferenced', 'Unreferenced']],
      f.reference
    )}</label>
    <button class="button secondary" data-live-credential-action="clear-filters">Clear filters</button>
  </section>`;
}

// --- view --------------------------------------------------------------------

function renderHeader() {
  return `<header class="page-heading">
    <div>
      <p class="kicker">Control · live tenant</p>
      <h1 id="page-title">Credentials</h1>
      <p class="page-description">Safe metadata for every credential this tenant has stored. Read-only:
      there is no create, rotate, delete, reveal, or copy control on this page.</p>
    </div>
    <div class="page-actions">
      <button class="button secondary" data-live-credential-action="refresh">Refresh</button>
    </div>
  </header>`;
}

function protectionPanel() {
  return `<section class="credential-protection">
    <div><p class="kicker">Protection posture</p><h2>Server-side boundaries, not console ones</h2></div>
    <div>
      <span><b>Managed values</b>Envelope-encrypted under tenant keys; plaintext is never returned by any read.</span>
      <span><b>Vault references</b>The path shown above is opaque — the value it points to stays in the external store.</span>
      <span><b>Injection</b>Applied to upstream calls only after policy allows the request; the caller's own authorization is stripped first.</span>
      <span><b>Delete conflict</b>Gateway rejects deleting a credential still referenced by an agent's <code>credential_ref</code> or the facilitator's <code>facilitator_credential_ref</code> with <code>409</code>. That check runs server-side regardless of this page — deletion itself is not offered here.</span>
    </div>
  </section>`;
}

export function liveCredentialsView() {
  if (state.status === 'idle' && typeof document !== 'undefined') {
    state.status = 'loading';
    loadCredentials().then(rerenderIfMounted);
  }

  const header = renderHeader();

  if (state.status === 'idle' || state.status === 'loading') {
    return `<section class="page-enter governance-page credential-page" data-live-credentials-root>${header}
      <section class="panel" aria-busy="true"><p>Loading tenant credentials…</p></section></section>`;
  }
  if (state.status === 'error') {
    return `<section class="page-enter governance-page credential-page" data-live-credentials-root>${header}
      <section class="panel"><p class="form-error" role="alert">${esc(state.error)}</p>
      <button class="button secondary" data-live-credential-action="retry">Retry</button></section></section>`;
  }

  if (!state.credentials.length) {
    return `<section class="page-enter governance-page credential-page" data-live-credentials-root>${header}
      <div class="catalog-empty"><p class="kicker">Live tenant</p><h2>No credentials stored yet</h2>
      <p>This is the real credential list for your tenant, and it is empty — not unavailable.</p></div>
      ${protectionPanel()}
    </section>`;
  }

  const rows = filterCredentials(state.credentials, state.filters);
  const list = rows.length
    ? `<div class="credential-columns" aria-hidden="true"><span>Credential</span><span>Source</span><span>Auth type</span><span>Secret reference</span><span>Version / updated</span><span>References</span></div>
       <section class="credential-list">${rows.map(row).join('')}</section>`
    : `<div class="governance-empty"><p class="kicker">Filtered</p><h2>No loaded records match</h2>
       <p>Adjust the filters above. This does not mean the tenant has no matching credentials.</p>
       <button class="button secondary" data-live-credential-action="clear-filters">Clear filters</button></div>`;

  return `<section class="page-enter governance-page credential-page" data-live-credentials-root>
    ${header}
    ${summaryStrip(state.credentials)}
    ${filterBar()}
    <div class="governance-results-heading">
      <p aria-live="polite"><strong>${rows.length} of ${state.credentials.length} credentials</strong></p>
      <span>Full tenant list · filtered client-side</span>
    </div>
    ${list}
    ${protectionPanel()}
  </section>`;
}

// --- loading -----------------------------------------------------------------

async function loadCredentials() {
  state.status = 'loading';
  state.error = null;
  try {
    const res = await api.listCredentials();
    state.credentials = (res?.credentials || []).map(normalizeCredential);
    state.status = 'ready';
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return unauthenticated();
    state.status = 'error';
    state.error =
      err instanceof ApiError && err.code === 'unreachable'
        ? 'Gateway is unreachable from the console.'
        : 'Tenant credentials could not be loaded.';
  }
}

function rerenderIfMounted() {
  const root = document.querySelector('[data-live-credentials-root]');
  if (!root) return;
  root.outerHTML = liveCredentialsView();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-live-credential-action]');
    if (!el) return;
    const action = el.dataset.liveCredentialAction;

    if (action === 'retry' || action === 'refresh') {
      await loadCredentials();
      rerenderIfMounted();
    } else if (action === 'clear-filters') {
      state.filters = defaultFilters();
      rerenderIfMounted();
      document.querySelector('#live-credential-search')?.focus();
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.id !== 'live-credential-search') return;
    state.filters = { ...state.filters, query: event.target.value };
    rerenderIfMounted();
    // Re-rendering replaces the input, so put the caret back where it was.
    const next = document.querySelector('#live-credential-search');
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  });

  document.addEventListener('change', (event) => {
    const key = event.target.dataset?.liveCredentialFilter;
    if (!key) return;
    state.filters = { ...state.filters, [key]: event.target.value };
    rerenderIfMounted();
  });
}

export const liveCredentialsState = state;
