export const overviewSnapshot = {
  workspace: "Zerker Labs",
  environment: "All environments",
  range: "Last 24 hours",
  capturedAt: "2026-08-18T09:10:00Z",
  paymentVolumeCents: 1240,
  paymentCurrency: "USD",
};

export const overviewMetricSources = {
  attention: { label: "Attention fixture", refreshedAt: "2026-08-18T09:10:00Z" },
  traffic: { label: "Catalog aggregate fixture", refreshedAt: "2026-08-18T09:09:00Z" },
  policy: { label: "Policy decision fixture", refreshedAt: "2026-08-18T09:08:00Z" },
  payment: { label: "Settlement fixture", refreshedAt: "2026-08-18T09:07:00Z" },
};

export const overviewScenarios = [
  { id: "complete", label: "Complete fixture", phase: "ready", completeness: "complete", recordCount: 5, hasUsableData: true, evaluatedAt: "2026-08-18T09:12:00Z", staleAfterMs: 15 * 60 * 1000, availableSources: ["attention", "traffic", "policy", "payment"] },
  { id: "loading", label: "Loading", phase: "loading", completeness: "unknown", recordCount: 0, hasUsableData: false, evaluatedAt: "2026-08-18T09:12:00Z", staleAfterMs: 15 * 60 * 1000, availableSources: [] },
  { id: "empty", label: "Empty", phase: "ready", completeness: "complete", recordCount: 0, hasUsableData: false, evaluatedAt: "2026-08-18T09:12:00Z", staleAfterMs: 15 * 60 * 1000, availableSources: ["attention", "traffic", "policy", "payment"] },
  { id: "stale", label: "Stale", phase: "ready", completeness: "complete", recordCount: 5, hasUsableData: true, evaluatedAt: "2026-08-18T09:12:00Z", staleAfterMs: 15 * 60 * 1000, refreshedAtOverride: "2026-08-18T08:10:00Z", availableSources: ["attention", "traffic", "policy", "payment"] },
  { id: "unavailable", label: "Unavailable", phase: "unavailable", completeness: "unknown", recordCount: 0, hasUsableData: false, evaluatedAt: "2026-08-18T09:12:00Z", staleAfterMs: 15 * 60 * 1000, availableSources: [], publicMessage: "Operational fixture sources are unavailable in this preview scenario." },
  { id: "partial", label: "Partial", phase: "ready", completeness: "partial", recordCount: 5, hasUsableData: true, evaluatedAt: "2026-08-18T09:12:00Z", staleAfterMs: 15 * 60 * 1000, availableSources: ["traffic"], unavailableSources: ["attention", "policy", "payment"] },
  { id: "error", label: "Error", phase: "error", completeness: "unknown", recordCount: 0, hasUsableData: false, evaluatedAt: "2026-08-18T09:12:00Z", staleAfterMs: 15 * 60 * 1000, availableSources: [], publicMessage: "The fixture snapshot could not be prepared. No Gateway request was made." },
];

export const trafficSnapshot = {
  workspace: "Zerker Labs",
  environment: "All environments",
  source: "Invocation fixture v1",
  refreshedAt: "2026-08-18T09:12:00Z",
  evaluatedAt: "2026-08-18T09:12:00Z",
  defaultRange: "24h",
};

export const catalogSnapshot = {
  workspace: "Zerker Labs",
  environment: "All environments",
  source: "Tenant catalog fixture v1",
  refreshedAt: "2026-08-18T09:12:00Z",
  evaluatedAt: "2026-08-18T09:12:00Z",
};

export const environmentSnapshot = {
  workspace: "Zerker Labs",
  environment: "All environments",
  source: "Environment evidence fixture v1",
  refreshedAt: "2026-08-18T09:12:00Z",
  evaluatedAt: "2026-08-18T09:12:00Z",
  observerRecentWithinMs: 5 * 60 * 1000,
};

