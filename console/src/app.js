import "./styles.css";
import { activity, agents, attention, catalogSnapshot, credentials, environmentSnapshot, environments, invocations, onboardingEvidence, overviewMetricSources, overviewScenarios, overviewSnapshot, policies, privacy, products, settlements, stack, trafficSnapshot } from "./data.js";
import { buildAgentResults, buildInvocationResults, buildOverviewModel, capabilityCounts, catalogStatusReason, credentialReferenceLabel, defaultAgentFilters, defaultInvocationFilters, deriveCatalogStatus, deriveFailureDiagnosis, deriveInvocationTrace, deriveObserverEvidenceState, filterAgents, formatCount, formatTimestamp, invocationModeLabel, invocationPaymentLabel, invocationRelativeLabel, invocationTimestampLabel, observerEvidenceLabel, pricingLabel, protocolLabel, protocolTransportLabel, rateBoundaryLabel, stateLabel, summarizeAgents } from "./view-model.js";

const main = document.querySelector("#main-content");
const modalRoot = document.querySelector("#modal-root");
const toastRegion = document.querySelector("#toast-region");
const stackSummary = capabilityCounts(stack);
let activeOverviewScenario = "complete";
let invocationFilters = { ...defaultInvocationFilters };
let agentFilters = { ...defaultAgentFilters };
let activeView = "overview";
let previousFocus = null;

const labels = {
  overview: "Overview", attention: "Needs attention", activity: "Agent activity", invocations: "Invocations",
  analytics: "Analytics", agents: "Agent catalog", environments: "Environments", policies: "Policies",
  credentials: "Credentials", products: "Products & portals", payments: "Payments", stack: "Stack & health",
};

function status(value, tone = value.toLowerCase().replaceAll(" ", "_")) {
  return `<span class="status ${tone}"><i></i>${value}</span>`;
}

function pageHeader(kicker, title, description, actions = "") {
  return `<header class="page-heading"><div><p class="kicker">${kicker}</p><h1>${title}</h1><p class="page-description">${description}</p></div><div class="page-actions">${actions}</div></header>`;
}

function fixtureContext(snapshot, label) {
  return `<section class="control-evidence" aria-label="${label} fixture context"><div class="control-preview"><span class="fixture-dot"></span><span><strong>Preview data</strong><small>Not connected to Gateway</small></span></div><div><span>Workspace</span><strong>${snapshot.workspace}</strong></div><div><span>Environment scope</span><strong>${snapshot.environment}</strong></div><div><span>Source</span><strong>${snapshot.source}</strong></div><div><span>Refreshed</span><strong>${formatTimestamp(snapshot.refreshedAt)}</strong></div></section>`;
}

function currentOverviewModel() {
  const scenario = overviewScenarios.find((item) => item.id === activeOverviewScenario) ?? overviewScenarios[0];
  return buildOverviewModel({ agents, invocations, attention, policies, snapshot: overviewSnapshot, sources: overviewMetricSources, scenario });
}

function renderDataState(kind, title, message, compact = false) {
  const role = kind === "error" ? "alert" : "status";
  const busy = kind === "loading" ? ' aria-busy="true"' : "";
  const skeleton = kind === "loading" ? '<div class="state-skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>' : "";
  return `<section class="data-state ${kind}${compact ? " compact" : ""}" role="${role}"${busy}>${status(kind, kind)}<div><h2>${title}</h2><p>${message}</p></div>${skeleton}</section>`;
}

function renderOverviewStateBanner(model) {
  if (model.state.availability === "empty") {
    return `<section class="state-banner empty" role="status">${status("Empty", "empty")}<div><strong>Complete fixture window · no activity</strong><small>Known zeroes are shown below. No agent connectivity claim is made.</small></div></section>`;
  }
  if (model.state.freshness === "stale") {
    return `<section class="state-banner stale" role="status">${status("Stale", "warning")}<div><strong>Showing last-known fixture values</strong><small>${model.runtime.detail}. These values are not current.</small></div></section>`;
  }
  if (model.state.availability === "partial") {
    return `<section class="state-banner partial" role="status">${status("Partial", "warning")}<div><strong>Some fixture sources are unavailable</strong><small>${model.unavailableSourceLabels.join(" · ")}. Affected values are Unknown, not zero.</small></div></section>`;
  }
  return "";
}

function renderOverviewMetrics(model) {
  return `<section class="metric-strip operational-metrics" aria-label="Operational fixture summary">${model.metrics.map((metric) => {
    const freshness = metric.evidence.lastRefresh === "Unavailable"
      ? "Last refresh unavailable"
      : metric.evidence.freshness === "stale" ? `Stale · ${metric.evidence.lastRefresh}` : `Refreshed ${metric.evidence.lastRefresh}`;
    const classes = `${metric.id === "failures" ? "failure-metric " : ""}metric-${metric.valueState}`;
    const content = `<span>${metric.display}</span><small>${metric.label}</small><em>${metric.detail}</em><div class="metric-evidence"><b>${metric.evidence.source}</b><i>${freshness}</i></div>`;
    return metric.actionable ? `<button class="${classes}" data-view="${metric.target}">${content}</button>` : `<div class="${classes}" aria-label="${metric.label}: ${metric.display}">${content}</div>`;
  }).join("")}</section>`;
}

function renderOverviewAttention(model) {
  const attentionMetric = model.metrics.find((metric) => metric.id === "attention");
  const title = model.attentionItems === null ? "Attention source unavailable" : model.attentionItems.length ? `${formatCount(model.attentionItems.length, "item")} require review` : "No items in this window";
  const body = model.attentionItems === null
    ? renderDataState("unavailable", "Attention is Unknown", "The attention fixture is unavailable in this partial scenario.", true)
    : model.attentionItems.length
      ? `<div class="attention-list">${model.attentionItems.map((item) => `<button class="attention-row" data-view="${item.target}"><span class="severity ${item.level}"></span><span><strong>${item.title}</strong><small>${item.detail}</small></span><span>→</span></button>`).join("")}</div>`
      : renderDataState("empty", "No attention items", "The complete fixture window returned no items that need review.", true);
  return `<section class="panel attention-panel"><div class="panel-heading"><div><p class="kicker">Needs attention</p><h2>${title}</h2></div>${model.attentionItems?.length ? '<button class="text-button" data-view="attention">View queue →</button>' : status(attentionMetric.valueState === "zero" ? "Known zero" : "Unknown", attentionMetric.valueState === "zero" ? "empty" : "unavailable")}</div>${body}</section>`;
}

function renderOverviewRuntime(model) {
  return `<section class="panel system-card"><div class="panel-heading"><div><p class="kicker">Runtime evidence</p><h2>Production Gateway</h2></div>${status(model.runtime.label, model.runtime.tone)}</div><dl class="system-facts"><div><dt>Evidence</dt><dd>${model.runtime.detail}</dd></div><div><dt>Version</dt><dd>development</dd></div><div><dt>Storage</dt><dd>Postgres</dd></div><div><dt>Identity</dt><dd>OIDC configured</dd></div><div><dt>Tenancy</dt><dd>Isolated</dd></div></dl><button class="button secondary wide" data-view="stack">Open runtime evidence</button></section>`;
}

function renderOverviewTraffic(model) {
  const body = model.invocationItems?.length
    ? `${invocationTable(model.invocationItems)}<div class="sample-note"><strong>${formatCount(model.latestFailures, "failure")}</strong> in this metadata-only sample. Request and response bodies remain off.</div>`
    : model.invocationItems === null
      ? renderDataState("unavailable", "Invocation evidence is unavailable", "The traffic fixture did not return usable records in this scenario.", true)
      : renderDataState("empty", "No invocations in this window", "The complete traffic fixture returned no invocation records. Request and response bodies remain off.", true);
  const evidence = model.invocationItems?.length ? status(`${model.invocationItems.length} fixture rows`, "review") : status(model.invocationItems === null ? "Unavailable" : "Empty", model.invocationItems === null ? "unavailable" : "empty");
  return `<section class="panel traffic-panel"><div class="panel-heading"><div><p class="kicker">Fixture evidence</p><h2>Latest invocation sample</h2></div><div class="panel-heading-actions">${evidence}${model.invocationItems?.length ? '<button class="text-button" data-view="invocations">Open traffic explorer →</button>' : ""}</div></div>${body}</section>`;
}

