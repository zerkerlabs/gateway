import "./styles.css";
import { activity, agents, attention, credentials, environments, invocations, overviewMetricSources, overviewScenarios, overviewSnapshot, policies, privacy, products, settlements, stack } from "./data.js";
import { buildOverviewModel, capabilityCounts, filterAgents, formatCount, stateLabel } from "./view-model.js";

const main = document.querySelector("#main-content");
const modalRoot = document.querySelector("#modal-root");
const toastRegion = document.querySelector("#toast-region");
const stackSummary = capabilityCounts(stack);
let activeOverviewScenario = "complete";
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
  return `<div class="data-table invocation-table" role="table" aria-label="Invocations"><div class="table-row table-head" role="row"><span>Invocation</span><span>Agent / operation</span><span>Policy</span><span>Result</span><span>Latency</span><span>Payment</span><span></span></div>${items.map((item) => `<button class="table-row" role="row" data-invocation="${item.id}"><span class="mono">${item.id}</span><span><strong>${item.agent}</strong><small>${item.method}</small></span><span>${status(item.policy, item.policy)}</span><span>${status(item.result, item.result)}</span><span>${item.latency}</span><span>${item.payment}</span><span>→</span></button>`).join("")}</div>`;
}

function invocationsView() {
  return `<section class="page-enter">
    ${pageHeader("Traffic · available OSS", "Invocations", "Every transactional and streaming call, tenant-scoped and addressable by ID.", '<button class="button secondary" data-action="export">Export view</button>')}
    <div class="filter-bar"><input id="invocation-search" type="search" placeholder="Search invocation or agent" aria-label="Search invocations"><select aria-label="Result"><option>All results</option><option>Succeeded</option><option>Failed</option></select><select aria-label="Mode"><option>All modes</option><option>Transactional</option><option>Streaming</option></select><button class="button secondary">Last 24 hours⌄</button></div>
    <section class="panel">${invocationTable(invocations)}</section>
    <div class="footnote"><span>Bodies are off by default.</span><span>Body reads require <code>invocations:read_body</code>.</span><span>Windows are tenant-scoped.</span></div>
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

function agentRows(items) {
  if (!items.length) return '<div class="empty-state">No agents match this view.</div>';
  return items.map((agent) => `<button class="catalog-row" data-agent="${agent.id}"><span class="agent-symbol">${agent.runtime === "Pi" ? "π" : agent.runtime.slice(0,2).toUpperCase()}</span><span><strong>${agent.name}</strong><small>${agent.runtime} · ${agent.environment}</small></span><span><strong>${agent.protocol.toUpperCase()}</strong><small>Protocol</small></span><span><strong>${agent.calls.toLocaleString("en-US")}</strong><small>Calls today</small></span><span><strong>${agent.p95}</strong><small>p95 latency</small></span>${status(stateLabel(agent.state), agent.state)}<span>→</span></button>`).join("");
}

function agentsView() {
  return `<section class="page-enter">
    ${pageHeader("Control · available OSS", "Agent catalog", "The tenant-scoped system of record for every HTTP agent and MCP server.", '<button class="button primary" data-action="add-agent">＋ Register agent</button>')}
    <section class="metric-strip compact"><div><span>6</span><small>Catalog entries</small><em>3 MCP · 2 HTTP · 1 local</em></div><div><span>5</span><small>Credential references</small><em>Secrets never returned</em></div><div><span>2</span><small>Priced agents</small><em>x402 gate active</em></div><div><span>1</span><small>Suspended</small><em>Traffic blocked</em></div></section>
    <div class="filter-bar"><input id="agent-filter" type="search" placeholder="Search name, runtime, environment or protocol" aria-label="Search agents"><select id="agent-state" aria-label="Agent state"><option value="all">All states</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="setup">Needs setup</option></select><button class="button secondary">Protocol⌄</button><button class="button secondary">Tags⌄</button></div>
    <section class="catalog-list" id="catalog-list">${agentRows(agents)}</section>
  </section>`;
}

function environmentsView() {
  return `<section class="page-enter">
    ${pageHeader("Control", "Environments", "Where Gateway and observed agents run. Evidence is not presented as a permanent connection.", '<button class="button primary" data-action="connect">＋ Connect environment</button>')}
    <div class="environment-list">${environments.map((environment) => `<article class="environment-card"><div class="environment-top"><span class="environment-icon">${environment.kind === "Self-hosted" ? "G" : "⌘"}</span>${status(stateLabel(environment.state), "available")}</div><p class="kicker">${environment.kind}</p><h2>${environment.name}</h2><p>${environment.evidence}</p><dl><div><dt>Agents</dt><dd>${environment.agents}</dd></div><div><dt>Storage</dt><dd>${environment.storage}</dd></div><div><dt>Runtime</dt><dd>${environment.version}</dd></div></dl><button class="text-button">Inspect environment →</button></article>`).join("")}<button class="environment-card add-card" data-action="connect"><span>＋</span><h2>Another environment</h2><p>Local discovery is in review. Remote pairing is planned.</p></button></div>
    <div class="availability-banner split"><div><p class="kicker">Enrollment status</p><h2>Reporting is evidence, not connectivity.</h2><p><b>Reporting</b> means an event arrived within five minutes. <b>Quiet</b> means older evidence exists. <b>Enrolled</b> means inventory exists without recent events.</p></div>${status("Contract in PR #46", "review")}</div>
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

function bindPageEvents() {
  main.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => render(button.dataset.view)));
  main.querySelectorAll("[data-agent]").forEach((button) => button.addEventListener("click", () => openAgent(button.dataset.agent)));
  main.querySelectorAll("[data-invocation]").forEach((button) => button.addEventListener("click", () => openInvocation(button.dataset.invocation)));
  main.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => handleAction(button.dataset.action)));
  main.querySelectorAll("[data-stack]").forEach((button) => button.addEventListener("click", () => openStackInfo(button.dataset.stack)));
  const scenario = main.querySelector("#overview-scenario");
  if (scenario) scenario.addEventListener("change", () => { activeOverviewScenario = scenario.value; render("overview"); main.querySelector("#overview-scenario")?.focus(); });
  const query = main.querySelector("#agent-filter");
  const state = main.querySelector("#agent-state");
  if (query && state) {
    const update = () => { main.querySelector("#catalog-list").innerHTML = agentRows(filterAgents(agents, query.value, state.value)); main.querySelectorAll("[data-agent]").forEach((button) => button.addEventListener("click", () => openAgent(button.dataset.agent))); };
    query.addEventListener("input", update); state.addEventListener("change", update);
  }
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
  openDrawer(`${agent.name}`, `${agent.runtime} · ${agent.environment}`, `${status(stateLabel(agent.state), agent.state)}<div class="drawer-grid"><div><strong>${agent.calls.toLocaleString("en-US")}</strong><small>Calls today</small></div><div><strong>${agent.success}</strong><small>Success rate</small></div><div><strong>${agent.p95}</strong><small>p95 latency</small></div><div><strong>${agent.price}</strong><small>Per call</small></div></div><h3>Gateway configuration</h3>${detailRows([["Catalog ID", agent.id], ["Protocol", agent.protocol.toUpperCase()], ["Credential", agent.credential], ["Rate boundary", agent.rate], ["Activity evidence", agent.evidence], ["Receipt setting", agent.receipt]])}<div class="drawer-actions"><button class="button secondary" data-drawer-action="invoke">View invocations</button><button class="button primary" data-drawer-action="edit">Edit configuration</button></div>`);
}

