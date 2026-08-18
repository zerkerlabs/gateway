import "./styles.css";
import { activity, agents, environments, excludedItems, privacyItems } from "./data.js";
import { filterAgents, formatCount, stateLabel, summarizeAgents } from "./view-model.js";

const main = document.querySelector("#main-content");
const modalRoot = document.querySelector("#modal-root");
const toastRegion = document.querySelector("#toast-region");
const summary = summarizeAgents(agents);
let activeView = "today";
let previousFocus = null;

const agentRows = (items, limit) => items.slice(0, limit ?? items.length).map((agent) => `
  <button class="agent-row" data-agent="${agent.id}" aria-label="View ${agent.name}">
    <span class="agent-avatar">${agent.initials}</span>
    <span class="agent-copy"><strong>${agent.name}</strong><span>${agent.location}</span></span>
    <span class="agent-evidence"><strong>${agent.note}</strong><span>${agent.evidence}</span></span>
    <span class="status-chip ${agent.state}">${stateLabel(agent.state)}</span>
  </button>`).join("");

function pageHeading(eyebrow, title, subtitle, action = true) {
  return `<div class="page-heading">
    <div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="page-subtitle">${subtitle}</p></div>
    ${action ? '<button class="primary-button" data-action="connect"><span class="button-icon">＋</span>Connect agent</button>' : ""}
  </div>`;
}

function todayView() {
  const date = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  return `<section class="page-enter">
    ${pageHeading(date, "Good morning, <strong>Alex.</strong>", "Your agents are calm. One setup needs your attention.")}
    <article class="hero-overview">
      <div class="overview-copy">
        <p class="eyebrow">Your agent team</p>
        <h2>Everything important, <strong>without the noise.</strong></h2>
        <p>See who is working, what needs you, and what Zerker deliberately never collects.</p>
        <button class="secondary-button" data-action="mission">Start a mission <span aria-hidden="true">↗</span></button>
      </div>
      <div class="overview-stats" aria-label="Agent summary">
        <div class="stat-tile"><span class="stat-value">${summary.total}</span><span class="stat-label">Agents</span></div>
        <div class="stat-tile"><span class="stat-value with-dot"><i class="status-pulse"></i>${summary.reporting}</span><span class="stat-label">Reporting now</span></div>
        <div class="stat-tile"><span class="stat-value">60</span><span class="stat-label">Tool calls today</span></div>
        <div class="stat-tile"><span class="stat-value">$8.39</span><span class="stat-label">Reported cost</span></div>
      </div>
    </article>

    <div class="attention-card">
      <span class="attention-icon" aria-hidden="true">◇</span>
      <span class="attention-copy"><strong>Cursor is ready to finish setup</strong><span>It was discovered on Stefan’s Mac mini but has not been enrolled.</span></span>
      <button class="secondary-button" data-agent="cursor">Review setup</button>
    </div>

    <div class="content-grid">
      <section class="panel">
        <div class="panel-header"><h2>Your agents</h2><button class="text-button" data-view="agents">View all →</button></div>
        <div class="agent-list">${agentRows(agents, 5)}</div>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>Now</h2><span class="status-chip reporting">Metadata only</span></div>
        <div class="activity-list">${activity.map((item) => `
          <div class="activity-row">
            <span class="activity-avatar ${item.tone}">${item.initials}</span>
            <span class="activity-copy"><strong>${item.agent} · ${item.event}</strong><span>${item.detail}</span></span>
            <span class="activity-time">${item.time}</span>
          </div>`).join("")}</div>
      </section>
    </div>
  </section>`;
}

function agentsView() {
  return `<section class="page-enter">
    ${pageHeading("Team", "Your <strong>agents</strong>", "Six agents across two environments. Select one for its evidence and privacy boundary.")}
    <div class="toolbar">
      <input class="filter-input" id="agent-filter" type="search" placeholder="Search agents or environments" aria-label="Search agents" />
      <select class="filter-select" id="state-filter" aria-label="Filter by status">
        <option value="all">All states</option><option value="reporting">Reporting</option><option value="quiet">Quiet</option><option value="not_enrolled">Needs setup</option>
      </select>
    </div>
    <div class="full-agent-list" id="full-agent-list">${fullAgentRows(agents)}</div>
  </section>`;
}