function renderOverviewOperations(model) {
  if (model.state.availability === "loading") {
    return renderDataState("loading", "Loading fixture snapshot", "This static preview is demonstrating a pending read. No Gateway request is in progress.");
  }
  if (model.state.availability === "unavailable") {
    return renderDataState("unavailable", "Operational data unavailable", model.publicMessage);
  }
  if (model.state.availability === "error") {
    return renderDataState("error", "Fixture snapshot error", model.publicMessage);
  }
  return `${renderOverviewStateBanner(model)}${renderOverviewMetrics(model)}<div class="overview-grid">${renderOverviewAttention(model)}${renderOverviewRuntime(model)}</div>${renderOverviewTraffic(model)}`;
}

function renderCapabilitySection() {
  return `<section class="capability-section"><div class="section-heading"><div><p class="kicker">Capability map</p><h2>Capability delivery status</h2></div><p>Roadmap context follows operational evidence. Available products and future integrations remain labeled separately.</p></div><div class="capability-grid">
    ${capabilityCard("Discover", "Inventory local agents and runtime environments.", ["Catalog", "Local discovery", "Enrollment evidence"], "agents", [["Available", "available"], ["In review", "review"]])}
    ${capabilityCard("Control", "Apply identity, credentials, rates and policy before traffic moves.", ["OIDC tenancy", "Policy decisions", "Protected credentials"], "policies", [["Available", "available"]])}
    ${capabilityCard("Observe", "Inspect request and agent metadata without guessing what happened.", ["Invocations", "Latency & errors", "Metadata-only activity"], "analytics", [["Available", "available"], ["In review", "review"]])}
    ${capabilityCard("Monetize", "Gate paid routes and settle through a separate facilitator.", ["x402 gate", "USDC on Base", "Settlement records"], "payments", [["Available", "available"]])}
    ${capabilityCard("Verify", "Bind high-risk actions to deterministic evidence and signed records.", ["Reason certificates", "Treeship evidence", "Guard enforcement"], "stack", [["Standalone", "standalone"], ["Integration path", "integration"], ["Planned", "planned"]])}
    ${capabilityCard("Publish & work", "Turn agents into products and dispatch bounded missions.", ["Customer portals", "Plans & docs", "Remote missions"], "products", [["Planned", "planned"]])}
  </div></section>`;
}

function overviewView() {
  const model = currentOverviewModel();
  const attentionAction = model.attentionItems?.length ? '<button class="button secondary" data-view="attention">Open attention queue →</button>' : "";
  return `<section class="page-enter overview-page">
    <header class="page-heading operational-heading"><div><p class="kicker">Operate</p><h1>Overview</h1><p class="page-description">Attention, traffic, policy, cost, and runtime evidence from a fixed sample window.</p></div>${attentionAction}</header>
    <section class="overview-snapshot" aria-label="Preview snapshot context">
      <div class="preview-state"><span class="fixture-dot"></span><span><strong>Preview data</strong><small>Not connected to Gateway</small></span></div>
      <div class="snapshot-fact"><span>Workspace</span><strong>${overviewSnapshot.workspace}</strong></div>
      <button class="snapshot-fact" data-view="environments"><span>Environment</span><strong>${overviewSnapshot.environment}</strong><small>View evidence →</small></button>
      <div class="snapshot-fact"><span>Window</span><strong>${overviewSnapshot.range}</strong></div>
      <div class="snapshot-fact"><span>Fixture captured</span><strong>${model.capturedAt}</strong></div>
      <label class="scenario-control" for="overview-scenario"><span>Preview scenario</span><select id="overview-scenario">${overviewScenarios.map((scenario) => `<option value="${scenario.id}"${scenario.id === model.scenario.id ? " selected" : ""}>${scenario.label}</option>`).join("")}</select><small>In-memory only</small></label>
    </section>
    <div id="overview-state-region" aria-live="polite">${renderOverviewOperations(model)}</div>
    ${renderCapabilitySection()}
  </section>`;
}

function capabilityCard(title, copy, items, target, deliveryStates) {
  return `<button class="capability-card" data-view="${target}"><span class="card-top"><strong>${title}</strong><span class="delivery-badges">${deliveryStates.map(([label, tone]) => status(label, tone)).join("")}</span></span><p>${copy}</p><ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul><span class="card-link">Open surface →</span></button>`;
}

function attentionView() {
  return `<section class="page-enter narrow-page">
    ${pageHeader("Operate", "Needs attention", "Only items that need a human decision appear here.", '<button class="button secondary" data-action="mark-reviewed">Mark reviewed</button>')}
    <div class="attention-queue">${attention.map((item, index) => `<article class="queue-card"><span class="queue-index">0${index + 1}</span><span class="severity ${item.level}"></span><div><p class="kicker">${item.level === "high" ? "Action required" : item.level === "medium" ? "Setup" : "Review"}</p><h2>${item.title}</h2><p>${item.detail}</p><button class="button ${item.level === "high" ? "primary" : "secondary"}" data-view="${item.target}">${item.action} →</button></div></article>`).join("")}</div>
  </section>`;
}

function activityView() {
  return `<section class="page-enter">
    ${pageHeader("Operate · in review", "Agent activity", "Privacy-bounded lifecycle and usage signals from native agent hooks.", '<button class="button secondary" data-action="privacy">Privacy boundary</button><button class="button primary" data-action="connect">＋ Connect observer</button>')}
    <div class="availability-banner review"><div>${status("In review · PR #46", "review")}<h2>Discover → enroll → observe</h2><p>This surface maps the local onboarding branch. It is not on Gateway main yet and does not claim a persistent connection.</p></div><a href="https://github.com/zerkerlabs/gateway/pull/46" target="_blank" rel="noreferrer">Open PR #46 ↗</a></div>
    <section class="metric-strip compact"><div><span>5</span><small>Measured agents</small><em>1 awaiting setup</em></div><div><span>18</span><small>Sessions today</small><em>Across native hooks</em></div><div><span>97</span><small>Tool calls</small><em>92 succeeded</em></div><div><span>592k</span><small>Tokens reported</small><em>Content excluded</em></div></section>
    <div class="two-column">
      <section class="panel"><div class="panel-heading"><div><p class="kicker">Event stream</p><h2>Metadata only</h2></div>${status("Observe · no blocking", "available")}</div><div class="event-list">${activity.map((item) => `<div class="event-row"><span class="event-mark"></span><span><strong>${item.agent} · ${item.event}</strong><small>${item.detail}</small></span><em>${item.time}</em></div>`).join("")}</div></section>
      <section class="panel privacy-card"><p class="kicker">Privacy contract</p><h2>Know the work.<br>Not the conversation.</h2><h3>Collected</h3><p>${privacy.collected.join(" · ")}</p><h3>Never collected</h3><p>${privacy.excluded.join(" · ")}</p><button class="button secondary wide" data-action="privacy">See exact boundary</button></section>
    </div>
  </section>`;
}

function invocationTable(items) {
  const columns = ["Time", "Invocation", "Agent / operation", "Mode", "Policy", "Result", "Latency", "Payment", ""];
  return `<div class="invocation-list" role="table" aria-label="Fixture invocations"><div class="invocation-row invocation-head" role="row">${columns.map((column) => `<span role="columnheader">${column}</span>`).join("")}</div>${items.map((item) => `<div class="invocation-row ${item.result}" role="row"><span class="invocation-time" role="cell" data-label="Time"><strong>${invocationTimestampLabel(item.occurredAt)}</strong><small>${invocationRelativeLabel(item.occurredAt, trafficSnapshot.evaluatedAt)}</small></span><span class="mono" role="cell" data-label="Invocation">${item.id}</span><span role="cell" data-label="Agent / operation"><strong>${item.agent}</strong><small>${item.method}</small></span><span role="cell" data-label="Mode">${invocationModeLabel(item.mode)}</span><span role="cell" data-label="Policy">${status(item.policy, item.policy)}</span><span role="cell" data-label="Result">${status(item.result, item.result)}</span><span role="cell" data-label="Latency">${item.latency}</span><span class="payment-state ${item.paymentState}" role="cell" data-label="Payment">${invocationPaymentLabel(item)}</span><span role="cell"><button class="inspect-button" data-invocation="${item.id}" aria-label="Inspect invocation ${item.id}">Inspect →</button></span></div>`).join("")}</div>`;
}

