import test from "node:test";
import assert from "node:assert/strict";
import { agents, attention, environmentSnapshot, invocations, onboardingEvidence, overviewMetricSources, overviewScenarios, overviewSnapshot, policies, stack, trafficSnapshot } from "./data.js";
import { buildAgentResults, buildInvocationResults, buildOverviewModel, capabilityCounts, catalogStatusReason, credentialReferenceLabel, defaultAgentFilters, defaultInvocationFilters, deriveCatalogStatus, deriveDataState, deriveFailureDiagnosis, deriveInvocationTrace, deriveObserverEvidenceState, filterAgents, filterInvocations, formatCount, formatCurrency, formatPercent, formatTimestamp, invocationModeLabel, invocationPaymentLabel, invocationRelativeLabel, invocationTimestampLabel, metricValueState, observerEvidenceLabel, pricingLabel, protocolLabel, protocolTransportLabel, rateBoundaryLabel, stateLabel, summarizeAgents, summarizeOverview } from "./view-model.js";

test("catalog status derivation preserves pending, active, inactive, and suspension independence", () => {
  assert.equal(deriveCatalogStatus({ upstreamConfigured: false, inactiveAt: null }), "pending");
  assert.equal(deriveCatalogStatus({ upstreamConfigured: true, inactiveAt: null }), "active");
  assert.equal(deriveCatalogStatus({ upstreamConfigured: true, inactiveAt: "2026-08-12T17:10:00Z" }), "inactive");
  assert.equal(deriveCatalogStatus({ upstreamConfigured: false, inactiveAt: "2026-08-12T17:10:00Z" }), "inactive");
  assert.equal(deriveCatalogStatus({}), "unknown");
  assert.match(catalogStatusReason({ upstreamConfigured: false, inactiveAt: null }), /no upstream/i);

  const suspended = agents.find((agent) => agent.id === "agt_codegen");
  assert.equal(deriveCatalogStatus(suspended), "active");
  assert.equal(suspended.suspended, true);
  assert.deepEqual(summarizeAgents(agents), { total: 7, active: 5, pending: 1, inactive: 1, suspended: 1, needsAttention: 2, calls: 1256, failures: 16 });
});

test("catalog filters use safe dimensions, AND semantics, and never mutate source fixtures", () => {
  const sourceOrder = agents.map((agent) => agent.id);
  assert.deepEqual(filterAgents(agents, { query: "  MCP " }).map((agent) => agent.id), ["agt_research", "agt_release", "agt_docs"]);
  assert.deepEqual(filterAgents(agents, { query: "AGT_TRIAGE" }).map((agent) => agent.id), ["agt_triage"]);
  assert.deepEqual(filterAgents(agents, { status: "pending" }).map((agent) => agent.id), ["agt_triage"]);
  assert.deepEqual(filterAgents(agents, { status: "inactive" }).map((agent) => agent.id), ["agt_legacy"]);
  assert.deepEqual(filterAgents(agents, { protocol: "mcp" }).map((agent) => agent.id), ["agt_research", "agt_release", "agt_docs"]);
  assert.deepEqual(filterAgents(agents, { suspension: "suspended" }).map((agent) => agent.id), ["agt_codegen"]);
  assert.deepEqual(filterAgents(agents, { query: "code", status: "active", protocol: "http", suspension: "suspended" }).map((agent) => agent.id), ["agt_codegen"]);
  assert.deepEqual(filterAgents(agents, { status: "pending", protocol: "mcp" }), []);
  assert.deepEqual(agents.map((agent) => agent.id), sourceOrder);
});

test("catalog result model preserves default, active-filter, and truthful zero-result shapes", () => {
  const all = buildAgentResults(agents, defaultAgentFilters);
  assert.equal(all.summary, "7 of 7 fixture catalog agents");
  assert.deepEqual(all.activeFilters, []);
  const zero = buildAgentResults(agents, { ...defaultAgentFilters, query: "missing fixture row", protocol: "mcp" });
  assert.deepEqual(zero.rows, []);
  assert.equal(zero.summary, "0 of 7 fixture catalog agents");
  assert.deepEqual(zero.activeFilters, ["query", "protocol"]);
});

