// Traffic: every call the gateway let through, and one call in full.

import { agentIndex, recentInvocations, settled, windowAnalytics } from './shared.js';
import { api } from '../live/api.js';
import { openPanel, state, updatePanel } from '../shell.js';
import { ago, bars, bytes, denseBuckets, esc, fmt, ms, spark, st, table, tag, usdc, when, WINDOWS } from '../ui.js';

const ERROR_WORDS = {
  timeout: 'The upstream took too long to answer',
  upstream_5xx: 'The upstream returned a server error',
  upstream_4xx: 'The upstream rejected the request',
  credential_error: 'The stored credential could not be used',
  ssrf_blocked: 'The upstream address is not allowed',
  cancelled: 'The call was cancelled before it finished',
  internal: 'The gateway hit an internal error',
};

const FILTERS = {
  all: 'All calls',
  failed: 'Failed',
  streaming: 'Streaming',
  warned: 'Flagged by policy',
};

function operation(r) {
  if (r.mcp_tool) return `<span class="mono sm" >${esc(r.mcp_tool)}</span>`;
  if (r.mcp_method) return `<span class="mono sm" >${esc(r.mcp_method)}</span>`;
  return r.mode === 'streaming' ? 'stream' : 'call';
}

function resultCell(r) {
  if (r.status === 'failed') {
    const words = ERROR_WORDS[r.error_class] || 'The call failed';
    return st('bad', `${words.split(' ').slice(0, 3).join(' ')}…`);
  }
  if (r.status !== 'succeeded') return st('off', r.status === 'running' ? 'Running' : 'Pending');
  return st(r.policy_action === 'warn' ? 'attn' : 'good', r.policy_action === 'warn' ? 'Succeeded, flagged' : 'Succeeded');
}

export async function trafficPage(s) {
  const w = WINDOWS[s.win];
  const filter = s.filters.status || 'all';
  const params = {};
  if (filter === 'failed') params.status = 'failed';
  if (filter === 'streaming') params.mode = 'streaming';
  if (filter === 'warned') params.policy = 'warn';
  if (s.filters.agentId) params.agent_id = s.filters.agentId;

  const [list, agents, analytics] = await Promise.all([
    recentInvocations(s, { limit: 40, ...params }),
    agentIndex(),
    windowAnalytics(s),
  ]);
  if (!list.ok) return `<h1>Traffic</h1><p class="lede">Invocations could not be read from Gateway.</p>`;

  const totals = analytics.totals;
  const series = denseBuckets(analytics.groups, s.win);
  const rows = list.rows.map((r) => `<tr class="click" data-go="#traffic/${esc(r.id)}">
    <td>${esc(ago(r.created_at))}</td>
    <td class="name">${esc(agents.names.get(r.agent_id) || r.agent_id)}</td>
    <td>${operation(r)}${r.payment_amount ? ` ${tag('sig', usdc(r.payment_amount))}` : ''}</td>
    <td>${resultCell(r)}</td>
    <td class="num">${r.latency_ms === null ? '—' : ms(r.latency_ms)}</td>
    <td>${r.receipt_artifact_id ? tag('good', 'signed') : tag('off', '—')}</td>
  </tr>`);

  const agentName = s.filters.agentId ? agents.names.get(s.filters.agentId) : null;

  return `<h1>Traffic</h1>
  <p class="lede">${
    totals?.available
      ? totals.calls === 0
        ? `<b>No calls ${esc(w.word)}.</b> That is a measured zero for this window.`
        : `<b>${fmt(Math.round(totals.errorRate * totals.calls))} of ${fmt(totals.calls)} calls failed ${esc(w.word)}.</b> Median ${ms(totals.latencyP50Ms)}, p95 ${ms(totals.latencyP95Ms)}.`
      : 'Window totals are unavailable on this Gateway, so the figures below cover only the rows listed.'
  } Open a call to see what happened to it, step by step.</p>

  <div class="chips">
    ${Object.entries(FILTERS).map(([k, label]) => `<button class="chip${filter === k ? ' on' : ''}" data-filter="status=${k}">${esc(label)}</button>`).join('')}
    ${agentName ? `<button class="chip on" data-go="#traffic">${esc(agentName)} ×</button>` : ''}
  </div>

  <div class="card mb14" >
    <h2 class="card-title">Calls per ${s.win === '24h' ? 'hour' : 'day'}</h2>
    ${s.win === '24h' ? spark(series.counts, 'Calls per hour') : bars(series.counts, series.labels, '', 'calls')}
  </div>

  ${table(
    [{ label: 'When' }, { label: 'Agent' }, { label: 'What' }, { label: 'Result' }, { label: 'Latency', num: true }, { label: 'Receipt' }],
    rows,
    { emptyText: `No call matches. That is a real zero for the ${w.label}, not a loading state.` }
  )}
  <p class="src">${
    list.total !== null ? `${fmt(list.rows.length)} shown of ${fmt(list.total)} matching · ` : ''
  }A policy denial or an unpaid x402 challenge returns before an invocation exists, so refused and unpaid calls never appear here — they are on <a href="#policy">Policy</a>.</p>`;
}

// --- one call ------------------------------------------------------------------