function openInvocation(id) {
  const item = invocations.find((invocation) => invocation.id === id); if (!item) return;
  openDrawer(item.id, `${item.agent} · ${item.time} ago`, `${status(item.result, item.result)}<div class="trace"><div class="done"><span>Identity</span><small>OIDC accepted</small></div><div class="${item.policy === "warn" ? "warn" : "done"}"><span>Policy</span><small>${item.policy}</small></div><div class="done"><span>Payment</span><small>${item.payment === "—" ? "not required" : item.payment}</small></div><div class="${item.result === "failed" ? "failed" : "done"}"><span>Proxy</span><small>${item.result}</small></div><div class="done"><span>Record</span><small>captured</small></div></div><h3>Invocation metadata</h3>${detailRows([["Mode", item.mode], ["Operation", item.method], ["Latency", item.latency], ["Payload size", item.size], ["Policy", item.policy], ["Payment", item.payment]])}<div class="privacy-inline">Request and response bodies are not shown in this preview.</div>`);
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
    "add-agent": ["Agent catalog", "Register an agent", "The API supports catalog registration today. This static admin preview will not write to Gateway."],
    connect: ["Environments", "Connect an environment", "Local discovery and observe-only enrollment are in PR #46. Human-approved remote pairing is planned."],
    "add-credential": ["Credentials", "Store a credential", "The API accepts managed secrets or external vault references. This preview never accepts or stores secret material."],
    "new-product": ["Product direction", "Create an agent product", "Customer portals, plan management and hosted billing are product direction, not shipped Gateway capabilities."],
    "product-preview": ["Product direction", "Customer portal concept", "A future portal will expose capabilities, documentation, access and optional payment under the operator’s domain."],
    "settlement-config": ["Payments", "Settlement configuration", "Gateway can point to a self-hosted or managed facilitator. This preview does not alter the configured URL or credential reference."],
    "edit-policy": ["Policies", "Edit policy document", "Gateway supports replacing the tenant policy today. This preview does not mutate a live policy."],
    simulate: ["Policies", "Simulate a request", "A safe policy simulator is a useful admin capability, but it is not currently exposed by the Gateway API."],
  }[action];
  openModal(copy[0], copy[1], `<p class="modal-lead">${copy[2]}</p><div class="concept-form"><label>Name or objective<input placeholder="Preview only" disabled></label><button class="button primary" disabled>Not connected</button></div>`);
}

function openDrawer(title, subtitle, body) {
  previousFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="drawer-backdrop" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><header><div><p class="kicker">Detail</p><h2 id="drawer-title">${title}</h2><p>${subtitle}</p></div><button class="close-button" data-close aria-label="Close">×</button></header><div class="drawer-body">${body}</div></aside>`;
  bindOverlay();
  modalRoot.querySelector(".close-button").focus();
  modalRoot.querySelectorAll("[data-drawer-action]").forEach((button) => button.addEventListener("click", () => { closeOverlay(); if (button.dataset.drawerAction === "invoke") render("invocations"); else openConcept("add-agent"); }));
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
