import "./styles.css";
import { liveAgentsView, loadAgents, bindLiveAgents } from "./live/agents-view.js";
import { liveInvocationsView } from "./live/invocations-view.js";
import { ensureAttentionLoaded, liveAttentionView } from "./live/attention-view.js";
import { liveOverviewView } from "./live/overview-view.js";
import { liveCredentialsView } from "./live/credentials-view.js";
import { livePoliciesView } from "./live/policies-view.js";
import { currentSession, renderSignIn, signOut } from "./live/gate.js";
import { activity, agents, analyticsScenarios, analyticsSnapshot, analyticsWindows, attention, catalogSnapshot, credentialSnapshot, credentials, environmentSnapshot, environments, facilitatorPosture, invocations, onboardingEvidence, overviewMetricSources, overviewScenarios, overviewSnapshot, paymentOperations, paymentSnapshot, policies, policySnapshot, privacy, products, restOperations, sdkInventory, stack, systemLimitations, systemSnapshot, trafficSnapshot } from "./data.js";
import { analyticsTTFTLabel, buildAgentResults, buildAnalyticsModel, buildCredentialResults, buildInvocationResults, buildOverviewModel, buildPaymentResults, buildPolicyDecisionResults, buildPolicyModel, buildRestInventory, buildSDKInventory, buildSystemModel, capabilityCounts, catalogStatusReason, credentialAuthLabel, credentialDeletePosture, credentialHintLabel, credentialReferenceLabel, credentialReferenceState, credentialSourceLabel, defaultAgentFilters, defaultCredentialFilters, defaultInvocationFilters, defaultPaymentFilters, defaultPolicyDecisionFilters, deliveryTruthLabel, deriveCatalogStatus, deriveFailureDiagnosis, deriveInvocationTrace, deriveObserverEvidenceState, derivePaymentDiagnosis, derivePaymentTrace, facilitatorModeLabel, filterAgents, formatAnalyticsDuration, formatCount, formatCurrency, formatPercent, formatTimestamp, invocationModeLabel, invocationPaymentLabel, invocationRelativeLabel, invocationTimestampLabel, observerEvidenceLabel, paymentGateLabel, paymentSettlementLabel, paymentUpstreamLabel, pricingLabel, protocolLabel, protocolTransportLabel, rateBoundaryLabel, safeCredentialMetadata, scrollBehaviorForMotion, stateLabel, summarizeAgents, summarizePayments } from "./view-model.js";

const main = document.querySelector("#main-content");
const modalRoot = document.querySelector("#modal-root");
const toastRegion = document.querySelector("#toast-region");
const appShell = document.querySelector("#app");
const skipLink = document.querySelector(".skip-link");
const searchTrigger = document.querySelector("#open-search");
const mobileMenuTrigger = document.querySelector("#mobile-menu");
const stackSummary = capabilityCounts(stack);
const systemModel = buildSystemModel(systemSnapshot, systemLimitations);
const restInventory = buildRestInventory(restOperations);
const sdkModel = buildSDKInventory(sdkInventory);
let activeOverviewScenario = "complete";
let activeAnalyticsScenario = "complete";
let activeAnalyticsWindow = analyticsSnapshot.defaultWindow;
let invocationFilters = { ...defaultInvocationFilters };
let agentFilters = { ...defaultAgentFilters };
let policyDecisionFilters = { ...defaultPolicyDecisionFilters };
let credentialFilters = { ...defaultCredentialFilters };
let paymentFilters = { ...defaultPaymentFilters };
let activeView = "overview";
let previousFocus = null;

const labels = {
  overview: "Overview", attention: "Needs attention", activity: "Agent activity", invocations: "Invocations",
  analytics: "Analytics", agents: "Agent catalog", environments: "Environments", policies: "Policies",
  credentials: "Credentials", products: "Products & portals", payments: "Payments", stack: "Stack & health",
};

function status(value, tone = value.toLowerCase().replaceAll(" ", "_")) {
  return `<span class="status ${tone}"><i aria-hidden="true"></i>${value}</span>`;
}

function pageHeader(kicker, title, description, actions = "") {
  return `<header class="page-heading"><div><p class="kicker">${kicker}</p><h1 id="page-title">${title}</h1><p class="page-description">${description}</p></div><div class="page-actions">${actions}</div></header>`;
}

