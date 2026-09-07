// Reads several pages need, in the shapes they need them.
//
// Each helper returns `{ ok, value, reason }` rather than throwing, because a
// page is expected to render when one of its four reads fails. The one
// exception is a 401: that is re-thrown, because a dead session is not a
// partial answer and the shell has to send the operator back to sign-in.

import { analyticsTotals, api, ApiError } from '../live/api.js';
import { sinceOf, WINDOWS } from '../ui.js';

export async function settled(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw err;
    return {
      ok: false,
      value: null,
      // 404 on a whole family means the surface is not mounted on this
      // deployment — a different fact from a read that failed, and the pages
      // word it differently.
      reason: err instanceof ApiError && err.status === 404 ? 'unmounted' : 'error',
    };
  }
}

export async function windowAnalytics(state) {
  const since = sinceOf(state.win);
  const res = await settled(api.getAnalytics({ since, bucket: WINDOWS[state.win].bucket }));
  if (!res.ok) return { ...res, totals: null, groups: [] };
  return {
    ok: true,
    totals: analyticsTotals(res.value),
    groups: res.value?.groups || [],
    since,
  };
}

export async function recentInvocations(state, params = {}) {
  const res = await settled(api.listInvocations({ since: sinceOf(state.win), limit: 100, offset: 0, ...params }));
  if (!res.ok) return { ...res, rows: [], total: null };
  return { ok: true, rows: res.value?.data || [], total: res.value?.total ?? null };
}

export async function agentIndex() {
  const res = await settled(api.listAgents({ per_page: 100 }));
  if (!res.ok) return { ...res, agents: [], names: new Map() };
  const agents = res.value?.agents || [];
  return { ok: true, agents, names: new Map(agents.map((a) => [a.id, a.name])) };
}

export async function denialCount(state) {
  const res = await settled(api.listPolicyDecisions({ since: sinceOf(state.win), action: 'deny', limit: 1, offset: 0 }));
  if (!res.ok) return res;
  return { ok: true, value: res.value?.total ?? null };
}

// The catalog's own view of an agent's health, from the analytics fold.
export function agentHealth(agent, folded) {
  const row = folded.agents.get(agent.id);
  if (!row) return { calls: 0, errors: 0, p95: null, merged: false, failing: false };
  const failing = row.errors >= 3 && row.calls > 0 && row.errors / row.calls >= 0.02;
  return { ...row, failing };
}
