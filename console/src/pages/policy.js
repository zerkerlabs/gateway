// Policy: the rules as written, and every decision they produced.
//
// The rules are rendered from the stored document's own match conditions. The
// gateway stores no prose explanation of a rule, so none is invented here — a
// rule reads as what it actually matches on.

import { agentIndex, settled } from './shared.js';
import { api } from '../live/api.js';
import { ago, bars, bytes, esc, fmt, sinceOf, table, tag, when, WINDOWS } from '../ui.js';

const ACTION_WORD = { deny: 'Block', warn: 'Flag', allow: 'Allow' };
const ACTION_TONE = { deny: 'bad', warn: 'attn', allow: 'good' };

function condition(match = {}, names) {
  const parts = [];
  if (match.agents?.length) {
    parts.push(`agent ${match.agents.map((id) => `<b>${esc(names.get(id) || id)}</b>`).join(' or ')}`);
  }
  if (match.tools?.length) {
    parts.push(`tool ${match.tools.map((t) => `<span class="mono sm" >${esc(t)}</span>`).join(' or ')}`);
  }
  if (match.methods?.length) {
    parts.push(`method ${match.methods.map((m) => `<span class="mono sm" >${esc(m)}</span>`).join(' or ')}`);
  }
  if (Number.isFinite(match.max_body_bytes)) parts.push(`body over ${esc(bytes(match.max_body_bytes))}`);
  if (Number.isFinite(match.rate_per_min)) parts.push(`more than ${fmt(match.rate_per_min)} calls a minute`);
  return parts.length ? parts.join(' and ') : 'every call';
}