function fixtureContext(snapshot, label) {
  const range = snapshot.range ? `<div><span>Window</span><strong data-fixture-window>${snapshot.range}</strong></div>` : "";
  return `<section class="control-evidence${snapshot.range ? " has-window" : ""}" aria-label="${label} fixture context"><div class="control-preview"><span class="fixture-dot"></span><span><strong>Preview data</strong><small>Not connected to Gateway</small></span></div><div><span>Workspace</span><strong>${snapshot.workspace}</strong></div><div><span>Environment scope</span><strong>${snapshot.environment}</strong></div><div><span>Source</span><strong>${snapshot.source}</strong></div><div><span>Refreshed</span><strong>${formatTimestamp(snapshot.refreshedAt)}</strong></div>${range}</section>`;
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
  return `<section class="panel system-card"><div class="panel-heading"><div><p class="kicker">Runtime evidence</p><h2>Production Gateway</h2></div>${status(model.runtime.label, model.runtime.tone)}</div><dl class="system-facts"><div><dt>Evidence</dt><dd>${model.runtime.detail}</dd></div><div><dt>Version</dt><dd>development</dd></div><div><dt>Storage</dt><dd>Postgres</dd></div><div><dt>Identity</dt><dd>Gateway API OIDC · fixture</dd></div><div><dt>Console session</dt><dd>Not implemented</dd></div></dl><button class="button secondary wide" data-view="stack">Open runtime evidence</button></section>`;
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
    ${capabilityCard("Discover", "Inventory local agents and runtime environments.", ["Catalog", "Local discovery", "Enrollment evidence"], "agents", [["Available OSS", "available"]])}
    ${capabilityCard("Control", "Apply identity, credentials, rates and policy before traffic moves.", ["OIDC tenancy", "Policy decisions", "Protected credentials"], "policies", [["Available", "available"]])}
    ${capabilityCard("Observe", "Inspect request and agent metadata without guessing what happened.", ["Invocations", "Latency & errors", "Metadata-only activity"], "analytics", [["Available OSS", "available"]])}
    ${capabilityCard("Monetize", "Gate paid routes and settle through a separate facilitator.", ["x402 gate", "USDC on Base", "Settlement records"], "payments", [["Available", "available"]])}
    ${capabilityCard("Verify", "Bind high-risk actions to deterministic evidence and signed records.", ["Reason certificates", "Treeship evidence", "Guard enforcement"], "stack", [["Standalone", "standalone"], ["Integration path", "integration"], ["Planned", "planned"]])}
    ${capabilityCard("Publish & work", "Turn agents into products and dispatch bounded missions.", ["Customer portals", "Plans & docs", "Remote missions"], "products", [["Planned", "planned"]])}
  </div></section>`;
}

function overviewView() {
  const model = currentOverviewModel();
  const attentionAction = model.attentionItems?.length ? '<button class="button secondary" data-view="attention">Open attention queue →</button>' : "";
  return `<section class="page-enter overview-page">
    <header class="page-heading operational-heading"><div><p class="kicker">Operate</p><h1 id="page-title">Overview</h1><p class="page-description">Attention, traffic, policy, cost, and runtime evidence from a fixed sample window.</p></div>${attentionAction}</header>
    <section class="overview-snapshot" aria-label="Preview snapshot context">
      <div class="preview-state"><span class="fixture-dot"></span><span><strong>Preview data</strong><small>Not connected to Gateway</small></span></div>
      <div class="snapshot-fact"><span>Workspace</span><strong>${overviewSnapshot.workspace}</strong></div>
      <button class="snapshot-fact" data-view="environments"><span>Environment</span><strong>${overviewSnapshot.environment}</strong><small>View evidence →</small></button>
      <div class="snapshot-fact"><span>Window</span><strong>${overviewSnapshot.range}</strong></div>
      <div class="snapshot-fact"><span>Fixture captured</span><strong>${model.capturedAt}</strong></div>
      <label class="scenario-control" for="overview-scenario"><span>Preview scenario</span><select id="overview-scenario">${overviewScenarios.map((scenario) => `<option value="${scenario.id}"${scenario.id === model.scenario.id ? " selected" : ""}>${scenario.label}</option>`).join("")}</select><small>In-memory only</small></label>
    </section>
    <p class="sr-only" role="status" aria-live="polite">Preview scenario: ${model.scenario.label}</p>
    <div id="overview-state-region">${renderOverviewOperations(model)}</div>
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
    ${pageHeader("Operate · available OSS", "Agent activity", "Privacy-bounded lifecycle and usage signals from native agent hooks.", '<button class="button secondary" data-action="privacy">Privacy boundary</button><button class="button secondary" data-action="connect">Review observer setup</button>')}
    <div class="availability-banner available"><div>${status("Available OSS · fixture", "available")}<h2>Discover → enroll → observe</h2><p>The agent-event and status contracts are on Gateway main. This fixture does not contact an observer or claim a persistent connection.</p></div><a href="https://docs.zerker.ai/gateway/agent-activity/" target="_blank" rel="noreferrer" aria-label="Open agent activity documentation in a new tab">Open docs <span aria-hidden="true">↗</span></a></div>
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
  return `<section class="capture-boundary${compact ? " compact" : ""}" aria-labelledby="${compact ? "drawer-capture-title" : "capture-title"}"><div><p class="kicker">Capture boundary</p><h2 id="${compact ? "drawer-capture-title" : "capture-title"}">Metadata visible. Bodies off.</h2></div><div class="capture-facts"><span><b>Proxy invocations</b>Metadata only</span><span><b>Request / response bodies</b>Off in this fixture · separate off-by-default Gateway feature</span><span><b>Body reads</b>Require <code>invocations:read_body</code> · response capped at 1 MiB</span><span><b>Native agent activity</b>Separate contract · never prompts, messages, arguments, outputs, commands, paths, files, environment values, or credentials</span></div></section>`;
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

function currentAnalyticsModel() {
  const scenario = analyticsScenarios.find((item) => item.id === activeAnalyticsScenario) ?? analyticsScenarios[0];
  return buildAnalyticsModel({ snapshot: analyticsSnapshot, windows: analyticsWindows, scenario, windowID: activeAnalyticsWindow });
}

function analyticsMetricStrip(model) {
  return `<section class="metric-strip analytics-metrics" aria-label="Analytics fixture metrics"><div><span>${model.countDisplay}</span><small>Completed calls</small><em>${model.window?.label ?? "Selected window"}</em></div><div><span>${model.errorDisplay}</span><small>Errors</small><em>${model.errorRate} error rate</em></div><div><span>${model.latency.p95}</span><small>Latency p95</small><em>Completed samples only</em></div><div><span>${model.ttft.p95}</span><small>TTFT p95</small><em>Streaming only</em></div><div><span>${Number.isFinite(model.aggregate?.streamingSamples) ? model.aggregate.streamingSamples.toLocaleString("en-US") : "Unknown"}</span><small>Streaming samples</small><em>TTFT population</em></div></section>`;
}

function analyticsPercentiles(model) {
  return `<section class="analytics-percentiles" aria-label="Aggregate percentile evidence"><div><div><p class="kicker">Completed latency</p><h2>Aggregate percentiles</h2></div><span>${status(model.latency.state === "available" ? "Available · fixture" : model.latency.state.replaceAll("_", " "), model.latency.state === "available" ? "available" : "unavailable")}</span></div><dl><div><dt>p50</dt><dd>${model.latency.p50}</dd></div><div><dt>p95</dt><dd>${model.latency.p95}</dd></div><div><dt>p99</dt><dd>${model.latency.p99}</dd></div></dl><div><div><p class="kicker">Streaming TTFT</p><h2>Aggregate percentiles</h2></div><span>${status(model.ttft.state === "available" ? "Available · fixture" : model.ttft.state.replaceAll("_", " "), model.ttft.state === "available" ? "available" : "unavailable")}</span></div><dl><div><dt>p50</dt><dd>${model.ttft.p50}</dd></div><div><dt>p95</dt><dd>${model.ttft.p95}</dd></div><div><dt>p99</dt><dd>${model.ttft.p99}</dd></div></dl></section>`;
}

function analyticsEvidence(model) {
  if (model.availability === "unavailable") return renderDataState("unavailable", "Analytics evidence unavailable", model.publicMessage);
  if (model.availability === "error") return renderDataState("error", "Analytics fixture error", model.publicMessage);
  const stateBanner = model.availability === "empty"
    ? `<section class="state-banner empty" role="status">${status("Empty", "empty")}<div><strong>Complete fixture window · known zero calls</strong><small>Error count is zero; rates have no denominator; latency and TTFT have no samples.</small></div></section>`
    : model.availability === "partial"
      ? `<section class="state-banner partial" role="status">${status("Partial", "warning")}<div><strong>Aggregate counts remain available</strong><small>Percentiles, taxonomy, agent, and operation breakdowns are Unavailable, not zero.</small></div></section>` : "";
  const emptyBreakdowns = model.availability === "empty" ? renderDataState("empty", "No completed calls in this fixture window", "The window is complete. There are no agent, operation, error, latency, or streaming TTFT samples.", true) : "";
  const unavailableBreakdowns = model.availability === "partial" ? renderDataState("unavailable", "Breakdowns unavailable", "The partial fixture retains aggregate count and errors only. No missing value is rendered as zero.", true) : "";
  const taxonomy = model.taxonomy?.length ? `<section class="panel analytics-taxonomy"><div class="panel-heading"><div><p class="kicker">Safe error taxonomy</p><h2>${model.errorDisplay} classified errors</h2></div>${status("Caller-safe", "available")}</div><div>${model.taxonomy.map((item) => `<span><strong>${item.count.toLocaleString("en-US")}</strong><small>${item.label}</small></span>`).join("")}</div></section>` : "";
  const agentsMarkup = model.agents?.length ? `<section class="panel analytics-table-panel"><div class="panel-heading"><div><p class="kicker">Underlying evidence</p><h2>Calls by agent</h2></div><span class="mono muted">${model.agents.length} fixture agents</span></div><div class="analytics-table" role="table" aria-label="Analytics by fixture agent"><div class="analytics-row analytics-head" role="row"><span>Name</span><span>Calls</span><span>Errors</span><span>Error rate</span><span>Latency p95</span><span>TTFT p95</span></div>${model.agents.map((row) => `<div class="analytics-row" role="row"><span data-label="Agent"><strong>${row.name}</strong></span><span data-label="Calls">${row.count.toLocaleString("en-US")}</span><span data-label="Errors">${row.errors.toLocaleString("en-US")}</span><span data-label="Error rate">${row.count ? formatPercent(row.errors, row.count) : "No calls"}</span><span data-label="Latency p95">${formatAnalyticsDuration(row.latencyP95Ms)}</span><span data-label="TTFT p95">${analyticsTTFTLabel(row)}</span></div>`).join("")}</div></section>` : "";
  const operationsMarkup = model.operations?.length ? `<section class="panel analytics-table-panel"><div class="panel-heading"><div><p class="kicker">Protocol / operation</p><h2>MCP method and tool observability</h2></div>${status("Metadata only", "review")}</div><div class="analytics-table operations" role="table" aria-label="Analytics by protocol and operation"><div class="analytics-row analytics-head" role="row"><span>Protocol</span><span>Method / tool</span><span>Calls</span><span>Errors</span><span>Error rate</span><span>Latency p95</span><span>TTFT p95</span></div>${model.operations.map((row) => `<div class="analytics-row" role="row"><span data-label="Protocol">${status(row.protocol, row.protocol === "MCP" ? "review" : "empty")}</span><span data-label="Method / tool"><strong>${row.method}</strong><small>${row.tool ?? "No tool identity"}</small></span><span data-label="Calls">${row.count.toLocaleString("en-US")}</span><span data-label="Errors">${row.errors.toLocaleString("en-US")}</span><span data-label="Error rate">${formatPercent(row.errors, row.count)}</span><span data-label="Latency p95">${formatAnalyticsDuration(row.latencyP95Ms)}</span><span data-label="TTFT p95">${analyticsTTFTLabel(row)}</span></div>`).join("")}</div></section>` : "";
  return `${stateBanner}${analyticsMetricStrip(model)}${analyticsPercentiles(model)}${taxonomy}${agentsMarkup}${operationsMarkup}${emptyBreakdowns}${unavailableBreakdowns}`;
}

function analyticsView() {
  const model = currentAnalyticsModel();
  return `<section class="page-enter analytics-page">
    ${pageHeader("Traffic · available OSS", "Analytics", "Investigate count, errors, latency, and streaming TTFT over explicit fixed windows.")}
    ${fixtureContext({ ...analyticsSnapshot, range: model.window?.label ?? "Unknown" }, "Analytics")}
    <section class="analytics-controls" aria-label="Analytics fixture controls"><label><span>Fixed window</span><select id="analytics-window">${Object.entries(analyticsWindows).map(([id, window]) => `<option value="${id}"${id === activeAnalyticsWindow ? " selected" : ""}>${window.label}</option>`).join("")}</select><small>In-memory · maximum 31 days</small></label><label><span>Preview scenario</span><select id="analytics-scenario">${analyticsScenarios.map((scenario) => `<option value="${scenario.id}"${scenario.id === model.scenario.id ? " selected" : ""}>${scenario.label}</option>`).join("")}</select><small>In-memory only · no request</small></label><div class="analytics-window-proof"><span>Required <code>since</code></span><strong>${formatTimestamp(model.window?.since)}</strong><small>Evaluated ${formatTimestamp(model.window?.until)}</small></div><div class="analytics-window-proof"><span>Endpoint contract</span><strong>Dedicated analytics limiter</strong><small>Latency excludes in-flight calls</small></div></section>
    <p class="sr-only" role="status" aria-live="polite">${model.stateSummary}</p>
    <div id="analytics-state-region">${analyticsEvidence(model)}</div>
    <section class="analytics-contract"><div><p class="kicker">Contract boundary</p><h2>Bounded aggregates, not content.</h2></div><div><span><b>Window</b><code>since</code> required · inclusive maximum 31 days</span><span><b>Limiter</b>Dedicated analytics boundary · capacity health not claimed</span><span><b>Population</b>Latency percentiles exclude in-flight calls</span><span><b>TTFT</b>Streaming samples only; transactional rows are Not applicable</span><span><b>Content</b>No bodies, prompts, arguments, outputs, paths, headers, or raw errors</span></div></section>
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
      ? `<span class="agent-evidence available-evidence"><b>Available OSS · fixture</b><small>${observerEvidenceLabel(observer, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs)}</small></span>`
      : '<span class="agent-evidence"><b>Native observer</b><small>Unavailable in this fixture</small></span>';
    return `<article class="catalog-row${agent.suspended ? " is-suspended" : ""}">
      <span class="agent-identity" data-label="Catalog agent"><span class="agent-symbol" aria-hidden="true">${agent.runtime === "Pi" ? "π" : agent.runtime.slice(0, 2).toUpperCase()}</span><span><strong>${agent.name}</strong><small class="mono">${agent.id}</small></span></span>
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
  if (environment.surface === "gateway") return environment.healthState ?? "unknown";
  return deriveObserverEvidenceState({ enrollmentState: environment.enrollmentState, lastEventAt: environment.lastEvidenceAt }, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs);
}

function environmentCard(environment) {
  const evidenceState = environmentEvidenceState(environment);
  const gateway = environment.surface === "gateway";
  const evidenceCopy = gateway
    ? `Probe captured ${formatTimestamp(environment.probeAt)} · evidence only`
    : observerEvidenceLabel({ enrollmentState: environment.enrollmentState, lastEventAt: environment.lastEvidenceAt }, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs);
  const facts = gateway
    ? [["Catalog", environment.catalogAgents], ["Pending", environment.pendingAgents], ["Suspended", environment.suspendedAgents]]
    : [["Observed", environment.observed], ["Enrolled", environment.enrolled], ["Discovered", environment.discovered]];
  return `<article class="environment-card"><div class="environment-top"><span class="environment-icon" aria-hidden="true">${gateway ? "G" : "⌘"}</span><span class="environment-badges">${status("Available OSS · fixture", "available")}${status(stateLabel(evidenceState), evidenceState)}</span></div><p class="kicker">${environment.kind}</p><h2>${environment.name}</h2><p>${evidenceCopy}. This is not persistent connectivity.</p><dl>${facts.map(([key, value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`).join("")}</dl><button class="inspect-button" data-environment="${environment.id}" aria-label="Inspect environment evidence for ${environment.name}">Inspect evidence →</button></article>`;
}

function onboardingRows() {
  return onboardingEvidence.map((item) => {
    const evidenceState = deriveObserverEvidenceState(item, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs);
    return `<article class="onboarding-row"><span><strong>${item.name}</strong><small>${item.runtime} · ${item.environment}</small></span>${status(stateLabel(evidenceState), evidenceState)}<span><strong>${observerEvidenceLabel(item, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs)}</strong><small>Evidence only · not a persistent connection</small></span><button class="inspect-button" data-onboarding="${item.id}" aria-label="Inspect onboarding evidence for ${item.name}">Inspect →</button></article>`;
  }).join("");
}

function environmentsView() {
  const gatewayEnvironments = environments.filter((environment) => environment.surface === "gateway");
  const observerEnvironments = environments.filter((environment) => environment.surface === "observer");
  return `<section class="page-enter environments-page">
    ${pageHeader("Control · available OSS", "Environments", "Captured Gateway probes and privacy-safe observer evidence, separated by evidence type.", '<button class="button secondary" data-action="connect">Review environment setup</button>')}
    ${fixtureContext(environmentSnapshot, "Environment")}
    <section class="environment-group"><div class="environment-group-heading"><div><p class="kicker">Available OSS · fixture</p><h2>Gateway runtime evidence</h2></div><p>A captured health probe describes only that fixed point in time.</p></div><div class="environment-list gateway-environments">${gatewayEnvironments.map(environmentCard).join("")}</div></section>
    <section class="environment-group"><div class="environment-group-heading"><div><p class="kicker">Available OSS · fixture</p><h2>Local observer evidence</h2></div><p>Discovery, enrollment, reporting, and quiet are evidence states—not connection states.</p></div><div class="environment-list">${observerEnvironments.map(environmentCard).join("")}</div></section>
    <section class="panel onboarding-panel"><div class="panel-heading"><div><p class="kicker">Available OSS · fixture</p><h2>Onboarding evidence</h2></div>${status("Metadata only", "available")}</div><div class="onboarding-list">${onboardingRows()}</div></section>
    <section class="planned-environment"><div><p class="kicker">Planned</p><h2>Remote pairing and missions</h2><p>Remote operation remains separate from observe-only evidence and is not available in this fixture.</p></div>${status("Planned", "planned")}</section>
    <section class="environment-privacy"><div><p class="kicker">Native activity privacy</p><h2>Evidence without conversation content</h2></div><p>Observer summaries never include prompts, messages, arguments, outputs, commands, paths, files, environment values, or credentials. No pairing token or credential is accepted here.</p></section>
  </section>`;
}

function policyRuleRows(rules) {
  return rules.map((rule) => `<article class="policy-rule-row"><span class="rule-order">${String(rule.order).padStart(2, "0")}</span><span data-label="Rule"><strong>${rule.name}</strong><small>${rule.dimension} · ${rule.match}</small></span><span data-label="Scope"><strong>${rule.scope}</strong><small>First matching rule wins</small></span><span data-label="Action">${status(rule.action, rule.action)}</span><span data-label="Decisions"><strong>${rule.decisions.toLocaleString("en-US")}</strong><small>Fixed fixture aggregate</small></span><button class="inspect-button" data-policy-rule="${rule.id}" aria-label="Inspect policy rule ${rule.name}">Inspect →</button></article>`).join("");
}

function policyDecisionRows(items) {
  if (!items.length) return `<div class="governance-empty"><p class="kicker">Filtered fixture</p><h2>No fixture policy decisions match</h2><p>Adjust the in-memory filters. This does not mean the tenant has no decisions or policy is unavailable.</p><button class="button secondary" id="empty-clear-policy-filters">Clear filters</button></div>`;
  const rulesByID = new Map(policies.rules.map((rule) => [rule.id, rule]));
  return items.map((decision) => {
    const rule = rulesByID.get(decision.ruleID);
    return `<article class="policy-decision-row"><span data-label="Time"><strong>${formatTimestamp(decision.occurredAt)}</strong><small class="mono">${decision.id}</small></span><span data-label="Action">${status(decision.action, decision.action)}<small>${decision.action === "warn" ? "Recorded · forwarded" : decision.action === "deny" ? "Stopped" : "Forwarded"}</small></span><span data-label="Agent / operation"><strong>${decision.agent}</strong><small>${decision.protocol.toUpperCase()} · ${decision.method}${decision.tool ? ` · ${decision.tool}` : ""}</small></span><span data-label="Rule"><strong>${rule ? `${String(rule.order).padStart(2, "0")} · ${rule.name}` : "Default action"}</strong><small>${decision.reason}</small></span><button class="inspect-button" data-policy-decision="${decision.id}" aria-label="Inspect policy decision ${decision.id}">Inspect →</button></article>`;
  }).join("");
}

function policiesView() {
  const model = buildPolicyModel(policies);
  const result = buildPolicyDecisionResults(policies.decisions, model.rules, policyDecisionFilters);
  return `<section class="page-enter governance-page policy-page">
    ${pageHeader("Control · available OSS", "Policies", "Effective posture, ordered rules, and caller-safe decision evidence from a fixed fixture.", '<button class="button secondary" data-action="simulate">Simulate concept</button><button class="button secondary" data-action="edit-policy">Edit policy concept</button>')}
    ${fixtureContext(policySnapshot, "Policy")}
    <section class="policy-posture"><div><p class="kicker">No rule matched</p><strong>${model.defaultAction === "unknown" ? "Unknown" : model.defaultAction}</strong><small>Configured default</small></div><div><p class="kicker">Evaluation error</p><strong>${model.onErrorAction === "unknown" ? "Unknown" : model.onErrorAction}</strong><small><code>on_error</code> posture</small></div><div><p class="kicker">Store outage</p><strong>${model.outagePosture === "fail_closed" ? "Fail closed" : "Unknown"}</strong><small>Current OSS behavior</small></div><div><p class="kicker">Evaluation order</p><strong>Policy first</strong><small>Before payment and proxy</small></div></section>
    <section class="policy-semantics" aria-label="Policy action semantics"><span><b>Allow</b>Forward request</span><span><b>Warn</b>Record and forward</span><span><b>Deny</b>Stop request</span><span><b>Error</b>Use <code>on_error</code></span></section>
    <section class="panel policy-rules-panel"><div class="panel-heading"><div><p class="kicker">Ordered policy document</p><h2>${formatCount(model.rules.length, "rule")}</h2></div><div class="policy-counts"><span>${model.actionCounts.allow} allow</span><span>${model.actionCounts.warn} warn</span><span>${model.actionCounts.deny} deny</span></div></div><div class="policy-rule-columns" aria-hidden="true"><span>Order</span><span>Rule</span><span>Scope</span><span>Action</span><span>Decisions</span><span>Action</span></div><div class="policy-rule-list">${policyRuleRows(model.rules)}</div></section>
    <section class="policy-decision-section"><div class="section-heading compact-heading"><div><p class="kicker">Decision audit</p><h2>Fixture decisions</h2></div><p>Newest first · safe metadata only</p></div>
      <section class="governance-filters" aria-label="Filter fixture policy decisions"><label class="governance-search"><span>Search</span><input id="policy-search" data-policy-filter="query" type="search" placeholder="ID, agent, operation, reason, or rule" autocomplete="off"></label><label><span>Action</span><select id="policy-action" data-policy-filter="action"><option value="all">All</option><option value="allow">Allow</option><option value="warn">Warn</option><option value="deny">Deny</option></select></label><label><span>Rule</span><select id="policy-rule" data-policy-filter="rule"><option value="all">All</option><option value="default">Default action</option>${model.rules.map((rule) => `<option value="${rule.id}">${String(rule.order).padStart(2, "0")} · ${rule.name}</option>`).join("")}</select></label><button class="button secondary" id="clear-policy-filters">Clear filters</button></section>
      <div class="governance-results-heading"><p id="policy-result-count" aria-live="polite"><strong>${result.summary}</strong><small>${result.activeFilters.length ? formatCount(result.activeFilters.length, "active filter") : "Default fixture view"}</small></p><span>${policySnapshot.range} · fixed clock</span></div>
      <section class="policy-decision-list" id="policy-decision-results">${policyDecisionRows(result.rows)}</section>
    </section>
    <section class="policy-limitations"><div><p class="kicker">Current OSS limitations</p><h2>Failure posture is part of the contract.</h2></div><div><span><b>Policy store outage</b>Fails closed today; this is not a normal deny-rule match.</span><span><b>Chunked streaming</b><code>max_body_bytes</code> cannot provide the same enforcement when body length is unavailable.</span></div></section>
  </section>`;
}

function credentialRows(items) {
  if (!items.length) return `<div class="governance-empty"><p class="kicker">Filtered fixture</p><h2>No fixture credential metadata matches</h2><p>Adjust the in-memory filters. This does not mean the tenant has no credential metadata.</p><button class="button secondary" id="empty-clear-credential-filters">Clear filters</button></div>`;
  return items.map((credential) => {
    const reference = credentialReferenceState(credential);
    return `<article class="credential-row"><span data-label="Credential"><strong>${credential.name ?? "Unknown"}</strong><small class="mono">${credential.id ?? "Unknown"}</small></span><span data-label="Source">${status(credentialSourceLabel(credential), credential.source === "managed" ? "managed" : credential.source === "external_vault" ? "vault" : "unavailable")}</span><span data-label="Auth type"><strong>${credentialAuthLabel(credential)}</strong><small>Metadata only</small></span><span data-label="Safe hint"><strong class="mono">${credentialHintLabel(credential)}</strong><small>No value is available</small></span><span data-label="Version"><strong>${Number.isInteger(credential.version) ? `v${credential.version}` : "Unknown"}</strong><small>${formatTimestamp(credential.updatedAt)}</small></span><span data-label="References">${status(reference.label, reference.id === "referenced" ? "review" : reference.id === "unreferenced" ? "empty" : "unavailable")}</span><button class="inspect-button" data-credential="${credential.id}" aria-label="Inspect credential metadata ${credential.name}">Inspect →</button></article>`;
  }).join("");
}

function credentialsView() {
  const safeCredentials = credentials.map(safeCredentialMetadata);
  const result = buildCredentialResults(credentials, credentialFilters);
  const managed = safeCredentials.filter((credential) => credential.source === "managed").length;
  const external = safeCredentials.filter((credential) => credential.source === "external_vault").length;
  const referenced = safeCredentials.filter((credential) => credentialReferenceState(credential).id === "referenced").length;
  const unreferenced = safeCredentials.filter((credential) => credentialReferenceState(credential).id === "unreferenced").length;
  return `<section class="page-enter governance-page credential-page">
    ${pageHeader("Control · available OSS", "Credentials", "Safe metadata for write-only managed values and external references.", '<button class="button secondary" data-action="add-credential">Store credential concept</button>')}
    ${fixtureContext(credentialSnapshot, "Credential metadata")}
    <section class="credential-safety"><span class="credential-safety-icon" aria-hidden="true">⌑</span><div><p class="kicker">Hard boundary</p><h2>Metadata visible. Credential values absent.</h2><p>No plaintext, token, vault path, reveal, copy, or input surface exists in this fixture.</p></div>${status("Tenant isolated", "available")}</section>
    <section class="metric-strip governance-metrics"><div><span>${safeCredentials.length}</span><small>Metadata records</small><em>Fixture count</em></div><div><span>${managed}</span><small>Managed</small><em>Envelope-encrypted posture</em></div><div><span>${external}</span><small>External vault</small><em>Path never returned</em></div><div><span>${referenced}</span><small>Referenced</small><em>Delete would conflict</em></div><div><span>${unreferenced}</span><small>Unreferenced</small><em>Preview still read-only</em></div></section>
    <section class="governance-filters credential-filters" aria-label="Filter fixture credential metadata"><label class="governance-search"><span>Search</span><input id="credential-search" data-credential-filter="query" type="search" placeholder="ID, name, auth type, or referencing agent" autocomplete="off"></label><label><span>Source</span><select id="credential-source" data-credential-filter="source"><option value="all">All</option><option value="managed">Managed</option><option value="external_vault">External vault</option></select></label><label><span>Auth type</span><select id="credential-auth" data-credential-filter="authType"><option value="all">All</option><option value="bearer">Bearer</option><option value="api_key">API key</option><option value="none">None</option></select></label><label><span>Reference state</span><select id="credential-reference" data-credential-filter="reference"><option value="all">All</option><option value="referenced">Referenced</option><option value="unreferenced">Unreferenced</option></select></label><button class="button secondary" id="clear-credential-filters">Clear filters</button></section>
    <div class="governance-results-heading"><p id="credential-result-count" aria-live="polite"><strong>${result.summary}</strong><small>${result.activeFilters.length ? formatCount(result.activeFilters.length, "active filter") : "Default fixture view"}</small></p><span>Allowlisted metadata only</span></div>
    <div class="credential-columns" aria-hidden="true"><span>Credential</span><span>Source</span><span>Auth type</span><span>Safe hint</span><span>Version / updated</span><span>References</span><span>Action</span></div>
    <section class="credential-list" id="credential-results">${credentialRows(result.rows)}</section>
    <section class="credential-protection"><div><p class="kicker">Protection posture</p><h2>Server-side boundaries</h2></div><div><span><b>Managed values</b>Envelope-encrypted under tenant KEKs.</span><span><b>External vault</b>Value and path remain external and are not in this fixture.</span><span><b>Tenant KEK rotation</b>Internal seam · no public REST operation.</span><span><b>Injection</b>After policy allow; caller authorization is stripped.</span></div></section>
  </section>`;
}

function productsView() {
  return `<section class="page-enter governance-page products-page">
    ${pageHeader("Revenue · planned product direction", "Products & portals", "Planned packaging concepts for access, documentation, usage, and payment.", '<button class="button secondary" data-action="new-product">Review product concept</button>')}
    <div class="availability-banner planned"><div>${status("Planned", "planned")}<h2>Not part of the current Gateway release.</h2><p>This preview shows the intended admin model without claiming that customer portals, plans or hosted billing are operational.</p></div><button class="button secondary" data-view="stack">See delivery status</button></div>
    <div class="product-grid">${products.map((product) => `<article class="product-card"><div class="product-preview"><span class="mini-brand" aria-hidden="true">Z</span><span class="mini-url">Concept URL · ${product.domain}</span><strong>${product.name}</strong><small>Powered by ${product.agent}</small></div><div class="product-copy"><span>${status(product.status, "planned")}</span><h2>${product.name}</h2><dl><div><dt>Agent concept</dt><dd>${product.agent}</dd></div><div><dt>Access concept</dt><dd>${product.access}</dd></div><div><dt>Price concept</dt><dd>${product.price}</dd></div></dl><button class="button secondary wide" data-action="product-preview" aria-label="Open product concept for ${product.name}">Open product concept</button></div></article>`).join("")}</div>
    <section class="capability-checklist"><div><strong>Product manifest</strong><small>Machine-readable capabilities and terms</small>${status("Direction", "planned")}</div><div><strong>Customer access</strong><small>OIDC, plans, quotas and documentation</small>${status("Planned", "planned")}</div><div><strong>Usage & billing</strong><small>Metering, invoices and spend limits</small>${status("Commercial concept", "planned")}</div></section>
  </section>`;
}

function paymentRangeLabel(value) {
  return { "5m": "Last 5 minutes", "15m": "Last 15 minutes", "24h": "Last 24 hours" }[value] ?? "Last 24 hours";
}

function paymentRows(items) {
  if (!items.length) return `<div class="governance-empty"><p class="kicker">Filtered fixture</p><h2>No fixture payment operations match</h2><p>Adjust the in-memory filters. This does not mean the tenant has no payment operations.</p><button class="button secondary" id="empty-clear-payment-filters">Clear filters</button></div>`;
  return items.map((operation) => {
    const settlementTone = operation.settlementState === "settlement_failed" || operation.settlementState === "settled_upstream_failed" ? "settlement_failed" : operation.settlementState === "settled" ? "settled" : operation.settlementState === "pending" ? "pending" : "empty";
    const gateTone = operation.gateState === "verified" ? "available" : operation.gateState === "challenged" ? "pending" : "unavailable";
    return `<article class="payment-row${operation.settlementState === "settlement_failed" || operation.settlementState === "settled_upstream_failed" ? " has-failure" : ""}"><span data-label="Time / ID"><strong>${formatTimestamp(operation.occurredAt)}</strong><small class="mono">${operation.id}</small></span><span data-label="Agent / operation"><strong>${operation.agent}</strong><small>${operation.operation}</small></span><span data-label="Amount"><strong>${formatCurrency(operation.amountCents, operation.currency)}</strong><small>${operation.asset} · ${operation.network}</small></span><span data-label="Gateway gate">${status(paymentGateLabel(operation), gateTone)}</span><span data-label="Collection / settlement">${status(paymentSettlementLabel(operation), settlementTone)}</span><span data-label="Upstream"><strong>${paymentUpstreamLabel(operation)}</strong><small>${operation.invocationID ? `Invocation ${operation.invocationID}` : "No invocation record"}</small></span><span data-label="Facilitator"><strong>${facilitatorModeLabel(operation.facilitatorMode)}</strong><small>${operation.facilitatorMode === "self_hosted" ? "Available OSS fixture" : "Not configured"}</small></span><button class="inspect-button" data-payment="${operation.id}" aria-label="Inspect payment operation ${operation.id}">Inspect →</button></article>`;
  }).join("");
}

function paymentsView() {
  const summary = summarizePayments(paymentOperations);
  const result = buildPaymentResults(paymentOperations, paymentFilters, paymentSnapshot.evaluatedAt);
  const settlementOptions = [...new Set(paymentOperations.map((operation) => operation.settlementState))];
  return `<section class="page-enter governance-page payments-page">
    ${pageHeader("Revenue · available OSS evidence", "Payments", "Payment-gate, collection, settlement, and upstream outcomes from a fixed fixture.", '<button class="button secondary" data-action="settlement-config">Settlement config concept</button>')}
    ${fixtureContext({ ...paymentSnapshot, range: paymentRangeLabel(paymentFilters.timeRange) }, "Payment operation")}
    <section class="metric-strip governance-metrics payment-metrics"><div><span>${summary.collectedDisplay}</span><small>Collected</small><em>${summary.settledUpstreamFailures} later upstream failure</em></div><div><span>${summary.verified}</span><small>Verified authorizations</small><em>Verification is not collection</em></div><div><span>${summary.gateOnlyDisplay}</span><small>Gate-only verified</small><em>Not collected</em></div><div><span>${summary.settlementFailures}</span><small>Settlement failures</small><em>Upstream not called</em></div><div><span>${summary.challenges}</span><small>402 challenges</small><em>No invocation created</em></div></section>
    <section class="payment-order"><span><b>1 · Policy</b>Denied requests do not pay</span><i aria-hidden="true">→</i><span><b>2 · Gateway gate</b>x402 exact · USDC · Base</span><i aria-hidden="true">→</i><span><b>3 · Facilitator</b>Optional independent settlement</span><i aria-hidden="true">→</i><span><b>4 · Upstream</b>Only after required settlement</span></section>
    <section class="governance-filters payment-filters" aria-label="Filter fixture payment operations"><label class="governance-search"><span>Search</span><input id="payment-search" data-payment-filter="query" type="search" placeholder="ID, invocation, agent, or operation" autocomplete="off"></label><label><span>Gateway gate</span><select id="payment-gate" data-payment-filter="gate"><option value="all">All</option><option value="challenged">Challenged</option><option value="verified">Verified</option></select></label><label><span>Settlement</span><select id="payment-settlement" data-payment-filter="settlement"><option value="all">All</option>${settlementOptions.map((value) => `<option value="${value}">${value.replaceAll("_", " ")}</option>`).join("")}</select></label><label><span>Time range</span><select id="payment-time-range" data-payment-filter="timeRange"><option value="5m">Last 5 minutes</option><option value="15m">Last 15 minutes</option><option value="24h">Last 24 hours</option></select></label><button class="button secondary" id="clear-payment-filters">Clear filters</button></section>
    <div class="governance-results-heading"><p id="payment-result-count" aria-live="polite"><strong>${result.summary}</strong><small>${result.activeFilters.length ? formatCount(result.activeFilters.length, "active filter") : "Default fixture view"}</small></p><span>Newest first · fixed fixture clock</span></div>
    <div class="payment-columns" aria-hidden="true"><span>Time / ID</span><span>Agent / operation</span><span>Amount</span><span>Gateway gate</span><span>Collection / settlement</span><span>Upstream</span><span>Facilitator</span><span>Action</span></div>
    <section class="payment-list" id="payment-results">${paymentRows(result.rows)}</section>
    <section class="gate-only-warning"><div><p class="kicker">Gate-only limitation</p><h2>Verified is not collected.</h2></div><p>Replay protection is best effort until settlement consumes the authorization on-chain. Do not treat gate-only verification as final revenue.</p></section>
    <section class="facilitator-posture"><div><p class="kicker">Tenant facilitator posture · fixture</p><h2>${facilitatorPosture.configured ? "Configured · readiness not claimed" : "Not configured"}</h2><p>${facilitatorPosture.source} · captured ${formatTimestamp(facilitatorPosture.capturedAt)}</p></div><div class="facilitator-facts"><span><b>Self-hosted</b>${status(deliveryTruthLabel(facilitatorPosture.selfHostedDelivery), "available")}</span><span><b>Managed</b>${status(deliveryTruthLabel(facilitatorPosture.managedDelivery), "commercial")}</span><span><b>Guardrails</b>${formatCurrency(facilitatorPosture.perTransactionLimitCents)} / transaction · ${formatCurrency(facilitatorPosture.dailyLimitCents)} / day</span><span><b>Duplicate protection</b>Nonce dedupe · single-flight</span></div><button class="inspect-button" data-facilitator aria-label="Inspect facilitator posture">Inspect posture →</button></section>
    <section class="revenue-delivery"><div><p class="kicker">Delivery truth</p><h2>x402 is an adapter, not the product identity.</h2></div><div><span><b>Raw payment / settlement evidence</b>${status("Available OSS", "available")}</span><span><b>Managed revenue metering</b>${status("Commercial", "commercial")}</span><span><b>Invoices, quotas, spend limits</b>${status("Planned / commercial", "planned")}</span><span><b>Prepaid, card, custom rails</b>${status("Planned", "planned")}</span><span><b>Customer portals</b>${status("Planned", "planned")}</span></div></section>
  </section>`;
}

function systemPostureCard(id, kicker, title, badge, tone, facts) {
  return `<article class="system-posture-card"><div class="system-posture-top"><div><p class="kicker">${kicker}</p><h2>${title}</h2></div>${status(badge, tone)}</div><dl>${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl><button class="inspect-button" data-system-detail="${id}" aria-label="Inspect ${title} fixture posture">Inspect posture →</button></article>`;
}

function restOperationPosture(operation) {
  return operation.kind === "probe" ? "Unauthenticated · exempt from the console session" : "Requires the operator's authenticated session";
}

function stackView() {
  const operationGroups = Object.entries(restInventory.groups);
  return `<section class="page-enter stack-page">
    ${pageHeader("System", "Stack & health", "Captured runtime evidence, production requirements, limitations, and contract inventory.")}
    ${fixtureContext(systemSnapshot, "Gateway system posture")}
    <section class="runtime-strip system-runtime"><div><span class="fixture-health-dot" aria-hidden="true"></span><span><strong>${systemModel.health.label}</strong><small>${formatTimestamp(systemSnapshot.health.capturedAt)} · one captured probe</small></span></div><div><strong>${systemSnapshot.build.version}</strong><small>${systemSnapshot.build.commit}</small></div><div><strong>${systemModel.rollout.label}</strong><small>Replica parity not proved</small></div><div><strong>${restInventory.total} operations</strong><small>${restInventory.counts.probe} probe · ${restInventory.counts.read} read · ${restInventory.counts.proxy} proxy · ${restInventory.counts.write} write</small></div><div><strong>${systemModel.facilitator.label}</strong><small>/supported and gas not probed</small></div></section>
    <section class="system-limitations"><div><p class="kicker">Known limitations · operator verification</p><h2>${systemModel.limitations.length} facts block a stronger readiness claim.</h2><p>Fixture configuration, support, and one captured probe are not continuous health, migration, backup, rollout, signer, or facilitator readiness evidence.</p><button class="inspect-button" data-system-detail="limitations" aria-label="Inspect all known system limitations">Inspect all limitations →</button></div><div>${systemModel.limitations.map((item) => `<span><b>${item.title}</b>${item.detail}</span>`).join("")}</div></section>
    <section class="system-posture-grid" aria-label="Gateway fixture system posture">
      ${systemPostureCard("runtime", "Captured probes", "Health & build", systemModel.health.label, "available", [["Health", "One fixed /healthz sample"], ["Build", "One deliberate /version sample"], ["Rollout", systemModel.rollout.label]])}
      ${systemPostureCard("storage", "Production path", "Storage & migrations", "Contract posture", "review", [["Durable", systemSnapshot.storage.production], ["Migrations", systemSnapshot.storage.migrations], ["Backup", systemSnapshot.storage.backup]])}
      ${systemPostureCard("kms", "Credential protection", "KMS & key rotation", systemModel.kms.label, "review", [["Requirement", systemSnapshot.kms.requirement], ["Fallback", systemSnapshot.kms.fallback], ["Master rotation", systemSnapshot.kms.masterRotation]])}
      ${systemPostureCard("security", "Trust boundary", "Identity & network", "Contract invariants", "available", [["Gateway API", systemSnapshot.security.apiIdentity], ["Console auth", systemSnapshot.security.consoleIdentity], ["Tenant isolation", systemSnapshot.security.tenancy]])}
      ${systemPostureCard("deployment", "Self-hosted operation", "Scale & rollout", systemModel.rollout.label, "warning", [["Replicas", systemSnapshot.deployment.replicas], ["Rate boundary", systemSnapshot.deployment.rateBoundary], ["Grace", systemSnapshot.deployment.graceful]])}
      ${systemPostureCard("facilitator", "Settlement system", "Facilitator readiness", systemModel.facilitator.label, "warning", [["Configuration", systemSnapshot.facilitator.configurationEvidence], ["/supported", systemSnapshot.facilitator.supported], ["Gas", systemSnapshot.facilitator.gas]])}
    </section>
    <section class="api-inventory"><div class="section-heading compact-heading"><div><p class="kicker">Gateway REST contract</p><h2>All ${restInventory.total} operations have an operator destination.</h2></div><p>${restInventory.unauthenticated} unauthenticated probes only. Auth is required for every data, proxy, and configuration operation; the signed-in operator's session satisfies it.</p></div><div class="operation-counts"><span><b>${restInventory.counts.probe}</b>Probe</span><span><b>${restInventory.counts.read}</b>Read</span><span><b>${restInventory.counts.proxy}</b>Proxy</span><span><b>${restInventory.counts.write}</b>Write</span></div><div class="operation-groups">${operationGroups.map(([destination, operations]) => `<section><div><h3>${destination}</h3><span>${formatCount(operations.length, "operation")}</span></div>${operations.map((operation) => `<article><code>${operation.id}</code><span>${status(operation.kind, operation.kind === "write" || operation.kind === "proxy" ? "warning" : operation.kind === "probe" ? "empty" : "review")}</span><span><b>${operation.auth === "unauthenticated" ? "Unauthenticated exemption" : "Authenticated contract"}</b><small>${restOperationPosture(operation)}</small></span></article>`).join("")}</section>`).join("")}</div></section>
    <section class="sdk-inventory"><div><p class="kicker">SDK & wire contract inventory</p><h2>Repository evidence wins over the strongest docs claim.</h2><p>Developer contracts remain subordinate to runtime operator evidence.</p></div><div>${sdkModel.map((item) => `<article><span><strong>${item.name}</strong><small>${item.evidence}</small></span>${status(item.label, item.tone)}</article>`).join("")}</div></section>
    <section class="stack-components"><div class="section-heading compact-heading"><div><p class="kicker">Wider Zerker stack</p><h2>Delivery states remain separate.</h2></div><p>These labels describe product contracts, not live integration evidence.</p></div><div class="stack-list">${stack.map((component, index) => `<article><span class="stack-number">${String(index + 1).padStart(2, "0")}</span><span><strong>${component.name}</strong><small>${component.job}</small></span>${status(component.status, component.tone)}<button data-stack="${component.name}" aria-label="Details for ${component.name}">Details <span aria-hidden="true">→</span></button></article>`).join("")}</div></section>
  </section>`;
}

// `overview`, `attention`, `invocations`, `agents`, `credentials`, and
// `policies` are live surfaces, reading (and for `agents`, writing) real
// tenant state through the BFF. Every other view here is still fixture-backed
// and labelled as such — see console/README.md.
const views = { overview: liveOverviewView, attention: liveAttentionView, activity: activityView, invocations: liveInvocationsView, analytics: analyticsView, agents: liveAgentsView, environments: environmentsView, policies: livePoliciesView, credentials: liveCredentialsView, products: productsView, payments: paymentsView, stack: stackView };

const mobilePrimaryViews = new Set(["overview", "invocations", "agents", "stack"]);

function syncNavigation() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    const selected = button.dataset.view === activeView;
    button.classList.toggle("active", selected);
    selected ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
  });
  const currentUnderMore = !mobilePrimaryViews.has(activeView);
  mobileMenuTrigger.classList.toggle("active", currentUnderMore);
  mobileMenuTrigger.setAttribute("aria-label", currentUnderMore ? `More pages, current page: ${labels[activeView]}` : "More pages");
  currentUnderMore ? mobileMenuTrigger.setAttribute("aria-current", "page") : mobileMenuTrigger.removeAttribute("aria-current");
}

function render(view = activeView, { focusMain = false, scroll = true } = {}) {
  activeView = views[view] ? view : "overview";
  main.innerHTML = views[activeView]();
  document.title = `${labels[activeView]} — Zerker Gateway preview`;
  syncNavigation();
  bindPageEvents();
  history.replaceState(null, "", `#${activeView}`);
  if (scroll) {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: scrollBehaviorForMotion(reducedMotion) });
  }
  if (focusMain) main.focus({ preventScroll: true });
}

