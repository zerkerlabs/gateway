export const stateLabels = {
  active: "Active",
  pending: "Pending",
  inactive: "Inactive",
  suspended: "Suspended",
  reporting: "Reporting",
  quiet: "Quiet",
  enrolled: "Enrolled",
  discovered: "Discovered",
  healthy: "Healthy",
};

export function stateLabel(state) {
  return stateLabels[state] ?? "Unknown";
}

export function scrollBehaviorForMotion(prefersReducedMotion) {
  return prefersReducedMotion === true ? "auto" : "smooth";
}

export function deriveCatalogStatus(agent) {
  if (typeof agent?.inactiveAt === "string" && agent.inactiveAt.trim()) return "inactive";
  if (agent?.upstreamConfigured === false) return "pending";
  if (agent?.upstreamConfigured === true) return "active";
  return "unknown";
}

export function catalogStatusReason(agent) {
  const status = deriveCatalogStatus(agent);
  if (status === "inactive") return "Inactive after soft deletion; the audit record remains.";
  if (status === "pending") return "Pending because no upstream is configured.";
  if (status === "active") return "Active because an upstream is configured.";
  return "Status derivation inputs are unavailable.";
}

export function summarizeAgents(agents) {
  return agents.reduce(
    (summary, agent) => {
      const catalogStatus = deriveCatalogStatus(agent);
      summary.total += 1;
      if (catalogStatus in summary) summary[catalogStatus] += 1;
      if (agent.suspended === true) summary.suspended += 1;
      if (catalogStatus === "pending" || agent.suspended === true) summary.needsAttention += 1;
      summary.calls += Number.isFinite(agent.calls) ? agent.calls : 0;
      summary.failures += Number.isFinite(agent.failures) ? agent.failures : 0;
      return summary;
    },
    { total: 0, active: 0, pending: 0, inactive: 0, suspended: 0, needsAttention: 0, calls: 0, failures: 0 },
  );
}