test("catalog labels keep protocol, rate, credential reference, and pricing truth explicit", () => {
  const http = agents.find((agent) => agent.id === "agt_support");
  const mcp = agents.find((agent) => agent.id === "agt_research");
  const pending = agents.find((agent) => agent.id === "agt_triage");
  assert.equal(protocolLabel(http.protocol), "HTTP");
  assert.equal(protocolLabel(mcp.protocol), "MCP");
  assert.equal(protocolLabel("local"), "Unknown");
  assert.equal(protocolTransportLabel(mcp), "Streamable HTTP");
  assert.equal(protocolTransportLabel({ protocol: "mcp", mcpTransport: "stdio" }), "Unknown");
  assert.equal(rateBoundaryLabel(http), "2 req/s · burst 20");
  assert.equal(rateBoundaryLabel(pending), "Not configured");
  assert.equal(rateBoundaryLabel({}), "Unknown");
  assert.equal(credentialReferenceLabel(http), "Reference · support-production");
  assert.equal(credentialReferenceLabel(pending), "None");
  assert.equal(credentialReferenceLabel({}), "Unknown");
  assert.equal(pricingLabel(mcp), "x402 exact · $0.25 / call");
  assert.equal(pricingLabel(http), "Unpriced");
  assert.equal(pricingLabel({}), "Unknown");
});

test("observer evidence uses only the fixed fixture clock at reporting and quiet boundaries", () => {
  const states = onboardingEvidence.map((evidence) => deriveObserverEvidenceState(evidence, environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs));
  assert.deepEqual(states, ["reporting", "quiet", "enrolled", "discovered"]);
  const boundary = { enrollmentState: "enrolled", lastEventAt: "2026-08-18T09:07:00Z" };
  assert.equal(deriveObserverEvidenceState(boundary, environmentSnapshot.evaluatedAt, 5 * 60 * 1000), "reporting");
  assert.equal(deriveObserverEvidenceState({ ...boundary, lastEventAt: "2026-08-18T09:06:59.999Z" }, environmentSnapshot.evaluatedAt, 5 * 60 * 1000), "quiet");
  assert.equal(deriveObserverEvidenceState({ enrollmentState: "enrolled", lastEventAt: "2026-08-18T09:13:00Z" }, environmentSnapshot.evaluatedAt, 5 * 60 * 1000), "unknown");
  assert.equal(observerEvidenceLabel(onboardingEvidence[0], environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs), "Reporting · event 18 Aug 2026 · 09:10 UTC");
  assert.equal(observerEvidenceLabel(onboardingEvidence[2], environmentSnapshot.evaluatedAt, environmentSnapshot.observerRecentWithinMs), "Enrolled · no recent event evidence");
});

test("unknown states never become active", () => {
  assert.equal(stateLabel("active"), "Active");
  assert.equal(stateLabel("discovered"), "Discovered");
  assert.equal(stateLabel("unexpected"), "Unknown");
});

test("capability counts preserve honest delivery states", () => {
  assert.deepEqual(capabilityCounts(stack), { total: 9, available: 2, review: 1, standalone: 1, integration: 2, planned: 3 });
});

test("formatCount uses human singular and plural labels", () => {
  assert.equal(formatCount(1, "agent"), "1 agent");
  assert.equal(formatCount(1256, "call"), "1,256 calls");
});

test("overview summary derives operator metrics from fixtures", () => {
  assert.deepEqual(summarizeOverview({ agents, invocations, attention, policies, snapshot: overviewSnapshot }), {
    attentionCount: 3,
    totalCalls: 1256,
    failedCalls: 16,
    failureRate: "1.3%",
    warnedDecisions: 7,
    deniedDecisions: 2,
    reviewDecisions: 9,
    paymentVolume: "$12.40",
    latestFailures: 1,
  });
});

test("overview metric formatters preserve unknown and zero states", () => {
  assert.equal(formatCurrency(0), "$0.00");
  assert.equal(formatCurrency(undefined), "Unknown");
  assert.equal(formatPercent(0, 1256), "0.0%");
  assert.equal(formatPercent(0, 0), "Unknown");
  assert.equal(metricValueState(0), "zero");
  assert.equal(metricValueState(null), "unknown");
  assert.equal(metricValueState(12, false), "unavailable");
  assert.equal(formatTimestamp("2026-08-18T09:10:00Z"), "18 Aug 2026 · 09:10 UTC");
});

test("data state precedence keeps availability states distinct", () => {
  const base = { completeness: "complete", recordCount: 0, hasUsableData: false, refreshedAt: "2026-08-18T09:10:00Z", evaluatedAt: "2026-08-18T09:12:00Z", staleAfterMs: 15 * 60 * 1000 };
  assert.deepEqual(deriveDataState({ ...base, phase: "loading" }), { availability: "loading", freshness: "unknown" });
  assert.deepEqual(deriveDataState({ ...base, phase: "error" }), { availability: "error", freshness: "unknown" });
  assert.deepEqual(deriveDataState({ ...base, phase: "unavailable" }), { availability: "unavailable", freshness: "unknown" });
  assert.deepEqual(deriveDataState({ ...base, phase: "ready" }), { availability: "empty", freshness: "current" });
  assert.deepEqual(deriveDataState({ ...base, phase: "ready", completeness: "partial", recordCount: 4, hasUsableData: true }), { availability: "partial", freshness: "current" });
  assert.deepEqual(deriveDataState({ ...base, phase: "ready", completeness: "partial" }), { availability: "unavailable", freshness: "unknown" });
  assert.deepEqual(deriveDataState({ ...base, phase: "ready", recordCount: 4, hasUsableData: true }), { availability: "ready", freshness: "current" });
});

