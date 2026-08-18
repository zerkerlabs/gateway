export const stateLabels = {
  reporting: "Reporting",
  quiet: "Quiet",
  enrolled: "Enrolled",
  not_enrolled: "Finish setup",
};

export function stateLabel(state) {
  return stateLabels[state] ?? "Unknown";
}

export function summarizeAgents(agents) {
  return agents.reduce(
    (summary, agent) => {
      summary.total += 1;
      if (agent.state === "reporting") summary.reporting += 1;
      if (agent.state === "quiet") summary.quiet += 1;
      if (agent.state === "not_enrolled") summary.needsAttention += 1;
      return summary;
    },
    { total: 0, reporting: 0, quiet: 0, needsAttention: 0 },
  );
}

export function filterAgents(agents, query = "", state = "all") {
  const normalized = query.trim().toLocaleLowerCase();
  return agents.filter((agent) => {
    const matchesQuery = !normalized || `${agent.name} ${agent.location}`.toLocaleLowerCase().includes(normalized);
    const matchesState = state === "all" || agent.state === state;
    return matchesQuery && matchesState;
  });
}

export function formatCount(value, singular, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}