export async function policyPage(s) {
  const w = WINDOWS[s.win];
  const since = sinceOf(s.win);
  const [policy, denials, decisions, agents] = await Promise.all([
    settled(api.getPolicy()),
    settled(api.listPolicyDecisions({ since, action: 'deny', limit: 100, offset: 0 })),
    settled(api.listPolicyDecisions({ since, limit: 25, offset: 0 })),
    agentIndex(),
  ]);

  if (!policy.ok) {
    return `<h1>Policy</h1><p class="lede">${
      policy.reason === 'unmounted'
        ? 'This Gateway has no policy surface mounted, so no calls are being evaluated.'
        : 'The policy document could not be read from Gateway.'
    }</p>`;
  }

  const doc = policy.value || {};
  const rules = doc.rules || [];
  const denyRows = denials.ok ? denials.value?.data || [] : [];
  const denyTotal = denials.ok ? denials.value?.total ?? null : null;

  // Denials per day, from the decision rows themselves. The decisions feed has
  // no server-side bucketing, so this counts the rows we hold and says so.
  const days = s.win === '24h' ? 1 : s.win === '7d' ? 7 : 30;
  const counts = new Array(days === 1 ? 24 : days).fill(0);
  const labels = [];
  const now = Date.now();
  for (let i = 0; i < counts.length; i += 1) {
    const t = new Date(now - (counts.length - 1 - i) * (days === 1 ? 3600000 : 86400000));
    labels.push(days === 1 ? `${String(t.getUTCHours()).padStart(2, '0')}:00` : t.toISOString().slice(5, 10));
  }
  for (const d of denyRows) {
    const age = now - new Date(d.created_at).getTime();
    const idx = counts.length - 1 - Math.floor(age / (days === 1 ? 3600000 : 86400000));
    if (idx >= 0 && idx < counts.length) counts[idx] += 1;
  }

  const ruleCounts = new Map();
  for (const d of denyRows) ruleCounts.set(d.matched_rule, (ruleCounts.get(d.matched_rule) || 0) + 1);

  return `<h1>Policy</h1>
  <p class="lede">${
    denyTotal === null
      ? 'The decision log could not be read, so the number of refusals in this window is unknown.'
      : `<b>${fmt(denyTotal)} call${denyTotal === 1 ? '' : 's'} refused ${esc(w.word)}.</b>`
  } Version ${esc(doc.version ?? 'unknown')}${doc.updated_at ? `, last changed ${esc(ago(doc.updated_at))}` : ''}. When no rule matches, calls are <b>${esc(doc.default || 'unknown')}</b>. If the engine cannot evaluate, calls are <b>${esc(doc.on_error || 'unknown')}</b>.</p>

  <div class="sec">
    <div class="row"><h2>The rules, in order</h2><span class="src m0" >Evaluated top to bottom. First match wins.</span></div>
    ${rules.length
      ? `<div class="rules">${rules.map((r, i) => `<div class="rule">
          <span class="k">${i + 1}</span>
          <div>
            <div>${tag(ACTION_TONE[r.action] || 'off', ACTION_WORD[r.action] || r.action)} &nbsp;${condition(r.match, agents.names)}</div>
            ${r.classifier ? `<div class="w">Also asks a classifier webhook before deciding.</div>` : ''}
          </div>
          <span class="sub">${fmt(ruleCounts.get(String(i + 1)) || 0)} refused ${esc(w.word)}</span>
        </div>`).join('')}</div>`
      : `<div class="card"><div class="empty">This tenant has no rules. Every call is ${esc(doc.default || 'allowed')}.</div></div>`}
    <p class="src">Conditions are read from the stored policy document. The gateway matches on agent, tool, method, body size, and observed rate — nothing about the call's content.</p>
  </div>

  <div class="sec card">
    <h2 class="card-title">Refusals per ${days === 1 ? 'hour' : 'day'}</h2>
    ${bars(counts, labels, 'bad', 'refusals')}
    <p class="src">Counted from the ${fmt(denyRows.length)} most recent refusals in this window${
      denyTotal !== null && denyTotal > denyRows.length ? `, of ${fmt(denyTotal)} total — older ones are not in this chart` : ''
    }.</p>
  </div>

  <div class="sec">
    <h2>Decisions, newest first</h2>
    ${table(
      [{ label: 'When' }, { label: 'Action' }, { label: 'Agent' }, { label: 'Tool' }, { label: 'Rule' }, { label: 'Receipt' }],
      (decisions.ok ? decisions.value?.data || [] : []).map((d) => `<tr>
        <td>${esc(ago(d.created_at))}</td>
        <td>${tag(ACTION_TONE[d.action] || 'off', ACTION_WORD[d.action] || d.action)}</td>
        <td class="name">${esc(agents.names.get(d.agent_id) || d.agent_id)}</td>
        <td>${d.mcp_tool ? `<span class="mono sm" >${esc(d.mcp_tool)}</span>` : '—'}</td>
        <td>${d.matched_rule ? `Rule ${esc(d.matched_rule)}` : `<span class="sub">${esc(doc.default || 'default')} (no rule matched)</span>`}</td>
        <td>${d.receipt_artifact_id ? `<span class="mono xxs" >${esc(d.receipt_artifact_id.slice(0, 14))}…</span>` : tag('off', '—')}</td>
      </tr>`),
      { emptyText: `Nothing was decided in the ${w.label}.` }
    )}
    <p class="src">A refused call returns before an invocation record exists, so this log is the only place it is visible — which is why each refusal is signed on its own.${
      decisions.ok && (decisions.value?.total ?? 0) > (decisions.value?.data?.length ?? 0)
        ? ` ${fmt(decisions.value.data.length)} of ${fmt(decisions.value.total)} shown.`
        : ''
    }</p>
  </div>

  <div class="sec card">
    <h2>The document</h2>
    <dl class="kv">
      <dt>Version</dt><dd>${esc(doc.version ?? 'unknown')}</dd>
      <dt>Default</dt><dd>${esc(doc.default || 'unknown')} <span class="sub">when no rule matches</span></dd>
      <dt>On error</dt><dd>${esc(doc.on_error || 'unknown')} <span class="sub">when the engine cannot evaluate</span></dd>
      <dt>Last changed</dt><dd>${doc.updated_at ? esc(when(doc.updated_at)) : 'Unknown'}</dd>
    </dl>
    <p class="src">Editing the policy from the console is not wired yet; it is written through <span class="mono">PUT /v1/policy</span>, and a write replaces the whole document.</p>
  </div>`;
}
