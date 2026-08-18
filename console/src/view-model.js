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
    { id: "identity", label: "Identity", state: "completed", detail: "OIDC identity accepted" },
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
