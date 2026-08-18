import test from "node:test";
import assert from "node:assert/strict";
import { agents, attention, invocations, overviewMetricSources, overviewScenarios, overviewSnapshot, policies, stack } from "./data.js";
import { buildOverviewModel, capabilityCounts, deriveDataState, filterAgents, formatCount, formatCurrency, formatPercent, formatTimestamp, metricValueState, stateLabel, summarizeAgents, summarizeOverview } from "./view-model.js";

test("summarizeAgents keeps catalog states distinct", () => {
  assert.deepEqual(summarizeAgents(agents), { total: 6, active: 4, suspended: 1, needsAttention: 1, calls: 1256, failures: 16 });
});

test("filterAgents searches control-plane dimensions without changing source data", () => {
  assert.deepEqual(filterAgents(agents, "mcp").map((agent) => agent.id), ["agt_research", "agt_release", "agt_docs"]);
  assert.deepEqual(filterAgents(agents, "stefan").map((agent) => agent.id), ["agt_research", "agt_docs", "agt_cursor"]);
  assert.deepEqual(filterAgents(agents, "", "suspended").map((agent) => agent.id), ["agt_codegen"]);
  assert.equal(agents.length, 6);
});

test("unknown states never become active", () => {
  assert.equal(stateLabel("active"), "Active");
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