function trafficRangeLabel(value) {
  return { "5m": "Last 5 minutes", "1h": "Last hour", "24h": "Last 24 hours" }[value] ?? "Last 24 hours";
}

function captureBoundary(compact = false) {
  return `<section class="capture-boundary${compact ? " compact" : ""}" aria-labelledby="${compact ? "drawer-capture-title" : "capture-title"}"><div><p class="kicker">Capture boundary</p><h2 id="${compact ? "drawer-capture-title" : "capture-title"}">Metadata visible. Bodies off.</h2></div><div class="capture-facts"><span><b>Proxy invocations</b>Metadata only</span><span><b>Request / response bodies</b>Off in this fixture · separate Gateway feature</span><span><b>Body reads</b>Require separate authorization</span><span><b>Native agent activity</b>Separate contract · never prompts, messages, arguments, outputs, commands, paths, files, environment values, or credentials</span></div></section>`;
}

function invocationResultsMarkup(result) {
  if (!result.rows.length) {
    return `<div class="traffic-empty"><p class="kicker">Filtered fixture</p><h2>No fixture invocations match</h2><p>Adjust the in-memory filters. This does not mean the Gateway has no tenant traffic or is disconnected.</p><button class="button secondary" id="empty-clear-invocation-filters">Clear filters</button></div>`;
  }
  return invocationTable(result.rows);
}

function invocationsView() {
  const result = buildInvocationResults(invocations, invocationFilters, trafficSnapshot.evaluatedAt);
  const agentsInFixture = agents.map((agent) => agent.name).toSorted();
  return `<section class="page-enter traffic-page">
    ${pageHeader("Traffic · available OSS", "Invocations", "Filter tenant-scoped fixture metadata and inspect the exact request path.", '<button class="button secondary" data-action="export">Export view</button>')}
    <section class="traffic-evidence" aria-label="Traffic fixture context"><div class="traffic-preview"><span class="fixture-dot"></span><span><strong>Preview data</strong><small>Not connected to Gateway</small></span></div><div><span>Workspace</span><strong>${trafficSnapshot.workspace}</strong></div><div><span>Environment</span><strong>${trafficSnapshot.environment}</strong></div><div><span>Source</span><strong>${trafficSnapshot.source}</strong></div><div><span>Refreshed</span><strong>${formatTimestamp(trafficSnapshot.refreshedAt)}</strong></div><div><span>Window</span><strong id="traffic-window-label">${trafficRangeLabel(invocationFilters.timeRange)}</strong></div></section>
    <section class="traffic-filters" aria-label="Filter fixture invocations">
      <label class="traffic-search"><span>Search</span><input id="invocation-search" data-invocation-filter="query" type="search" placeholder="ID, agent, or operation" autocomplete="off"></label>
      <label><span>Result</span><select id="invocation-result" data-invocation-filter="result"><option value="all">All</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option></select></label>
      <label><span>Mode</span><select id="invocation-mode" data-invocation-filter="mode"><option value="all">All</option><option value="transaction">Transactional</option><option value="stream">Streaming</option></select></label>
      <label><span>Agent</span><select id="invocation-agent" data-invocation-filter="agent"><option value="all">All</option>${agentsInFixture.map((agent) => `<option value="${agent}">${agent}</option>`).join("")}</select></label>
      <label><span>Policy</span><select id="invocation-policy" data-invocation-filter="policy"><option value="all">All</option><option value="allow">Allow</option><option value="warn">Warn</option><option value="deny">Deny</option></select></label>
      <label><span>Payment</span><select id="invocation-payment" data-invocation-filter="payment"><option value="all">All</option><option value="not_required">Not required</option><option value="verified">Verified</option></select></label>
      <label><span>Time range</span><select id="invocation-time-range" data-invocation-filter="timeRange"><option value="5m">Last 5 minutes</option><option value="1h">Last hour</option><option value="24h">Last 24 hours</option></select></label>
      <button class="button secondary clear-filters" id="clear-invocation-filters">Clear filters</button>
    </section>
    <div class="traffic-results-heading"><p id="invocation-result-count" aria-live="polite"><strong>${result.summary}</strong><small>${result.activeFilters.length ? `${formatCount(result.activeFilters.length, "active filter")}` : "Default fixture view"}</small></p><span>Newest first · fixed fixture clock</span></div>
    <section class="panel traffic-results" id="invocation-results">${invocationResultsMarkup(result)}</section>
    ${captureBoundary()}
  </section>`;
}

function analyticsView() {
  const rows = [{ name: "Support agent", calls: "486", success: "99.2%", latency: "1.4s", width: "w-92" }, { name: "Docs search", calls: "301", success: "99.7%", latency: "720ms", width: "w-68" }, { name: "Research agent", calls: "214", success: "98.1%", latency: "2.8s", width: "w-52" }, { name: "Release reviewer", calls: "173", success: "100%", latency: "3.1s", width: "w-44" }, { name: "Code generator", calls: "82", success: "91.4%", latency: "8.6s", width: "w-24" }];
  return `<section class="page-enter">
    ${pageHeader("Traffic · available OSS", "Analytics", "Latency, error and volume summaries over bounded time windows.", '<button class="button secondary">Last 24 hours⌄</button>')}
    <section class="metric-strip"><div><span>1,256</span><small>Total calls</small><em>+12.4% vs prior day</em></div><div><span>1.3%</span><small>Error rate</small><em>16 failed calls</em></div><div><span>1.8s</span><small>p95 latency</small><em>p50 620ms</em></div><div><span>720ms</span><small>p95 TTFT</small><em>Streaming only</em></div><div><span>58 MB</span><small>Data moved</small><em>Metadata aggregate</em></div></section>
    <div class="analytics-grid"><section class="panel chart-panel"><div class="panel-heading"><div><p class="kicker">Volume</p><h2>Calls by agent</h2></div><span class="mono muted">GET /v1/analytics</span></div><div class="bar-chart">${rows.map((row) => `<div class="bar-row"><span>${row.name}</span><div><i class="${row.width}"></i></div><strong>${row.calls}</strong></div>`).join("")}</div></section><section class="panel"><div class="panel-heading"><div><p class="kicker">Quality</p><h2>Service levels</h2></div></div><div class="quality-list">${rows.map((row) => `<div><span><strong>${row.name}</strong><small>${row.calls} calls</small></span><span><strong>${row.success}</strong><small>Success</small></span><span><strong>${row.latency}</strong><small>p95</small></span></div>`).join("")}</div></section></div>
    <div class="availability-note">Analytics requires an explicit <code>since</code> value, caps windows at 31 days, and excludes in-flight calls from latency percentiles.</div>
  </section>`;
}

function onboardingForAgent(agentID) {
  return onboardingEvidence.find((item) => item.agentID === agentID) ?? null;
}

function invocationEvidenceLabel(agent) {
  if (!Number.isFinite(agent.calls)) return "Unknown invocation count";
  if (agent.calls === 0) return "0 calls · complete fixture window";
  const latest = agent.latestInvocationAt ? ` · latest ${formatTimestamp(agent.latestInvocationAt)}` : " · latest time Unknown";
  return `${agent.calls.toLocaleString("en-US")} calls${latest}`;
}