export function formatCurrency(cents, currency = "USD") {
  if (!Number.isInteger(cents) || cents < 0) return "Unknown";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function formatPercent(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return "Unknown";
  return `${((part / total) * 100).toFixed(1)}%`;
}

export function formatTimestamp(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "Unknown";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} · ${hour}:${minute} UTC`;
}

export function deriveDataState({ phase, completeness, recordCount, hasUsableData, refreshedAt, staleAfterMs, evaluatedAt }) {
  let availability;
  if (phase === "loading") availability = "loading";
  else if (phase === "error") availability = "error";
  else if (phase === "unavailable") availability = "unavailable";
  else if (completeness === "partial") availability = hasUsableData ? "partial" : "unavailable";
  else if (completeness === "complete" && recordCount === 0) availability = "empty";
  else availability = "ready";

  const refreshedTime = new Date(refreshedAt).getTime();
  const evaluatedTime = new Date(evaluatedAt).getTime();
  const canEvaluateFreshness = ["ready", "empty", "partial"].includes(availability)
    && Number.isFinite(refreshedTime)
    && Number.isFinite(evaluatedTime)
    && Number.isFinite(staleAfterMs)
    && staleAfterMs >= 0;
  const freshness = !canEvaluateFreshness
    ? "unknown"
    : evaluatedTime - refreshedTime > staleAfterMs ? "stale" : "current";

  return { availability, freshness };
}

export function metricValueState(value, sourceAvailable = true) {
  if (!sourceAvailable) return "unavailable";
  if (value === null || value === undefined || !Number.isFinite(value)) return "unknown";
  if (value === 0) return "zero";
  return "available";
}

export function buildOverviewModel({ agents, invocations, attention, policies, snapshot, sources, scenario }) {
  const summary = summarizeOverview({ agents, invocations, attention, policies, snapshot });
  const refreshedAt = scenario.refreshedAtOverride ?? snapshot.capturedAt;
  const state = deriveDataState({ ...scenario, refreshedAt });
  const isEmpty = state.availability === "empty";
  const availableSources = new Set(scenario.availableSources ?? []);
  const sourceRefresh = (sourceKey) => scenario.refreshedAtOverride ?? sources[sourceKey].refreshedAt;
  const sourceIsAvailable = (sourceKey) => availableSources.has(sourceKey)
    && !["loading", "error", "unavailable"].includes(state.availability);
  const sourceEvidence = (sourceKey) => {
    const source = sources[sourceKey];
    if (!sourceIsAvailable(sourceKey)) {
      return { source: source.label, lastRefresh: "Unavailable", freshness: "unknown" };
    }
    const sourceState = deriveDataState({
      phase: "ready",
      completeness: "complete",
      recordCount: isEmpty ? 0 : 1,
      hasUsableData: !isEmpty,
      refreshedAt: sourceRefresh(sourceKey),
      staleAfterMs: scenario.staleAfterMs,
      evaluatedAt: scenario.evaluatedAt,
    });
    return { source: source.label, lastRefresh: formatTimestamp(sourceRefresh(sourceKey)), freshness: sourceState.freshness };
  };
  const metric = ({ id, label, sourceKey, value, format, detail, target }) => {
    const sourceAvailable = sourceIsAvailable(sourceKey);
    const valueState = metricValueState(value, sourceAvailable);
    const display = valueState === "available" || valueState === "zero" ? format(value) : "Unknown";
    return { id, label, target, value, valueState, display, detail: sourceAvailable ? detail : "Source unavailable in this fixture", evidence: sourceEvidence(sourceKey), actionable: sourceAvailable && !isEmpty };
  };

  const attentionCount = isEmpty ? 0 : summary.attentionCount;
  const totalCalls = isEmpty ? 0 : summary.totalCalls;
  const failedCalls = isEmpty ? 0 : summary.failedCalls;
  const reviewDecisions = isEmpty ? 0 : summary.reviewDecisions;
  const paymentVolumeCents = isEmpty ? 0 : snapshot.paymentVolumeCents;
  const metrics = [
    metric({ id: "attention", label: "Needs attention", sourceKey: "attention", value: attentionCount, format: (value) => value.toLocaleString("en-US"), detail: isEmpty ? "Complete window · no items" : formatCount(attentionCount, "item") + " in review queue", target: "attention" }),
    metric({ id: "traffic", label: `Calls · ${snapshot.range}`, sourceKey: "traffic", value: totalCalls, format: (value) => value.toLocaleString("en-US"), detail: isEmpty ? "Complete window · no calls" : `Across ${agents.length} catalog agents`, target: "invocations" }),
    metric({ id: "failures", label: "Failed calls", sourceKey: "traffic", value: failedCalls, format: (value) => value.toLocaleString("en-US"), detail: isEmpty ? "Complete window · no calls" : `${formatPercent(failedCalls, totalCalls)} of fixture traffic`, target: "invocations" }),
    metric({ id: "policy", label: "Policy decisions", sourceKey: "policy", value: reviewDecisions, format: (value) => value.toLocaleString("en-US"), detail: isEmpty ? "Complete window · no decisions" : `${summary.deniedDecisions} denied · ${summary.warnedDecisions} warned`, target: "policies" }),
    metric({ id: "payment", label: "Payment volume", sourceKey: "payment", value: paymentVolumeCents, format: (value) => formatCurrency(value, snapshot.paymentCurrency), detail: isEmpty ? "Complete window · no paid traffic" : "Fixture value · USDC on Base", target: "payments" }),
  ];

  const unavailableSourceLabels = (scenario.unavailableSources ?? []).map((sourceKey) => sources[sourceKey].label);
  const runtime = state.freshness === "stale"
    ? { label: "Last known healthy · stale", tone: "warning", detail: `Last refreshed ${formatTimestamp(refreshedAt)}` }
    : state.availability === "partial"
      ? { label: "Partial fixture", tone: "warning", detail: "Some operational sources are unavailable" }
      : { label: "Healthy · fixture", tone: "available", detail: "Probe captured 12s before fixed snapshot" };

  return {
    scenario,
    state,
    capturedAt: ["loading", "error", "unavailable"].includes(state.availability) ? "Not completed" : formatTimestamp(refreshedAt),
    metrics,
    attentionItems: sourceIsAvailable("attention") ? isEmpty ? [] : attention : null,
    invocationItems: sourceIsAvailable("traffic") ? isEmpty ? [] : invocations : null,
    latestFailures: isEmpty ? 0 : summary.latestFailures,
    unavailableSourceLabels,
    runtime,
    publicMessage: scenario.publicMessage ?? "",
  };
}

export function summarizeOverview({ agents, invocations, attention, policies, snapshot }) {
  const agentSummary = summarizeAgents(agents);
  const warnedDecisions = policies.rules
    .filter((rule) => rule.action === "warn")
    .reduce((total, rule) => total + rule.decisions, 0);
  const deniedDecisions = policies.rules
    .filter((rule) => rule.action === "deny")
    .reduce((total, rule) => total + rule.decisions, 0);

  return {
    attentionCount: attention.length,
    totalCalls: agentSummary.calls,
    failedCalls: agentSummary.failures,
    failureRate: formatPercent(agentSummary.failures, agentSummary.calls),
    warnedDecisions,
    deniedDecisions,
    reviewDecisions: warnedDecisions + deniedDecisions,
    paymentVolume: formatCurrency(snapshot.paymentVolumeCents, snapshot.paymentCurrency),
    latestFailures: invocations.filter((invocation) => invocation.result === "failed").length,
  };
}

export const defaultInvocationFilters = Object.freeze({ query: "", result: "all", mode: "all", agent: "all", policy: "all", payment: "all", timeRange: "24h" });

export const invocationTimeRanges = Object.freeze({ "5m": 5 * 60 * 1000, "1h": 60 * 60 * 1000, "24h": 24 * 60 * 60 * 1000 });

export function invocationModeLabel(mode) {
  if (mode === "transaction") return "Transactional";
  if (mode === "stream") return "Streaming";
  return "Unknown";
}

export function invocationPaymentLabel(invocation) {
  if (invocation.paymentState === "not_required") return "Not required";
  if (invocation.paymentState === "verified") {
    const amount = formatCurrency(invocation.paymentAmountCents, invocation.paymentCurrency);
    return amount === "Unknown" ? "Verified · amount unknown" : `Verified · ${amount}`;
  }
  return "Unknown";
}

export function invocationTimestampLabel(value) {
  const formatted = formatTimestamp(value);
  return formatted === "Unknown" ? "Unknown" : formatted.replace(/^(\d{2} [A-Z][a-z]{2}) \d{4} · /, "$1 · ");
}

export function invocationRelativeLabel(occurredAt, evaluatedAt) {
  const occurred = new Date(occurredAt).getTime();
  const evaluated = new Date(evaluatedAt).getTime();
  if (!Number.isFinite(occurred) || !Number.isFinite(evaluated)) return "Unknown fixture time";
  const minutes = Math.max(0, Math.floor((evaluated - occurred) / 60000));
  return minutes === 0 ? "At fixture refresh" : `${minutes}m before fixture refresh`;
}

export function filterInvocations(items, filters = defaultInvocationFilters, evaluatedAt) {
  const normalized = { ...defaultInvocationFilters, ...filters, query: (filters.query ?? "").trim().toLocaleLowerCase() };
  const rangeMs = invocationTimeRanges[normalized.timeRange] ?? invocationTimeRanges[defaultInvocationFilters.timeRange];
  const evaluatedTime = new Date(evaluatedAt).getTime();
  const earliest = evaluatedTime - rangeMs;
  return items
    .filter((item) => {
      const haystack = `${item.id} ${item.agent} ${item.method}`.toLocaleLowerCase();
      const occurredTime = new Date(item.occurredAt).getTime();
      const matchesTime = Number.isFinite(occurredTime) && Number.isFinite(evaluatedTime) && occurredTime >= earliest && occurredTime <= evaluatedTime;
      return (!normalized.query || haystack.includes(normalized.query))
        && (normalized.result === "all" || item.result === normalized.result)
        && (normalized.mode === "all" || item.mode === normalized.mode)
        && (normalized.agent === "all" || item.agent === normalized.agent)
        && (normalized.policy === "all" || item.policy === normalized.policy)
        && (normalized.payment === "all" || item.paymentState === normalized.payment)
        && matchesTime;
    })
    .toSorted((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
}

export function buildInvocationResults(items, filters, evaluatedAt) {
  const normalized = { ...defaultInvocationFilters, ...filters, query: (filters?.query ?? "").trim() };
  const rows = filterInvocations(items, normalized, evaluatedAt);
  const activeFilters = Object.keys(defaultInvocationFilters).filter((key) => normalized[key] !== defaultInvocationFilters[key]);
  return {
    rows,
    total: items.length,
    activeFilters,
    summary: `${rows.length} of ${items.length} fixture ${items.length === 1 ? "invocation" : "invocations"}`,
  };
}

export function deriveInvocationTrace(invocation) {
  const paymentVerified = invocation.paymentState === "verified";
  const proxyFailed = invocation.failure?.stage === "proxy" || invocation.result === "failed";
  return [
    { id: "identity", label: "Identity", state: "completed", detail: "Gateway API OIDC identity accepted · fixture" },
    { id: "policy", label: "Policy", state: invocation.policy === "warn" ? "warning" : invocation.policy === "deny" ? "failed" : "completed", detail: invocation.policy === "warn" ? "Warning recorded · request forwarded" : invocation.policy === "deny" ? "Request denied" : "Request allowed" },
    { id: "payment", label: "Payment", state: paymentVerified ? "completed" : invocation.paymentState === "not_required" ? "skipped" : "not_reached", detail: paymentVerified ? `${invocationPaymentLabel(invocation)} authorization` : invocation.paymentState === "not_required" ? "Not required" : "Payment state unknown" },
    { id: "proxy", label: "Proxy", state: proxyFailed ? "failed" : invocation.policy === "deny" ? "not_reached" : "completed", detail: proxyFailed ? invocation.failure?.label ?? "Proxy failed" : invocation.policy === "deny" ? "Not reached" : `Completed in ${invocation.latency}` },
    { id: "record", label: "Record", state: "completed", detail: "Invocation metadata captured" },
  ];
}

export function deriveFailureDiagnosis(invocation) {
  if (!invocation.failure) return null;
  const stage = invocation.failure.stage === "proxy" ? "Proxy" : "Unknown";
  return {
    stage,
    classification: invocation.failure.label ?? "Unknown",
    upstreamStatus: invocation.failure.upstreamStatus === null || invocation.failure.upstreamStatus === undefined ? "No upstream response/status" : String(invocation.failure.upstreamStatus),
    retryability: invocation.failure.retryability === null || invocation.failure.retryability === undefined ? "Unknown" : invocation.failure.retryability ? "Retryable" : "Not retryable",
  };
}

export const defaultAgentFilters = Object.freeze({ query: "", status: "all", protocol: "all", suspension: "all" });

export function protocolLabel(protocol) {
  if (protocol === "http") return "HTTP";
  if (protocol === "mcp") return "MCP";
  return "Unknown";
}

export function protocolTransportLabel(agent) {
  if (agent?.protocol === "http") return "HTTP";
  if (agent?.protocol !== "mcp") return "Unknown";
  if (agent.mcpTransport === "streamable_http") return "Streamable HTTP";
  return "Unknown";
}

export function rateBoundaryLabel(agent) {
  if (agent?.ratePerSecond === undefined) return "Unknown";
  if (agent.ratePerSecond === null) return "Not configured";
  if (!Number.isFinite(agent.ratePerSecond) || agent.ratePerSecond <= 0) return "Unknown";
  if (agent.burst === undefined) return "Unknown";
  if (agent.burst === null) return `${agent.ratePerSecond} req/s · burst default 20`;
  if (!Number.isInteger(agent.burst) || agent.burst < 1) return "Unknown";
  return `${agent.ratePerSecond} req/s · burst ${agent.burst}`;
}

export function credentialReferenceLabel(agent) {
  if (agent?.credentialRef === undefined) return "Unknown";
  if (agent.credentialRef === null || agent.credentialRef === "") return "None";
  return `Reference · ${agent.credentialRef}`;
}

export function pricingLabel(agent) {
  if (agent?.pricing === undefined) return "Unknown";
  if (agent.pricing === null) return "Unpriced";
  if (agent.pricing.scheme !== "exact" || agent.pricing.asset !== "USDC" || agent.pricing.network !== "base" || !agent.pricing.displayAmount) return "Unknown";
  return `x402 exact · ${agent.pricing.displayAmount}`;
}

export function deriveObserverEvidenceState(evidence, evaluatedAt, recentWithinMs) {
  if (evidence?.enrollmentState === "discovered") return "discovered";
  if (evidence?.enrollmentState !== "enrolled") return "unknown";
  if (evidence.lastEventAt === null) return "enrolled";
  const eventTime = new Date(evidence.lastEventAt).getTime();
  const evaluationTime = new Date(evaluatedAt).getTime();
  if (!Number.isFinite(eventTime) || !Number.isFinite(evaluationTime) || !Number.isFinite(recentWithinMs) || recentWithinMs < 0 || eventTime > evaluationTime) return "unknown";
  return evaluationTime - eventTime <= recentWithinMs ? "reporting" : "quiet";
}

export function observerEvidenceLabel(evidence, evaluatedAt, recentWithinMs) {
  const state = deriveObserverEvidenceState(evidence, evaluatedAt, recentWithinMs);
  if (state === "discovered") return `Discovered · ${formatTimestamp(evidence.discoveredAt)}`;
  if (state === "enrolled") return "Enrolled · no recent event evidence";
  if (state === "reporting") return `Reporting · event ${formatTimestamp(evidence.lastEventAt)}`;
  if (state === "quiet") return `Quiet · last event ${formatTimestamp(evidence.lastEventAt)}`;
  return "Unknown evidence state";
}

export function filterAgents(agents, filters = defaultAgentFilters, legacyStatus = "all") {
  const input = typeof filters === "string" ? { ...defaultAgentFilters, query: filters, status: legacyStatus } : { ...defaultAgentFilters, ...filters };
  const normalizedQuery = (input.query ?? "").trim().toLocaleLowerCase();
  return agents.filter((agent) => {
    const catalogStatus = deriveCatalogStatus(agent);
    const haystack = `${agent.id} ${agent.name} ${agent.runtime} ${agent.protocol}`.toLocaleLowerCase();
    const matchesSuspension = input.suspension === "all"
      || (input.suspension === "suspended" && agent.suspended === true)
      || (input.suspension === "not_suspended" && agent.suspended !== true);
    return (!normalizedQuery || haystack.includes(normalizedQuery))
      && (input.status === "all" || catalogStatus === input.status)
      && (input.protocol === "all" || agent.protocol === input.protocol)
      && matchesSuspension;
  });
}

export function buildAgentResults(agents, filters = defaultAgentFilters) {
  const normalized = { ...defaultAgentFilters, ...filters, query: (filters?.query ?? "").trim() };
  const rows = filterAgents(agents, normalized);
  const activeFilters = Object.keys(defaultAgentFilters).filter((key) => normalized[key] !== defaultAgentFilters[key]);
  return {
    rows,
    total: agents.length,
    activeFilters,
    summary: `${rows.length} of ${agents.length} fixture catalog ${agents.length === 1 ? "agent" : "agents"}`,
  };
}

export const defaultPolicyDecisionFilters = Object.freeze({ query: "", action: "all", rule: "all" });

export function buildPolicyModel(policy) {
  const rules = [...(policy?.rules ?? [])].toSorted((left, right) => left.order - right.order);
  const actionCounts = { allow: 0, warn: 0, deny: 0 };
  for (const rule of rules) {
    if (rule.action in actionCounts && Number.isFinite(rule.decisions)) actionCounts[rule.action] += rule.decisions;
  }
  const safeAction = (value) => ["allow", "warn", "deny"].includes(value) ? value : "unknown";
  return {
    rules,
    actionCounts,
    defaultAction: safeAction(policy?.default),
    onErrorAction: safeAction(policy?.onError),
    outagePosture: policy?.outagePosture === "fail_closed" ? "fail_closed" : "unknown",
  };
}

export function filterPolicyDecisions(decisions, rules, filters = defaultPolicyDecisionFilters) {
  const normalized = { ...defaultPolicyDecisionFilters, ...filters, query: (filters?.query ?? "").trim().toLocaleLowerCase() };
  const rulesByID = new Map(rules.map((rule) => [rule.id, rule]));
  return decisions
    .filter((decision) => {
      const rule = rulesByID.get(decision.ruleID);
      const haystack = `${decision.id} ${decision.agent} ${decision.protocol} ${decision.method} ${decision.tool ?? ""} ${decision.reason} ${rule?.name ?? "default"}`.toLocaleLowerCase();
      return (!normalized.query || haystack.includes(normalized.query))
        && (normalized.action === "all" || decision.action === normalized.action)
        && (normalized.rule === "all" || (normalized.rule === "default" ? decision.ruleID === null : decision.ruleID === normalized.rule));
    })
    .toSorted((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
}

export function buildPolicyDecisionResults(decisions, rules, filters = defaultPolicyDecisionFilters) {
  const normalized = { ...defaultPolicyDecisionFilters, ...filters, query: (filters?.query ?? "").trim() };
  const rows = filterPolicyDecisions(decisions, rules, normalized);
  const activeFilters = Object.keys(defaultPolicyDecisionFilters).filter((key) => normalized[key] !== defaultPolicyDecisionFilters[key]);
  return {
    rows,
    total: decisions.length,
    activeFilters,
    summary: `${rows.length} of ${decisions.length} fixture policy ${decisions.length === 1 ? "decision" : "decisions"}`,
  };
}

const credentialDisplayKeys = Object.freeze(["id", "name", "authType", "source", "maskedLastFour", "version", "references", "createdAt", "updatedAt"]);

export function safeCredentialMetadata(credential) {
  const safe = {};
  for (const key of credentialDisplayKeys) {
    if (Object.hasOwn(credential ?? {}, key)) safe[key] = key === "references" && Array.isArray(credential[key]) ? [...credential[key]] : credential[key];
  }
  return safe;
}

export function credentialSourceLabel(credential) {
  if (credential?.source === "managed") return "Managed";
  if (credential?.source === "external_vault") return "External vault";
  return "Unknown";
}

export function credentialAuthLabel(credential) {
  if (credential?.authType === "bearer") return "Bearer";
  if (credential?.authType === "api_key") return "API key";
  if (credential?.authType === "none") return "None";
  return "Unknown";
}

export function credentialHintLabel(credential) {
  if (credential?.source === "external_vault") return "External reference configured";
  if (credential?.source !== "managed") return "Unknown";
  if (credential.maskedLastFour === null) return "Not returned";
  if (credential.maskedLastFour === undefined) return "Unknown";
  return /^[A-Za-z0-9]{4}$/.test(credential.maskedLastFour) ? `•••• ${credential.maskedLastFour}` : "Unknown";
}

export function credentialReferenceState(credential) {
  if (!Array.isArray(credential?.references)) return { id: "unknown", label: "Unknown", count: null };
  if (credential.references.length === 0) return { id: "unreferenced", label: "Unreferenced", count: 0 };
  return { id: "referenced", label: `Referenced · ${credential.references.length}`, count: credential.references.length };
}

export function credentialDeletePosture(credential) {
  const reference = credentialReferenceState(credential);
  if (reference.id === "referenced") return "Conflict while referenced";
  if (reference.id === "unreferenced") return "API eligible · preview does not delete";
  return "Unknown";
}

export const defaultCredentialFilters = Object.freeze({ query: "", source: "all", authType: "all", reference: "all" });

export function filterCredentials(credentials, filters = defaultCredentialFilters) {
  const normalized = { ...defaultCredentialFilters, ...filters, query: (filters?.query ?? "").trim().toLocaleLowerCase() };
  return credentials
    .map(safeCredentialMetadata)
    .filter((credential) => {
      const reference = credentialReferenceState(credential).id;
      const haystack = `${credential.id ?? ""} ${credential.name ?? ""} ${credential.authType ?? ""} ${credential.source ?? ""} ${(credential.references ?? []).join(" ")}`.toLocaleLowerCase();
      return (!normalized.query || haystack.includes(normalized.query))
        && (normalized.source === "all" || credential.source === normalized.source)
        && (normalized.authType === "all" || credential.authType === normalized.authType)
        && (normalized.reference === "all" || reference === normalized.reference);
    });
}

export function buildCredentialResults(credentials, filters = defaultCredentialFilters) {
  const normalized = { ...defaultCredentialFilters, ...filters, query: (filters?.query ?? "").trim() };
  const rows = filterCredentials(credentials, normalized);
  const activeFilters = Object.keys(defaultCredentialFilters).filter((key) => normalized[key] !== defaultCredentialFilters[key]);
  return {
    rows,
    total: credentials.length,
    activeFilters,
    summary: `${rows.length} of ${credentials.length} fixture credential metadata ${credentials.length === 1 ? "record" : "records"}`,
  };
}

export const defaultPaymentFilters = Object.freeze({ query: "", gate: "all", settlement: "all", timeRange: "24h" });
export const paymentTimeRanges = Object.freeze({ "5m": 5 * 60 * 1000, "15m": 15 * 60 * 1000, "24h": 24 * 60 * 60 * 1000 });

export function paymentGateLabel(operation) {
  if (operation?.gateState === "challenged") return "402 challenge · no invocation";
  if (operation?.gateState === "verified") return "Verified";
  return "Unknown";
}

export function paymentSettlementLabel(operation) {
  if (operation?.settlementState === "not_reached") return "Not reached";
  if (operation?.settlementState === "not_configured") return "Verified · not collected";
  if (operation?.settlementState === "pending") return "Pending";
  if (operation?.settlementState === "settled") return "Settled";
  if (operation?.settlementState === "settlement_failed") return "Settlement failed · upstream not called";
  if (operation?.settlementState === "settled_upstream_failed") return "Settled · upstream failed";
  return "Unknown";
}

export function paymentUpstreamLabel(operation) {
  if (operation?.upstreamState === "succeeded") return "Succeeded";
  if (operation?.upstreamState === "failed") return "Failed after settlement";
  if (operation?.upstreamState === "not_called") return "Not called";
  if (operation?.upstreamState === "not_reached") return "Not reached";
  return "Unknown";
}

export function facilitatorModeLabel(mode) {
  if (mode === "self_hosted") return "Self-hosted";
  if (mode === "gate_only") return "Gate-only";
  if (mode === "managed") return "Managed";
  return "Unknown";
}

export function summarizePayments(operations) {
  const collected = operations.filter((operation) => ["settled", "settled_upstream_failed"].includes(operation.settlementState));
  const gateOnly = operations.filter((operation) => operation.gateState === "verified" && operation.settlementState === "not_configured");
  const sumKnown = (items) => items.every((item) => Number.isInteger(item.amountCents) && item.amountCents >= 0)
    ? items.reduce((total, item) => total + item.amountCents, 0)
    : null;
  const collectedCents = sumKnown(collected);
  const gateOnlyCents = sumKnown(gateOnly);
  return {
    total: operations.length,
    challenges: operations.filter((operation) => operation.gateState === "challenged").length,
    verified: operations.filter((operation) => operation.gateState === "verified").length,
    settlementFailures: operations.filter((operation) => operation.settlementState === "settlement_failed").length,
    settledUpstreamFailures: operations.filter((operation) => operation.settlementState === "settled_upstream_failed").length,
    collectedCents,
    collectedDisplay: collectedCents === null ? "Unknown" : formatCurrency(collectedCents),
    gateOnlyCents,
    gateOnlyDisplay: gateOnlyCents === null ? "Unknown" : formatCurrency(gateOnlyCents),
  };
}

export function filterPaymentOperations(operations, filters = defaultPaymentFilters, evaluatedAt) {
  const normalized = { ...defaultPaymentFilters, ...filters, query: (filters?.query ?? "").trim().toLocaleLowerCase() };
  const evaluationTime = new Date(evaluatedAt).getTime();
  const rangeMs = paymentTimeRanges[normalized.timeRange] ?? paymentTimeRanges[defaultPaymentFilters.timeRange];
  const earliest = evaluationTime - rangeMs;
  return operations
    .filter((operation) => {
      const occurred = new Date(operation.occurredAt).getTime();
      const haystack = `${operation.id} ${operation.agent} ${operation.operation} ${operation.invocationID ?? ""}`.toLocaleLowerCase();
      return (!normalized.query || haystack.includes(normalized.query))
        && (normalized.gate === "all" || operation.gateState === normalized.gate)
        && (normalized.settlement === "all" || operation.settlementState === normalized.settlement)
        && Number.isFinite(occurred) && Number.isFinite(evaluationTime) && occurred >= earliest && occurred <= evaluationTime;
    })
    .toSorted((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
}

export function buildPaymentResults(operations, filters, evaluatedAt) {
  const normalized = { ...defaultPaymentFilters, ...filters, query: (filters?.query ?? "").trim() };
  const rows = filterPaymentOperations(operations, normalized, evaluatedAt);
  const activeFilters = Object.keys(defaultPaymentFilters).filter((key) => normalized[key] !== defaultPaymentFilters[key]);
  return {
    rows,
    total: operations.length,
    activeFilters,
    summary: `${rows.length} of ${operations.length} fixture payment ${operations.length === 1 ? "operation" : "operations"}`,
  };
}

export function derivePaymentTrace(operation) {
  const challenged = operation.gateState === "challenged";
  const verified = operation.gateState === "verified";
  const gateOnly = operation.settlementState === "not_configured";
  const settlementFailed = operation.settlementState === "settlement_failed";
  const settled = ["settled", "settled_upstream_failed"].includes(operation.settlementState);
  return [
    { id: "policy", label: "Policy", state: "completed", detail: "Allowed before payment evaluation" },
    { id: "authorization", label: "Challenge / authorization", state: challenged || verified ? "completed" : "unknown", detail: challenged ? "402 challenge returned · no invocation created" : verified ? "Signed authorization presented" : "Unknown" },
    { id: "gateway", label: "Gateway verification", state: challenged ? "not_reached" : verified ? "completed" : "unknown", detail: challenged ? "Not reached without authorization" : verified ? "Authorization verified · not collection" : "Unknown" },
    { id: "facilitator", label: "Facilitator", state: challenged ? "not_reached" : gateOnly ? "skipped" : settlementFailed ? "failed" : settled ? "completed" : operation.settlementState === "pending" ? "pending" : "not_reached", detail: challenged ? "Not reached" : gateOnly ? "Not configured · gate-only" : settlementFailed ? "Independent re-verification / settlement failed" : settled ? "Independently re-verified and settled" : operation.settlementState === "pending" ? "Settlement pending" : "Not reached" },
    { id: "upstream", label: "Upstream", state: operation.upstreamState === "succeeded" ? "completed" : operation.upstreamState === "failed" ? "failed" : "not_reached", detail: paymentUpstreamLabel(operation) },
  ];
}

export function derivePaymentDiagnosis(operation) {
  if (operation?.settlementState === "settlement_failed") {
    return { stage: "Settlement", classification: operation.reason ?? "Payment could not be collected", money: "Not collected", upstream: "Not called", settlementAttempts: Number.isInteger(operation.settlementAttempts) ? String(operation.settlementAttempts) : "Unknown" };
  }
  if (operation?.settlementState === "settled_upstream_failed") {
    return { stage: "Upstream after settlement", classification: operation.reason ?? "Upstream failed after settlement", money: "Collected before upstream failure", upstream: "Failed after settlement", settlementAttempts: Number.isInteger(operation.settlementAttempts) ? String(operation.settlementAttempts) : "Unknown" };
  }
  return null;
}

export function deliveryTruthLabel(delivery) {
  if (delivery === "available") return "Available OSS";
  if (delivery === "commercial") return "Commercial";
  if (delivery === "planned") return "Planned";
  return "Unknown";
}

export function formatCount(value, singular, plural = `${singular}s`) {
  return `${value.toLocaleString("en-US")} ${value === 1 ? singular : plural}`;
}

export function capabilityCounts(stack) {
  return stack.reduce(
    (counts, capability) => {
      counts.total += 1;
      counts[capability.tone] = (counts[capability.tone] ?? 0) + 1;
      return counts;
    },
    { total: 0 },
  );
}

export function validateAnalyticsWindow(window, maxWindowDays = 31) {
  const since = new Date(window?.since).getTime();
  const until = new Date(window?.until).getTime();
  if (!window?.since || !window?.until || !Number.isFinite(since) || !Number.isFinite(until)) return { valid: false, reason: "A valid since and until are required" };
  if (since > until) return { valid: false, reason: "Since cannot be after the evaluation time" };
  if (!Number.isFinite(maxWindowDays) || maxWindowDays <= 0) return { valid: false, reason: "Window limit is unavailable" };
  const durationMs = until - since;
  if (durationMs > maxWindowDays * 24 * 60 * 60 * 1000) return { valid: false, reason: `Window exceeds ${maxWindowDays} days` };
  return { valid: true, durationMs };
}

export function validatePercentiles(series) {
  if (!series || [series.p50, series.p95, series.p99].some((value) => !Number.isFinite(value) || value < 0)) return { valid: false, state: "unknown" };
  if (series.p50 > series.p95 || series.p95 > series.p99) return { valid: false, state: "unknown" };
  return { valid: true, state: "available" };
}

export function formatAnalyticsDuration(value, state = "available") {
  if (state === "no_samples") return "No samples";
  if (state === "not_applicable") return "Not applicable";
  if (state === "unavailable") return "Unavailable";
  if (!Number.isFinite(value) || value < 0) return "Unknown";
  if (value >= 1000) return `${(value / 1000).toFixed(2).replace(/\.?0+$/, "")}s`;
  return `${Math.round(value)}ms`;
}

export function analyticsTTFTLabel(row, sourceAvailable = true) {
  if (!sourceAvailable) return "Unavailable";
  if (row?.streaming === false) return "Not applicable";
  if (row?.streamingSamples === 0) return "No streaming samples";
  if (!Number.isFinite(row?.ttftP95Ms)) return "Unknown";
  return formatAnalyticsDuration(row.ttftP95Ms);
}

function sumRows(rows, key) {
  return (rows ?? []).reduce((total, row) => total + (Number.isFinite(row[key]) ? row[key] : 0), 0);
}

function analyticsIntegrity(window) {
  const aggregate = window?.aggregate;
  const latencyValid = validatePercentiles(aggregate?.latencyMs).valid;
  const ttftValid = validatePercentiles(aggregate?.ttftMs).valid;
  const agentsMatch = sumRows(window?.agents, "count") === aggregate?.count && sumRows(window?.agents, "errors") === aggregate?.errors;
  const operationsMatch = sumRows(window?.operations, "count") === aggregate?.count && sumRows(window?.operations, "errors") === aggregate?.errors;
  const taxonomyMatches = sumRows(window?.errorTaxonomy, "count") === aggregate?.errors;
  return { valid: Boolean(latencyValid && ttftValid && agentsMatch && operationsMatch && taxonomyMatches), latencyValid, ttftValid, agentsMatch, operationsMatch, taxonomyMatches };
}

function analyticsMetricSeries(series, state) {
  if (state === "empty") return { p50: "No samples", p95: "No samples", p99: "No samples", state: "no_samples" };
  if (state === "partial") return { p50: "Unavailable", p95: "Unavailable", p99: "Unavailable", state: "unavailable" };
  if (!validatePercentiles(series).valid) return { p50: "Unknown", p95: "Unknown", p99: "Unknown", state: "unknown" };
  return { p50: formatAnalyticsDuration(series.p50), p95: formatAnalyticsDuration(series.p95), p99: formatAnalyticsDuration(series.p99), state: "available" };
}

export function buildAnalyticsModel({ snapshot, windows, scenario, windowID }) {
  const window = windows?.[windowID] ?? null;
  const validation = validateAnalyticsWindow(window, snapshot?.maxWindowDays);
  const scenarioState = scenario?.state ?? "error";
  const integrity = window ? analyticsIntegrity(window) : { valid: false };
  const invalidFixture = scenarioState === "complete" && (!validation.valid || !integrity.valid);
  const availability = invalidFixture ? "error" : scenarioState;
  const empty = availability === "empty";
  const partial = availability === "partial";
  const aggregate = availability === "complete" ? window.aggregate
    : partial ? { count: window.aggregate.count, errors: window.aggregate.errors, latencyMs: null, ttftMs: null, streamingSamples: null }
      : empty ? { count: 0, errors: 0, latencyMs: null, ttftMs: null, streamingSamples: 0 } : null;
  const errorRate = !aggregate ? "Unknown" : aggregate.count === 0 ? "No calls" : formatPercent(aggregate.errors, aggregate.count);
  const latency = analyticsMetricSeries(aggregate?.latencyMs, empty ? "empty" : partial ? "partial" : availability === "complete" ? "complete" : "partial");
  const ttft = analyticsMetricSeries(aggregate?.ttftMs, empty ? "empty" : partial ? "partial" : availability === "complete" ? "complete" : "partial");
  const stateSummary = availability === "complete"
    ? `${aggregate.count.toLocaleString("en-US")} fixture calls in ${window.label}`
    : availability === "empty" ? `Known zero fixture calls in ${window?.label ?? "selected window"}`
      : availability === "partial" ? `Partial fixture metrics in ${window?.label ?? "selected window"}`
        : availability === "unavailable" ? "Analytics fixture unavailable"
          : "Analytics fixture error";
  return {
    scenario,
    availability,
    publicMessage: invalidFixture ? "Analytics fixture consistency checks failed. No Gateway request was made." : scenario?.publicMessage ?? "",
    window,
    validation,
    integrity,
    aggregate,
    countDisplay: aggregate ? aggregate.count.toLocaleString("en-US") : "Unknown",
    errorDisplay: aggregate ? aggregate.errors.toLocaleString("en-US") : "Unknown",
    errorRate,
    latency,
    ttft,
    taxonomy: availability === "complete" ? window.errorTaxonomy : empty ? [] : null,
    agents: availability === "complete" ? window.agents : empty ? [] : null,
    operations: availability === "complete" ? window.operations : empty ? [] : null,
    stateSummary,
  };
}

export function buildSystemModel(snapshot, limitations = []) {
  const replicaSamples = snapshot?.build?.replicaSamples;
  const rollout = Number.isInteger(replicaSamples) && replicaSamples > 1
    ? { id: "evidenced", label: "Comparison evidence available" }
    : { id: "unconfirmed", label: "Unconfirmed · one fixture build sample" };
  const configured = typeof snapshot?.facilitator?.configurationEvidence === "string" && snapshot.facilitator.configurationEvidence.startsWith("Configured");
  const ready = snapshot?.facilitator?.supported === "Supported" && snapshot?.facilitator?.readiness === "Ready" && snapshot?.facilitator?.gas === "Sufficient";
  const facilitator = ready
    ? { id: "ready", label: "Ready · fixture evidence" }
    : configured ? { id: "not_proved", label: "Configured · readiness not proved" } : { id: "unknown", label: "Configuration Unknown" };
  const kms = snapshot?.kms?.configurationEvidence?.startsWith("Configured")
    ? { id: "configured_fixture", label: "Configured · fixture metadata only" }
    : { id: "unknown", label: "Configuration Unknown" };
  return {
    health: snapshot?.health?.state === "healthy" ? { id: "captured_healthy", label: "Healthy · captured fixture" } : { id: "unknown", label: "Unknown" },
    rollout,
    facilitator,
    kms,
    limitations: limitations.map((item) => ({ ...item })),
  };
}

export function buildRestInventory(operations) {
  const groups = {};
  const counts = { probe: 0, read: 0, proxy: 0, write: 0 };
  const ids = new Set();
  let duplicate = false;
  let destinationsComplete = true;
  let unauthenticated = 0;
  for (const operation of operations ?? []) {
    if (ids.has(operation.id)) duplicate = true;
    ids.add(operation.id);
    if (operation.kind in counts) counts[operation.kind] += 1;
    if (operation.auth === "unauthenticated") unauthenticated += 1;
    if (!operation.destination) destinationsComplete = false;
    (groups[operation.destination ?? "Unmapped"] ??= []).push({ ...operation });
  }
  const valid = operations?.length === 25 && ids.size === 25 && !duplicate && unauthenticated === 2
    && counts.probe === 2 && counts.read === 11 && counts.proxy === 3 && counts.write === 9 && destinationsComplete;
  return { total: operations?.length ?? 0, unique: ids.size, duplicate, unauthenticated, counts, destinationsComplete, groups, valid };
}

export function buildSDKInventory(items) {
  return (items ?? []).map((item) => {
    if (item.delivery === "available") return { ...item, label: "Available · repository-evidenced", tone: "available" };
    if (item.delivery === "discrepancy") return { ...item, label: "Docs/repository discrepancy · not evidenced", tone: "warning" };
    if (item.delivery === "developer") return { ...item, label: "Developer-only inventory", tone: "empty" };
    return { ...item, label: "Unknown", tone: "unavailable" };
  });
}
