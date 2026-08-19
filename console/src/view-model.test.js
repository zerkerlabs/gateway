import test from "node:test";
import assert from "node:assert/strict";
import { agents, analyticsScenarios, analyticsSnapshot, analyticsWindows, attention, credentials, environmentSnapshot, facilitatorPosture, invocations, onboardingEvidence, overviewMetricSources, overviewScenarios, overviewSnapshot, paymentOperations, paymentSnapshot, policies, restOperations, sdkInventory, stack, systemLimitations, systemSnapshot, trafficSnapshot } from "./data.js";
import { analyticsTTFTLabel, buildAgentResults, buildAnalyticsModel, buildCredentialResults, buildInvocationResults, buildOverviewModel, buildPaymentResults, buildPolicyDecisionResults, buildPolicyModel, buildRestInventory, buildSDKInventory, buildSystemModel, capabilityCounts, catalogStatusReason, credentialAuthLabel, credentialDeletePosture, credentialHintLabel, credentialReferenceLabel, credentialReferenceState, credentialSourceLabel, defaultAgentFilters, defaultCredentialFilters, defaultInvocationFilters, defaultPaymentFilters, defaultPolicyDecisionFilters, deliveryTruthLabel, deriveCatalogStatus, deriveDataState, deriveFailureDiagnosis, deriveInvocationTrace, deriveObserverEvidenceState, derivePaymentDiagnosis, derivePaymentTrace, facilitatorModeLabel, filterAgents, filterCredentials, filterInvocations, filterPaymentOperations, filterPolicyDecisions, formatAnalyticsDuration, formatCount, formatCurrency, formatPercent, formatTimestamp, invocationModeLabel, invocationPaymentLabel, invocationRelativeLabel, invocationTimestampLabel, metricValueState, observerEvidenceLabel, paymentGateLabel, paymentSettlementLabel, paymentUpstreamLabel, pricingLabel, protocolLabel, protocolTransportLabel, rateBoundaryLabel, safeCredentialMetadata, scrollBehaviorForMotion, stateLabel, summarizeAgents, summarizeOverview, summarizePayments, validateAnalyticsWindow, validatePercentiles } from "./view-model.js";

test("analytics windows require fixed valid since values and enforce the inclusive 31-day boundary", () => {
  assert.deepEqual(validateAnalyticsWindow({ since: "2026-07-18T09:12:00Z", until: "2026-08-18T09:12:00Z" }), { valid: true, durationMs: 31 * 24 * 60 * 60 * 1000 });
  assert.equal(validateAnalyticsWindow({ since: "2026-07-18T09:11:59.999Z", until: "2026-08-18T09:12:00Z" }).valid, false);
  assert.equal(validateAnalyticsWindow({ since: "", until: analyticsSnapshot.evaluatedAt }).valid, false);
  assert.equal(validateAnalyticsWindow({ since: "2026-08-18T09:12:00.001Z", until: analyticsSnapshot.evaluatedAt }).valid, false);
  assert.ok(Object.values(analyticsWindows).every((window) => validateAnalyticsWindow(window, analyticsSnapshot.maxWindowDays).valid));
});

test("analytics percentile and duration formatting never invents invalid or empty samples", () => {
  assert.deepEqual(validatePercentiles({ p50: 620, p95: 1800, p99: 8600 }), { valid: true, state: "available" });
  assert.deepEqual(validatePercentiles({ p50: 900, p95: 800, p99: 1000 }), { valid: false, state: "unknown" });
  assert.deepEqual(validatePercentiles({ p50: 1, p95: null, p99: 3 }), { valid: false, state: "unknown" });
  assert.equal(formatAnalyticsDuration(1800), "1.8s");
  assert.equal(formatAnalyticsDuration(720), "720ms");
  assert.equal(formatAnalyticsDuration(null), "Unknown");
  assert.equal(formatAnalyticsDuration(0, "no_samples"), "No samples");
  assert.equal(formatAnalyticsDuration(0, "not_applicable"), "Not applicable");
});

function analyticsModel(scenarioID, windowID = "24h") {
  return buildAnalyticsModel({ snapshot: analyticsSnapshot, windows: analyticsWindows, scenario: analyticsScenarios.find((item) => item.id === scenarioID), windowID });
}