export const agents = [
  {
    id: "agt_support", name: "Support agent", runtime: "Claude Code", protocol: "http", upstreamConfigured: true, inactiveAt: null, suspended: false,
    createdAt: "2026-07-04T11:20:00Z", updatedAt: "2026-08-17T16:40:00Z", latestInvocationAt: "2026-08-18T09:12:00Z",
    calls: 486, failures: 4, success: "99.2%", p95: "1.4s", credentialRef: "support-production", ratePerSecond: 2, burst: 20,
    pricing: null, captureBody: false, emitReceipts: false,
  },
  {
    id: "agt_research", name: "Research agent", runtime: "Hermes", protocol: "mcp", mcpTransport: "streamable_http", mcpProtocolVersion: "2025-03-26", upstreamConfigured: true, inactiveAt: null, suspended: false,
    createdAt: "2026-07-08T08:15:00Z", updatedAt: "2026-08-18T07:55:00Z", latestInvocationAt: "2026-08-18T09:09:00Z",
    calls: 214, failures: 4, success: "98.1%", p95: "2.8s", credentialRef: "research-vault", ratePerSecond: 1, burst: 20,
    pricing: { scheme: "exact", asset: "USDC", network: "base", displayAmount: "$0.25 / call", tool: "research.report" }, captureBody: false, emitReceipts: true,
  },
  {
    id: "agt_release", name: "Release reviewer", runtime: "Pi", protocol: "mcp", mcpTransport: "streamable_http", mcpProtocolVersion: "2025-03-26", upstreamConfigured: true, inactiveAt: null, suspended: false,
    createdAt: "2026-07-11T14:05:00Z", updatedAt: "2026-08-16T10:22:00Z", latestInvocationAt: "2026-08-18T09:11:00Z",
    calls: 173, failures: 0, success: "100%", p95: "3.1s", credentialRef: "github-app", ratePerSecond: 0.5, burst: 10,
    pricing: null, captureBody: false, emitReceipts: true,
  },
  {
    id: "agt_docs", name: "Docs search", runtime: "Gemini CLI", protocol: "mcp", mcpTransport: "streamable_http", mcpProtocolVersion: "2025-03-26", upstreamConfigured: true, inactiveAt: null, suspended: false,
    createdAt: "2026-07-15T09:30:00Z", updatedAt: "2026-08-18T08:20:00Z", latestInvocationAt: "2026-08-18T09:08:00Z",
    calls: 301, failures: 1, success: "99.7%", p95: "720ms", credentialRef: "docs-api", ratePerSecond: 4, burst: 30,
    pricing: { scheme: "exact", asset: "USDC", network: "base", displayAmount: "$0.05 / call", tool: "search_docs" }, captureBody: false, emitReceipts: false,
  },
  {
    id: "agt_codegen", name: "Code generator", runtime: "Codex", protocol: "http", upstreamConfigured: true, inactiveAt: null, suspended: true,
    createdAt: "2026-07-18T12:00:00Z", updatedAt: "2026-08-18T09:04:00Z", latestInvocationAt: "2026-08-18T09:03:00Z",
    calls: 82, failures: 7, success: "91.4%", p95: "8.6s", credentialRef: "openai-team", ratePerSecond: 0.33, burst: 8,
    pricing: null, captureBody: false, emitReceipts: false,
  },
  {
    id: "agt_triage", name: "Customer triage", runtime: "HTTP service", protocol: "http", upstreamConfigured: false, inactiveAt: null, suspended: false,
    createdAt: "2026-08-18T08:35:00Z", updatedAt: "2026-08-18T08:35:00Z", latestInvocationAt: null,
    calls: 0, failures: 0, success: null, p95: null, credentialRef: null, ratePerSecond: null, burst: null,
    pricing: null, captureBody: false, emitReceipts: false,
  },
  {
    id: "agt_legacy", name: "Legacy summarizer", runtime: "HTTP service", protocol: "http", upstreamConfigured: true, inactiveAt: "2026-08-12T17:10:00Z", suspended: false,
    createdAt: "2026-06-20T10:00:00Z", updatedAt: "2026-08-12T17:10:00Z", latestInvocationAt: null,
    calls: 0, failures: 0, success: null, p95: null, credentialRef: null, ratePerSecond: null, burst: null,
    pricing: null, captureBody: false, emitReceipts: false,
  },
];