function agentRows(items) {
  if (!items.length) {
    return `<div class="catalog-empty"><p class="kicker">Filtered fixture</p><h2>No fixture catalog agents match</h2><p>Adjust the in-memory filters. This does not mean the tenant catalog is empty or Gateway is unavailable.</p><button class="button secondary" id="empty-clear-agent-filters">Clear filters</button></div>`;
  }
  return items.map((agent) => {
    const catalogStatus = deriveCatalogStatus(agent);
    const observer = onboardingForAgent(agent.id);
    const observerMarkup = observer
      ? `<span class="agent-evidence review-evidence"><b>In review · PR #46</b><small>${observerEvidenceLabel(observer, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs)}</small></span>`
      : '<span class="agent-evidence"><b>Native observer</b><small>Unavailable in this fixture</small></span>';
    return `<article class="catalog-row${agent.suspended ? " is-suspended" : ""}">
      <span class="agent-identity" data-label="Catalog agent"><span class="agent-symbol">${agent.runtime === "Pi" ? "π" : agent.runtime.slice(0, 2).toUpperCase()}</span><span><strong>${agent.name}</strong><small class="mono">${agent.id}</small></span></span>
      <span data-label="Catalog status">${status(stateLabel(catalogStatus), catalogStatus)}<small>${catalogStatusReason(agent)}</small></span>
      <span data-label="Suspension">${agent.suspended ? status("Suspended", "suspended") : '<strong>Not suspended</strong>'}<small>${agent.suspended ? "Invocations blocked" : "Separate from catalog status"}</small></span>
      <span data-label="Protocol"><strong>${protocolLabel(agent.protocol)}</strong><small>${protocolTransportLabel(agent)}</small></span>
      <span data-label="Rate boundary"><strong>${rateBoundaryLabel(agent)}</strong><small>Per agent</small></span>
      <span data-label="Credential reference"><strong>${credentialReferenceLabel(agent)}</strong><small>Metadata only</small></span>
      <span data-label="Pricing"><strong>${pricingLabel(agent)}</strong><small>${agent.pricing ? "Gate configuration" : "No payment gate"}</small></span>
      <span class="catalog-evidence" data-label="Evidence"><span class="agent-evidence"><b>Available · invocation fixture</b><small>${invocationEvidenceLabel(agent)}</small></span>${observerMarkup}</span>
      <span class="catalog-inspect"><button class="inspect-button" data-agent="${agent.id}" aria-label="Inspect catalog agent ${agent.name}">Inspect →</button></span>
    </article>`;
  }).join("");
}

function agentsView() {
  const summary = summarizeAgents(agents);
  const result = buildAgentResults(agents, agentFilters);
  return `<section class="page-enter catalog-page">
    ${pageHeader("Control · available OSS", "Agent catalog", "Tenant-scoped routing configuration, independent suspension, and fixed evidence for HTTP agents and MCP servers.", '<button class="button primary" data-action="add-agent">＋ Register agent</button>')}
    ${fixtureContext(catalogSnapshot, "Agent catalog")}
    <section class="metric-strip catalog-metrics"><div><span>${summary.total}</span><small>Catalog records</small><em>Tenant-scoped fixture</em></div><div><span>${summary.active}</span><small>Active</small><em>Upstream configured</em></div><div><span>${summary.pending}</span><small>Pending</small><em>No upstream configured</em></div><div><span>${summary.inactive}</span><small>Inactive</small><em>Soft-deleted audit record</em></div><div><span>${summary.suspended}</span><small>Suspended</small><em>Counted separately · blocked</em></div></section>
    <section class="catalog-filters" aria-label="Filter fixture catalog agents">
      <label class="catalog-search"><span>Search</span><input id="agent-filter" data-agent-filter="query" type="search" placeholder="ID, name, runtime, or protocol" autocomplete="off"></label>
      <label><span>Catalog status</span><select id="agent-status" data-agent-filter="status"><option value="all">All</option><option value="active">Active</option><option value="pending">Pending</option><option value="inactive">Inactive</option></select></label>
      <label><span>Protocol</span><select id="agent-protocol" data-agent-filter="protocol"><option value="all">All</option><option value="http">HTTP</option><option value="mcp">MCP</option></select></label>
      <label><span>Suspension</span><select id="agent-suspension" data-agent-filter="suspension"><option value="all">All</option><option value="suspended">Suspended</option><option value="not_suspended">Not suspended</option></select></label>
      <button class="button secondary clear-agent-filters" id="clear-agent-filters">Clear filters</button>
    </section>
    <div class="catalog-results-heading"><p id="agent-result-count" aria-live="polite"><strong>${result.summary}</strong><small>${result.activeFilters.length ? formatCount(result.activeFilters.length, "active filter") : "Default fixture view"}</small></p><span>Catalog status ≠ suspension ≠ activity evidence</span></div>
    <div class="catalog-columns" aria-hidden="true"><span>Catalog agent</span><span>Catalog status</span><span>Suspension</span><span>Protocol</span><span>Rate boundary</span><span>Credential reference</span><span>Pricing</span><span>Evidence</span><span>Action</span></div>
    <section class="catalog-list" id="catalog-list" aria-label="Fixture catalog agents">${agentRows(result.rows)}</section>
  </section>`;
}

function environmentEvidenceState(environment) {
  if (environment.delivery === "available") return environment.healthState ?? "unknown";
  return deriveObserverEvidenceState({ enrollmentState: environment.enrollmentState, lastEventAt: environment.lastEvidenceAt }, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs);
}