function navigate(view) {
  render(view, { focusMain: true });
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

function bindGovernanceInspectButtons(scope = main) {
  scope.querySelectorAll("[data-policy-rule]").forEach((button) => button.addEventListener("click", () => openPolicyRule(button.dataset.policyRule)));
  scope.querySelectorAll("[data-policy-decision]").forEach((button) => button.addEventListener("click", () => openPolicyDecision(button.dataset.policyDecision)));
  scope.querySelectorAll("[data-credential]").forEach((button) => button.addEventListener("click", () => openCredential(button.dataset.credential)));
  scope.querySelectorAll("[data-payment]").forEach((button) => button.addEventListener("click", () => openPaymentOperation(button.dataset.payment)));
  scope.querySelectorAll("[data-facilitator]").forEach((button) => button.addEventListener("click", openFacilitatorPosture));
}

function refreshPolicyDecisionResults() {
  const container = main.querySelector("#policy-decision-results");
  const count = main.querySelector("#policy-result-count");
  if (!container || !count) return;
  const result = buildPolicyDecisionResults(policies.decisions, policies.rules, policyDecisionFilters);
  container.innerHTML = policyDecisionRows(result.rows);
  count.innerHTML = `<strong>${result.summary}</strong><small>${result.activeFilters.length ? formatCount(result.activeFilters.length, "active filter") : "Default fixture view"}</small>`;
  bindGovernanceInspectButtons(container);
  container.querySelector("#empty-clear-policy-filters")?.addEventListener("click", () => clearPolicyFilterState(true));
}

function clearPolicyFilterState(focusSearch = false) {
  policyDecisionFilters = { ...defaultPolicyDecisionFilters };
  main.querySelectorAll("[data-policy-filter]").forEach((control) => { control.value = policyDecisionFilters[control.dataset.policyFilter]; });
  refreshPolicyDecisionResults();
  (focusSearch ? main.querySelector("#policy-search") : main.querySelector("#clear-policy-filters"))?.focus();
}

function bindPolicyFilters() {
  const controls = main.querySelectorAll("[data-policy-filter]");
  controls.forEach((control) => {
    control.value = policyDecisionFilters[control.dataset.policyFilter];
    control.addEventListener(control.matches("input") ? "input" : "change", () => {
      policyDecisionFilters = { ...policyDecisionFilters, [control.dataset.policyFilter]: control.value };
      refreshPolicyDecisionResults();
    });
  });
  main.querySelector("#clear-policy-filters")?.addEventListener("click", () => clearPolicyFilterState());
}

function refreshCredentialResults() {
  const container = main.querySelector("#credential-results");
  const count = main.querySelector("#credential-result-count");
  if (!container || !count) return;
  const result = buildCredentialResults(credentials, credentialFilters);
  container.innerHTML = credentialRows(result.rows);
  count.innerHTML = `<strong>${result.summary}</strong><small>${result.activeFilters.length ? formatCount(result.activeFilters.length, "active filter") : "Default fixture view"}</small>`;
  bindGovernanceInspectButtons(container);
  container.querySelector("#empty-clear-credential-filters")?.addEventListener("click", () => clearCredentialFilterState(true));
}

function clearCredentialFilterState(focusSearch = false) {
  credentialFilters = { ...defaultCredentialFilters };
  main.querySelectorAll("[data-credential-filter]").forEach((control) => { control.value = credentialFilters[control.dataset.credentialFilter]; });
  refreshCredentialResults();
  (focusSearch ? main.querySelector("#credential-search") : main.querySelector("#clear-credential-filters"))?.focus();
}

function bindCredentialFilters() {
  const controls = main.querySelectorAll("[data-credential-filter]");
  controls.forEach((control) => {
    control.value = credentialFilters[control.dataset.credentialFilter];
    control.addEventListener(control.matches("input") ? "input" : "change", () => {
      credentialFilters = { ...credentialFilters, [control.dataset.credentialFilter]: control.value };
      refreshCredentialResults();
    });
  });
  main.querySelector("#clear-credential-filters")?.addEventListener("click", () => clearCredentialFilterState());
}

function refreshPaymentResults() {
  const container = main.querySelector("#payment-results");
  const count = main.querySelector("#payment-result-count");
  if (!container || !count) return;
  const result = buildPaymentResults(paymentOperations, paymentFilters, paymentSnapshot.evaluatedAt);
  container.innerHTML = paymentRows(result.rows);
  count.innerHTML = `<strong>${result.summary}</strong><small>${result.activeFilters.length ? formatCount(result.activeFilters.length, "active filter") : "Default fixture view"}</small>`;
  const windowLabel = main.querySelector("[data-fixture-window]");
  if (windowLabel) windowLabel.textContent = paymentRangeLabel(paymentFilters.timeRange);
  bindGovernanceInspectButtons(container);
  container.querySelector("#empty-clear-payment-filters")?.addEventListener("click", () => clearPaymentFilterState(true));
}

function clearPaymentFilterState(focusSearch = false) {
  paymentFilters = { ...defaultPaymentFilters };
  main.querySelectorAll("[data-payment-filter]").forEach((control) => { control.value = paymentFilters[control.dataset.paymentFilter]; });
  refreshPaymentResults();
  (focusSearch ? main.querySelector("#payment-search") : main.querySelector("#clear-payment-filters"))?.focus();
}

function bindPaymentFilters() {
  const controls = main.querySelectorAll("[data-payment-filter]");
  controls.forEach((control) => {
    control.value = paymentFilters[control.dataset.paymentFilter];
    control.addEventListener(control.matches("input") ? "input" : "change", () => {
      paymentFilters = { ...paymentFilters, [control.dataset.paymentFilter]: control.value };
      refreshPaymentResults();
    });
  });
  main.querySelector("#clear-payment-filters")?.addEventListener("click", () => clearPaymentFilterState());
}

function bindPageEvents() {
  main.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
  bindAgentInspectButtons();
  bindInvocationButtons();
  bindGovernanceInspectButtons();
  main.querySelectorAll("[data-environment]").forEach((button) => button.addEventListener("click", () => openEnvironment(button.dataset.environment)));
  main.querySelectorAll("[data-onboarding]").forEach((button) => button.addEventListener("click", () => openOnboardingEvidence(button.dataset.onboarding)));
  main.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => handleAction(button.dataset.action)));
  main.querySelectorAll("[data-stack]").forEach((button) => button.addEventListener("click", () => openStackInfo(button.dataset.stack)));
  main.querySelectorAll("[data-system-detail]").forEach((button) => button.addEventListener("click", () => openSystemPosture(button.dataset.systemDetail)));
  const scenario = main.querySelector("#overview-scenario");
  if (scenario) scenario.addEventListener("change", () => { activeOverviewScenario = scenario.value; render("overview", { scroll: false }); main.querySelector("#overview-scenario")?.focus(); });
  const analyticsWindow = main.querySelector("#analytics-window");
  if (analyticsWindow) analyticsWindow.addEventListener("change", () => { activeAnalyticsWindow = analyticsWindow.value; render("analytics", { scroll: false }); main.querySelector("#analytics-window")?.focus(); });
  const analyticsScenario = main.querySelector("#analytics-scenario");
  if (analyticsScenario) analyticsScenario.addEventListener("change", () => { activeAnalyticsScenario = analyticsScenario.value; render("analytics", { scroll: false }); main.querySelector("#analytics-scenario")?.focus(); });
  bindInvocationFilters();
  bindAgentFilters();
  bindPolicyFilters();
  bindCredentialFilters();
  bindPaymentFilters();
}