function fullAgentRows(items) {
  if (!items.length) return '<div class="empty-state">No agents match that search.</div>';
  return items.map((agent) => `
    <button class="full-agent" data-agent="${agent.id}" aria-label="View ${agent.name}">
      <span class="agent-avatar">${agent.initials}</span>
      <span class="agent-copy"><strong>${agent.name}</strong><span>${agent.location}</span></span>
      <span class="agent-metric"><strong>${agent.sessions}</strong><span>Sessions today</span></span>
      <span class="agent-metric"><strong>${agent.tokens}</strong><span>Tokens today</span></span>
      <span class="status-chip ${agent.state}">${stateLabel(agent.state)}</span>
    </button>`).join("");
}

function attentionView() {
  return `<section class="page-enter">
    ${pageHeading("Focus", "Needs <strong>attention</strong>", "Only decisions that require a person appear here.", false)}
    <article class="panel focus-card">
      <p class="eyebrow">One thing</p>
      <h2>Finish connecting Cursor</h2>
      <p>Zerker found Cursor on Stefan’s Mac mini. It cannot report activity until someone approves observe-only enrollment.</p>
      <div class="task-item">
        <span class="task-number">1</span>
        <span><strong>Review the privacy boundary</strong><p>Metadata only. No prompts, messages, code, commands, or credentials.</p></span>
        <button class="primary-button" data-agent="cursor">Review setup</button>
      </div>
    </article>
  </section>`;
}

function environmentsView() {
  return `<section class="page-enter">
    ${pageHeading("Places", "Your <strong>environments</strong>", "Where agents run. Enrollment is evidence, not a permanent connection.")}
    <div class="environment-grid">
      ${environments.map((environment) => `<article class="panel environment-card">
        <div class="environment-top"><span class="environment-icon" aria-hidden="true">⌘</span><span class="status-chip ${environment.state}">Reporting</span></div>
        <h2>${environment.name}</h2><p>${environment.kind} environment</p>
        <div class="environment-meta"><span>${formatCount(environment.agents, "agent")}</span><span>${environment.evidence}</span></div>
      </article>`).join("")}
      <button class="panel environment-card add-environment" data-action="connect">
        <span><span class="plus" aria-hidden="true">＋</span><strong>Connect another environment</strong><p>Local or remote pairing</p></span>
      </button>
    </div>
  </section>`;
}

function privacyView() {
  return `<section class="page-enter">
    ${pageHeading("Boundaries", "Privacy you can <strong>explain</strong>", "Simple enough to show your team, precise enough to audit.", false)}
    <article class="panel privacy-hero">
      <div><p class="eyebrow">Observe mode</p><h2>Know the work.<br><strong>Not the conversation.</strong></h2><p>Zerker measures bounded operational metadata. Agent content remains where the agent runs.</p></div>
      <div class="shield-art" aria-hidden="true"><div class="shield"></div></div>
    </article>
    <div class="privacy-columns">
      <section class="panel privacy-list"><h3>Collected</h3><ul>${privacyItems.map((item) => `<li>${item}</li>`).join("")}</ul></section>
      <section class="panel privacy-list excluded"><h3>Never collected</h3><ul>${excludedItems.map((item) => `<li>${item}</li>`).join("")}</ul></section>
    </div>
  </section>`;
}

const views = { today: todayView, agents: agentsView, attention: attentionView, environments: environmentsView, privacy: privacyView };