function environmentCard(environment) {
  const evidenceState = environmentEvidenceState(environment);
  const gateway = environment.delivery === "available";
  const evidenceCopy = gateway
    ? `Probe captured ${formatTimestamp(environment.probeAt)} · evidence only`
    : observerEvidenceLabel({ enrollmentState: environment.enrollmentState, lastEventAt: environment.lastEvidenceAt }, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs);
  const facts = gateway
    ? [["Catalog", environment.catalogAgents], ["Pending", environment.pendingAgents], ["Suspended", environment.suspendedAgents]]
    : [["Observed", environment.observed], ["Enrolled", environment.enrolled], ["Discovered", environment.discovered]];
  return `<article class="environment-card"><div class="environment-top"><span class="environment-icon">${gateway ? "G" : "⌘"}</span><span class="environment-badges">${status(gateway ? "Available OSS · fixture" : "In review · PR #46", gateway ? "available" : "review")}${status(stateLabel(evidenceState), evidenceState)}</span></div><p class="kicker">${environment.kind}</p><h2>${environment.name}</h2><p>${evidenceCopy}. This is not persistent connectivity.</p><dl>${facts.map(([key, value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`).join("")}</dl><button class="inspect-button" data-environment="${environment.id}" aria-label="Inspect environment evidence for ${environment.name}">Inspect evidence →</button></article>`;
}

function onboardingRows() {
  return onboardingEvidence.map((item) => {
    const evidenceState = deriveObserverEvidenceState(item, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs);
    return `<article class="onboarding-row"><span><strong>${item.name}</strong><small>${item.runtime} · ${item.environment}</small></span>${status(stateLabel(evidenceState), evidenceState)}<span><strong>${observerEvidenceLabel(item, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs)}</strong><small>Evidence only · not a persistent connection</small></span><button class="inspect-button" data-onboarding="${item.id}" aria-label="Inspect onboarding evidence for ${item.name}">Inspect →</button></article>`;
  }).join("");
}

function environmentsView() {
  const gatewayEnvironments = environments.filter((environment) => environment.delivery === "available");
  const observerEnvironments = environments.filter((environment) => environment.delivery === "review");
  return `<section class="page-enter environments-page">
    ${pageHeader("Control", "Environments", "Captured Gateway probes and in-review observer evidence, separated by delivery truth.", '<button class="button secondary" data-action="connect">Review environment concept</button>')}
    ${fixtureContext(environmentSnapshot, "Environment")}
    <section class="environment-group"><div class="environment-group-heading"><div><p class="kicker">Available OSS · fixture</p><h2>Gateway runtime evidence</h2></div><p>A captured health probe describes only that fixed point in time.</p></div><div class="environment-list gateway-environments">${gatewayEnvironments.map(environmentCard).join("")}</div></section>
    <section class="environment-group"><div class="environment-group-heading"><div><p class="kicker">In review · PR #46</p><h2>Local observer evidence</h2></div><p>Discovery, enrollment, reporting, and quiet are evidence states—not connection states.</p></div><div class="environment-list">${observerEnvironments.map(environmentCard).join("")}</div></section>
    <section class="panel onboarding-panel"><div class="panel-heading"><div><p class="kicker">In review · PR #46</p><h2>Onboarding evidence</h2></div>${status("Metadata only", "review")}</div><div class="onboarding-list">${onboardingRows()}</div></section>
    <section class="planned-environment"><div><p class="kicker">Planned</p><h2>Remote pairing and missions</h2><p>Remote operation remains separate from observe-only evidence and is not available in this fixture.</p></div>${status("Planned", "planned")}</section>
    <section class="environment-privacy"><div><p class="kicker">Native activity privacy</p><h2>Evidence without conversation content</h2></div><p>Observer summaries never include prompts, messages, arguments, outputs, commands, paths, files, environment values, or credentials. No pairing token or credential is accepted here.</p></section>
  </section>`;
}

function policiesView() {
  return `<section class="page-enter">
    ${pageHeader("Control · available OSS", "Policies", "Evaluate identity, agent, MCP tool, body size and caller rate before payment or proxying.", '<button class="button secondary" data-action="simulate">Simulate request</button><button class="button primary" data-action="edit-policy">Edit policy</button>')}
    <div class="policy-posture"><div><p class="kicker">No rule matched</p><strong>${policies.default}</strong><small>Default action</small></div><div><p class="kicker">Evaluation failed</p><strong>${policies.onError}</strong><small>Failure posture</small></div><div><p class="kicker">Order</p><strong>Policy first</strong><small>Before payment and proxy</small></div></div>
    <div class="two-column policy-layout"><section class="panel"><div class="panel-heading"><div><p class="kicker">Rules</p><h2>Policy document</h2></div><span class="mono muted">PUT /v1/policy</span></div><div class="rule-list">${policies.rules.map((rule, index) => `<button data-rule="${index}"><span class="rule-order">${index + 1}</span><span><strong>${rule.name}</strong><small>${rule.match} · ${rule.scope}</small></span>${status(rule.action, rule.action)}<span><strong>${rule.decisions}</strong><small>Decisions</small></span><span>→</span></button>`).join("")}</div></section><section class="panel"><div class="panel-heading"><div><p class="kicker">Audit</p><h2>Recent decisions</h2></div></div><div class="decision-list">${policies.decisions.map((decision) => `<div><span>${status(decision.action, decision.action)}</span><span><strong>${decision.agent} · ${decision.tool}</strong><small>${decision.rule} · ${decision.reason}</small></span><em>${decision.time}</em></div>`).join("")}</div><button class="text-button panel-link">Open all decisions →</button></section></div>
  </section>`;
}

function credentialsView() {
  return `<section class="page-enter">
    ${pageHeader("Control · available OSS", "Credentials", "Managed secrets and vault references are injected only after policy allows a call.", '<button class="button primary" data-action="add-credential">＋ Store credential</button>')}
    <div class="security-rule"><span>⌑</span><div><strong>Secrets never leave Gateway.</strong><p>Reads return metadata and a masked hint only. Caller OAuth tokens are stripped before proxying.</p></div>${status("Tenant isolated", "available")}</div>
    <section class="panel"><div class="credential-table"><div class="credential-row table-head"><span>Name</span><span>Source</span><span>Masked reference</span><span>Version</span><span>Used by</span><span>Last rotated</span><span></span></div>${credentials.map((credential) => `<button class="credential-row" data-credential="${credential.name}"><span><strong>${credential.name}</strong><small>${credential.type}</small></span><span>${status(credential.source, credential.source.toLowerCase())}</span><span class="mono">${credential.hint}</span><span>v${credential.version}</span><span>${credential.usedBy}</span><span>${credential.rotated}</span><span>→</span></button>`).join("")}</div></section>
    <div class="footnote"><span>Delete is blocked while referenced.</span><span>Managed values are envelope-encrypted.</span><span>Vault references remain external.</span></div>
  </section>`;
}

function productsView() {
  return `<section class="page-enter">
    ${pageHeader("Revenue · product direction", "Products & portals", "Package an agent with access, documentation, usage and payment under your own domain.", '<button class="button primary" data-action="new-product">＋ New product concept</button>')}
    <div class="availability-banner planned"><div>${status("Planned", "planned")}<h2>Not part of the current Gateway release.</h2><p>This preview shows the intended admin model without claiming that customer portals, plans or hosted billing are operational.</p></div><button class="button secondary" data-view="stack">See delivery status</button></div>
    <div class="product-grid">${products.map((product) => `<article class="product-card"><div class="product-preview"><span class="mini-brand">Z</span><span class="mini-url">${product.domain}</span><strong>${product.name}</strong><small>Powered by ${product.agent}</small></div><div class="product-copy"><span>${status(product.status, "planned")}</span><h2>${product.name}</h2><dl><div><dt>Agent</dt><dd>${product.agent}</dd></div><div><dt>Access</dt><dd>${product.access}</dd></div><div><dt>Price</dt><dd>${product.price}</dd></div></dl><button class="button secondary wide" data-action="product-preview">Open product concept</button></div></article>`).join("")}</div>
    <section class="capability-checklist"><div><strong>Product manifest</strong><small>Machine-readable capabilities and terms</small>${status("Direction", "planned")}</div><div><strong>Customer access</strong><small>OIDC, plans, quotas and documentation</small>${status("Planned", "planned")}</div><div><strong>Usage & billing</strong><small>Metering, invoices and spend limits</small>${status("Commercial concept", "planned")}</div></section>
  </section>`;
}

function paymentsView() {
  return `<section class="page-enter">
    ${pageHeader("Revenue", "Payments", "Verify payment before forwarding, then settle through an independently verifying facilitator.", '<button class="button secondary" data-action="settlement-config">Settlement config</button>')}
    <section class="payment-flow"><div><p class="kicker">Optional gate</p><strong>Identity + policy</strong><small>Denied requests never receive a payment challenge.</small></div><i>→</i><div><p class="kicker">Available OSS</p><strong>x402 verification</strong><small>Signed USDC authorization on Base.</small></div><i>→</i><div><p class="kicker">Separate deployable</p><strong>Facilitator</strong><small>Re-verifies, submits and records settlement.</small></div></section>
    <section class="metric-strip compact"><div><span>$12.40</span><small>Volume today</small><em>48 settlements</em></div><div><span>$0.25</span><small>Top route price</small><em>research.report</em></div><div><span>97.9%</span><small>Settlement success</small><em>1 failed</em></div><div><span>Base</span><small>Network</small><em>USDC · exact scheme</em></div></section>
    <div class="two-column"><section class="panel"><div class="panel-heading"><div><p class="kicker">Ledger</p><h2>Recent settlements</h2></div>${status("Facilitator configured", "available")}</div><div class="settlement-list">${settlements.map((item) => `<div><span class="mono">${item.id}</span><span><strong>${item.product}</strong><small>${item.payer}</small></span><span><strong>${item.amount}</strong><small>${item.rail}</small></span>${status(item.status, item.status)}<em>${item.time}</em></div>`).join("")}</div></section><section class="panel rail-card"><p class="kicker">Payment rails</p><h2>x402 is an adapter.<br>Not the product identity.</h2><div class="rail-list"><div><strong>USDC · Base</strong>${status("Available", "available")}</div><div><strong>Prepaid credits</strong>${status("Planned", "planned")}</div><div><strong>Invoice balance</strong>${status("Planned", "planned")}</div><div><strong>Card-backed billing</strong>${status("Planned", "planned")}</div><div><strong>Custom rail</strong>${status("Direction", "planned")}</div></div></section></div>
  </section>`;
}

function stackView() {
  return `<section class="page-enter">
    ${pageHeader("System", "Stack & health", "What is available, what works independently, and what remains an integration path.", '<a class="button secondary" href="https://docs.zerker.ai" target="_blank" rel="noreferrer">Open documentation ↗</a>')}
    <section class="runtime-strip"><div><span class="fixture-health-dot"></span><span><strong>Gateway API healthy · fixture</strong><small>Probe captured 12s before fixed snapshot</small></span></div><div><strong>Postgres</strong><small>Persistent storage</small></div><div><strong>OIDC</strong><small>Issuer configured</small></div><div><strong>23 operations</strong><small>Gateway REST API</small></div><div><strong>${stackSummary.total} components</strong><small>Across Zerker</small></div></section>
    <div class="stack-list">${stack.map((component, index) => `<article><span class="stack-number">${String(index + 1).padStart(2, "0")}</span><span><strong>${component.name}</strong><small>${component.job}</small></span>${status(component.status, component.tone)}<button data-stack="${component.name}">Details →</button></article>`).join("")}</div>
    <section class="api-surface"><div><p class="kicker">Gateway API surface</p><h2>What the admin will eventually operate live.</h2></div><div class="api-groups"><span><b>Catalog</b>5 agent operations</span><span><b>Credentials</b>5 protected-secret operations</span><span><b>Proxy</b>transactional + streaming + poll</span><span><b>Observe</b>invocations + analytics</span><span><b>Govern</b>policy + decisions</span><span><b>Revenue</b>payment gate + settlement config</span></div></section>
    <section class="deployment-surface"><div><p class="kicker">Deployment posture</p><h2>Self-hosted control without inventing a hosted fleet.</h2></div><div class="deployment-grid"><span><b>Identity</b>OIDC required at startup</span><span><b>Storage</b>Memory for dev · Postgres for persistence</span><span><b>Secrets</b>Managed encryption or external vault reference</span><span><b>Network</b>TLS externally · SSRF checked at write and dial</span><span><b>Capacity</b>Per-caller and per-agent rate boundaries</span><span><b>Operations</b><code>/healthz</code> and <code>/version</code></span></div></section>
  </section>`;
}

const views = { overview: overviewView, attention: attentionView, activity: activityView, invocations: invocationsView, analytics: analyticsView, agents: agentsView, environments: environmentsView, policies: policiesView, credentials: credentialsView, products: productsView, payments: paymentsView, stack: stackView };

function syncAttentionNavigation() {
  const button = document.querySelector(".side-nav [data-view='attention']");
  const badge = button?.querySelector(".nav-badge");
  if (!button || !badge) return;
  if (activeView !== "overview") {
    badge.textContent = String(attention.length);
    button.removeAttribute("aria-label");
    return;
  }
  const metric = currentOverviewModel().metrics.find((item) => item.id === "attention");
  const value = metric.valueState === "available" || metric.valueState === "zero" ? metric.display : "?";
  badge.textContent = value;
  button.setAttribute("aria-label", `Needs attention: ${value === "?" ? "Unknown" : value} in selected preview scenario`);
}

function render(view = activeView) {
  activeView = views[view] ? view : "overview";
  main.innerHTML = views[activeView]();
  document.title = `${labels[activeView]} — Zerker Gateway preview`;
  syncAttentionNavigation();
  document.querySelectorAll("[data-view]").forEach((button) => {
    const selected = button.dataset.view === activeView;
    button.classList.toggle("active", selected);
    selected ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
  });
  bindPageEvents();
  history.replaceState(null, "", `#${activeView}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindInvocationButtons(scope = main) {
  scope.querySelectorAll("[data-invocation]").forEach((button) => button.addEventListener("click", () => openInvocation(button.dataset.invocation)));
}