function handleAction(action) {
  const concepts = new Set(["add-agent", "connect", "add-credential", "new-product", "product-preview", "settlement-config", "edit-policy", "simulate"]);
  if (action === "privacy") return openPrivacy();
  if (concepts.has(action)) return openConcept(action);
  if (action === "export") return showToast("Preview only — no invocation data was exported.");
  if (action === "mark-reviewed") return showToast("Preview only — the attention queue was not changed.");
}

function openPolicyRule(id) {
  const model = buildPolicyModel(policies);
  const rule = model.rules.find((item) => item.id === id); if (!rule) return;
  const limitation = rule.id === "rule_large_request" ? '<div class="drawer-copy"><strong>Chunked streaming limitation</strong><p><code>max_body_bytes</code> cannot provide the same enforcement when body length is unavailable.</p></div>' : "";
  openDrawer(rule.name, `Order ${String(rule.order).padStart(2, "0")} · policy fixture`, `${status(rule.action, rule.action)}<div class="read-only-banner"><strong>Read-only rule evidence</strong><span>No reorder, edit, enable, disable, or policy write occurs here.</span></div><section class="drawer-section"><h3>Ordered rule</h3>${detailRows([["Rule ID", rule.id], ["Order", String(rule.order).padStart(2, "0")], ["Match dimension", rule.dimension], ["Safe match", rule.match], ["Scope", rule.scope], ["Action", rule.action], ["Decision aggregate", rule.decisions.toLocaleString("en-US")], ["Semantics", rule.action === "warn" ? "Record and forward" : rule.action === "deny" ? "Stop request" : "Forward request"]])}</section>${limitation}<div class="drawer-copy compact"><p>Rules evaluate in order; the first match wins. No fixture request was evaluated by opening this drawer.</p></div>`);
}

