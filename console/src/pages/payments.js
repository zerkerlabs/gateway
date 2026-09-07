// Payments: what the gate is charging for, and what actually settled.
//
// The gateway has no revenue aggregate, so nothing here is presented as one.
// Sums are computed over the invocations actually fetched and labelled that
// way; a window figure the API cannot produce is not fabricated from a page.

import { agentIndex, recentInvocations, settled } from './shared.js';
import { api } from '../live/api.js';
import { ago, answer, big, esc, fmt, hbars, st, table, tag, usdc, when, WINDOWS } from '../ui.js';

const SETTLEMENT_TONE = {
  settled: 'good',
  pending: 'attn',
  settlement_failed: 'bad',
  settled_upstream_failed: 'bad',
};

export async function paymentsPage(s) {
  const w = WINDOWS[s.win];
  const [list, agents, config] = await Promise.all([
    recentInvocations(s, { limit: 100 }),
    agentIndex(),
    settled(api.getSettlementConfig()),
  ]);

  const priced = agents.agents.filter((a) => a.pricing);
  const paid = (list.rows || []).filter((r) => r.payment_amount);
  const settledRows = paid.filter((r) => r.settlement?.status === 'settled');
  const failedAfterPay = paid.filter((r) => r.status === 'failed');

  const collected = settledRows.reduce((sum, r) => sum + Number(r.settlement?.settled_amount || r.payment_amount || 0), 0);
  const byAgent = priced
    .map((a) => ({
      k: a.name,
      v: settledRows.filter((r) => r.agent_id === a.id).reduce((t, r) => t + Number(r.settlement?.settled_amount || r.payment_amount || 0), 0),
    }))
    .filter((r) => r.v > 0)
    .sort((x, y) => y.v - x.v);

  const configured = config.ok && config.value;
  const orchestration = state_orchestration(s);

  return `<h1>Payments</h1>
  <p class="lede">${fmt(priced.length)} agent${priced.length === 1 ? '' : 's'} priced. ${
    configured
      ? `Verified payments are settled through <span class="mono">${esc(config.value.facilitator_url)}</span>.`
      : '<b>No settlement destination is configured</b>, so the gate verifies payments and forwards calls without collecting anything.'
  }</p>

  ${!configured ? `<p class="notice"><b>Gate-only.</b> Every priced call is held until a valid signed authorization arrives, then forwarded. Because no facilitator is configured, no money moves and the authorization's nonce is never consumed on-chain — replay protection stays best-effort until settlement is enabled.</p>` : ''}
  ${configured && !orchestration ? `<p class="notice"><b>A facilitator is configured but settle-then-forward is not wired on this deployment</b>, so priced routes still behave as gate-only.</p>` : ''}

  <div class="answers">
    ${answer({
      title: `Collected, newest ${fmt(list.rows.length)} calls`,
      body: list.ok ? big(usdc(String(Math.round(collected))), { tone: collected > 0 ? 'good' : 'off' }) : big(null, { state: 'unknown' }),
      detail: list.ok
        ? `Across ${fmt(settledRows.length)} settled call${settledRows.length === 1 ? '' : 's'}. This is a sum over the calls listed below, not a window total — the gateway exposes no revenue aggregate, so a figure for the whole ${esc(w.label)} would be a guess.`
        : 'Invocations could not be read from Gateway.',
      source: `Source: settlement sub-records on the newest ${fmt(list.rows.length)} invocations`,
    })}
    ${answer({
      title: 'Collected by agent',
      body: byAgent.length ? hbars(byAgent, (v) => usdc(String(Math.round(v)))) : '<p class="src m0" >Nothing has settled in these calls.</p>',
      detail: priced.length
        ? `${priced.map((a) => `${esc(a.name)} at ${esc(usdc(a.pricing.amount))}`).join(', ')}.`
        : 'No agent is priced, so the payment gate never engages.',
      source: 'Source: agent pricing and settlement sub-records',
    })}
  </div>

  <div class="sec">
    <h2>Paid calls</h2>
    ${table(
      [{ label: 'When' }, { label: 'Agent' }, { label: 'Amount' }, { label: 'Settlement' }, { label: 'Result' }, { label: 'Payer' }],
      paid.map((r) => `<tr class="click" data-go="#traffic/${esc(r.id)}">
        <td>${esc(ago(r.created_at))}</td>
        <td class="name">${esc(agents.names.get(r.agent_id) || r.agent_id)}</td>
        <td>${esc(usdc(r.payment_amount))} <span class="sub">${esc(r.payment_asset || '')}</span></td>
        <td>${r.settlement ? st(SETTLEMENT_TONE[r.settlement.status] || 'off', r.settlement.status.replace(/_/g, ' ')) : tag('off', 'not settled')}</td>
        <td>${r.status === 'failed' ? st('bad', 'Failed') : st('good', 'Succeeded')}</td>
        <td class="mono xs" >${r.payment_payer ? `${esc(r.payment_payer.slice(0, 8))}…${esc(r.payment_payer.slice(-4))}` : '—'}</td>
      </tr>`),
      { emptyText: `No paid call in the ${w.label}. An unpaid call is challenged with a 402 and never becomes an invocation, so it is not listed here either.` }
    )}
    ${failedAfterPay.length ? `<p class="src"><b>${fmt(failedAfterPay.length)} paid call${failedAfterPay.length === 1 ? '' : 's'} failed after the payment was verified.</b> On a settlement-enabled route the money moved first, so these are the rows to check before anyone asks for a refund.</p>` : ''}
  </div>

  <div class="sec card">
    <h2>Settlement</h2>
    ${configured
      ? `<dl class="kv">
          <dt>Facilitator</dt><dd class="mono">${esc(config.value.facilitator_url)}</dd>
          <dt>Credential</dt><dd class="mono">${esc(config.value.facilitator_credential_ref)}</dd>
          <dt>Configured</dt><dd>${esc(when(config.value.created_at))}</dd>
        </dl>
        <p class="src">The gateway verifies a signed authorization locally, hands it to this facilitator to submit on-chain, and only calls the upstream once that succeeds — so there is no "served but not paid" state to reconcile.</p>`
      : `<p class="src">No facilitator is configured for this tenant. The x402 gate still runs: a priced call without a valid authorization is answered with a 402 challenge and never reaches the upstream.</p>`}
  </div>`;
}

function state_orchestration(s) {
  return Boolean(s.capabilities?.posture?.settlement_orchestration);
}
