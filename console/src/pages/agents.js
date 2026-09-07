// Agents: the catalog, and one agent in the detail panel.

import { agentHealth, agentIndex, settled, windowAnalytics } from './shared.js';
import { api } from '../live/api.js';
import { openPanel, state, updatePanel } from '../shell.js';
import { esc, fmt, foldGroups, ms, pct, st, table, tag, usdc, when, WINDOWS } from '../ui.js';

const FILTERS = {
  all: 'All',
  http: 'HTTP',
  mcp: 'MCP',
  paid: 'Paid',
  paused: 'Paused or not connected',
};

function agentState(a) {
  if (a.status === 'pending') return ['off', 'Not connected yet'];
  if (a.suspended) return ['attn', 'Paused'];
  if (a.status === 'inactive') return ['off', 'Deleted'];
  return ['good', 'Active'];
}

function matches(a, filter) {
  if (!filter || filter === 'all') return true;
  if (filter === 'http') return (a.protocol || 'http') === 'http';
  if (filter === 'mcp') return a.protocol === 'mcp';
  if (filter === 'paid') return Boolean(a.pricing);
  if (filter === 'paused') return a.suspended || a.status === 'pending';
  return true;
}

export async function agentsPage(s) {
  const w = WINDOWS[s.win];
  const [agents, analytics] = await Promise.all([agentIndex(), windowAnalytics(s)]);
  if (!agents.ok) {
    return `<h1>Agents</h1><p class="lede">The agent catalog could not be read from Gateway.</p>`;
  }
  const folded = foldGroups(analytics.groups);
  const filter = s.filters.agent || 'all';
  const shown = agents.agents.filter((a) => matches(a, filter));

  const rows = shown.map((a) => {
    const h = agentHealth(a, folded);
    const [tone, word] = agentState(a);
    const invocable = a.status === 'active' && !a.suspended;
    return `<tr class="click" data-go="#agents/${esc(a.id)}">
      <td><div class="name">${esc(a.name)}</div><div class="sub">${esc(a.description || 'No description')}</div></td>
      <td>${st(h.failing ? 'bad' : tone, h.failing ? 'Failing' : word)}</td>
      <td>${a.protocol === 'mcp' ? 'MCP' : 'HTTP'}</td>
      <td class="num">${invocable ? fmt(h.calls) : '—'}</td>
      <td class="num">${invocable ? (h.errors ? `<span class="fail-count">${fmt(h.errors)}</span>` : '0') : '—'}</td>
      <td class="num">${!invocable ? '—' : h.p95 === null ? (h.merged ? '<span class="sub" title="A percentile cannot be merged across buckets">—</span>' : '—') : ms(h.p95)}</td>
      <td>${a.pricing ? esc(usdc(a.pricing.amount)) : '<span class="sub">free</span>'}</td>
      <td>${a.emit_receipts ? tag('good', 'on') : tag('off', 'off')}</td>
    </tr>`;
  });

  return `<h1>Agents</h1>
  <p class="lede">${fmt(agents.agents.length)} registered. Open one to see its upstream, credential, price, and how it has been behaving.</p>
  <div class="chips">${Object.entries(FILTERS)
    .map(([k, label]) => `<button class="chip${filter === k ? ' on' : ''}" data-filter="agent=${k}">${esc(label)}</button>`)
    .join('')}</div>
  ${table(
    [
      { label: 'Agent' }, { label: 'Status' }, { label: 'Type' },
      { label: 'Calls', num: true }, { label: 'Failed', num: true }, { label: 'p95', num: true },
      { label: 'Price' }, { label: 'Receipts' },
    ],
    rows,
    { emptyText: 'No agent matches this filter.' }
  )}
  <p class="src">Call counts and p95 come from the gateway's analytics for the ${esc(w.label)}.${
    [...folded.agents.values()].some((a) => a.merged)
      ? ' A per-agent p95 is shown only when the window is a single bucket — percentiles cannot be merged across buckets, and the window figure on Overview is the one that spans them.'
      : ''
  }</p>`;
}

export async function agentPanel(id) {
  openPanel('<p>Reading agent…</p>');
  const [agent, analytics, creds] = await Promise.all([
    settled(api.getAgent(id)),
    windowAnalytics(state),
    settled(api.listCredentials()),
  ]);
  if (!agent.ok) {
    updatePanel(`<h2>Agent not found</h2><p>No agent with this id exists in your tenant.</p>`);
    return;
  }
  const a = agent.value;
  const h = agentHealth(a, foldGroups(analytics.groups));
  const [tone, word] = agentState(a);
  const cred = (creds.value?.credentials || []).find((c) => c.id === a.credential_ref);
  const w = WINDOWS[state.win];

  updatePanel(`<h2>${esc(a.name)}</h2>
  <div class="id mono">${esc(a.id)} <button class="copy" data-action="copy" data-value="${esc(a.id)}">copy</button></div>
  <dl class="kv">
    <dt>Status</dt><dd>${st(tone, word)}</dd>
    <dt>Does</dt><dd>${esc(a.description || 'No description')}</dd>
    <dt>Type</dt><dd>${a.protocol === 'mcp' ? 'MCP server, streamable HTTP' : 'HTTP upstream'}</dd>
    <dt>Upstream</dt><dd>${a.upstream_url ? `<span class="mono">${esc(a.upstream_url)}</span>` : tag('off', 'none yet')}</dd>
    <dt>Credential</dt><dd>${cred ? `${esc(cred.name)} <span class="sub">(${esc(cred.masked_hint || cred.source)}, v${esc(cred.version)})</span>` : a.credential_ref ? `<span class="mono">${esc(a.credential_ref)}</span>` : 'none'}</dd>
    <dt>Rate limit</dt><dd>${a.invocation_rate_limit ? `${esc(a.invocation_rate_limit)}/s · burst ${esc(a.invocation_burst ?? 20)}` : 'Process default'}</dd>
    <dt>Price</dt><dd>${a.pricing ? `${esc(usdc(a.pricing.amount))} per call${a.pricing.tools ? `, ${Object.keys(a.pricing.tools).length} tool override(s)` : ''}` : 'free'}</dd>
    <dt>Receipts</dt><dd>${a.emit_receipts ? 'signed after every call' : tag('off', 'off')}</dd>
    <dt>Body capture</dt><dd>${a.capture_body ? 'on' : 'off'}</dd>
    <dt>Registered</dt><dd>${esc(when(a.created_at))} by ${esc(a.created_by || 'unknown')}</dd>
  </dl>
  <h3>${esc(w.word.replace(/^./, (c) => c.toUpperCase()))}</h3>
  <dl class="kv">
    <dt>Calls</dt><dd>${fmt(h.calls)}</dd>
    <dt>Failed</dt><dd>${fmt(h.errors)}${h.calls ? ` (${pct(h.errors / h.calls)})` : ''}</dd>
    <dt>p95 latency</dt><dd>${h.p95 === null ? 'Not available for a multi-bucket window' : ms(h.p95)}</dd>
  </dl>
  <p><a class="btn sec" href="#traffic/agent/${esc(a.id)}">See its calls</a></p>
  <h3>Call it through the gateway</h3>
  <pre>curl -H "Authorization: Bearer $TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '${a.protocol === 'mcp' ? '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' : '{"hello":"world"}'}' \\
  $GATEWAY/v1/proxy/${esc(a.id)}</pre>
  <p class="src">The stored credential is added by the gateway on the way out. The caller never sees it, and the caller's own Authorization header is stripped before the upstream is reached.</p>`);
}