function openPolicyDecision(id) {
  const decision = policies.decisions.find((item) => item.id === id); if (!decision) return;
  const rule = policies.rules.find((item) => item.id === decision.ruleID);
  openDrawer(decision.id, `${decision.agent} · policy decision fixture`, `${status(decision.action, decision.action)}<div class="read-only-banner"><strong>Captured decision metadata</strong><span>No request is replayed and no policy state changes.</span></div><section class="drawer-section"><h3>Decision</h3>${detailRows([["Occurred", formatTimestamp(decision.occurredAt)], ["Action", decision.action], ["Semantics", decision.action === "warn" ? "Recorded · request forwarded" : decision.action === "deny" ? "Request stopped" : "Request forwarded"], ["Agent", decision.agent], ["Protocol", decision.protocol.toUpperCase()], ["Method", decision.method], ["Tool", decision.tool ?? "None"], ["Rule", rule ? `${String(rule.order).padStart(2, "0")} · ${rule.name}` : "Configured default"], ["Caller-safe reason", decision.reason], ["Source", decision.source]])}</section><div class="drawer-copy compact"><p>Only decision metadata is present. No body, arguments, outputs, caller token, raw error, header, or internal address is available.</p></div>`);
}

function openCredential(id) {
  const source = credentials.find((item) => item.id === id); if (!source) return;
  const credential = safeCredentialMetadata(source);
  const reference = credentialReferenceState(credential);
  const references = reference.id === "referenced" ? credential.references.join(" · ") : reference.id === "unreferenced" ? "None" : "Unknown";
  const protection = credential.source === "managed" ? "Envelope-encrypted under tenant KEK" : credential.source === "external_vault" ? "Value and path remain external" : "Unknown";
  openDrawer(credential.name ?? "Unknown credential", `${credential.id ?? "Unknown"} · safe metadata fixture`, `${status(credentialSourceLabel(credential), credential.source === "managed" ? "managed" : credential.source === "external_vault" ? "vault" : "unavailable")}<div class="read-only-banner"><strong>Credential value absent</strong><span>No plaintext, token, vault path, reveal, copy, rotate, delete, or input control exists.</span></div><section class="drawer-section"><h3>Allowlisted metadata</h3>${detailRows([["Credential ID", credential.id ?? "Unknown"], ["Name", credential.name ?? "Unknown"], ["Auth type", credentialAuthLabel(credential)], ["Source", credentialSourceLabel(credential)], ["Safe hint", credentialHintLabel(credential)], ["Version", Number.isInteger(credential.version) ? `v${credential.version}` : "Unknown"], ["Created", formatTimestamp(credential.createdAt)], ["Updated", formatTimestamp(credential.updatedAt)], ["Reference state", reference.label], ["Referencing agents", references]])}</section><section class="drawer-section"><h3>Operation posture</h3>${detailRows([["Delete", credentialDeletePosture(credential)], ["Injection", "Resolve only after policy allow"], ["Caller authorization", "Stripped before upstream injection"], ["Protection", protection], ["Tenant KEK rotation", "Internal seam · no public REST operation"]])}</section><div class="drawer-copy compact"><p>The Gateway API supports credential metadata operations, but this preview accepts, issues, replaces, persists, transmits, rotates, or deletes nothing.</p></div>`);
}