test("complete analytics fixtures reconcile aggregate, agent, operation, and safe taxonomy totals", () => {
  for (const windowID of Object.keys(analyticsWindows)) {
    const model = analyticsModel("complete", windowID);
    assert.equal(model.availability, "complete");
    assert.deepEqual(model.integrity, { valid: true, latencyValid: true, ttftValid: true, agentsMatch: true, operationsMatch: true, taxonomyMatches: true });
    assert.equal(model.taxonomy.reduce((sum, item) => sum + item.count, 0), model.aggregate.errors);
    assert.equal(model.agents.reduce((sum, item) => sum + item.count, 0), model.aggregate.count);
    assert.equal(model.operations.reduce((sum, item) => sum + item.count, 0), model.aggregate.count);
  }
  assert.equal(analyticsModel("complete").countDisplay, "1,256");
  assert.equal(analyticsModel("complete").errorRate, "1.3%");
  assert.deepEqual(analyticsModel("complete").latency, { p50: "620ms", p95: "1.8s", p99: "8.6s", state: "available" });
});

test("analytics states preserve known zero, partial, unavailable, and safe error semantics", () => {
  const empty = analyticsModel("empty");
  assert.equal(empty.countDisplay, "0");
  assert.equal(empty.errorDisplay, "0");
  assert.equal(empty.errorRate, "No calls");
  assert.deepEqual(empty.latency, { p50: "No samples", p95: "No samples", p99: "No samples", state: "no_samples" });
  assert.deepEqual(empty.ttft, { p50: "No samples", p95: "No samples", p99: "No samples", state: "no_samples" });
  assert.deepEqual(empty.agents, []);
  const partial = analyticsModel("partial");
  assert.equal(partial.countDisplay, "1,256");
  assert.equal(partial.errorDisplay, "16");
  assert.equal(partial.aggregate.streamingSamples, null);
  assert.equal(partial.latency.p95, "Unavailable");
  assert.equal(partial.agents, null);
  assert.equal(analyticsModel("unavailable").countDisplay, "Unknown");
  assert.match(analyticsModel("error").publicMessage, /No Gateway request/);
});

test("analytics TTFT applicability distinguishes streaming evidence from non-streaming operations", () => {
  const streaming = analyticsWindows["24h"].operations.find((item) => item.streaming);
  const transactional = analyticsWindows["24h"].operations.find((item) => item.streaming === false);
  assert.equal(analyticsTTFTLabel(streaming), "480ms");
  assert.equal(analyticsTTFTLabel(transactional), "Not applicable");
  assert.equal(analyticsTTFTLabel({ streamingSamples: 0 }), "No streaming samples");
  assert.equal(analyticsTTFTLabel(streaming, false), "Unavailable");
});

test("analytics model reads fixed fixtures without mutating their source order or values", () => {
  const before = JSON.stringify({ analyticsSnapshot, analyticsWindows, analyticsScenarios });
  analyticsModel("complete", "31d");
  analyticsModel("partial", "1h");
  assert.equal(JSON.stringify({ analyticsSnapshot, analyticsWindows, analyticsScenarios }), before);
});

test("system posture never promotes one probe, configuration, or one build sample to readiness", () => {
  const model = buildSystemModel(systemSnapshot, systemLimitations);
  assert.deepEqual(model.health, { id: "captured_healthy", label: "Healthy · captured fixture" });
  assert.deepEqual(model.rollout, { id: "unconfirmed", label: "Unconfirmed · one fixture build sample" });
  assert.deepEqual(model.facilitator, { id: "not_proved", label: "Configured · readiness not proved" });
  assert.deepEqual(model.kms, { id: "configured_fixture", label: "Configured · fixture metadata only" });
  assert.equal(model.limitations.length, 7);
  assert.match(systemSnapshot.kms.masterRotation, /Unsupported/);
  assert.match(systemSnapshot.kms.fallback, /development only/);
});

test("REST inventory contains the exact unique contract classes, auth exemptions, and destinations", () => {
  const model = buildRestInventory(restOperations);
  assert.equal(model.valid, true);
  assert.equal(model.total, 23);
  assert.equal(model.unique, 23);
  assert.equal(model.unauthenticated, 2);
  assert.deepEqual(model.counts, { probe: 2, read: 10, proxy: 3, write: 8 });
  assert.deepEqual(restOperations.map((item) => item.id), ["getHealthz", "getVersion", "createAgent", "listAgents", "getAgent", "updateAgent", "deleteAgent", "createCredential", "listCredentials", "getCredential", "putCredential", "deleteCredential", "transactInvocation", "streamInvocation", "pollInvocation", "listInvocations", "getInvocation", "getAnalytics", "getSettlementConfig", "patchSettlementConfig", "getPolicy", "putPolicy", "listPolicyDecisions"]);
  assert.deepEqual(restOperations.filter((item) => item.auth === "unauthenticated").map((item) => item.id), ["getHealthz", "getVersion"]);
  assert.ok(restOperations.every((item) => item.destination));
  assert.equal(buildRestInventory([...restOperations, restOperations[0]]).valid, false);
});

