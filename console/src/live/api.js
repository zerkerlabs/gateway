// The live Gateway client.
//
// Every call is same-origin to /api/*, which the console BFF proxies to the
// gateway with a bearer this code never sees and cannot read. That is the
// whole point of the arrangement: there is no token in this file, no token in
// storage, and nothing here to steal.

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
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

  listAgents: () => request('/agents?per_page=100'),
  createAgent: (agent) => request('/agents', { method: 'POST', body: agent }),
  getAgent: (id) => request(`/agents/${encodeURIComponent(id)}`),
};

// The gateway returns snake_case records with no analytics on them. The
// fixture catalog carries call counts and latency percentiles that simply do
// not exist on a freshly registered agent, so live rows render what is
// actually known and say nothing about the rest — presenting unknown as zero
// is the one thing UX_RUBRIC.md rules out.
export function normalizeAgent(a) {
  return {
    id: a.id,
    name: a.name,
    description: a.description || '',
    tags: a.tags || [],
    protocol: a.protocol || 'http',
    mcpTransport: a.mcp_transport || null,
    upstreamUrl: a.upstream_url || null,
    status: a.status,
    suspended: Boolean(a.suspended),
    credentialRef: a.credential_ref || null,
    emitReceipts: Boolean(a.emit_receipts),
    captureBody: Boolean(a.capture_body),
    pricing: a.pricing || null,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}