function refreshInvocationResults() {
  const container = main.querySelector("#invocation-results");
  const count = main.querySelector("#invocation-result-count");
  if (!container || !count) return;
  const result = buildInvocationResults(invocations, invocationFilters, trafficSnapshot.evaluatedAt);
  container.innerHTML = invocationResultsMarkup(result);
  count.innerHTML = `<strong>${result.summary}</strong><small>${result.activeFilters.length ? formatCount(result.activeFilters.length, "active filter") : "Default fixture view"}</small>`;
  const windowLabel = main.querySelector("#traffic-window-label");
  if (windowLabel) windowLabel.textContent = trafficRangeLabel(invocationFilters.timeRange);
  bindInvocationButtons(container);
  container.querySelector("#empty-clear-invocation-filters")?.addEventListener("click", () => clearInvocationFilterState(true));
}

function clearInvocationFilterState(focusSearch = false) {
  invocationFilters = { ...defaultInvocationFilters };
  main.querySelectorAll("[data-invocation-filter]").forEach((control) => { control.value = invocationFilters[control.dataset.invocationFilter]; });
  refreshInvocationResults();
  (focusSearch ? main.querySelector("#invocation-search") : main.querySelector("#clear-invocation-filters"))?.focus();
}

function bindInvocationFilters() {
  const controls = main.querySelectorAll("[data-invocation-filter]");
  if (!controls.length) return;
  controls.forEach((control) => {
    control.value = invocationFilters[control.dataset.invocationFilter];
    control.addEventListener(control.matches("input") ? "input" : "change", () => {
      invocationFilters = { ...invocationFilters, [control.dataset.invocationFilter]: control.value };
      refreshInvocationResults();
    });
  });
  main.querySelector("#clear-invocation-filters")?.addEventListener("click", () => clearInvocationFilterState());
}

function bindAgentInspectButtons(scope = main) {
  scope.querySelectorAll("[data-agent]").forEach((button) => button.addEventListener("click", () => openAgent(button.dataset.agent)));
}

function refreshAgentResults() {
  const container = main.querySelector("#catalog-list");
  const count = main.querySelector("#agent-result-count");
  if (!container || !count) return;
  const result = buildAgentResults(agents, agentFilters);
  container.innerHTML = agentRows(result.rows);
  count.innerHTML = `<strong>${result.summary}</strong><small>${result.activeFilters.length ? formatCount(result.activeFilters.length, "active filter") : "Default fixture view"}</small>`;
  bindAgentInspectButtons(container);
  container.querySelector("#empty-clear-agent-filters")?.addEventListener("click", () => clearAgentFilterState(true));
}

function clearAgentFilterState(focusSearch = false) {
  agentFilters = { ...defaultAgentFilters };
  main.querySelectorAll("[data-agent-filter]").forEach((control) => { control.value = agentFilters[control.dataset.agentFilter]; });
  refreshAgentResults();
  (focusSearch ? main.querySelector("#agent-filter") : main.querySelector("#clear-agent-filters"))?.focus();
}

function bindAgentFilters() {
  const controls = main.querySelectorAll("[data-agent-filter]");
  if (!controls.length) return;
  controls.forEach((control) => {
    control.value = agentFilters[control.dataset.agentFilter];
    control.addEventListener(control.matches("input") ? "input" : "change", () => {
      agentFilters = { ...agentFilters, [control.dataset.agentFilter]: control.value };
      refreshAgentResults();
    });
  });
  main.querySelector("#clear-agent-filters")?.addEventListener("click", () => clearAgentFilterState());
}

function bindPageEvents() {
  main.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => render(button.dataset.view)));
  bindAgentInspectButtons();
  bindInvocationButtons();
  main.querySelectorAll("[data-environment]").forEach((button) => button.addEventListener("click", () => openEnvironment(button.dataset.environment)));
  main.querySelectorAll("[data-onboarding]").forEach((button) => button.addEventListener("click", () => openOnboardingEvidence(button.dataset.onboarding)));
  main.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => handleAction(button.dataset.action)));
  main.querySelectorAll("[data-stack]").forEach((button) => button.addEventListener("click", () => openStackInfo(button.dataset.stack)));
  const scenario = main.querySelector("#overview-scenario");
  if (scenario) scenario.addEventListener("change", () => { activeOverviewScenario = scenario.value; render("overview"); main.querySelector("#overview-scenario")?.focus(); });
  bindInvocationFilters();
  bindAgentFilters();
}

function handleAction(action) {
  const concepts = new Set(["add-agent", "connect", "add-credential", "new-product", "product-preview", "settlement-config", "edit-policy", "simulate"]);
  if (action === "privacy") return openPrivacy();
  if (concepts.has(action)) return openConcept(action);
  if (action === "export") return showToast("Preview only — no invocation data was exported.");
  if (action === "mark-reviewed") return showToast("Preview only — the attention queue was not changed.");
}

