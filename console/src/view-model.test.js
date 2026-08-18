import test from "node:test";
import assert from "node:assert/strict";
import { agents, attention, invocations, overviewSnapshot, policies, stack } from "./data.js";
import { capabilityCounts, filterAgents, formatCount, formatCurrency, formatPercent, stateLabel, summarizeAgents, summarizeOverview } from "./view-model.js";

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
});