function paymentTraceMarkup(operation) {
  return `<div class="trace" aria-label="Ordered payment lifecycle">${derivePaymentTrace(operation).map((stage, index) => `<div class="trace-stage ${stage.state}"><span class="trace-order">0${index + 1}</span><span><strong>${stage.label}</strong><small>${stage.detail}</small></span>${status(stage.state.replaceAll("_", " "), stage.state)}</div>`).join("")}</div>`;
}

function openPaymentOperation(id) {
  const operation = paymentOperations.find((item) => item.id === id); if (!operation) return;
  const diagnosis = derivePaymentDiagnosis(operation);
  const diagnosisMarkup = diagnosis ? `<section class="payment-diagnosis"><div><p class="kicker">Failure diagnosis</p><h3>${diagnosis.stage}</h3><p>${diagnosis.classification}</p></div>${detailRows([["Money", diagnosis.money], ["Upstream", diagnosis.upstream], ["Settlement attempts", diagnosis.settlementAttempts]])}</section>` : "";
  const replay = operation.settlementState === "not_configured" ? '<div class="drawer-copy"><strong>Gate-only replay boundary</strong><p>Replay protection is best effort. Verification is not collection or on-chain nonce consumption.</p></div>' : "";
  openDrawer(operation.id, `${operation.agent} · payment operation fixture`, `${status(paymentSettlementLabel(operation), operation.settlementState === "settlement_failed" || operation.settlementState === "settled_upstream_failed" ? "settlement_failed" : operation.settlementState === "settled" ? "settled" : operation.gateState === "challenged" ? "pending" : "empty")}<div class="read-only-banner"><strong>Captured payment metadata</strong><span>No authorization, payment, settlement, retry, or proxy request occurs here.</span></div>${diagnosisMarkup}<section class="drawer-section"><h3>Lifecycle</h3>${paymentTraceMarkup(operation)}</section><section class="drawer-section"><h3>Safe metadata</h3>${detailRows([["Occurred", formatTimestamp(operation.occurredAt)], ["Agent", operation.agent], ["Operation", operation.operation], ["Amount", `${formatCurrency(operation.amountCents, operation.currency)} · ${operation.asset} · ${operation.network}`], ["Gateway gate", paymentGateLabel(operation)], ["Settlement", paymentSettlementLabel(operation)], ["Upstream", paymentUpstreamLabel(operation)], ["Facilitator", facilitatorModeLabel(operation.facilitatorMode)], ["Invocation", operation.invocationID ?? "None · challenge created no invocation"], ["Masked payer", operation.maskedPayer ?? "Not returned"], ["Settlement attempts", Number.isInteger(operation.settlementAttempts) ? String(operation.settlementAttempts) : "Unknown"]])}</section>${replay}<div class="drawer-copy compact"><p>No signature, nonce, transaction payload, endpoint, credential reference, RPC detail, raw error, or stack trace is present.</p></div>`);
}

