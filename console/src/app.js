// The console shell: session gate, hash router, window control, detail panel.
//
// Every page is an async function that fetches what it needs and returns HTML.
// The shell renders a skeleton first and swaps it when the page resolves, so a
// slow gateway shows the layout it is filling rather than a blank screen — and
// a page that fails renders its own failure rather than emptying the console.

import './styles.css';
import { api, ApiError } from './live/api.js';
import { currentSession, renderSignIn, signOut } from './live/gate.js';
import { esc, WINDOWS } from './ui.js';
import { closePanel as hidePanel, copyText, state, toast } from './shell.js';
import { overviewPage } from './pages/overview.js';
import { agentsPage, agentPanel } from './pages/agents.js';
import { trafficPage, invocationPanel } from './pages/traffic.js';
import { policyPage } from './pages/policy.js';
import { paymentsPage } from './pages/payments.js';
import { receiptsPage } from './pages/receipts.js';
import { activityPage } from './pages/activity.js';
import { systemPage } from './pages/system.js';

const PAGES = {
  overview: overviewPage,
  agents: agentsPage,
  traffic: trafficPage,
  policy: policyPage,
  payments: paymentsPage,
  receipts: receiptsPage,
  activity: activityPage,
  system: systemPage,
};

const NAV = [
  ['overview', 'Overview', '<path d="M3 12 12 4l9 8"/><path d="M5 10v10h14V10"/>'],
  ['agents', 'Agents', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
  ['traffic', 'Traffic', '<path d="M3 17l5-6 4 4 4-7 5 5"/>'],
  ['policy', 'Policy', '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/>'],
  ['payments', 'Payments', '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>'],
  ['receipts', 'Receipts', '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'],
  ['activity', 'Activity', '<path d="M4 12h4l2-6 4 12 2-6h4"/>'],
  ['system', 'System', '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>'],
];

const $ = (sel) => document.querySelector(sel);

function shell() {
  const tenant = state.identity?.tenant_id;
  const p = state.capabilities?.posture;
  const facts = p
    ? [p.store === 'postgres' ? 'Postgres' : 'in-memory store', p.receipts_enabled ? 'receipts on' : 'receipts off']
        .join(' · ')
    : 'reading capabilities…';

  return `<div class="shell">
    <aside class="side">
      <div class="brand"><i></i>Zerker</div>
      <nav id="nav" aria-label="Sections"></nav>
      <div class="tenant">
        <b>${esc(tenant ? `Tenant ${tenant}` : 'Signed in')}</b>${esc(facts)}
        <button type="button" data-action="signout">Sign out</button>
      </div>
    </aside>
    <div>
      <div class="topbar">
        <label class="search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input id="q" placeholder="Find an agent or paste a call ID" autocomplete="off" aria-label="Search" />
          <kbd>/</kbd>
        </label>
        <div class="win" id="win" role="group" aria-label="Time window">
          ${Object.keys(WINDOWS).map((w) => `<button data-w="${w}"${state.win === w ? ' class="on"' : ''}>${w === '24h' ? '24 hours' : w === '7d' ? '7 days' : '30 days'}</button>`).join('')}
        </div>
        <div class="fresh"><b></b><span id="fresh">Reading…</span></div>
      </div>
      <main id="main" tabindex="-1"></main>
    </div>
  </div>
  <aside class="panel" id="panel" aria-label="Details" aria-hidden="true"></aside>
  <div class="tip" id="tip" hidden></div>`;
}

function paintNav() {
  const nav = $('#nav');
  if (!nav) return;
  nav.innerHTML = NAV.map(
    ([key, label, icon]) =>
      `<a href="#${key}"${state.route === key ? ' class="on"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>${esc(label)}${
        key === 'overview' && state.attention ? `<span class="n">${state.attention}</span>` : ''
      }</a>`
  ).join('');
}

function paintFreshness() {
  const el = $('#fresh');
  if (!el) return;
  el.textContent = state.fetchedAt
    ? `Read ${new Date(state.fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
    : 'Reading…';
}

// The page-level loading state. It mirrors the shape a page settles into — a
// heading, a lede, then blocks — so the layout does not jump when the reads
// land.
const loadingPage = `<h1><span class="skeleton t" ></span></h1>
  <p class="lede"><span class="skeleton wide"></span></p>
  <div class="answers">${'<div class="ans"><span class="skeleton l" ></span><span class="skeleton v" ></span><span class="skeleton wide"></span></div>'.repeat(4)}</div>`;

async function render() {
  const main = $('#main');
  if (!main) return;
  paintNav();
  main.innerHTML = loadingPage;

  const page = PAGES[state.route] || PAGES.overview;
  try {
    const html = await page(state);
    if (!$('#main')) return;
    $('#main').innerHTML = html;
    state.fetchedAt = new Date().toISOString();
    paintNav();
    paintFreshness();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return boot({ reason: 'expired' });
    $('#main').innerHTML = `<h1>This page could not be read</h1>
      <p class="lede">${esc(err instanceof ApiError ? err.message : 'The console could not reach Gateway.')}</p>
      <p><button class="btn sec" data-action="refresh">Try again</button></p>`;
  }
  window.scrollTo({ top: 0 });
}

function closePanel() {
  hidePanel();
  if (state.sel) {
    state.sel = null;
    render();
  }
}

async function route() {
  const hash = location.hash.replace('#', '') || 'overview';
  const [page, a, b] = hash.split('/');
  state.route = PAGES[page] ? page : 'overview';
  state.sel = null;
  state.filters = {};

  if (page === 'traffic' && a === 'failed') state.filters.status = 'failed';
  else if (page === 'traffic' && a === 'agent') state.filters.agentId = b;
  else if (page === 'traffic' && a) {
    state.sel = a;
    await render();
    return invocationPanel(a);
  }
  if (page === 'agents' && a) {
    state.sel = a;
    await render();
    return agentPanel(a);
  }
  hidePanel();
  return render();
}

function bindEvents() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go],[data-w],[data-action],[data-filter]');
    if (!t) return;
    if (t.dataset.go) {
      location.hash = t.dataset.go;
    } else if (t.dataset.w) {
      state.win = t.dataset.w;
      document.querySelectorAll('#win button').forEach((b) => b.classList.toggle('on', b.dataset.w === state.win));
      render();
    } else if (t.dataset.filter) {
      const [key, value] = t.dataset.filter.split('=');
      state.filters = value ? { ...state.filters, [key]: value } : { ...state.filters, [key]: undefined };
      render();
    } else if (t.dataset.action === 'close-panel') {
      closePanel();
      history.replaceState(null, '', `#${state.route}`);
    } else if (t.dataset.action === 'refresh') {
      render();
    } else if (t.dataset.action === 'signout') {
      signOut();
    } else if (t.dataset.action === 'copy') {
      copyText(t.dataset.value || '');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
    if (e.key === '/' && document.activeElement !== $('#q')) {
      e.preventDefault();
      $('#q')?.focus();
    }
  });

  document.addEventListener('mousemove', (e) => {
    const t = e.target.closest('[data-tip]');
    const tip = $('#tip');
    if (!tip) return;
    if (!t) {
      tip.hidden = true;
      return;
    }
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    tip.style.left = `${e.clientX}px`;
    tip.style.top = `${e.clientY}px`;
  });

  document.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.target !== $('#q')) return;
    const q = e.target.value.trim();
    if (!q) return;
    if (q.startsWith('inv_')) {
      location.hash = `#traffic/${q}`;
      return;
    }
    if (q.startsWith('agt_')) {
      location.hash = `#agents/${q}`;
      return;
    }
    try {
      const { agents = [] } = await api.listAgents({ per_page: 100 });
      const hit = agents.find((a) => a.name.toLowerCase().includes(q.toLowerCase()));
      if (hit) location.hash = `#agents/${hit.id}`;
      else toast(`Nothing matches "${q}"`);
    } catch {
      toast('Search could not reach Gateway.');
    }
  });

  window.addEventListener('hashchange', route);
}

// Identity and capabilities are read once per session, not per page: they
// describe the caller and the deployment, and neither changes while a console
// tab is open. Every page reads them off `state`.
async function loadContext() {
  const [me, caps] = await Promise.allSettled([api.me(), api.getCapabilities()]);
  state.identity = me.status === 'fulfilled' ? me.value : null;
  state.capabilities = caps.status === 'fulfilled' ? caps.value : null;
}

export async function boot({ reason } = {}) {
  const root = document.getElementById('root');
  const user = await currentSession();
  if (!user) {
    renderSignIn(root, { reason });
    return;
  }
  await loadContext();
  root.innerHTML = shell();
  bindEvents();
  await route();
}

if (typeof document !== 'undefined' && document.getElementById('root')) boot();