function openAgent(id) {
  const agent = agents.find((item) => item.id === id); if (!agent) return;
  const catalogStatus = deriveCatalogStatus(agent);
  const observer = onboardingForAgent(agent.id);
  const observerMarkup = observer
    ? `<div class="drawer-evidence review-evidence">${status("In review · PR #46", "review")}<strong>${observerEvidenceLabel(observer, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs)}</strong><small>Native observer metadata · evidence only, not persistent connectivity</small></div>`
    : `<div class="drawer-evidence">${status("Unavailable", "unavailable")}<strong>Native observer evidence unavailable</strong><small>Unavailable is not zero and does not imply disconnection.</small></div>`;
  const mcpReliability = agent.protocol === "mcp"
    ? "Known-idempotent MCP methods may be retried. tools/call is never automatically retried."
    : "Transient upstream failures may be retried; circuit breaking protects a consistently failing upstream.";
  const pricingRows = agent.pricing
    ? [["Gate configuration", pricingLabel(agent)], ["Scheme / asset / network", "exact · USDC · Base"], ["Scope", agent.pricing.tool ? `Per-tool · ${agent.pricing.tool}` : "Per call"]]
    : [["Gate configuration", pricingLabel(agent)], ["Payment requirement", "None"]];
  openDrawer(
    agent.name,
    `${agent.runtime} · tenant catalog fixture`,
    `<div class="drawer-statuses">${status(stateLabel(catalogStatus), catalogStatus)}${agent.suspended ? status("Suspended · invocations blocked", "suspended") : status("Not suspended", "empty")}</div>
    <div class="read-only-banner"><strong>Read-only preview</strong><span>No Gateway request or catalog mutation occurs here.</span></div>
    <div class="drawer-grid"><div><strong>${Number.isFinite(agent.calls) ? agent.calls.toLocaleString("en-US") : "Unknown"}</strong><small>Calls · complete fixture window</small></div><div><strong>${Number.isFinite(agent.failures) ? agent.failures.toLocaleString("en-US") : "Unknown"}</strong><small>Failures · fixture</small></div><div><strong>${agent.success ?? "Unknown"}</strong><small>Success rate</small></div><div><strong>${agent.p95 ?? "Unknown"}</strong><small>p95 latency</small></div></div>
    <section class="drawer-section"><h3>Catalog</h3>${detailRows([["Catalog ID", agent.id], ["Derived status", stateLabel(catalogStatus)], ["Derivation", catalogStatusReason(agent)], ["Suspension", agent.suspended ? "Suspended · invocations blocked" : "Not suspended"], ["Created", formatTimestamp(agent.createdAt)], ["Updated", formatTimestamp(agent.updatedAt)]])}</section>
    <section class="drawer-section"><h3>Routing</h3>${detailRows([["Upstream", agent.upstreamConfigured ? "Configured" : "Not configured"], ["Protocol", protocolLabel(agent.protocol)], ["Transport", protocolTransportLabel(agent)], ["MCP protocol version", agent.protocol === "mcp" ? agent.mcpProtocolVersion ?? "Unknown" : "Not applicable"], ["MCP limitation", agent.protocol === "mcp" ? "Streamable HTTP only · stdio unsupported" : "Not applicable"]])}</section>
    <section class="drawer-section"><h3>Protection</h3>${detailRows([["Credential reference", credentialReferenceLabel(agent)], ["Credential injection", agent.credentialRef ? "Configured reference resolved after policy" : agent.credentialRef === null ? "None configured" : "Unknown"], ["Caller authorization", "Stripped before upstream injection"], ["Rate boundary", rateBoundaryLabel(agent)], ["SSRF posture", "Checked at write and dial time"], ["Proxy body capture", agent.captureBody === false ? "Off in this fixture" : "Unknown"]])}</section>
    <section class="drawer-section"><h3>Reliability</h3><div class="drawer-copy"><strong>Retries and circuit breaking</strong><p>${mcpReliability}</p><small>No current circuit state or retry event is claimed by this configuration fixture.</small></div></section>
    <section class="drawer-section"><h3>Pricing</h3>${detailRows(pricingRows)}<div class="drawer-copy compact"><p>This configures a payment gate. It does not prove verification, collection, or settlement.</p></div></section>
    <section class="drawer-section"><h3>Evidence</h3><div class="drawer-evidence"><span>${status("Available OSS · fixture", "available")}</span><strong>${invocationEvidenceLabel(agent)}</strong><small>Invocation metadata source · refreshed ${formatTimestamp(catalogSnapshot.refreshedAt)}</small></div>${observerMarkup}</section>
    <div class="drawer-actions"><button class="button secondary" data-drawer-action="agent-invocations" data-agent-name="${agent.name}">View invocations</button><button class="button secondary" data-drawer-action="agent-edit">Edit configuration</button></div>`,
  );
}

function openEnvironment(id) {
  const environment = environments.find((item) => item.id === id); if (!environment) return;
  const gateway = environment.delivery === "available";
  const evidenceState = environmentEvidenceState(environment);
  const evidenceAt = gateway ? environment.probeAt : environment.lastEvidenceAt;
  const countRows = gateway
    ? [["Catalog records", environment.catalogAgents], ["Pending", environment.pendingAgents], ["Suspended", environment.suspendedAgents]]
    : [["Observed", environment.observed], ["Enrolled", environment.enrolled], ["Discovered", environment.discovered]];
  const runtimeRows = gateway ? [["Storage", environment.storage], ["Version", environment.version]] : [];
  openDrawer(
    environment.name,
    `${environment.kind} · environment fixture`,
    `<div class="drawer-statuses">${status(gateway ? "Available OSS · fixture" : "In review · PR #46", gateway ? "available" : "review")}${status(stateLabel(evidenceState), evidenceState)}</div>
    <div class="read-only-banner"><strong>Captured evidence</strong><span>This record does not represent a persistent connection.</span></div>
    <section class="drawer-section"><h3>Provenance</h3>${detailRows([["Source", environment.source], ["Delivery", gateway ? "Available OSS · fixture" : "In review · PR #46"], ["Evidence state", stateLabel(evidenceState)], ["Evidence captured", formatTimestamp(evidenceAt)], ["Fixture refreshed", formatTimestamp(environmentSnapshot.refreshedAt)]])}</section>
    <section class="drawer-section"><h3>${gateway ? "Gateway inventory" : "Observer inventory"}</h3>${detailRows([...countRows, ...runtimeRows])}</section>
    ${gateway ? '<div class="drawer-copy"><strong>Probe boundary</strong><p>Healthy describes only the captured fixture probe. It is not a current or continuous health claim.</p></div>' : '<div class="drawer-copy"><strong>Observer boundary</strong><p>Reporting means a recent event; Quiet means older evidence; Enrolled means inventory without recent event evidence. None is a connection state.</p></div>'}
    <section class="drawer-section"><h3>Privacy boundary</h3><div class="drawer-copy compact"><p>Native observer summaries never contain prompts, messages, arguments, outputs, commands, paths, files, environment values, or credentials.</p></div></section>`,
  );
}

function openOnboardingEvidence(id) {
  const evidence = onboardingEvidence.find((item) => item.id === id); if (!evidence) return;
  const evidenceState = deriveObserverEvidenceState(evidence, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs);
  const evidenceAt = evidenceState === "discovered" ? evidence.discoveredAt : evidence.lastEventAt;
  openDrawer(
    evidence.name,
    `${evidence.runtime} · onboarding evidence fixture`,
    `<div class="drawer-statuses">${status("In review · PR #46", "review")}${status(stateLabel(evidenceState), evidenceState)}</div>
    <div class="read-only-banner"><strong>Evidence, not connectivity</strong><span>No enrollment, pairing, or observer mutation occurs here.</span></div>
    <section class="drawer-section"><h3>Onboarding evidence</h3>${detailRows([["State", stateLabel(evidenceState)], ["Meaning", observerEvidenceLabel(evidence, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs)], ["Environment", evidence.environment], ["Source", evidence.source], ["Evidence timestamp", evidenceAt ? formatTimestamp(evidenceAt) : "No recent event evidence"], ["Fixture refreshed", formatTimestamp(environmentSnapshot.refreshedAt)]])}</section>
    <div class="drawer-copy"><strong>State contract</strong><p>Reporting is an event within five minutes of the fixed fixture clock. Quiet is older event evidence. Enrolled is inventory without a recent event. Discovered is a candidate not enrolled.</p><small>These states never prove a persistent connection or disconnection.</small></div>
    <section class="drawer-section"><h3>Privacy boundary</h3><div class="drawer-copy compact"><p>Metadata summaries only. Never prompts, messages, arguments, outputs, commands, paths, files, environment values, or credentials. No pairing token or credential field is present.</p></div></section>`,
  );
}

function openInvocation(id) {
  const item = invocations.find((invocation) => invocation.id === id); if (!item) return;
  const trace = deriveInvocationTrace(item);
  const diagnosis = deriveFailureDiagnosis(item);
  const diagnosisMarkup = diagnosis ? `<section class="failure-diagnosis" aria-labelledby="failure-title"><div><p class="kicker">Failure diagnosis</p><h3 id="failure-title">Failed at ${diagnosis.stage}</h3><p>${diagnosis.classification}</p></div><dl><div><dt>Upstream status</dt><dd>${diagnosis.upstreamStatus}</dd></div><div><dt>Retryability</dt><dd>${diagnosis.retryability}</dd></div></dl><small>No retry was attempted by this fixture.</small></section>` : "";
  const traceMarkup = `<div class="trace" aria-label="Ordered invocation trace">${trace.map((stage, index) => `<div class="trace-stage ${stage.state}"><span class="trace-order">0${index + 1}</span><span><strong>${stage.label}</strong><small>${stage.detail}</small></span>${status(stage.state.replaceAll("_", " "), stage.state)}</div>`).join("")}</div>`;
  const paymentEvidence = item.paymentState === "verified" ? `${invocationPaymentLabel(item)} authorization · settlement tracked separately` : invocationPaymentLabel(item);
  openDrawer(item.id, `${item.agent} · ${invocationRelativeLabel(item.occurredAt, trafficSnapshot.evaluatedAt)}`, `${status(item.result, item.result)}${diagnosisMarkup}<h3>Request path</h3>${traceMarkup}<h3>Invocation metadata</h3>${detailRows([["Occurred", formatTimestamp(item.occurredAt)], ["Completed", formatTimestamp(item.completedAt)], ["Mode", invocationModeLabel(item.mode)], ["Operation", item.method], ["Latency", item.latency], ["Payload size", item.size], ["Policy result", item.policy], ["Payment", paymentEvidence]])}${captureBoundary(true)}`);
}