test("freshness uses fixed clocks and becomes stale only beyond the boundary", () => {
  const base = { phase: "ready", completeness: "complete", recordCount: 1, hasUsableData: true, evaluatedAt: "2026-08-18T09:15:00Z", staleAfterMs: 5 * 60 * 1000 };
  assert.equal(deriveDataState({ ...base, refreshedAt: "2026-08-18T09:10:00Z" }).freshness, "current");
  assert.equal(deriveDataState({ ...base, refreshedAt: "2026-08-18T09:09:59Z" }).freshness, "stale");
  assert.equal(deriveDataState({ ...base, refreshedAt: undefined }).freshness, "unknown");
  assert.deepEqual(deriveDataState({ ...base, completeness: "partial", refreshedAt: "2026-08-18T09:09:59Z" }), { availability: "partial", freshness: "stale" });
});

function overviewModel(scenarioID) {
  const scenario = overviewScenarios.find((item) => item.id === scenarioID);
  return buildOverviewModel({ agents, invocations, attention, policies, snapshot: overviewSnapshot, sources: overviewMetricSources, scenario });
}

test("overview scenarios expose the exact state matrix consumed by the UI", () => {
  assert.deepEqual(overviewScenarios.map((scenario) => scenario.label), ["Complete fixture", "Loading", "Empty", "Stale", "Unavailable", "Partial", "Error"]);
  assert.deepEqual(overviewScenarios.map((scenario) => overviewModel(scenario.id).state.availability), ["ready", "loading", "empty", "ready", "unavailable", "partial", "error"]);
  assert.equal(overviewModel("stale").state.freshness, "stale");
  assert.equal(overviewModel("unavailable").state.freshness, "unknown");
});

test("complete overview metrics include source and refresh evidence", () => {
  const model = overviewModel("complete");
  assert.deepEqual(model.metrics.map(({ id, display, valueState }) => ({ id, display, valueState })), [
    { id: "attention", display: "3", valueState: "available" },
    { id: "traffic", display: "1,256", valueState: "available" },
    { id: "failures", display: "16", valueState: "available" },
    { id: "policy", display: "9", valueState: "available" },
    { id: "payment", display: "$12.40", valueState: "available" },
  ]);
  assert.ok(model.metrics.every((metric) => metric.evidence.source.endsWith("fixture")));
  assert.ok(model.metrics.every((metric) => metric.evidence.lastRefresh.includes("UTC")));
});

test("empty is known zero while partial missing cost is unknown", () => {
  const empty = overviewModel("empty");
  assert.ok(empty.metrics.every((metric) => metric.valueState === "zero"));
  assert.ok(empty.metrics.every((metric) => metric.actionable === false));
  assert.equal(empty.metrics.find((metric) => metric.id === "payment").display, "$0.00");
  assert.deepEqual(empty.attentionItems, []);
  assert.deepEqual(empty.invocationItems, []);

  const partial = overviewModel("partial");
  assert.equal(partial.metrics.find((metric) => metric.id === "traffic").display, "1,256");
  assert.equal(partial.metrics.find((metric) => metric.id === "traffic").actionable, true);
  assert.equal(partial.metrics.find((metric) => metric.id === "payment").display, "Unknown");
  assert.equal(partial.metrics.find((metric) => metric.id === "payment").actionable, false);
  assert.equal(partial.metrics.find((metric) => metric.id === "payment").valueState, "unavailable");
  assert.deepEqual(partial.unavailableSourceLabels, ["Attention fixture", "Policy decision fixture", "Settlement fixture"]);
  assert.equal(partial.attentionItems, null);
  assert.equal(partial.invocationItems.length, 5);
});

test("stale overview retains values and marks every source and runtime as last-known", () => {
  const stale = overviewModel("stale");
  assert.equal(stale.metrics.find((metric) => metric.id === "payment").display, "$12.40");
  assert.ok(stale.metrics.every((metric) => metric.evidence.freshness === "stale"));
  assert.equal(stale.runtime.label, "Last known healthy · stale");
  assert.match(stale.runtime.detail, /^Last refreshed /);
});