function openFacilitatorPosture() {
  openDrawer("Facilitator posture", "Tenant configuration fixture · readiness not claimed", `${status("Self-hosted · Available OSS", "available")}<div class="read-only-banner"><strong>Configuration evidence only</strong><span>No endpoint, credential, account, key, readiness, gas balance, or settlement request is available here.</span></div><section class="drawer-section"><h3>Configuration posture</h3>${detailRows([["Mode", facilitatorModeLabel(facilitatorPosture.mode)], ["Configured", facilitatorPosture.configured ? "Yes · fixture" : "No"], ["Endpoint", facilitatorPosture.endpointConfigured ? "Configured · value not shown" : "Not configured"], ["Credential", facilitatorPosture.credentialConfigured ? "Configured · value not shown" : "Not configured"], ["Captured", formatTimestamp(facilitatorPosture.capturedAt)], ["Per transaction", formatCurrency(facilitatorPosture.perTransactionLimitCents)], ["Daily ceiling", formatCurrency(facilitatorPosture.dailyLimitCents)], ["Fixture daily use", formatCurrency(facilitatorPosture.dailyUsedCents)]])}</section><section class="drawer-section"><h3>Settlement contract</h3><div class="drawer-copy"><strong>Independent verification</strong><p>The facilitator independently re-verifies before settlement. Per-transaction and daily guardrails apply.</p></div><div class="drawer-copy"><strong>Duplicate protection</strong><p>Nonce dedupe and single-flight reduce duplicate settlement; they do not turn gate-only verification into collection.</p></div><div class="drawer-copy"><strong>No custody</strong><p>The facilitator relays gas and never custodies payer or operator funds.</p></div></section><section class="drawer-section"><h3>Delivery truth</h3>${detailRows([["Self-hosted facilitator", deliveryTruthLabel(facilitatorPosture.selfHostedDelivery)], ["Managed facilitator", deliveryTruthLabel(facilitatorPosture.managedDelivery)]])}</section>`);
}

function openAgent(id) {
  const agent = agents.find((item) => item.id === id); if (!agent) return;
  const catalogStatus = deriveCatalogStatus(agent);
  const observer = onboardingForAgent(agent.id);
  const observerMarkup = observer
    ? `<div class="drawer-evidence available-evidence">${status("Available OSS · fixture", "available")}<strong>${observerEvidenceLabel(observer, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs)}</strong><small>Native observer metadata · evidence only, not persistent connectivity</small></div>`
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
  const gateway = environment.surface === "gateway";
  const evidenceState = environmentEvidenceState(environment);
  const evidenceAt = gateway ? environment.probeAt : environment.lastEvidenceAt;
  const countRows = gateway
    ? [["Catalog records", environment.catalogAgents], ["Pending", environment.pendingAgents], ["Suspended", environment.suspendedAgents]]
    : [["Observed", environment.observed], ["Enrolled", environment.enrolled], ["Discovered", environment.discovered]];
  const runtimeRows = gateway ? [["Storage", environment.storage], ["Version", environment.version]] : [];
  openDrawer(
    environment.name,
    `${environment.kind} · environment fixture`,
    `<div class="drawer-statuses">${status("Available OSS · fixture", "available")}${status(stateLabel(evidenceState), evidenceState)}</div>
    <div class="read-only-banner"><strong>Captured evidence</strong><span>This record does not represent a persistent connection.</span></div>
    <section class="drawer-section"><h3>Provenance</h3>${detailRows([["Source", environment.source], ["Delivery", "Available OSS · fixture"], ["Evidence state", stateLabel(evidenceState)], ["Evidence captured", formatTimestamp(evidenceAt)], ["Fixture refreshed", formatTimestamp(environmentSnapshot.refreshedAt)]])}</section>
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
    `<div class="drawer-statuses">${status("Available OSS · fixture", "available")}${status(stateLabel(evidenceState), evidenceState)}</div>
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

function openSystemPosture(id) {
  const common = `<div class="read-only-banner"><strong>Read-only fixture evidence</strong><span>No probe, readiness check, migration, backup, rollout, key operation, configuration change, or external request occurs here.</span></div><div class="drawer-evidence"><strong>${systemSnapshot.source}</strong><small>Fixed fixture refresh · ${formatTimestamp(systemSnapshot.refreshedAt)}</small></div>`;
  const bodies = {
    runtime: {
      title: "Health & build",
      subtitle: `${systemSnapshot.health.source} · fixed capture`,
      body: `${status(systemModel.health.label, "available")}${common}<section class="drawer-section"><h3>Health probe</h3>${detailRows([["Route", systemSnapshot.health.route], ["Authentication", systemSnapshot.health.auth], ["Captured", formatTimestamp(systemSnapshot.health.capturedAt)], ["Subsystems", systemSnapshot.health.subsystems.join(" · ")], ["Boundary", "One captured point · not readiness"]])}</section><section class="drawer-section"><h3>Build metadata</h3>${detailRows([["Route", systemSnapshot.build.route], ["Authentication", systemSnapshot.build.auth], ["Version", systemSnapshot.build.version], ["Commit / build", systemSnapshot.build.commit], ["Captured", formatTimestamp(systemSnapshot.build.capturedAt)], ["Replica samples", String(systemSnapshot.build.replicaSamples)], ["Rollout", systemModel.rollout.label]])}</section><div class="drawer-copy"><strong>Rollout confirmation</strong><p>A single build sample cannot prove every replica matches. Compare deliberate version and commit metadata for each replica externally.</p></div>`,
    },
    storage: {
      title: "Storage & migrations",
      subtitle: "Documented production posture · outcome not evidenced",
      body: `${status("Available OSS posture", "available")}${common}<section class="drawer-section"><h3>Storage contract</h3>${detailRows([["Production", systemSnapshot.storage.production], ["Fallback", systemSnapshot.storage.fallback], ["Migrations", systemSnapshot.storage.migrations], ["Backup", systemSnapshot.storage.backup], ["Upgrades", systemSnapshot.deployment.upgrades]])}</section><div class="drawer-copy"><strong>Evidence boundary</strong><p>Automatic boot behavior does not prove the latest migration succeeded. A documented backup responsibility does not prove a backup exists.</p></div>`,
    },
    kms: {
      title: "KMS & key rotation",
      subtitle: "Configuration metadata fixture · no key material",
      body: `${status(systemModel.kms.label, "review")}${common}<section class="drawer-section"><h3>Encryption posture</h3>${detailRows([["Configuration evidence", systemSnapshot.kms.configurationEvidence], ["Durable requirement", systemSnapshot.kms.requirement], ["Development fallback", systemSnapshot.kms.fallback], ["Master-key rotation", systemSnapshot.kms.masterRotation], ["Tenant KEK rotation", systemSnapshot.kms.tenantRotation]])}</section><div class="drawer-copy"><strong>Credential boundary</strong><p>No key value, length result, hash, source, path, environment value, plaintext, token, or reveal/copy control is present.</p></div>`,
    },
    security: {
      title: "Identity & network",
      subtitle: "Gateway contract invariants · console auth human-gated",
      body: `${status("Available OSS invariants", "available")}${common}<section class="drawer-section"><h3>Trust boundaries</h3>${detailRows([["Gateway API identity", systemSnapshot.security.apiIdentity], ["Console identity", systemSnapshot.security.consoleIdentity], ["Tenant isolation", systemSnapshot.security.tenancy], ["External transport", systemSnapshot.security.transport], ["SSRF", systemSnapshot.security.ssrf], ["Credential injection", systemSnapshot.security.authorization], ["Policy-store outage", systemSnapshot.security.policyOutage]])}</section><div class="drawer-copy"><strong>Authentication boundary</strong><p>Gateway API OIDC configuration is not browser login. This fixture has no authenticated session, token, callback, cookie, CSRF flow, or browser storage.</p></div>`,
    },
    deployment: {
      title: "Scale & rollout",
      subtitle: "Supported operation · live fleet not evidenced",
      body: `${status(systemModel.rollout.label, "warning")}${common}<section class="drawer-section"><h3>Deployment contract</h3>${detailRows([["Artifact", systemSnapshot.deployment.binary], ["Replicas", systemSnapshot.deployment.replicas], ["Rate limits", systemSnapshot.deployment.rateBoundary], ["Graceful allowance", systemSnapshot.deployment.graceful], ["Upgrade path", systemSnapshot.deployment.upgrades], ["Configuration", systemSnapshot.deployment.configuration], ["Sovereignty", systemSnapshot.deployment.sovereignty]])}</section><div class="drawer-copy"><strong>Capacity boundary</strong><p>Horizontal support does not evidence an active replica count. Per-process limits multiply across replicas unless an external shared boundary is introduced.</p></div>`,
    },
    facilitator: {
      title: "Facilitator readiness",
      subtitle: "Configuration fixture · readiness not proved",
      body: `${status(systemModel.facilitator.label, "warning")}${common}<section class="drawer-section"><h3>Configuration versus readiness</h3>${detailRows([["Configuration", systemSnapshot.facilitator.configurationEvidence], ["/supported", systemSnapshot.facilitator.supported], ["Readiness", systemSnapshot.facilitator.readiness], ["Gas", systemSnapshot.facilitator.gas], ["mTLS", systemSnapshot.facilitator.mtls], ["Account mapping", systemSnapshot.facilitator.accountMapping]])}</section><section class="drawer-section"><h3>Settlement and signer contract</h3>${detailRows([["Independent verification", systemSnapshot.facilitator.verification], ["Custody", systemSnapshot.facilitator.custody], ["Local encrypted-keystore signer", systemSnapshot.facilitator.localSigner], ["AWS KMS signer", systemSnapshot.facilitator.awsSigner], ["Self-hosted facilitator", "Available OSS"], ["Managed facilitator", "Commercial"]])}</section><div class="drawer-copy"><strong>Readiness boundary</strong><p>Configured endpoint and credential metadata do not prove supported networks, readiness, gas, signer selection, settlement ability, or chain finality.</p></div>`,
    },
    limitations: {
      title: "Known system limitations",
      subtitle: `${systemModel.limitations.length} documented facts · operator verification required`,
      body: `${status("Readiness constrained", "warning")}${common}<section class="drawer-section"><h3>Limitations inventory</h3>${detailRows(systemModel.limitations.map((item) => [item.title, item.detail]))}</section><div class="drawer-copy"><strong>No remediation action</strong><p>This inventory records contract limits only. It cannot rotate a key, change a rate boundary, recover a policy store, confirm replicas, wire a signer, or probe a facilitator.</p></div>`,
    },
  };
  const item = bodies[id];
  if (!item) return;
  openDrawer(item.title, item.subtitle, item.body);
}

function openStackInfo(name) {
  const component = stack.find((item) => item.name === name); if (!component) return;
  openModal("Zerker stack", component.name, `${status(component.status, component.tone)}<p class="modal-lead">${component.job}</p><div class="availability-note">The status label is the product contract. This preview does not imply a live integration.</div>`);
}

function openPrivacy() {
  openModal("Agent activity", "The privacy boundary", `<div class="privacy-modal"><section><h3>Collected</h3><ul>${privacy.collected.map((item) => `<li>${item}</li>`).join("")}</ul></section><section><h3>Never collected</h3><ul>${privacy.excluded.map((item) => `<li>${item}</li>`).join("")}</ul></section></div><p class="modal-lead">Native adapters fail open. Gateway telemetry must never delay or block normal agent work.</p><div class="availability-note">This contract applies to native agent activity. Proxy invocation body capture is a separate, off-by-default Gateway setting. Reading a captured body requires <code>invocations:read_body</code>, and the body-read response is capped at 1 MiB.</div>`);
}

function openConcept(action) {
  const copy = {
    "add-agent": ["Agent catalog", "Register an agent", "The Gateway API supports tenant-scoped catalog registration. This fixture preview accepts no configuration or credential input and will not write to Gateway."],
    "edit-agent": ["Agent catalog", "Edit agent configuration", "The Gateway API supports catalog updates. This read-only fixture does not change routing, suspension, rates, credentials, pricing, or any other configuration."],
    connect: ["Environments", "Review environment setup", "Local discovery and observe-only enrollment are available in Gateway main. Remote pairing and missions are planned; this fixture performs neither."],
    "add-credential": ["Credentials", "Store credential concept", "The API accepts write-only managed values or external references. This preview contains no fields and accepted, issued, replaced, persisted, or transmitted no credential material."],
    "new-product": ["Product direction", "Create an agent product", "Customer portals, plan management and hosted billing are product direction, not shipped Gateway capabilities."],
    "product-preview": ["Product direction", "Customer portal concept", "A future portal will expose capabilities, documentation, access and optional payment under the operator’s domain."],
    "settlement-config": ["Payments", "Settlement config concept", "Gateway exposes tenant settlement configuration. This preview accepts no URL, credential reference, account, key, guardrail, or secret and changes no configuration."],
    "edit-policy": ["Policies", "Edit policy concept", "Gateway supports replacing the tenant policy. This fixture accepts no policy input and changed no rule, decision, or request."],
    simulate: ["Policies", "Simulate request concept", "A safe policy simulator is not currently exposed by the Gateway API. No request input is accepted, evaluated, or recorded."],
  }[action];
  if (!copy) return;
  openModal(copy[0], copy[1], `<p class="modal-lead">${copy[2]}</p><div class="availability-note"><strong>Preview only.</strong> No mutation, request, credential input, or browser storage write occurred.</div>`);
}

function beginOverlay(type) {
  previousFocus = document.activeElement;
  document.body.classList.add("overlay-open");
  appShell.inert = true;
  skipLink.inert = true;
  searchTrigger.setAttribute("aria-expanded", String(type === "search"));
  mobileMenuTrigger.setAttribute("aria-expanded", String(type === "mobile-menu"));
  if (type === "search") searchTrigger.setAttribute("aria-controls", "overlay-dialog");
  if (type === "mobile-menu") mobileMenuTrigger.setAttribute("aria-controls", "overlay-dialog");
}

function openDrawer(title, subtitle, body) {
  beginOverlay("drawer");
  modalRoot.innerHTML = `<div class="drawer-backdrop" data-close aria-hidden="true"></div><aside id="overlay-dialog" class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><header><div><p class="kicker">Detail</p><h2 id="drawer-title">${title}</h2><p>${subtitle}</p></div><button class="close-button" data-close aria-label="Close ${title}">×</button></header><div class="drawer-body">${body}</div></aside>`;
  bindOverlay();
  modalRoot.querySelector(".close-button").focus();
  modalRoot.querySelectorAll("[data-drawer-action]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.drawerAction;
    const agentName = button.dataset.agentName;
    if (action === "agent-invocations") {
      invocationFilters = { ...defaultInvocationFilters, agent: agentName };
      closeOverlay({ restoreFocus: false });
      navigate("invocations");
      return;
    }
    closeOverlay();
    if (action === "agent-edit") openConcept("edit-agent");
  }));
}

