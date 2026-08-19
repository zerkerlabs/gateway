export const overviewSnapshot = {
  workspace: "Zerker Labs",
  environment: "All environments",
  range: "Last 24 hours",
  capturedAt: "2026-08-18T09:10:00Z",
  paymentVolumeCents: 50,
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

export const policySnapshot = {
  workspace: "Zerker Labs",
  environment: "All environments",
  source: "Policy and decision fixture v1",
  refreshedAt: "2026-08-18T09:12:00Z",
  evaluatedAt: "2026-08-18T09:12:00Z",
  range: "Last 24 hours",
};

export const credentialSnapshot = {
  workspace: "Zerker Labs",
  environment: "All environments",
  source: "Credential metadata fixture v1",
  refreshedAt: "2026-08-18T09:12:00Z",
  evaluatedAt: "2026-08-18T09:12:00Z",
};

export const paymentSnapshot = {
  workspace: "Zerker Labs",
  environment: "All environments",
  source: "Payment operation fixture v1",
  refreshedAt: "2026-08-18T09:12:00Z",
  evaluatedAt: "2026-08-18T09:12:00Z",
  range: "Last 24 hours",
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
  { level: "medium", title: "Cursor is ready for enrollment", detail: "Discovered on Stefan’s Mac mini. Observe-only enrollment is available in Gateway main.", action: "Review setup", target: "environments" },
  { level: "low", title: "Seven policy warnings today", detail: "All requests continued. The large-response rule accounts for six warnings.", action: "Review decisions", target: "policies" },
];

export const policies = {
  default: "allow",
  onError: "deny",
  outagePosture: "fail_closed",
  rules: [
    { id: "rule_destructive", order: 1, name: "Block destructive tools", dimension: "MCP tool", match: "delete_* · write_production", scope: "All agents", action: "deny", decisions: 2 },
    { id: "rule_large_request", order: 2, name: "Protect large requests", dimension: "Body size", match: "Body ≥ 8 MB", scope: "Support agent", action: "warn", decisions: 7 },
    { id: "rule_research_rate", order: 3, name: "Research rate boundary", dimension: "Caller rate", match: "> 60 requests/min", scope: "Research agent", action: "deny", decisions: 0 },
    { id: "rule_release_tools", order: 4, name: "Release tools only", dimension: "MCP tool", match: "check_*", scope: "Release reviewer", action: "allow", decisions: 41 },
  ],
  decisions: [
    { id: "dec_205", occurredAt: "2026-08-18T09:08:00Z", agent: "Docs search", protocol: "mcp", method: "tools/call", tool: "search_docs", action: "warn", ruleID: "rule_large_request", reason: "Body-size metadata matched warning rule", source: "Policy decision fixture" },
    { id: "dec_204", occurredAt: "2026-08-18T08:51:00Z", agent: "Support agent", protocol: "mcp", method: "tools/call", tool: "delete_customer", action: "deny", ruleID: "rule_destructive", reason: "Tool metadata matched deny rule", source: "Policy decision fixture" },
    { id: "dec_203", occurredAt: "2026-08-18T08:26:00Z", agent: "Release reviewer", protocol: "mcp", method: "tools/call", tool: "check_release", action: "allow", ruleID: "rule_release_tools", reason: "Explicit tool allow-list", source: "Policy decision fixture" },
    { id: "dec_202", occurredAt: "2026-08-18T07:40:00Z", agent: "Research agent", protocol: "mcp", method: "resources/list", tool: null, action: "allow", ruleID: null, reason: "No rule matched; default applied", source: "Policy decision fixture" },
    { id: "dec_201", occurredAt: "2026-08-18T06:20:00Z", agent: "Support agent", protocol: "http", method: "HTTP", tool: null, action: "warn", ruleID: "rule_large_request", reason: "Body-size metadata matched warning rule", source: "Policy decision fixture" },
  ],
};

export const credentials = [
  { id: "cred_support", name: "support-production", authType: "bearer", source: "managed", maskedLastFour: "8F2A", version: 4, references: ["Support agent"], createdAt: "2026-06-04T11:20:00Z", updatedAt: "2026-08-06T15:30:00Z" },
  { id: "cred_research", name: "research-vault", authType: "api_key", source: "external_vault", maskedLastFour: null, version: 2, references: ["Research agent"], createdAt: "2026-06-18T08:40:00Z", updatedAt: "2026-08-13T10:05:00Z" },
  { id: "cred_github", name: "github-app", authType: "bearer", source: "managed", maskedLastFour: "C91D", version: 7, references: ["Release reviewer"], createdAt: "2026-05-21T09:10:00Z", updatedAt: "2026-08-17T14:18:00Z" },
  { id: "cred_docs", name: "docs-api", authType: "api_key", source: "managed", maskedLastFour: "44E0", version: 3, references: ["Docs search"], createdAt: "2026-07-02T13:25:00Z", updatedAt: "2026-07-21T08:45:00Z" },
  { id: "cred_openai", name: "openai-team", authType: "bearer", source: "managed", maskedLastFour: "D117", version: 5, references: ["Code generator"], createdAt: "2026-06-29T16:00:00Z", updatedAt: "2026-08-10T17:40:00Z" },
  { id: "cred_staging", name: "staging-unused", authType: "api_key", source: "managed", maskedLastFour: null, version: 1, references: [], createdAt: "2026-08-15T12:10:00Z", updatedAt: "2026-08-15T12:10:00Z" },
];

export const products = [
  { name: "Research reports", agent: "Research agent", access: "Customer plan", price: "$0.25 / call", status: "Concept", domain: "research.example.com" },
  { name: "Docs API", agent: "Docs search", access: "Public with payment", price: "$0.05 / call", status: "Concept", domain: "docs.example.com" },
];

export const paymentOperations = [
  { id: "pay_305", occurredAt: "2026-08-18T09:12:00Z", agent: "Research agent", operation: "research.report", amountCents: 25, currency: "USD", asset: "USDC", network: "Base", gateState: "challenged", settlementState: "not_reached", upstreamState: "not_reached", facilitatorMode: "self_hosted", invocationID: null, maskedPayer: null, settlementAttempts: 0, reason: "Payment authorization required" },
  { id: "pay_304", occurredAt: "2026-08-18T09:10:00Z", agent: "Docs search", operation: "search_docs", amountCents: 5, currency: "USD", asset: "USDC", network: "Base", gateState: "verified", settlementState: "not_configured", upstreamState: "succeeded", facilitatorMode: "gate_only", invocationID: "inv_7HE9", maskedPayer: "0x18…2de", settlementAttempts: 0, reason: null },
  { id: "pay_303", occurredAt: "2026-08-18T09:08:00Z", agent: "Research agent", operation: "research.report", amountCents: 25, currency: "USD", asset: "USDC", network: "Base", gateState: "verified", settlementState: "settled", upstreamState: "succeeded", facilitatorMode: "self_hosted", invocationID: "inv_7HF1", maskedPayer: "0x72…9ac", settlementAttempts: 1, reason: null },
  { id: "pay_302", occurredAt: "2026-08-18T09:06:00Z", agent: "Docs search", operation: "search_docs", amountCents: 5, currency: "USD", asset: "USDC", network: "Base", gateState: "verified", settlementState: "settlement_failed", upstreamState: "not_called", facilitatorMode: "self_hosted", invocationID: "inv_7HE6", maskedPayer: "0xb4…813", settlementAttempts: 2, reason: "Payment could not be collected" },
  { id: "pay_301", occurredAt: "2026-08-18T09:03:00Z", agent: "Research agent", operation: "research.report", amountCents: 25, currency: "USD", asset: "USDC", network: "Base", gateState: "verified", settlementState: "settled_upstream_failed", upstreamState: "failed", facilitatorMode: "self_hosted", invocationID: "inv_7HE7", maskedPayer: "0x91…7af", settlementAttempts: 1, reason: "Upstream failed after settlement" },
];

export const facilitatorPosture = {
  mode: "self_hosted",
  configured: true,
  endpointConfigured: true,
  credentialConfigured: true,
  perTransactionLimitCents: 1000,
  dailyLimitCents: 10000,
  dailyUsedCents: 50,
  source: "Facilitator configuration fixture",
  capturedAt: "2026-08-18T09:12:00Z",
  selfHostedDelivery: "available",
  managedDelivery: "commercial",
};

export const analyticsSnapshot = {
  workspace: "Zerker Labs",
  environment: "All environments",
  source: "Gateway analytics fixture v1",
  refreshedAt: "2026-08-18T09:12:00Z",
  evaluatedAt: "2026-08-18T09:12:00Z",
  defaultWindow: "24h",
  maxWindowDays: 31,
  limiter: "Dedicated analytics limiter · contract posture",
};

export const analyticsScenarios = [
  { id: "complete", label: "Complete fixture", state: "complete" },
  { id: "empty", label: "Empty", state: "empty" },
  { id: "partial", label: "Partial", state: "partial" },
  { id: "unavailable", label: "Unavailable", state: "unavailable", publicMessage: "Analytics fixture evidence is unavailable. No Gateway request was made." },
  { id: "error", label: "Error", state: "error", publicMessage: "The analytics fixture could not be prepared. No Gateway request was made." },
];

export const analyticsWindows = {
  "1h": {
    label: "Last hour", since: "2026-08-18T08:12:00Z", until: "2026-08-18T09:12:00Z",
    aggregate: { count: 62, errors: 1, latencyMs: { p50: 590, p95: 1720, p99: 8300 }, ttftMs: { p50: 210, p95: 450, p99: 820 }, streamingSamples: 20 },
    errorTaxonomy: [{ id: "upstream_timeout", label: "Upstream timeout", count: 1 }, { id: "policy_denied", label: "Policy denied", count: 0 }, { id: "rate_limited", label: "Rate limited", count: 0 }, { id: "payment_required", label: "Payment required", count: 0 }],
    agents: [
      { name: "Support agent", count: 24, errors: 0, latencyP95Ms: 1320, streamingSamples: 10, ttftP95Ms: 410 },
      { name: "Docs search", count: 15, errors: 0, latencyP95Ms: 700, streamingSamples: 0, ttftP95Ms: null },
      { name: "Research agent", count: 10, errors: 0, latencyP95Ms: 2600, streamingSamples: 10, ttftP95Ms: 690 },
      { name: "Release reviewer", count: 9, errors: 0, latencyP95Ms: 3000, streamingSamples: 0, ttftP95Ms: null },
      { name: "Code generator", count: 4, errors: 1, latencyP95Ms: 8300, streamingSamples: 0, ttftP95Ms: null },
    ],
    operations: [
      { protocol: "HTTP", method: "Streaming proxy", tool: null, count: 10, errors: 0, latencyP95Ms: 1320, streaming: true, ttftP95Ms: 410 },
      { protocol: "HTTP", method: "Transactional proxy", tool: null, count: 18, errors: 1, latencyP95Ms: 8300, streaming: false, ttftP95Ms: null },
      { protocol: "MCP", method: "tools/call", tool: "research.report", count: 10, errors: 0, latencyP95Ms: 2600, streaming: true, ttftP95Ms: 690 },
      { protocol: "MCP", method: "tools/call", tool: "search_docs", count: 15, errors: 0, latencyP95Ms: 700, streaming: false, ttftP95Ms: null },
      { protocol: "MCP", method: "tools/call", tool: "check_release", count: 9, errors: 0, latencyP95Ms: 3000, streaming: false, ttftP95Ms: null },
    ],
  },
  "24h": {
    label: "Last 24 hours", since: "2026-08-17T09:12:00Z", until: "2026-08-18T09:12:00Z",
    aggregate: { count: 1256, errors: 16, latencyMs: { p50: 620, p95: 1800, p99: 8600 }, ttftMs: { p50: 230, p95: 720, p99: 1600 }, streamingSamples: 350 },
    errorTaxonomy: [{ id: "upstream_timeout", label: "Upstream timeout", count: 7 }, { id: "policy_denied", label: "Policy denied", count: 4 }, { id: "rate_limited", label: "Rate limited", count: 3 }, { id: "payment_required", label: "Payment required", count: 2 }],
    agents: [
      { name: "Support agent", count: 486, errors: 4, latencyP95Ms: 1400, streamingSamples: 200, ttftP95Ms: 480 },
      { name: "Docs search", count: 301, errors: 1, latencyP95Ms: 720, streamingSamples: 0, ttftP95Ms: null },
      { name: "Research agent", count: 214, errors: 4, latencyP95Ms: 2800, streamingSamples: 150, ttftP95Ms: 820 },
      { name: "Release reviewer", count: 173, errors: 0, latencyP95Ms: 3100, streamingSamples: 0, ttftP95Ms: null },
      { name: "Code generator", count: 82, errors: 7, latencyP95Ms: 8600, streamingSamples: 0, ttftP95Ms: null },
    ],
    operations: [
      { protocol: "HTTP", method: "Streaming proxy", tool: null, count: 200, errors: 1, latencyP95Ms: 1400, streaming: true, ttftP95Ms: 480 },
      { protocol: "HTTP", method: "Transactional proxy", tool: null, count: 368, errors: 10, latencyP95Ms: 8600, streaming: false, ttftP95Ms: null },
      { protocol: "MCP", method: "tools/call", tool: "research.report", count: 214, errors: 4, latencyP95Ms: 2800, streaming: true, ttftP95Ms: 820 },
      { protocol: "MCP", method: "tools/call", tool: "search_docs", count: 301, errors: 1, latencyP95Ms: 720, streaming: false, ttftP95Ms: null },
      { protocol: "MCP", method: "tools/call", tool: "check_release", count: 173, errors: 0, latencyP95Ms: 3100, streaming: false, ttftP95Ms: null },
    ],
  },
  "7d": {
    label: "Last 7 days", since: "2026-08-11T09:12:00Z", until: "2026-08-18T09:12:00Z",
    aggregate: { count: 7850, errors: 81, latencyMs: { p50: 640, p95: 1950, p99: 9100 }, ttftMs: { p50: 240, p95: 760, p99: 1710 }, streamingSamples: 2190 },
    errorTaxonomy: [{ id: "upstream_timeout", label: "Upstream timeout", count: 36 }, { id: "policy_denied", label: "Policy denied", count: 20 }, { id: "rate_limited", label: "Rate limited", count: 15 }, { id: "payment_required", label: "Payment required", count: 10 }],
    agents: [
      { name: "Support agent", count: 3030, errors: 20, latencyP95Ms: 1490, streamingSamples: 1250, ttftP95Ms: 510 },
      { name: "Docs search", count: 1880, errors: 8, latencyP95Ms: 760, streamingSamples: 0, ttftP95Ms: null },
      { name: "Research agent", count: 1340, errors: 18, latencyP95Ms: 2920, streamingSamples: 940, ttftP95Ms: 850 },
      { name: "Release reviewer", count: 1080, errors: 3, latencyP95Ms: 3260, streamingSamples: 0, ttftP95Ms: null },
      { name: "Code generator", count: 520, errors: 32, latencyP95Ms: 9100, streamingSamples: 0, ttftP95Ms: null },
    ],
    operations: [
      { protocol: "HTTP", method: "Streaming proxy", tool: null, count: 1250, errors: 7, latencyP95Ms: 1490, streaming: true, ttftP95Ms: 510 },
      { protocol: "HTTP", method: "Transactional proxy", tool: null, count: 2300, errors: 45, latencyP95Ms: 9100, streaming: false, ttftP95Ms: null },
      { protocol: "MCP", method: "tools/call", tool: "research.report", count: 1340, errors: 18, latencyP95Ms: 2920, streaming: true, ttftP95Ms: 850 },
      { protocol: "MCP", method: "tools/call", tool: "search_docs", count: 1880, errors: 8, latencyP95Ms: 760, streaming: false, ttftP95Ms: null },
      { protocol: "MCP", method: "tools/call", tool: "check_release", count: 1080, errors: 3, latencyP95Ms: 3260, streaming: false, ttftP95Ms: null },
    ],
  },
  "31d": {
    label: "Last 31 days", since: "2026-07-18T09:12:00Z", until: "2026-08-18T09:12:00Z",
    aggregate: { count: 34020, errors: 410, latencyMs: { p50: 670, p95: 2100, p99: 9700 }, ttftMs: { p50: 250, p95: 790, p99: 1840 }, streamingSamples: 9410 },
    errorTaxonomy: [{ id: "upstream_timeout", label: "Upstream timeout", count: 181 }, { id: "policy_denied", label: "Policy denied", count: 103 }, { id: "rate_limited", label: "Rate limited", count: 75 }, { id: "payment_required", label: "Payment required", count: 51 }],
    agents: [
      { name: "Support agent", count: 13120, errors: 91, latencyP95Ms: 1580, streamingSamples: 5400, ttftP95Ms: 530 },
      { name: "Docs search", count: 8150, errors: 31, latencyP95Ms: 790, streamingSamples: 0, ttftP95Ms: null },
      { name: "Research agent", count: 5830, errors: 72, latencyP95Ms: 3050, streamingSamples: 4010, ttftP95Ms: 890 },
      { name: "Release reviewer", count: 4700, errors: 15, latencyP95Ms: 3410, streamingSamples: 0, ttftP95Ms: null },
      { name: "Code generator", count: 2220, errors: 201, latencyP95Ms: 9700, streamingSamples: 0, ttftP95Ms: null },
    ],
    operations: [
      { protocol: "HTTP", method: "Streaming proxy", tool: null, count: 5400, errors: 35, latencyP95Ms: 1580, streaming: true, ttftP95Ms: 530 },
      { protocol: "HTTP", method: "Transactional proxy", tool: null, count: 9940, errors: 257, latencyP95Ms: 9700, streaming: false, ttftP95Ms: null },
      { protocol: "MCP", method: "tools/call", tool: "research.report", count: 5830, errors: 72, latencyP95Ms: 3050, streaming: true, ttftP95Ms: 890 },
      { protocol: "MCP", method: "tools/call", tool: "search_docs", count: 8150, errors: 31, latencyP95Ms: 790, streaming: false, ttftP95Ms: null },
      { protocol: "MCP", method: "tools/call", tool: "check_release", count: 4700, errors: 15, latencyP95Ms: 3410, streaming: false, ttftP95Ms: null },
    ],
  },
};

export const systemSnapshot = {
  workspace: "Zerker Labs",
  environment: "Production Gateway · fixture",
  source: "Gateway system posture fixture v1",
  refreshedAt: "2026-08-18T09:12:00Z",
  health: { state: "healthy", source: "Gateway health fixture", capturedAt: "2026-08-18T09:11:48Z", route: "/healthz", auth: "Unauthenticated", subsystems: ["Gateway", "Postgres", "Policy store"] },
  build: { source: "Gateway build metadata fixture", capturedAt: "2026-08-18T09:11:48Z", route: "/version", auth: "Unauthenticated", version: "gateway development · fixture", commit: "fixture-build-2026-08-18", replicaSamples: 1 },
  storage: { production: "Postgres durable path", fallback: "Memory · development only", migrations: "Automatic at boot · outcome not evidenced", backup: "Operator responsibility · not evidenced" },
  kms: { configurationEvidence: "Configured · fixture metadata only", requirement: "Stable 32-byte ZERKER_KMS_KEY required for durable production", fallback: "Ephemeral key · development only", masterRotation: "Unsupported", tenantRotation: "Internal tenant KEK seam · no public REST operation" },
  security: { apiIdentity: "Gateway API OIDC required at startup", consoleIdentity: "Not implemented · human approval required", tenancy: "Cross-tenant resources return 404", transport: "TLS externally", ssrf: "Checked at write and dial time", authorization: "Caller authorization stripped before credential injection", policyOutage: "Fails closed" },
  deployment: { binary: "Single statically linked Go binary", replicas: "Supported · active count unavailable", graceful: "60-second rollout allowance", upgrades: "Adjacent rolling upgrades", configuration: "Environment at boot · values never returned", sovereignty: "No call home", rateBoundary: "Per process when replicated" },
  facilitator: { configurationEvidence: "Configured · fixture metadata only", supported: "Not probed", readiness: "Not probed", gas: "Unknown", mtls: "Capability/configuration posture", accountMapping: "Capability/configuration posture", verification: "Independent re-verification", custody: "Gas relay · no payer/operator fund custody", localSigner: "Available OSS capability", awsSigner: "Implementation exists · not wired into startup" },
};

export const systemLimitations = [
  { id: "dev-fallbacks", title: "Development fallbacks", detail: "Memory storage and ephemeral keying are development-only." },
  { id: "master-rotation", title: "Master-key rotation", detail: "Unsupported; tenant KEK rotation is an internal seam." },
  { id: "rate-replicas", title: "Replica rate multiplication", detail: "Process boundaries multiply when horizontally replicated." },
  { id: "policy-outage", title: "Policy-store outage", detail: "Gateway fails closed today." },
  { id: "rollout", title: "Replica rollout", detail: "One build sample cannot confirm version parity." },
  { id: "aws-signer", title: "AWS KMS signer", detail: "Adapter exists but is not wired into startup." },
  { id: "facilitator-readiness", title: "Facilitator readiness", detail: "Configuration does not prove /supported, readiness, or gas." },
];

export const restOperations = [
  { id: "getHealthz", kind: "probe", auth: "unauthenticated", destination: "Stack & health" },
  { id: "getVersion", kind: "probe", auth: "unauthenticated", destination: "Stack & health" },
  { id: "createAgent", kind: "write", auth: "authenticated", destination: "Agent catalog" },
  { id: "listAgents", kind: "read", auth: "authenticated", destination: "Agent catalog" },
  { id: "getAgent", kind: "read", auth: "authenticated", destination: "Agent catalog" },
  { id: "updateAgent", kind: "write", auth: "authenticated", destination: "Agent catalog" },
  { id: "deleteAgent", kind: "write", auth: "authenticated", destination: "Agent catalog" },
  { id: "createCredential", kind: "write", auth: "authenticated", destination: "Credentials" },
  { id: "listCredentials", kind: "read", auth: "authenticated", destination: "Credentials" },
  { id: "getCredential", kind: "read", auth: "authenticated", destination: "Credentials" },
  { id: "putCredential", kind: "write", auth: "authenticated", destination: "Credentials" },
  { id: "deleteCredential", kind: "write", auth: "authenticated", destination: "Credentials" },
  { id: "transactInvocation", kind: "proxy", auth: "authenticated", destination: "Invocations" },
  { id: "streamInvocation", kind: "proxy", auth: "authenticated", destination: "Invocations" },
  { id: "pollInvocation", kind: "proxy", auth: "authenticated", destination: "Invocations" },
  { id: "listInvocations", kind: "read", auth: "authenticated", destination: "Invocations" },
  { id: "getInvocation", kind: "read", auth: "authenticated", destination: "Invocations" },
  { id: "getAnalytics", kind: "read", auth: "authenticated", destination: "Analytics" },
  { id: "getSettlementConfig", kind: "read", auth: "authenticated", destination: "Payments" },
  { id: "patchSettlementConfig", kind: "write", auth: "authenticated", destination: "Payments" },
  { id: "getPolicy", kind: "read", auth: "authenticated", destination: "Policies" },
  { id: "putPolicy", kind: "write", auth: "authenticated", destination: "Policies" },
  { id: "listPolicyDecisions", kind: "read", auth: "authenticated", destination: "Policies" },
];

export const sdkInventory = [
  { id: "go", name: "Go SDK", evidence: "Repository-evidenced", delivery: "available" },
  { id: "typescript", name: "TypeScript SDK", evidence: "Docs/repository discrepancy · sdk/ts absent in audited repository", delivery: "discrepancy" },
  { id: "wire", name: "Shared x402 wire types", evidence: "Developer-only contract inventory", delivery: "developer" },
];

export const environments = [
  {
    id: "env_gateway", name: "Production Gateway", kind: "Self-hosted Gateway", surface: "gateway", delivery: "available", source: "Gateway health fixture",
    probeAt: "2026-08-18T09:11:48Z", healthState: "healthy", catalogAgents: 7, pendingAgents: 1, suspendedAgents: 1,
    storage: "Postgres", version: "gateway development",
  },
  {
    id: "env_alex", name: "Alex’s MacBook Pro", kind: "Local observer", surface: "observer", delivery: "available", source: "Agent activity fixture · Gateway main",
    lastEvidenceAt: "2026-08-18T09:12:00Z", enrollmentState: "enrolled", observed: 3, enrolled: 3, discovered: 0,
  },
  {
    id: "env_stefan", name: "Stefan’s Mac mini", kind: "Local observer", surface: "observer", delivery: "available", source: "Agent activity fixture · Gateway main",
    lastEvidenceAt: "2026-08-18T09:02:00Z", enrollmentState: "enrolled", observed: 2, enrolled: 3, discovered: 1,
  },
];

export const onboardingEvidence = [
  { id: "obs_support", agentID: "agt_support", name: "Support agent", runtime: "Claude Code", environmentID: "env_alex", environment: "Alex’s MacBook Pro", enrollmentState: "enrolled", lastEventAt: "2026-08-18T09:10:00Z", source: "Native observer fixture · Gateway main" },
  { id: "obs_research", agentID: "agt_research", name: "Research agent", runtime: "Hermes", environmentID: "env_stefan", environment: "Stefan’s Mac mini", enrollmentState: "enrolled", lastEventAt: "2026-08-18T08:54:00Z", source: "Native observer fixture · Gateway main" },
  { id: "obs_triage", agentID: "agt_triage", name: "Customer triage", runtime: "HTTP service", environmentID: "env_stefan", environment: "Stefan’s Mac mini", enrollmentState: "enrolled", lastEventAt: null, source: "Native observer fixture · Gateway main" },
  { id: "obs_cursor", agentID: null, name: "Cursor", runtime: "Cursor", environmentID: "env_stefan", environment: "Stefan’s Mac mini", enrollmentState: "discovered", lastEventAt: null, discoveredAt: "2026-08-18T09:06:00Z", source: "Local discovery fixture · Gateway main" },
];

export const stack = [
  { name: "Gateway", job: "Catalog, proxy, policy, credentials, analytics and payment gate", status: "Available", tone: "available" },
  { name: "Facilitator", job: "Independent x402 verification and on-chain settlement", status: "Available OSS", tone: "available" },
  { name: "Agent activity", job: "Local discovery, observe-only enrollment and metadata summaries", status: "Available OSS", tone: "available" },
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