function steps(r, receipt) {
  const out = [
    ['Received', 'good', when(r.created_at)],
    [
      'Policy checked',
      r.policy_action === 'warn' ? 'attn' : r.policy_action === 'allow' ? 'good' : 'off',
      r.policy_action === null
        ? 'No policy configured for this tenant — nothing evaluated this call'
        : r.policy_action === 'warn'
          ? `Flagged by rule ${r.policy_matched_rule || 'default'}, forwarded anyway`
          : `Allowed${r.policy_matched_rule ? ` by rule ${r.policy_matched_rule}` : ', no rule matched'}`,
    ],
  ];
  if (r.payment_amount) {
    out.push([
      'Payment verified',
      'good',
      `${usdc(r.payment_amount)} ${r.payment_asset || ''} on ${r.payment_network || 'unknown network'}${
        r.settlement ? ` · settlement ${r.settlement.status}` : ' · not settled'
      }`,
    ]);
  }
  out.push(['Sent to upstream', 'good', 'Stored credential added, caller token stripped']);
  out.push([
    r.status === 'failed' ? 'Failed' : r.status === 'succeeded' ? 'Answered' : 'Still running',
    r.status === 'failed' ? 'bad' : r.status === 'succeeded' ? 'good' : 'off',
    r.status === 'failed'
      ? `${ERROR_WORDS[r.error_class] || 'The call failed'}${r.upstream_status ? ` (HTTP ${r.upstream_status})` : ''}`
      : r.upstream_status
        ? `HTTP ${r.upstream_status} · ${bytes(r.resp_size)} out`
        : 'No upstream status recorded',
  ]);
  out.push([
    receipt?.attested ? 'Receipt signed' : 'Receipt not recorded',
    receipt?.attested ? 'good' : 'off',
    receipt?.attested ? receipt.artifact_id : receipt?.reason === 'receipts_disabled' ? 'Receipts are off on this deployment' : 'No artifact reference recorded for this call',
  ]);
  return out;
}

export async function invocationPanel(id) {
  openPanel('<p>Reading call…</p>');
  const [inv, receipt] = await Promise.all([settled(api.getInvocation(id)), settled(api.getInvocationReceipt(id))]);
  if (!inv.ok) {
    updatePanel(`<h2>Call not found</h2><p>No invocation with this id exists in your tenant.</p>`);
    return;
  }
  const r = inv.value;
  const rc = receipt.ok ? receipt.value : null;

  updatePanel(`<h2>${r.status === 'failed' ? 'Failed call' : r.policy_action === 'warn' ? 'Flagged call' : 'Call'}</h2>
  <div class="id mono">${esc(r.id)} <button class="copy" data-action="copy" data-value="${esc(r.id)}">copy</button></div>

  ${r.status === 'failed' ? `<p class="notice bad"><b>${esc(ERROR_WORDS[r.error_class] || 'The call failed')}.</b> ${
    r.error_class === 'credential_error'
      ? 'The stored credential could not be decrypted or was rejected — check it on System.'
      : r.error_class === 'timeout'
        ? 'The gateway gave up waiting.'
        : 'The upstream, not the gateway, produced this outcome.'
  }</p>` : ''}

  <h3>What happened</h3>
  <ol class="steps">${steps(r, rc).map(([label, tone, why]) => `<li><span class="dot ${esc(tone)}"></span><span>${esc(label)}</span><span class="t"></span>${why ? `<span class="why">${esc(why)}</span>` : ''}</li>`).join('')}</ol>

  ${rc?.attested
    ? `<section class="receipt ok"><h3>Trust receipt</h3>
        <dl class="kv"><dt>Artifact</dt><dd class="mono">${esc(rc.artifact_id)}</dd><dt>Signed as</dt><dd>${esc(rc.actor || 'this gateway')}</dd><dt>Signed at</dt><dd>${esc(when(rc.signed_at))}</dd></dl>
        <pre>${esc(rc.verify)}</pre>
        <p class="src">Gateway reports what it signed, never whether the signature holds — that is checked against the artifact by whoever relies on it.</p>
      </section>`
    : `<section class="receipt"><h3>Trust receipt</h3><p class="src">${esc(
        rc?.reason === 'receipts_disabled'
          ? 'This Gateway is not configured to sign receipts.'
          : 'No artifact reference is recorded. Emission is fail-open and off the request path, so this is not proof that nothing was signed.'
      )}</p></section>`}

  <dl class="kv">
    <dt>Agent</dt><dd><a href="#agents/${esc(r.agent_id)}">${esc(r.agent_id)}</a></dd>
    <dt>Mode</dt><dd>${r.mode === 'streaming' ? 'Streaming' : 'Transactional (202 + poll)'}</dd>
    ${r.mcp_method ? `<dt>MCP</dt><dd class="mono">${esc(r.mcp_method)}${r.mcp_tool ? ` · ${esc(r.mcp_tool)}` : ''}</dd>` : ''}
    <dt>Latency</dt><dd>${r.latency_ms === null ? 'Unknown' : ms(r.latency_ms)}${r.ttft_ms ? ` · first byte ${ms(r.ttft_ms)}` : ''}</dd>
    <dt>Sizes</dt><dd>${bytes(r.req_size)} in · ${bytes(r.resp_size)} out</dd>
    <dt>Model</dt><dd>${r.model ? esc(r.model) : 'Not supplied by the caller'}</dd>
    <dt>Bodies</dt><dd>${r.body_captured ? 'Captured' : 'Not captured'}${
      r.body_captured && !('req_body' in r) ? ' <span class="sub">(reading one needs the invocations:read_body scope)</span>' : ''
    }</dd>
    <dt>Created</dt><dd>${esc(when(r.created_at))}</dd>
    <dt>Completed</dt><dd>${r.completed_at ? esc(when(r.completed_at)) : 'Not yet'}</dd>
  </dl>`);
}
