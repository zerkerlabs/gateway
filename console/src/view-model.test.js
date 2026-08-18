import test from "node:test";
import assert from "node:assert/strict";
import { agents } from "./data.js";
import { filterAgents, formatCount, stateLabel, summarizeAgents } from "./view-model.js";

test("summarizeAgents keeps evidence states distinct", () => {
  assert.deepEqual(summarizeAgents(agents), { total: 6, reporting: 3, quiet: 2, needsAttention: 1 });
});

test("filterAgents searches names and environments without changing source data", () => {
  assert.deepEqual(filterAgents(agents, "stefan").map((agent) => agent.id), ["hermes", "gemini-cli", "cursor"]);
  assert.deepEqual(filterAgents(agents, "", "quiet").map((agent) => agent.id), ["hermes", "codex"]);
  assert.equal(agents.length, 6);
});

test("unknown states never become reporting", () => {
  assert.equal(stateLabel("reporting"), "Reporting");
  assert.equal(stateLabel("unexpected"), "Unknown");
});

test("formatCount uses human singular and plural labels", () => {
  assert.equal(formatCount(1, "agent"), "1 agent");
  assert.equal(formatCount(3, "agent"), "3 agents");
});