function render(view = activeView) {
  activeView = views[view] ? view : "today";
  main.innerHTML = views[activeView]();
  document.querySelectorAll("[data-view]").forEach((button) => {
    const isActive = button.dataset.view === activeView;
    button.classList.toggle("active", isActive);
    if (button.closest(".side-nav")) isActive ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
  });
  bindPageEvents();
  history.replaceState(null, "", `#${activeView}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindPageEvents() {
  main.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => render(button.dataset.view)));
  main.querySelectorAll("[data-agent]").forEach((button) => button.addEventListener("click", () => openAgent(button.dataset.agent)));
  main.querySelectorAll("[data-action='connect']").forEach((button) => button.addEventListener("click", openConnect));
  main.querySelectorAll("[data-action='mission']").forEach((button) => button.addEventListener("click", openMission));
  const query = main.querySelector("#agent-filter");
  const state = main.querySelector("#state-filter");
  if (query && state) {
    const update = () => { main.querySelector("#full-agent-list").innerHTML = fullAgentRows(filterAgents(agents, query.value, state.value)); bindAgentRows(); };
    query.addEventListener("input", update);
    state.addEventListener("change", update);
  }
}

function bindAgentRows() {
  main.querySelectorAll("#full-agent-list [data-agent]").forEach((button) => button.addEventListener("click", () => openAgent(button.dataset.agent)));
}

function openAgent(id) {
  const agent = agents.find((item) => item.id === id);
  if (!agent) return;
  previousFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="drawer-backdrop" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
    <div class="drawer-head"><div class="drawer-title"><span class="agent-avatar">${agent.initials}</span><div><h2 id="drawer-title">${agent.name}</h2><p>${agent.location}</p></div></div><button class="close-button" data-close aria-label="Close">×</button></div>
    <div class="drawer-status"><span class="status-chip ${agent.state}">${stateLabel(agent.state)}</span><p><strong>${agent.evidence}.</strong> ${agent.note}.</p></div>
    <div class="metric-grid">
      <div class="metric-card"><strong>${agent.sessions}</strong><span>Sessions today</span></div><div class="metric-card"><strong>${agent.toolCalls}</strong><span>Tool calls today</span></div>
      <div class="metric-card"><strong>${agent.tokens}</strong><span>Tokens today</span></div><div class="metric-card"><strong>${agent.cost}</strong><span>Reported cost</span></div>
    </div>
    <section class="drawer-section"><h3>Connection evidence</h3><div class="detail-list">
      <div class="detail-row"><span>Mode</span><strong>${agent.mode} · no blocking</strong></div><div class="detail-row"><span>Environment</span><strong>${agent.location}</strong></div><div class="detail-row"><span>Content access</span><strong>None</strong></div><div class="detail-row"><span>Credential scope</span><strong>${agent.state === "not_enrolled" ? "Not issued" : "Agent events only"}</strong></div>
    </div></section>
    <div class="modal-actions">${agent.state === "not_enrolled" ? '<button class="primary-button" data-action="finish-setup">Finish setup</button>' : '<button class="secondary-button" data-action="mission">Start a mission</button>'}</div>
  </aside>`;
  bindOverlay();
  modalRoot.querySelector(".close-button").focus();
  modalRoot.querySelector("[data-action='finish-setup']")?.addEventListener("click", () => { closeOverlay(); openConnect("cursor"); });
  modalRoot.querySelector("[data-action='mission']")?.addEventListener("click", () => { closeOverlay(); openMission(agent.id); });
}

function openMission(agentId = "pi") {
  previousFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="modal-backdrop" data-close><section class="modal" role="dialog" aria-modal="true" aria-labelledby="mission-title" data-modal-panel>
    <div class="modal-header"><div><p class="eyebrow">Concept preview</p><h2 id="mission-title">Start a mission</h2><p>Assign a bounded objective—not an open-ended chat.</p></div><button class="close-button" data-close aria-label="Close">×</button></div>
    <div class="modal-body">
      <div class="beta-banner"><span aria-hidden="true">◇</span><span><strong>Remote missions are not enabled.</strong><br>This interaction previews the future approval experience. It will not contact an agent.</span></div>
      <div class="form-field"><label for="mission-agent">Agent</label><select id="mission-agent">${agents.filter((agent) => agent.state !== "not_enrolled").map((agent) => `<option value="${agent.id}" ${agent.id === agentId ? "selected" : ""}>${agent.name} · ${agent.location}</option>`).join("")}</select></div>
      <div class="form-field"><label for="mission-objective">Objective</label><textarea id="mission-objective" placeholder="Example: Review the latest release candidate and prepare a risk summary."></textarea><small>The future Gateway will show capabilities and approvals before dispatch.</small></div>
      <div class="form-row"><div class="form-field"><label for="time-limit">Time limit</label><select id="time-limit"><option>30 minutes</option><option>1 hour</option><option>2 hours</option></select></div><div class="form-field"><label for="cost-limit">Cost limit</label><select id="cost-limit"><option>$5 maximum</option><option>$10 maximum</option><option>$25 maximum</option></select></div></div>
      <div class="form-field"><label>Guardrails</label><div class="permission-row"><span><strong>Require approval for writes</strong><span>The agent pauses before changing anything.</span></span><button class="toggle on" role="switch" aria-checked="true" aria-label="Require approval for writes"></button></div></div>
      <div class="modal-actions"><button class="quiet-button" data-close>Cancel</button><button class="primary-button" id="preview-mission" disabled>Preview authorization</button></div>
    </div>
  </section></div>`;
  bindOverlay();
  const objective = modalRoot.querySelector("#mission-objective");
  const submit = modalRoot.querySelector("#preview-mission");
  objective.addEventListener("input", () => { submit.disabled = objective.value.trim().length < 12; });
  submit.addEventListener("click", () => { showToast("Preview only — no agent was contacted."); closeOverlay(); });
  modalRoot.querySelector(".toggle").addEventListener("click", (event) => {
    const button = event.currentTarget;
    const next = button.getAttribute("aria-checked") !== "true";
    button.setAttribute("aria-checked", String(next));
    button.classList.toggle("on", next);
  });
  objective.focus();
}

function openConnect() {
  previousFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="modal-backdrop" data-close><section class="modal" role="dialog" aria-modal="true" aria-labelledby="connect-title" data-modal-panel>
    <div class="modal-header"><div><p class="eyebrow">Add environment</p><h2 id="connect-title">Where does the agent run?</h2><p>Choose the setup that matches your team.</p></div><button class="close-button" data-close aria-label="Close">×</button></div>
    <div class="modal-body">
      <button class="permission-row connect-choice" data-connect-choice="local"><span><strong>This computer</strong><span>Discover supported agents without reading their content.</span></span><span aria-hidden="true">→</span></button>
      <button class="permission-row connect-choice" data-connect-choice="remote"><span><strong>Another computer or server</strong><span>Preview the human-approved remote pairing flow.</span></span><span aria-hidden="true">→</span></button>
      <div class="beta-banner connect-note"><span aria-hidden="true">◒</span><span>Pairing is a planned capability. This static console does not issue credentials or connect environments.</span></div>
    </div>
  </section></div>`;
  bindOverlay();
  modalRoot.querySelector("[data-connect-choice='local']").addEventListener("click", () => { showToast("Preview only — local discovery was not started."); closeOverlay(); });
  modalRoot.querySelector("[data-connect-choice='remote']").addEventListener("click", () => { showToast("Remote pairing is planned, not active."); closeOverlay(); });
  modalRoot.querySelector(".close-button").focus();
}

function openSearch() {
  previousFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="modal-backdrop" data-close><section class="modal command-menu" role="dialog" aria-modal="true" aria-label="Find anything" data-modal-panel>
    <input class="command-input" id="command-input" type="search" placeholder="Find an agent or environment…" aria-label="Search" />
    <div class="command-results" id="command-results">${searchResults("")}</div>
  </section></div>`;
  bindOverlay();
  const input = modalRoot.querySelector("#command-input");
  input.addEventListener("input", () => { modalRoot.querySelector("#command-results").innerHTML = searchResults(input.value); bindSearchResults(); });
  bindSearchResults();
  input.focus();
}

function searchResults(query) {
  return filterAgents(agents, query).slice(0, 6).map((agent) => `<button class="command-result" data-search-agent="${agent.id}"><span class="agent-avatar">${agent.initials}</span><strong>${agent.name}</strong><span>${agent.location}</span></button>`).join("") || '<div class="empty-state">Nothing found.</div>';
}
function bindSearchResults() { modalRoot.querySelectorAll("[data-search-agent]").forEach((button) => button.addEventListener("click", () => { const id = button.dataset.searchAgent; closeOverlay(); openAgent(id); })); }

function bindOverlay() {
  document.body.classList.add("overlay-open");
  modalRoot.querySelectorAll("[data-close]").forEach((element) => element.addEventListener("click", (event) => {
    if (event.target === element || element.matches("button")) closeOverlay();
  }));
  modalRoot.querySelector("[data-modal-panel]")?.addEventListener("click", (event) => event.stopPropagation());
}

function closeOverlay() {
  modalRoot.innerHTML = "";
  document.body.classList.remove("overlay-open");
  previousFocus?.focus?.();
  previousFocus = null;
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3500);
}

document.querySelectorAll(".side-nav [data-view], .mobile-nav [data-view]").forEach((button) => button.addEventListener("click", () => render(button.dataset.view)));
document.querySelector("[data-nav='today']").addEventListener("click", (event) => { event.preventDefault(); render("today"); });
document.querySelector("#open-search").addEventListener("click", openSearch);
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); }
  if (event.key === "Escape" && modalRoot.children.length) closeOverlay();
  if (event.key === "Tab" && modalRoot.children.length) {
    const focusable = [...modalRoot.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href]")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

render(location.hash.slice(1) || "today");