export const invocations = [
  { id: "inv_7HF3", agent: "Support agent", mode: "stream", method: "HTTP", result: "succeeded", occurredAt: "2026-08-18T09:12:00Z", completedAt: "2026-08-18T09:12:01.200Z", latency: "1.2s", latencyMs: 1200, size: "24 KB", policy: "allow", paymentState: "not_required", paymentAmountCents: null, paymentCurrency: "USD", time: "Just now" },
  { id: "inv_7HF2", agent: "Release reviewer", mode: "transaction", method: "tools/call · check_release", result: "succeeded", occurredAt: "2026-08-18T09:11:00Z", completedAt: "2026-08-18T09:11:03.100Z", latency: "3.1s", latencyMs: 3100, size: "18 KB", policy: "allow", paymentState: "not_required", paymentAmountCents: null, paymentCurrency: "USD", time: "1m" },
  { id: "inv_7HF1", agent: "Research agent", mode: "stream", method: "tools/call · research.report", result: "succeeded", occurredAt: "2026-08-18T09:09:00Z", completedAt: "2026-08-18T09:09:02.600Z", latency: "2.6s", latencyMs: 2600, size: "41 KB", policy: "allow", paymentState: "verified", paymentAmountCents: 25, paymentCurrency: "USD", paymentRail: "x402 · USDC on Base", time: "3m" },
  { id: "inv_7HE9", agent: "Docs search", mode: "transaction", method: "tools/call · search_docs", result: "succeeded", occurredAt: "2026-08-18T09:08:00Z", completedAt: "2026-08-18T09:08:00.680Z", latency: "680ms", latencyMs: 680, size: "9 KB", policy: "warn", paymentState: "verified", paymentAmountCents: 5, paymentCurrency: "USD", paymentRail: "x402 · USDC on Base", time: "4m" },
  { id: "inv_7HE8", agent: "Code generator", mode: "transaction", method: "HTTP", result: "failed", occurredAt: "2026-08-18T09:03:00Z", completedAt: "2026-08-18T09:03:10.000Z", latency: "10.0s", latencyMs: 10000, size: "3 KB", policy: "allow", paymentState: "not_required", paymentAmountCents: null, paymentCurrency: "USD", time: "9m", failure: { stage: "proxy", class: "upstream_timeout", label: "Upstream timeout", upstreamStatus: null, retryability: null } },
];

export const activity = [
  { agent: "Pi", event: "Tool completed", detail: "bash · success · 1.8s", time: "Now", kind: "agent event" },
  { agent: "Research agent", event: "Payment settled", detail: "USDC · Base · $0.25", time: "3m", kind: "settlement" },
  { agent: "Docs search", event: "Policy warning", detail: "large-response · request forwarded", time: "4m", kind: "decision" },
  { agent: "Code generator", event: "Circuit opened", detail: "upstream timeout · runtime protection", time: "9m", kind: "runtime" },
  { agent: "Hermes", event: "Session ended", detail: "3 tools · 11m duration", time: "18m", kind: "agent event" },
];

export const attention = [
  { level: "high", title: "Code generator is suspended", detail: "Its catalog status remains active, but the independent suspension blocks invocations. Review the timeout evidence before any human-approved resume.", action: "Inspect failures", target: "invocations" },
  { level: "medium", title: "Cursor is ready for enrollment", detail: "Discovered on Stefan’s Mac mini. Observe-only enrollment is available in PR #46.", action: "Review setup", target: "environments" },
  { level: "low", title: "Seven policy warnings today", detail: "All requests continued. The large-response rule accounts for six warnings.", action: "Review decisions", target: "policies" },
];

export const policies = {
  default: "allow",
  onError: "deny",
  rules: [
    { name: "Block destructive tools", match: "delete_* · write_production", scope: "All agents", action: "deny", decisions: 2 },
    { name: "Protect large requests", match: "Body ≥ 8 MB", scope: "Support agent", action: "warn", decisions: 7 },
    { name: "Research rate boundary", match: "> 60 requests/min", scope: "Research agent", action: "deny", decisions: 0 },
    { name: "Release tools only", match: "check_*", scope: "Release reviewer", action: "allow", decisions: 41 },
  ],
  decisions: [
    { time: "4m", agent: "Docs search", tool: "search_docs", action: "warn", rule: "Protect large requests", reason: "Response budget approached" },
    { time: "21m", agent: "Support agent", tool: "delete_customer", action: "deny", rule: "Block destructive tools", reason: "Tool matched deny rule" },
    { time: "46m", agent: "Release reviewer", tool: "check_release", action: "allow", rule: "Release tools only", reason: "Explicit tool allow-list" },
  ],
};

export const credentials = [
  { name: "support-production", type: "Bearer", source: "Managed", hint: "•••• 8F2A", version: 4, usedBy: "Support agent", rotated: "12 days ago" },
  { name: "research-vault", type: "API key", source: "Vault", hint: "vault://research/prod", version: 2, usedBy: "Research agent", rotated: "5 days ago" },
  { name: "github-app", type: "Bearer", source: "Managed", hint: "•••• C91D", version: 7, usedBy: "Release reviewer", rotated: "Yesterday" },
  { name: "docs-api", type: "API key", source: "Managed", hint: "•••• 44E0", version: 3, usedBy: "Docs search", rotated: "28 days ago" },
  { name: "openai-team", type: "Bearer", source: "Managed", hint: "•••• D117", version: 5, usedBy: "Code generator", rotated: "8 days ago" },
];