test("invocation labels keep mode, time, and payment semantics explicit", () => {
  assert.equal(invocationModeLabel("transaction"), "Transactional");
  assert.equal(invocationModeLabel("stream"), "Streaming");
  assert.equal(invocationModeLabel("other"), "Unknown");
  assert.equal(invocationPaymentLabel(invocations[0]), "Not required");
  assert.equal(invocationPaymentLabel(invocations[2]), "Verified · $0.25");
  assert.equal(invocationPaymentLabel({ paymentState: "unknown" }), "Unknown");
  assert.equal(invocationTimestampLabel("2026-08-18T09:03:00Z"), "18 Aug · 09:03 UTC");
  assert.equal(invocationRelativeLabel("2026-08-18T09:03:00Z", trafficSnapshot.evaluatedAt), "9m before fixture refresh");
});

test("invocation filters cover every dimension with AND semantics", () => {
  const at = trafficSnapshot.evaluatedAt;
  assert.deepEqual(filterInvocations(invocations, { query: "  code GENERATOR " }, at).map((item) => item.id), ["inv_7HE8"]);
  assert.deepEqual(filterInvocations(invocations, { query: "check_release" }, at).map((item) => item.id), ["inv_7HF2"]);
  assert.deepEqual(filterInvocations(invocations, { result: "failed" }, at).map((item) => item.id), ["inv_7HE8"]);
  assert.deepEqual(filterInvocations(invocations, { mode: "stream" }, at).map((item) => item.id), ["inv_7HF3", "inv_7HF1"]);
  assert.deepEqual(filterInvocations(invocations, { agent: "Docs search" }, at).map((item) => item.id), ["inv_7HE9"]);
  assert.deepEqual(filterInvocations(invocations, { policy: "warn" }, at).map((item) => item.id), ["inv_7HE9"]);
  assert.deepEqual(filterInvocations(invocations, { payment: "verified" }, at).map((item) => item.id), ["inv_7HF1", "inv_7HE9"]);
  assert.deepEqual(filterInvocations(invocations, { result: "failed", mode: "transaction", agent: "Code generator", policy: "allow", payment: "not_required" }, at).map((item) => item.id), ["inv_7HE8"]);
});

test("invocation time filtering includes the boundary and never mutates fixtures", () => {
  const sourceOrder = invocations.map((item) => item.id);
  const boundary = { ...invocations[0], id: "inv_boundary", occurredAt: "2026-08-18T09:07:00Z" };
  const reversed = [boundary, ...invocations].toReversed();
  const filtered = filterInvocations(reversed, { timeRange: "5m" }, trafficSnapshot.evaluatedAt);
  assert.deepEqual(filtered.map((item) => item.id), ["inv_7HF3", "inv_7HF2", "inv_7HF1", "inv_7HE9", "inv_boundary"]);
  assert.deepEqual(invocations.map((item) => item.id), sourceOrder);
  assert.deepEqual(reversed.map((item) => item.id), ["inv_7HE8", "inv_7HE9", "inv_7HF1", "inv_7HF2", "inv_7HF3", "inv_boundary"]);
});

test("invocation result model preserves a truthful zero-result state and active filters", () => {
  const result = buildInvocationResults(invocations, { ...defaultInvocationFilters, query: "missing fixture row", result: "failed" }, trafficSnapshot.evaluatedAt);
  assert.deepEqual(result.rows, []);
  assert.equal(result.summary, "0 of 5 fixture invocations");
  assert.deepEqual(result.activeFilters, ["query", "result"]);
});

test("failed invocation trace diagnoses the safe failure stage and still records metadata", () => {
  const failed = invocations.find((item) => item.id === "inv_7HE8");
  assert.deepEqual(deriveInvocationTrace(failed).map(({ id, state }) => ({ id, state })), [
    { id: "identity", state: "completed" },
    { id: "policy", state: "completed" },
    { id: "payment", state: "skipped" },
    { id: "proxy", state: "failed" },
    { id: "record", state: "completed" },
  ]);
  assert.deepEqual(deriveFailureDiagnosis(failed), { stage: "Proxy", classification: "Upstream timeout", upstreamStatus: "No upstream response/status", retryability: "Unknown" });
  const paidTrace = deriveInvocationTrace(invocations.find((item) => item.id === "inv_7HF1"));
  assert.match(paidTrace.find((stage) => stage.id === "payment").detail, /^Verified · \$0\.25 authorization$/);
  assert.doesNotMatch(paidTrace.find((stage) => stage.id === "payment").detail, /settled/i);
});