function detailRows(rows) { return `<dl class="detail-rows">${rows.map(([key, value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`).join("")}</dl>`; }

function openStackInfo(name) {
  const component = stack.find((item) => item.name === name); if (!component) return;
  openModal("Zerker stack", component.name, `${status(component.status, component.tone)}<p class="modal-lead">${component.job}</p><div class="availability-note">The status label is the product contract. This preview does not imply a live integration.</div>`);
}

function openPrivacy() {
  openModal("Agent activity", "The privacy boundary", `<div class="privacy-modal"><section><h3>Collected</h3><ul>${privacy.collected.map((item) => `<li>${item}</li>`).join("")}</ul></section><section><h3>Never collected</h3><ul>${privacy.excluded.map((item) => `<li>${item}</li>`).join("")}</ul></section></div><p class="modal-lead">Native adapters fail open. Gateway telemetry must never delay or block normal agent work.</p><div class="availability-note">This contract applies to native agent activity. Proxy invocation body capture is a separate, off-by-default Gateway setting and body reads require an additional OAuth scope.</div>`);
}

function openConcept(action) {
  const copy = {
    "add-agent": ["Agent catalog", "Register an agent", "The Gateway API supports tenant-scoped catalog registration. This fixture preview accepts no configuration or credential input and will not write to Gateway."],
    "edit-agent": ["Agent catalog", "Edit agent configuration", "The Gateway API supports catalog updates. This read-only fixture does not change routing, suspension, rates, credentials, pricing, or any other configuration."],
    connect: ["Environments", "Review environment concept", "Local discovery and observe-only enrollment are in review in PR #46. Remote pairing and missions are planned; this fixture performs neither."],
    "add-credential": ["Credentials", "Store a credential", "The API accepts managed secrets or external vault references. This preview never accepts or stores secret material."],
    "new-product": ["Product direction", "Create an agent product", "Customer portals, plan management and hosted billing are product direction, not shipped Gateway capabilities."],
    "product-preview": ["Product direction", "Customer portal concept", "A future portal will expose capabilities, documentation, access and optional payment under the operator’s domain."],
    "settlement-config": ["Payments", "Settlement configuration", "Gateway can point to a self-hosted or managed facilitator. This preview does not alter the configured URL or credential reference."],
    "edit-policy": ["Policies", "Edit policy document", "Gateway supports replacing the tenant policy today. This preview does not mutate a live policy."],
    simulate: ["Policies", "Simulate a request", "A safe policy simulator is a useful admin capability, but it is not currently exposed by the Gateway API."],
  }[action];
  if (!copy) return;
  openModal(copy[0], copy[1], `<p class="modal-lead">${copy[2]}</p><div class="availability-note"><strong>Preview only.</strong> No mutation, request, credential input, or browser storage write occurred.</div>`);
}

function openDrawer(title, subtitle, body) {
  previousFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="drawer-backdrop" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><header><div><p class="kicker">Detail</p><h2 id="drawer-title">${title}</h2><p>${subtitle}</p></div><button class="close-button" data-close aria-label="Close">×</button></header><div class="drawer-body">${body}</div></aside>`;
  bindOverlay();
  modalRoot.querySelector(".close-button").focus();
  modalRoot.querySelectorAll("[data-drawer-action]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.drawerAction;
    const agentName = button.dataset.agentName;
    closeOverlay();
    if (action === "agent-invocations") {
      invocationFilters = { ...defaultInvocationFilters, agent: agentName };
      render("invocations");
      return;
    }
    if (action === "agent-edit") openConcept("edit-agent");
  }));
}

function openModal(kicker, title, body) {
  previousFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="modal-backdrop" data-close><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-modal-panel><header><div><p class="kicker">${kicker}</p><h2 id="modal-title">${title}</h2></div><button class="close-button" data-close aria-label="Close">×</button></header><div class="modal-body">${body}</div></section></div>`;
  bindOverlay(); modalRoot.querySelector(".close-button").focus();
}

function openSearch() {
  previousFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="modal-backdrop" data-close><section class="modal command-menu" role="dialog" aria-modal="true" aria-label="Search Gateway" data-modal-panel><input id="command-input" class="command-input" type="search" placeholder="Search pages and agents…" aria-label="Search Gateway"><div id="command-results" class="command-results">${searchResults("")}</div></section></div>`;
  bindOverlay(); const input = modalRoot.querySelector("#command-input"); input.addEventListener("input", () => { modalRoot.querySelector("#command-results").innerHTML = searchResults(input.value); bindSearch(); }); bindSearch(); input.focus();
}

function searchResults(query) {
  const q = query.trim().toLowerCase();
  const pages = Object.entries(labels).filter(([, label]) => !q || label.toLowerCase().includes(q)).slice(0, 5).map(([view, label]) => `<button data-search-view="${view}"><span class="search-icon">↗</span><strong>${label}</strong><small>Admin surface</small></button>`);
  const foundAgents = filterAgents(agents, query).slice(0, 4).map((agent) => `<button data-search-agent="${agent.id}"><span class="search-icon">◎</span><strong>${agent.name}</strong><small>${agent.runtime}</small></button>`);
  return [...pages, ...foundAgents].join("") || '<div class="empty-state">Nothing found.</div>';
}
function bindSearch() { modalRoot.querySelectorAll("[data-search-view]").forEach((button) => button.addEventListener("click", () => { const view = button.dataset.searchView; closeOverlay(); render(view); })); modalRoot.querySelectorAll("[data-search-agent]").forEach((button) => button.addEventListener("click", () => { const id = button.dataset.searchAgent; closeOverlay(); openAgent(id); })); }

function openMobileMenu() {
  openModal("Navigate", "All Gateway surfaces", `<div class="mobile-menu-grid">${Object.entries(labels).map(([view, label]) => `<button data-mobile-view="${view}">${label}<span>→</span></button>`).join("")}</div>`);
  modalRoot.querySelectorAll("[data-mobile-view]").forEach((button) => button.addEventListener("click", () => { const view = button.dataset.mobileView; closeOverlay(); render(view); }));
}

function bindOverlay() {
  document.body.classList.add("overlay-open");
  modalRoot.querySelectorAll("[data-close]").forEach((element) => element.addEventListener("click", (event) => { if (event.target === element || element.matches("button")) closeOverlay(); }));
  modalRoot.querySelector("[data-modal-panel]")?.addEventListener("click", (event) => event.stopPropagation());
}
function closeOverlay() { modalRoot.innerHTML = ""; document.body.classList.remove("overlay-open"); previousFocus?.focus?.(); previousFocus = null; }
function showToast(message) { const toast = document.createElement("div"); toast.className = "toast"; toast.textContent = message; toastRegion.append(toast); window.setTimeout(() => toast.remove(), 3200); }

document.querySelectorAll(".side-nav [data-view], .mobile-nav [data-view]").forEach((button) => button.addEventListener("click", () => render(button.dataset.view)));
document.querySelector("[data-nav='overview']").addEventListener("click", (event) => { event.preventDefault(); render("overview"); });
document.querySelector("#open-search").addEventListener("click", openSearch);
document.querySelector("#mobile-menu").addEventListener("click", openMobileMenu);
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); }
  if (event.key === "Escape" && modalRoot.children.length) closeOverlay();
  if (event.key === "Tab" && modalRoot.children.length) { const focusable = [...modalRoot.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href]")]; if (!focusable.length) return; const first = focusable[0], last = focusable.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
});

render(location.hash.slice(1) || "overview");
