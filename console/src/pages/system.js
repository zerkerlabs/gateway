// System: what this deployment has turned on, and the credentials it holds.
//
// Every value here is a mode or a name. The gateway reports posture as modes
// deliberately — never a DSN, never a key — and the credential list carries
// metadata and a masked hint, never secret material.

import { agentIndex, settled } from './shared.js';
import { api } from '../live/api.js';
import { esc, fmt, st, table, tag, when } from '../ui.js';

function card(title, value, tone, note) {
  return `<div class="card"><h3>${esc(title)}</h3><div class="v">${tone ? `<span class="dot ${esc(tone)}"></span>` : ''}${esc(value)}</div><p>${esc(note)}</p></div>`;
}

export async function systemPage(s) {
  const [version, health, creds, agents] = await Promise.all([
    settled(api.version()),
    settled(api.healthz()),
    settled(api.listCredentials()),
    agentIndex(),
  ]);

  const caps = s.capabilities;
  const p = caps?.posture;
  const surfaces = caps?.surfaces || {};
  const limits = caps?.limits || {};

  const credentials = creds.ok ? creds.value?.credentials || [] : [];
  const usage = new Map();
  for (const a of agents.agents) {
    if (!a.credential_ref) continue;
    usage.set(a.credential_ref, [...(usage.get(a.credential_ref) || []), a.name]);
  }

  return `<h1>System</h1>
  <p class="lede">What this gateway has turned on, how it is deployed, and the credentials it holds for your upstreams. Values are never shown — only names, modes and states.</p>

  ${!caps ? '<p class="notice">This Gateway does not report its capabilities, so the posture below is unknown rather than assumed.</p>' : ''}
  ${p?.store === 'memory' ? '<p class="notice"><b>In-memory store.</b> Agents, credentials and invocations are lost on the next restart. This is the development fallback, not a deployment posture.</p>' : ''}
  ${p && p.kms_key_configured === false ? '<p class="notice bad"><b>Ephemeral master key.</b> The key wrapping stored credentials was generated at boot, so every credential stops decrypting when this process restarts — and re-entering them will not help until a stable key is configured.</p>' : ''}

  <div class="post">
    ${card('Version', version.ok ? version.value.version : 'Unknown', null, version.ok ? `commit ${String(version.value.commit).slice(0, 12)}` : 'The build metadata could not be read')}
    ${card('Health', health.ok ? health.value.status : 'Unknown', health.ok && health.value.status === 'ok' ? 'good' : 'bad', 'From /healthz, the one route that needs no token')}
    ${card('Store', p ? (p.store === 'postgres' ? 'Postgres' : 'In memory') : 'Unknown', p ? (p.store === 'postgres' ? 'good' : 'attn') : null, p?.store === 'postgres' ? 'Durable, migrations applied at boot' : 'Non-durable, development only')}
    ${card('Master key', p ? (p.kms_key_configured ? 'Configured' : 'Ephemeral') : 'Unknown', p ? (p.kms_key_configured ? 'good' : 'bad') : null, 'Wraps every stored upstream credential')}
    ${card('Receipts', p ? (p.receipts_enabled ? 'On' : 'Off') : 'Unknown', p ? (p.receipts_enabled ? 'good' : 'off') : null, p?.receipt_actor ? `Signed as ${p.receipt_actor}` : 'No signing actor reported')}
    ${card('Reason enforcement', surfaces.reason_enforcement ? 'On' : 'Off', surfaces.reason_enforcement ? 'good' : 'off', surfaces.reason_enforcement ? 'MCP tool calls must carry a verified authorization' : 'MCP tool calls are not required to carry one')}
    ${card('Settlement', p?.settlement_orchestration ? 'Wired' : 'Not wired', p?.settlement_orchestration ? 'good' : 'off', p?.settlement_orchestration ? 'Verified payments are settled before the upstream runs' : 'Priced routes gate but never collect')}
    ${card('Analytics window', limits.analytics_max_range_days ? `${limits.analytics_max_range_days} days` : 'Unknown', null, `${limits.invocations_max_limit || '—'} rows per page · ${limits.transact_max_body_bytes ? `${Math.round(limits.transact_max_body_bytes / (1024 * 1024))} MB` : '—'} per call`)}
  </div>

  <div class="sec">
    <div class="row"><h2>Mounted surfaces</h2><span class="src m0" >A surface that is not mounted answers 404 — which is why the console asks rather than guesses.</span></div>
    <div class="card"><p class="tagrow">${
      Object.entries(surfaces).length
        ? Object.entries(surfaces).map(([k, on]) => (on ? tag('good', k.replace(/_/g, ' ')) : tag('off', k.replace(/_/g, ' ')))).join('')
        : '<span class="sub">Unknown — this Gateway does not report capabilities.</span>'
    }</p></div>
  </div>

  <div class="sec">
    <div class="row"><h2>Credentials</h2><span class="src m0" >${fmt(credentials.length)} stored</span></div>
    ${table(
      [{ label: 'Name' }, { label: 'Kind' }, { label: 'Where' }, { label: 'Hint' }, { label: 'Version', num: true }, { label: 'Updated' }, { label: 'Used by' }],
      credentials.map((c) => `<tr>
        <td class="name">${esc(c.name)}</td>
        <td>${esc(c.auth_type === 'api_key' ? 'API key' : c.auth_type === 'bearer' ? 'Bearer' : 'None')}</td>
        <td>${esc(c.source === 'vault' ? 'Your vault' : 'Gateway, encrypted')}</td>
        <td class="mono sm" >${esc(c.masked_hint || c.vault_ref || '—')}</td>
        <td class="num">${fmt(c.version)}</td>
        <td>${esc(when(c.updated_at))}</td>
        <td>${(usage.get(c.id) || []).map((n) => esc(n)).join(', ') || '<span class="sub">unused</span>'}</td>
      </tr>`),
      { emptyText: creds.ok ? 'No credential is stored for this tenant.' : 'Credentials could not be read from Gateway.' }
    )}
    <p class="src">Secrets never leave the gateway. The hint is the last characters of the stored value, so two keys can be told apart without either being shown. "Updated" is the last write or rotation, which is the closest thing the API reports to a rotation date.</p>
  </div>

  <div class="sec card">
    <h2>Your session</h2>
    <dl class="kv">
      <dt>Tenant</dt><dd>${esc(s.identity?.tenant_id || 'Unknown')}</dd>
      <dt>Operator</dt><dd>${esc(s.identity?.user_id || 'Unknown')}</dd>
      <dt>Scopes</dt><dd>${s.identity?.scopes?.length ? s.identity.scopes.map((x) => `<span class="mono sm" >${esc(x)}</span>`).join(' ') : '<span class="sub">none</span>'}</dd>
      <dt>Body access</dt><dd>${s.identity?.can_read_invocation_bodies ? st('attn', 'This session may read captured request and response bodies') : st('good', 'This session cannot read captured bodies')}</dd>
    </dl>
    <p class="src">The console's server holds the Gateway token; this browser never receives one. Reading a captured body needs the <span class="mono">invocations:read_body</span> scope, which is deliberately separate from ordinary metadata access.</p>
  </div>`;
}