export const products = [
  { name: "Research reports", agent: "Research agent", access: "Customer plan", price: "$0.25 / call", status: "Concept", domain: "research.example.com" },
  { name: "Docs API", agent: "Docs search", access: "Public with payment", price: "$0.05 / call", status: "Concept", domain: "docs.example.com" },
];

export const settlements = [
  { id: "set_91A", product: "Research reports", payer: "0x72…9ac", amount: "$0.25", rail: "x402 · USDC", status: "settled", time: "3m" },
  { id: "set_919", product: "Docs API", payer: "0x18…2de", amount: "$0.05", rail: "x402 · USDC", status: "settled", time: "12m" },
  { id: "set_918", product: "Research reports", payer: "0xb4…813", amount: "$0.25", rail: "x402 · USDC", status: "failed", time: "38m" },
];

export const environments = [
  {
    id: "env_gateway", name: "Production Gateway", kind: "Self-hosted Gateway", delivery: "available", source: "Gateway health fixture",
    probeAt: "2026-08-18T09:11:48Z", healthState: "healthy", catalogAgents: 7, pendingAgents: 1, suspendedAgents: 1,
    storage: "Postgres", version: "gateway development",
  },
  {
    id: "env_alex", name: "Alex’s MacBook Pro", kind: "Local observer", delivery: "review", source: "Agent activity fixture · PR #46",
    lastEvidenceAt: "2026-08-18T09:12:00Z", enrollmentState: "enrolled", observed: 3, enrolled: 3, discovered: 0,
  },
  {
    id: "env_stefan", name: "Stefan’s Mac mini", kind: "Local observer", delivery: "review", source: "Agent activity fixture · PR #46",
    lastEvidenceAt: "2026-08-18T09:02:00Z", enrollmentState: "enrolled", observed: 2, enrolled: 3, discovered: 1,
  },
];

export const onboardingEvidence = [
  { id: "obs_support", agentID: "agt_support", name: "Support agent", runtime: "Claude Code", environmentID: "env_alex", environment: "Alex’s MacBook Pro", enrollmentState: "enrolled", lastEventAt: "2026-08-18T09:10:00Z", source: "Native observer fixture · PR #46" },
  { id: "obs_research", agentID: "agt_research", name: "Research agent", runtime: "Hermes", environmentID: "env_stefan", environment: "Stefan’s Mac mini", enrollmentState: "enrolled", lastEventAt: "2026-08-18T08:54:00Z", source: "Native observer fixture · PR #46" },
  { id: "obs_triage", agentID: "agt_triage", name: "Customer triage", runtime: "HTTP service", environmentID: "env_stefan", environment: "Stefan’s Mac mini", enrollmentState: "enrolled", lastEventAt: null, source: "Native observer fixture · PR #46" },
  { id: "obs_cursor", agentID: null, name: "Cursor", runtime: "Cursor", environmentID: "env_stefan", environment: "Stefan’s Mac mini", enrollmentState: "discovered", lastEventAt: null, discoveredAt: "2026-08-18T09:06:00Z", source: "Local discovery fixture · PR #46" },
];

export const stack = [
  { name: "Gateway", job: "Catalog, proxy, policy, credentials, analytics and payment gate", status: "Available", tone: "available" },
  { name: "Facilitator", job: "Independent x402 verification and on-chain settlement", status: "Available OSS", tone: "available" },
  { name: "Agent activity", job: "Local discovery, observe-only enrollment and metadata summaries", status: "In review · PR #46", tone: "review" },
  { name: "Reason", job: "Deterministic exact-action authorization certificates", status: "Standalone", tone: "standalone" },
  { name: "ZMem + Rooms", job: "Governed context, quarantined memory and long-running work", status: "Integration path", tone: "integration" },
  { name: "Treeship", job: "Signed evidence and portable trust receipts", status: "Integration in progress", tone: "integration" },
  { name: "Guard", job: "Enforce verified Reason certificates before tools execute", status: "Next integration", tone: "planned" },
  { name: "Agent portals", job: "Branded products, access, docs, usage and billing", status: "Product direction", tone: "planned" },
  { name: "Remote missions", job: "Dispatch bounded work with budgets and approvals", status: "Planned", tone: "planned" },
];

export const privacy = {
  collected: ["Session lifecycle", "Tool name and outcome", "Duration", "Model identity", "Token counts", "Reported cost"],
  excluded: ["Prompts and messages", "Tool arguments and outputs", "Commands and file paths", "Files and environment values", "Credentials"],
};
