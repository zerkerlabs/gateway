export const stateLabels = {
  active: "Active",
  suspended: "Suspended",
  setup: "Finish setup",
  reporting: "Reporting",
  healthy: "Healthy",
};

export function stateLabel(state) {
  return stateLabels[state] ?? "Unknown";
}

export function summarizeAgents(agents) {
  return agents.reduce(
    (summary, agent) => {
      summary.total += 1;
      if (agent.state === "active") summary.active += 1;
      if (agent.state === "suspended") summary.suspended += 1;
      if (agent.state === "setup") summary.needsAttention += 1;
      summary.calls += agent.calls;
      summary.failures += agent.failures ?? 0;
      return summary;
    },
    { total: 0, active: 0, suspended: 0, needsAttention: 0, calls: 0, failures: 0 },
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

export function filterAgents(agents, query = "", state = "all") {
  const normalized = query.trim().toLocaleLowerCase();
  return agents.filter((agent) => {
    const haystack = `${agent.name} ${agent.runtime} ${agent.environment} ${agent.protocol}`.toLocaleLowerCase();
    const matchesQuery = !normalized || haystack.includes(normalized);
    const matchesState = state === "all" || agent.state === state;
    return matchesQuery && matchesState;
  });
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
