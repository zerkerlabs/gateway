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
      return summary;
    },
    { total: 0, active: 0, suspended: 0, needsAttention: 0, calls: 0 },
  );
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
