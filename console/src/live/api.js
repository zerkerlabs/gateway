// The live Gateway client.
//
// Every call is same-origin to /api/*, which the console BFF proxies to the
// gateway with a bearer this code never sees and cannot read. That is the
// whole point of the arrangement: there is no token in this file, no token in
// storage, and nothing here to steal.

// Everything under /v1 is tenant-scoped and authenticated. /healthz and
// /version sit outside it — they are the gateway's two unauthenticated routes —
// but they still travel through the BFF, which strips the /api prefix before
// forwarding. So the console reaches them on its own session like anything
// else; it just cannot address them through the versioned base.
const BASE = '/api/v1';
const ROOT = '/api';

// Build a query string from a plain object, dropping keys the caller left
// absent. Callers pass filters as objects and never assemble URLs themselves,
// so a filter that is "not set" cannot accidentally travel as the string
// "undefined" — which the gateway would reject, or worse, match nothing on.
function query(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, base = BASE } = {}) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      // Same-origin credentials: the session cookie rides along, and because
      // it is HttpOnly this code cannot read it either.
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'unreachable', 'The console could not reach Gateway.');
  }

  if (res.status === 401) throw new ApiError(401, 'unauthenticated', 'Your session has ended.');
  if (res.status === 204) return null;

  let payload = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) payload = await res.json().catch(() => null);

  if (!res.ok) {
    // A 404 is passed straight through as "not found". It must not be
    // rephrased as "belongs to another tenant" or anything else that would
    // confirm the resource exists — the gateway answers cross-tenant lookups
    // this way deliberately.
    throw new ApiError(res.status, payload?.error || 'error', payload?.message || `Request failed (${res.status}).`);
  }
  return payload;
}

export const api = {
  session: () => fetch('/auth/session', { credentials: 'same-origin' }).then((r) => r.json()),

  logout: () =>
    fetch('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    }).then((r) => (r.ok ? r.json() : null)),

  // --- catalog
  listAgents: (params) => request(`/agents${query({ per_page: 100, ...params })}`),
  getAgent: (id) => request(`/agents/${encodeURIComponent(id)}`),
  createAgent: (agent) => request('/agents', { method: 'POST', body: agent }),
  // PATCH is tri-state on the gateway: an absent key leaves the field alone, an
  // explicit null clears it, a value sets it. Callers must therefore build the
  // patch by hand and never spread a whole agent record into it — that would
  // rewrite every field on the server with whatever the browser last read.
  updateAgent: (id, patch) =>
    request(`/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),

  // --- credentials (metadata only; a secret value is never returned)
  listCredentials: () => request('/credentials'),

  // --- traffic
  listInvocations: (params) => request(`/invocations${query(params)}`),
  getInvocation: (id) => request(`/invocations/${encodeURIComponent(id)}`),
  getAnalytics: (params) => request(`/analytics${query(params)}`),

  // Metadata-only agent activity. There is no GET that lists individual
  // events — this is the one read the gateway offers, a per-agent aggregate
  // over a window of at most 31 days. agent_id is required by the endpoint.
  summarizeAgentEvents: (agentId, params) =>
    request(`/agent-events/summary${query({ agent_id: agentId, ...params })}`),

  // --- governance
  getPolicy: () => request('/policy'),
  listPolicyDecisions: (params) => request(`/policy/decisions${query(params)}`),

  // A tenant that has never configured settlement gets a 404 here, and that is
  // the expected state rather than a failure — it is exactly what a gate-only
  // deployment looks like. Collapse it to null so callers branch on "not
  // configured" instead of catching an error to discover normality.
  getSettlementConfig: async () => {
    try {
      return await request('/settlement/config');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  // --- unauthenticated gateway routes, reached through the session anyway
  healthz: () => request('/healthz', { base: ROOT }),
  version: () => request('/version', { base: ROOT }),
};

// The gateway returns snake_case records with no analytics on them. The
// fixture catalog carries call counts and latency percentiles that simply do
// not exist on a freshly registered agent, so live rows render what is
// actually known and say nothing about the rest — presenting unknown as zero
// is the one thing UX_RUBRIC.md rules out.
//
// Note the rate-limit fields keep `null` rather than being coerced to a
// number: null means "no per-agent override, the process limiter applies",
// which is a different operational fact from a limit of zero.
export function normalizeAgent(a) {
  return {
    id: a.id,
    name: a.name,
    description: a.description || '',
    tags: a.tags || [],
    metadata: a.metadata || {},
    protocol: a.protocol || 'http',
    mcpTransport: a.mcp_transport || null,
    mcpProtocolVersion: a.mcp_protocol_version || null,
    upstreamUrl: a.upstream_url || null,
    status: a.status,
    suspended: Boolean(a.suspended),
    credentialRef: a.credential_ref || null,
    rateLimit: Number.isFinite(a.invocation_rate_limit) ? a.invocation_rate_limit : null,
    burst: Number.isFinite(a.invocation_burst) ? a.invocation_burst : null,
    emitReceipts: Boolean(a.emit_receipts),
    captureBody: Boolean(a.capture_body),
    pricing: a.pricing || null,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

// Fold an analytics response into per-agent totals.
//
// Counts and error counts sum across buckets; percentiles do not — a p95 is
// not a quantity you can add up or average, and merging cells would produce a
// number that is not a percentile of anything. So a multi-bucket window
// reports its latency as unknown rather than as a plausible-looking lie. When
// the window is a single bucket the percentile is exact and is carried through.
export function summarizeAnalyticsByAgent(response) {
  const byAgent = new Map();

  for (const group of response?.groups || []) {
    const current = byAgent.get(group.agent_id) || {
      calls: 0,
      errors: 0,
      buckets: 0,
      latencyP95Ms: null,
      ttftP95Ms: null,
    };

    current.calls += group.count || 0;
    // error_rate is a ratio in [0,1]; by_error_class is the same information
    // as counts, and summing it avoids re-deriving a count from a float.
    for (const n of Object.values(group.by_error_class || {})) current.errors += n || 0;
    current.buckets += 1;
    current.latencyP95Ms = group.latency_ms?.p95 ?? null;
    current.ttftP95Ms = group.ttft_ms?.p95 ?? null;

    byAgent.set(group.agent_id, current);
  }

  for (const summary of byAgent.values()) {
    if (summary.buckets > 1) {
      summary.latencyP95Ms = null;
      summary.ttftP95Ms = null;
      summary.percentilesMerged = true;
    }
  }
  return byAgent;
}