test("SDK inventory preserves repository evidence, discrepancy, and developer-only states", () => {
  const model = buildSDKInventory(sdkInventory);
  assert.equal(model.find((item) => item.id === "go").label, "Available · repository-evidenced");
  assert.equal(model.find((item) => item.id === "typescript").label, "Docs/repository discrepancy · not evidenced");
  assert.equal(model.find((item) => item.id === "wire").label, "Developer-only inventory");
  assert.notEqual(model.find((item) => item.id === "typescript").tone, "available");
});

test("system and operation models do not mutate source fixtures", () => {
  const before = JSON.stringify({ systemSnapshot, systemLimitations, restOperations, sdkInventory });
  buildSystemModel(systemSnapshot, systemLimitations);
  buildRestInventory(restOperations);
  buildSDKInventory(sdkInventory);
  assert.equal(JSON.stringify({ systemSnapshot, systemLimitations, restOperations, sdkInventory }), before);
});

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

test("scroll behavior respects the reduced-motion preference deterministically", () => {
  assert.equal(scrollBehaviorForMotion(true), "auto");
  assert.equal(scrollBehaviorForMotion(false), "smooth");
  assert.equal(scrollBehaviorForMotion(undefined), "smooth");
});

test("policy model preserves order, aggregate action counts, defaults, and fail-closed posture", () => {
  const sourceOrder = policies.rules.map((rule) => rule.id);
  const model = buildPolicyModel(policies);
  assert.deepEqual(model.rules.map((rule) => rule.order), [1, 2, 3, 4]);
  assert.deepEqual(model.actionCounts, { allow: 41, warn: 7, deny: 2 });
  assert.equal(model.rules.find((rule) => rule.id === "rule_research_rate").decisions, 0);
  assert.equal(model.defaultAction, "allow");
  assert.equal(model.onErrorAction, "deny");
  assert.equal(model.outagePosture, "fail_closed");
  assert.deepEqual(policies.rules.map((rule) => rule.id), sourceOrder);
  assert.deepEqual(buildPolicyModel({ default: "unexpected", onError: null, rules: [] }), { rules: [], actionCounts: { allow: 0, warn: 0, deny: 0 }, defaultAction: "unknown", onErrorAction: "unknown", outagePosture: "unknown" });
});

test("policy decision filters use AND semantics, fixed ordering, and truthful zero results", () => {
  const sourceOrder = policies.decisions.map((decision) => decision.id);
  assert.deepEqual(filterPolicyDecisions(policies.decisions, policies.rules, { query: "  SEARCH_docs " }).map((decision) => decision.id), ["dec_205"]);
  assert.deepEqual(filterPolicyDecisions([...policies.decisions].reverse(), policies.rules).map((decision) => decision.id), ["dec_205", "dec_204", "dec_203", "dec_202", "dec_201"]);
  assert.deepEqual(filterPolicyDecisions(policies.decisions, policies.rules, { action: "deny" }).map((decision) => decision.id), ["dec_204"]);
  assert.deepEqual(filterPolicyDecisions(policies.decisions, policies.rules, { rule: "default" }).map((decision) => decision.id), ["dec_202"]);
  assert.deepEqual(filterPolicyDecisions(policies.decisions, policies.rules, { query: "support", action: "warn", rule: "rule_large_request" }).map((decision) => decision.id), ["dec_201"]);
  assert.deepEqual(policies.decisions.map((decision) => decision.id), sourceOrder);
  const zero = buildPolicyDecisionResults(policies.decisions, policies.rules, { ...defaultPolicyDecisionFilters, query: "missing", action: "deny" });
  assert.equal(zero.summary, "0 of 5 fixture policy decisions");
  assert.deepEqual(zero.activeFilters, ["query", "action"]);
});

