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