function openModal(kicker, title, body, type = "modal") {
  beginOverlay(type);
  modalRoot.innerHTML = `<div class="modal-backdrop" data-close><section id="overlay-dialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-modal-panel><header><div><p class="kicker">${kicker}</p><h2 id="modal-title">${title}</h2></div><button class="close-button" data-close aria-label="Close ${title}">×</button></header><div class="modal-body">${body}</div></section></div>`;
  bindOverlay();
  modalRoot.querySelector(".close-button").focus();
}

function buildSearchResults(query) {
  const q = query.trim().toLowerCase();
  const pages = Object.entries(labels).filter(([, label]) => !q || label.toLowerCase().includes(q)).slice(0, 5).map(([view, label]) => `<button data-search-view="${view}"><span class="search-icon" aria-hidden="true">↗</span><strong>${label}</strong><small>Admin surface</small></button>`);
  const foundAgents = filterAgents(agents, query).slice(0, 4).map((agent) => `<button data-search-agent="${agent.id}"><span class="search-icon" aria-hidden="true">◎</span><strong>${agent.name}</strong><small>${agent.runtime} · fixture agent</small></button>`);
  const results = [...pages, ...foundAgents];
  return { count: results.length, markup: results.join("") || '<div class="empty-state">Nothing found in fixture pages or agents.</div>' };
}

function openSearch() {
  const initial = buildSearchResults("");
  beginOverlay("search");
  modalRoot.innerHTML = `<div class="modal-backdrop" data-close><section id="overlay-dialog" class="modal command-menu" role="dialog" aria-modal="true" aria-labelledby="command-title" data-modal-panel><h2 id="command-title" class="sr-only">Search Gateway</h2><div class="command-header"><input id="command-input" class="command-input" type="search" placeholder="Search pages and agents…" aria-label="Search fixture pages and agents" aria-controls="command-results" aria-describedby="command-status" autocomplete="off"><button class="close-button" data-close aria-label="Close search">×</button></div><p id="command-status" class="sr-only" role="status" aria-live="polite">${formatCount(initial.count, "result")}</p><div id="command-results" class="command-results">${initial.markup}</div></section></div>`;
  bindOverlay();
  const input = modalRoot.querySelector("#command-input");
  input.addEventListener("input", () => {
    const result = buildSearchResults(input.value);
    modalRoot.querySelector("#command-results").innerHTML = result.markup;
    modalRoot.querySelector("#command-status").textContent = formatCount(result.count, "result");
    bindSearch();
  });
  bindSearch();
  input.focus();
}

function bindSearch() {
  modalRoot.querySelectorAll("[data-search-view]").forEach((button) => button.addEventListener("click", () => {
    const view = button.dataset.searchView;
    closeOverlay({ restoreFocus: false });
    navigate(view);
  }));
  modalRoot.querySelectorAll("[data-search-agent]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.searchAgent;
    closeOverlay();
    openAgent(id);
  }));
}

function openMobileMenu() {
  openModal("Navigate", "All Gateway surfaces", `<div class="mobile-menu-grid">${Object.entries(labels).map(([view, label]) => `<button data-mobile-view="${view}"${view === activeView ? ' class="current" aria-current="page"' : ""}>${label}<span aria-hidden="true">→</span></button>`).join("")}</div>`, "mobile-menu");
  modalRoot.querySelectorAll("[data-mobile-view]").forEach((button) => button.addEventListener("click", () => {
    const view = button.dataset.mobileView;
    closeOverlay({ restoreFocus: false });
    navigate(view);
  }));
}

function bindOverlay() {
  modalRoot.querySelectorAll("[data-close]").forEach((element) => element.addEventListener("click", (event) => {
    if (event.target === element || element.matches("button")) closeOverlay();
  }));
  modalRoot.querySelector("[data-modal-panel]")?.addEventListener("click", (event) => event.stopPropagation());
}

function closeOverlay({ restoreFocus = true } = {}) {
  const focusTarget = previousFocus;
  modalRoot.innerHTML = "";
  document.body.classList.remove("overlay-open");
  appShell.inert = false;
  skipLink.inert = false;
  searchTrigger.setAttribute("aria-expanded", "false");
  mobileMenuTrigger.setAttribute("aria-expanded", "false");
  searchTrigger.removeAttribute("aria-controls");
  mobileMenuTrigger.removeAttribute("aria-controls");
  previousFocus = null;
  if (restoreFocus && focusTarget?.isConnected) focusTarget.focus();
}
function showToast(message) { const toast = document.createElement("div"); toast.className = "toast"; toast.textContent = message; toastRegion.append(toast); window.setTimeout(() => toast.remove(), 3200); }

document.querySelectorAll(".side-nav [data-view], .mobile-nav [data-view]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
document.querySelector("[data-nav='overview']").addEventListener("click", (event) => { event.preventDefault(); navigate("overview"); });
document.querySelector("#open-search").addEventListener("click", openSearch);
document.querySelector("#mobile-menu").addEventListener("click", openMobileMenu);
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!modalRoot.children.length) openSearch();
  }
  if (event.key === "Escape" && modalRoot.children.length) closeOverlay();
  if (event.key === "Tab" && modalRoot.children.length) {
    const focusable = [...modalRoot.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href]")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!modalRoot.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

// Boot is gated: nothing renders until the BFF confirms a session, and an
// expired session drops straight back to sign-in rather than painting a shell
// full of 401s.
function toSignIn(reason) {
  renderSignIn(document.body, { reason });
}

async function boot() {
  const user = await currentSession();
  if (!user) return toSignIn();

  bindLiveAgents({
    rerender: () => render(activeView, { scroll: false }),
    onUnauthenticated: () => toSignIn("expired"),
  });

  const signOutButton = document.querySelector("[data-action='sign-out']");
  if (signOutButton) signOutButton.addEventListener("click", signOut);

  document.querySelectorAll("[data-operator-identity]").forEach((identity) => {
    identity.textContent = user.email || user.name || user.sub;
  });

  try {
    await loadAgents();
  } catch {
    return toSignIn("expired");
  }

  // Started alongside the initial render, not deferred to a first visit to
  // the Needs attention tab — the sidebar badge has to reflect live state
  // for an operator who never opens that tab.
  ensureAttentionLoaded();

  render(location.hash.slice(1) || "overview");
}

boot();