test("credential display metadata is allowlisted and never copies unsafe fields", () => {
  const unsafe = { ...credentials[0], plaintext: "forbidden", token: "forbidden", vaultPath: "forbidden", environmentValue: "forbidden" };
  const safe = safeCredentialMetadata(unsafe);
  assert.deepEqual(Object.keys(safe), ["id", "name", "authType", "source", "maskedLastFour", "version", "references", "createdAt", "updatedAt"]);
  assert.equal("plaintext" in safe, false);
  assert.equal("token" in safe, false);
  assert.equal("vaultPath" in safe, false);
  assert.notEqual(safe.references, unsafe.references);
});

test("credential labels distinguish masked, external, not-returned, unknown, and reference conflict states", () => {
  const managed = credentials.find((credential) => credential.id === "cred_support");
  const external = credentials.find((credential) => credential.id === "cred_research");
  const unreferenced = credentials.find((credential) => credential.id === "cred_staging");
  assert.equal(credentialSourceLabel(managed), "Managed");
  assert.equal(credentialSourceLabel(external), "External vault");
  assert.equal(credentialAuthLabel(managed), "Bearer");
  assert.equal(credentialHintLabel(managed), "•••• 8F2A");
  assert.equal(credentialHintLabel(external), "External reference configured");
  assert.equal(credentialHintLabel(unreferenced), "Not returned");
  assert.equal(credentialHintLabel({ source: "managed" }), "Unknown");
  assert.deepEqual(credentialReferenceState(unreferenced), { id: "unreferenced", label: "Unreferenced", count: 0 });
  assert.equal(credentialDeletePosture(managed), "Conflict while referenced");
  assert.equal(credentialDeletePosture(unreferenced), "API eligible · preview does not delete");
});

test("credential filters cover source, auth, references, combined filters, immutability, and zero results", () => {
  const sourceJSON = JSON.stringify(credentials);
  assert.deepEqual(filterCredentials(credentials, { query: "SUPPORT" }).map((credential) => credential.id), ["cred_support"]);
  assert.deepEqual(filterCredentials(credentials, { source: "external_vault" }).map((credential) => credential.id), ["cred_research"]);
  assert.deepEqual(filterCredentials(credentials, { authType: "api_key" }).map((credential) => credential.id), ["cred_research", "cred_docs", "cred_staging"]);
  assert.deepEqual(filterCredentials(credentials, { reference: "unreferenced" }).map((credential) => credential.id), ["cred_staging"]);
  assert.deepEqual(filterCredentials(credentials, { query: "staging", source: "managed", authType: "api_key", reference: "unreferenced" }).map((credential) => credential.id), ["cred_staging"]);
  assert.equal(JSON.stringify(credentials), sourceJSON);
  const zero = buildCredentialResults(credentials, { ...defaultCredentialFilters, query: "missing", source: "managed" });
  assert.equal(zero.summary, "0 of 6 fixture credential metadata records");
  assert.deepEqual(zero.activeFilters, ["query", "source"]);
});

test("payment summaries distinguish collected, gate-only, failures, known zero, and unknown", () => {
  assert.deepEqual(summarizePayments(paymentOperations), { total: 5, challenges: 1, verified: 4, settlementFailures: 1, settledUpstreamFailures: 1, collectedCents: 50, collectedDisplay: "$0.50", gateOnlyCents: 5, gateOnlyDisplay: "$0.05" });
  assert.deepEqual(summarizePayments([]), { total: 0, challenges: 0, verified: 0, settlementFailures: 0, settledUpstreamFailures: 0, collectedCents: 0, collectedDisplay: "$0.00", gateOnlyCents: 0, gateOnlyDisplay: "$0.00" });
  assert.equal(summarizePayments([{ settlementState: "settled", gateState: "verified", amountCents: null }]).collectedDisplay, "Unknown");
});

test("payment labels keep challenge, verification, collection, and upstream outcomes separate", () => {
  assert.equal(paymentGateLabel(paymentOperations[0]), "402 challenge · no invocation");
  assert.equal(paymentSettlementLabel(paymentOperations[1]), "Verified · not collected");
  assert.equal(paymentSettlementLabel(paymentOperations[2]), "Settled");
  assert.equal(paymentSettlementLabel(paymentOperations[3]), "Settlement failed · upstream not called");
  assert.equal(paymentSettlementLabel(paymentOperations[4]), "Settled · upstream failed");
  assert.equal(paymentUpstreamLabel(paymentOperations[3]), "Not called");
  assert.equal(facilitatorModeLabel("self_hosted"), "Self-hosted");
});

test("payment filters cover dimensions, fixed boundaries, newest-first ordering, and source immutability", () => {
  const sourceOrder = paymentOperations.map((operation) => operation.id);
  assert.deepEqual(filterPaymentOperations(paymentOperations, { query: "DOCS" }, paymentSnapshot.evaluatedAt).map((operation) => operation.id), ["pay_304", "pay_302"]);
  assert.deepEqual(filterPaymentOperations([...paymentOperations].reverse(), {}, paymentSnapshot.evaluatedAt).map((operation) => operation.id), ["pay_305", "pay_304", "pay_303", "pay_302", "pay_301"]);
  assert.deepEqual(filterPaymentOperations(paymentOperations, { gate: "challenged" }, paymentSnapshot.evaluatedAt).map((operation) => operation.id), ["pay_305"]);
  assert.deepEqual(filterPaymentOperations(paymentOperations, { settlement: "settlement_failed" }, paymentSnapshot.evaluatedAt).map((operation) => operation.id), ["pay_302"]);
  assert.deepEqual(filterPaymentOperations(paymentOperations, { gate: "verified", settlement: "settled", timeRange: "5m" }, paymentSnapshot.evaluatedAt).map((operation) => operation.id), ["pay_303"]);
  const boundary = { ...paymentOperations[0], id: "pay_boundary", occurredAt: "2026-08-18T09:07:00Z" };
  assert.ok(filterPaymentOperations([boundary], { timeRange: "5m" }, paymentSnapshot.evaluatedAt).some((operation) => operation.id === "pay_boundary"));
  const afterClock = { ...boundary, id: "pay_after", occurredAt: "2026-08-18T09:12:01Z" };
  assert.deepEqual(filterPaymentOperations([afterClock], { timeRange: "5m" }, paymentSnapshot.evaluatedAt), []);
  assert.deepEqual(paymentOperations.map((operation) => operation.id), sourceOrder);
  const zero = buildPaymentResults(paymentOperations, { ...defaultPaymentFilters, query: "missing", settlement: "settled" }, paymentSnapshot.evaluatedAt);
  assert.equal(zero.summary, "0 of 5 fixture payment operations");
  assert.deepEqual(zero.activeFilters, ["query", "settlement"]);
});

test("payment traces preserve every lifecycle outcome and safe failure diagnoses", () => {
  assert.deepEqual(derivePaymentTrace(paymentOperations[0]).map((stage) => stage.state), ["completed", "completed", "not_reached", "not_reached", "not_reached"]);
  assert.deepEqual(derivePaymentTrace(paymentOperations[1]).map((stage) => stage.state), ["completed", "completed", "completed", "skipped", "completed"]);
  assert.deepEqual(derivePaymentTrace(paymentOperations[2]).map((stage) => stage.state), ["completed", "completed", "completed", "completed", "completed"]);
  assert.deepEqual(derivePaymentTrace(paymentOperations[3]).map((stage) => stage.state), ["completed", "completed", "completed", "failed", "not_reached"]);
  assert.deepEqual(derivePaymentTrace(paymentOperations[4]).map((stage) => stage.state), ["completed", "completed", "completed", "completed", "failed"]);
  assert.deepEqual(derivePaymentDiagnosis(paymentOperations[3]), { stage: "Settlement", classification: "Payment could not be collected", money: "Not collected", upstream: "Not called", settlementAttempts: "2" });
  assert.deepEqual(derivePaymentDiagnosis(paymentOperations[4]), { stage: "Upstream after settlement", classification: "Upstream failed after settlement", money: "Collected before upstream failure", upstream: "Failed after settlement", settlementAttempts: "1" });
  assert.equal(derivePaymentDiagnosis(paymentOperations[2]), null);
});

test("facilitator and revenue delivery labels remain available, commercial, and planned", () => {
  assert.equal(deliveryTruthLabel(facilitatorPosture.selfHostedDelivery), "Available OSS");
  assert.equal(deliveryTruthLabel(facilitatorPosture.managedDelivery), "Commercial");
  assert.equal(deliveryTruthLabel("planned"), "Planned");
  assert.equal(deliveryTruthLabel("unexpected"), "Unknown");
});

test("capability counts preserve honest delivery states", () => {
  assert.deepEqual(capabilityCounts(stack), { total: 9, available: 3, standalone: 1, integration: 2, planned: 3 });
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
    paymentVolume: "$0.50",
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
    { id: "payment", display: "$0.50", valueState: "available" },
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
  assert.equal(stale.metrics.find((metric) => metric.id === "payment").display, "$0.50");
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
