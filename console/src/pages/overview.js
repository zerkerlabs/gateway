// Overview: the five questions an operator asks before they know what is wrong.
//
// Everything here is a real read. Where a read fails or a surface is not
// mounted, the answer says so — it never falls back to a zero, because "no
// denials" and "this gateway cannot tell me about denials" would send an
// operator in opposite directions.

import { agentIndex, denialCount, recentInvocations, settled, windowAnalytics, agentHealth } from './shared.js';
import { api } from '../live/api.js';
import { answer, ago, bars, big, denseBuckets, esc, fmt, foldGroups, ms, pct, spark, WINDOWS } from '../ui.js';

// What needs a look, derived from reads that already happened.
//
// Exported and pure so the rules can be tested without a browser. Each rule
// fires only on a fact the gateway actually reported: a read that failed
// produces no item at all, because "we could not tell" is not the same alarm
// as "nothing is wrong" and must not be rendered as either.
export function deriveAttention({ agents = [], folded, denials, posture, completed = [], signed = [], settlementConfigured, word = 'today' }) {
  const items = [];
  for (const a of agents) {
    const h = agentHealth(a, folded);
    if (!h.failing) continue;
    items.push({
      tone: 'bad',
      html: `<b>${esc(a.name)}</b> failed ${pct(h.errors / h.calls)} of its calls ${word} (${fmt(h.errors)} of ${fmt(h.calls)}).`,
      go: `#traffic/agent/${a.id}`,
      cta: 'See the failed calls',
    });
  }
  if (denials?.ok && denials.value > 0) {
    items.push({
      tone: 'attn',
      html: `Policy refused <b>${fmt(denials.value)} call${denials.value === 1 ? '' : 's'}</b> ${word}.`,
      go: '#policy',
      cta: 'See why',
    });
  }
  if (agents.some((a) => a.pricing) && settlementConfigured === false) {
    items.push({
      tone: 'attn',
      html: 'Priced agents are gating calls but <b>no settlement destination</b> is configured, so nothing is being collected.',
      go: '#payments',
      cta: 'See payments',
    });
  }
  if (posture?.receipts_enabled && completed.length && signed.length < completed.length) {
    items.push({
      tone: 'attn',
      html: `<b>${fmt(completed.length - signed.length)}</b> of the newest ${fmt(completed.length)} calls carry no receipt reference.`,
      go: '#receipts',
      cta: 'See coverage',
    });
  }
  if (posture?.store === 'memory') {
    items.push({
      tone: 'attn',
      html: 'This gateway is running on an <b>in-memory store</b>. Everything registered is lost on restart.',
      go: '#system',
      cta: 'See the deployment',
    });
  }
  return items;
}

export async function overviewPage(state) {
  const w = WINDOWS[state.win];
  const surfaces = state.capabilities?.surfaces || {};
  const posture = state.capabilities?.posture || null;

  const [analytics, agents, denials, recent, settlement] = await Promise.all([
    windowAnalytics(state),
    agentIndex(),
    surfaces.policy_decisions === false ? Promise.resolve({ ok: false, reason: 'unmounted' }) : denialCount(state),
    recentInvocations(state, { limit: 100 }),
    settled(api.getSettlementConfig()),
  ]);

  const folded = foldGroups(analytics.groups);
  const totals = analytics.totals;
  const active = agents.agents.filter((a) => a.status === 'active' && !a.suspended);
  const paused = agents.agents.filter((a) => a.suspended);
  const pending = agents.agents.filter((a) => a.status === 'pending');
  const failing = agents.agents.filter((a) => agentHealth(a, folded).failing);

  // Receipt coverage is computed over the rows actually fetched, and labelled
  // that way. There is no server-side count of attested invocations, and a
  // page-scoped tally presented as a window figure would be exactly the kind of
  // plausible number this console refuses to invent.
  const receiptable = recent.rows.filter((r) => r.status === 'succeeded' || r.status === 'failed');
  const signed = receiptable.filter((r) => r.receipt_artifact_id);

  const attention = deriveAttention({
    agents: agents.agents,
    folded,
    denials,
    posture,
    completed: receiptable,
    signed,
    settlementConfigured: settlement.ok ? Boolean(settlement.value) : null,
    word: w.word,
  });
  state.attention = attention.filter((a) => a.tone === 'bad').length;

  const greeting = state.identity?.user_id ? `Tenant ${state.identity.tenant_id}` : 'Your gateway';

  return `<h1>${esc(greeting)}</h1>
  <p class="lede">${fmt(agents.agents.length)} agents behind one gateway. ${
    attention.length
      ? `<b>${attention.length} thing${attention.length > 1 ? 's' : ''} need${attention.length > 1 ? '' : 's'} a look.</b>`
      : '<b>Nothing needs your attention.</b>'
  }</p>

  ${attention.length ? `<div class="attn-strip">${attention.slice(0, 4).map((a) => `<div class="attn-item ${esc(a.tone)}"><span class="dot ${esc(a.tone)}"></span><span>${a.html}</span><a class="go" href="${esc(a.go)}">${esc(a.cta)} →</a></div>`).join('')}</div>` : ''}

  <div class="answers">
    ${answer({
      title: 'What is running?',
      body: agents.ok ? big(`${active.length} agents`, { tone: 'good' }) : big(null, { state: 'unknown' }),
      detail: agents.ok
        ? `${fmt(active.length)} active, ${fmt(paused.length)} paused, ${fmt(pending.length)} not connected yet. <a href="#agents">See the agents</a>`
        : 'The agent catalog could not be read from Gateway.',
      source: 'Source: agent catalog',
    })}

    ${answer({
      title: 'What is failing?',
      body: !analytics.ok
        ? big(null, { state: 'unknown' })
        : big(failing.length ? `${failing.length} agent${failing.length > 1 ? 's' : ''}` : 'Nothing', {
            tone: failing.length ? 'bad' : totals?.errorRate > 0.01 ? 'attn' : 'good',
          }),
      detail: analytics.ok && totals?.available
        ? totals.calls === 0
          ? `No calls in this window. That is a measured zero, not a missing read.`
          : `${fmt(Math.round(totals.errorRate * totals.calls))} of ${fmt(totals.calls)} calls failed (${pct(totals.errorRate)}), p95 ${ms(totals.latencyP95Ms)}. <a href="#traffic/failed">See the failed calls</a>`
        : analytics.ok
          ? 'This Gateway does not report window totals, so a rate over this window cannot be computed.'
          : 'The traffic aggregate could not be read from Gateway.',
      source: `Source: analytics totals · ${w.label} · percentiles computed by the gateway`,
    })}

    ${answer({
      title: 'What was refused?',
      body: denials.ok
        ? big(fmt(denials.value), { tone: denials.value > 0 ? 'attn' : 'good' })
        : big(null, { state: 'unknown' }),
      detail: denials.ok
        ? `call${denials.value === 1 ? '' : 's'} denied by policy ${w.word}. A denied call never becomes an invocation, so the decision log is the only record of it. <a href="#policy">See the rules</a>`
        : denials.reason === 'unmounted'
          ? 'No policy surface is mounted on this Gateway.'
          : 'The decision log could not be read from Gateway.',
      source: `Source: policy decisions · ${w.label}`,
    })}

    ${answer({
      title: 'What can I prove?',
      body: posture
        ? big(posture.receipts_enabled ? 'Signed' : 'Off', { tone: posture.receipts_enabled ? 'good' : 'off' })
        : big(null, { state: 'unknown' }),
      detail: !posture
        ? 'This Gateway does not report whether it signs receipts.'
        : posture.receipts_enabled
          ? `${fmt(signed.length)} of the newest ${fmt(receiptable.length)} completed calls carry an artifact, signed as ${esc(posture.receipt_actor || 'this gateway')}. <a href="#receipts">Verify one</a>`
          : 'Receipts are not enabled on this deployment, so calls carry no signed evidence.',
      source: 'Source: capabilities and the newest 100 invocations',
    })}
  </div>

  <div class="sec card">
    <div class="row"><h2>Calls ${esc(w.word)}</h2><span class="src m0" >${
      totals?.available ? `${fmt(totals.calls)} calls · ${pct(totals.errorRate)} failed · ${ms(totals.latencyP95Ms)} p95` : 'Totals unavailable'
    }</span></div>
    ${analytics.ok
      ? (() => {
          const series = denseBuckets(analytics.groups, state.win);
          return state.win === '24h'
            ? spark(series.counts, 'Calls per hour')
            : bars(series.counts, series.labels, '', 'calls');
        })()
      : '<div class="empty">The traffic chart could not be read from Gateway.</div>'}
    <p class="src">Buckets come from the gateway's own aggregation${analytics.since ? ` since ${esc(ago(analytics.since))}` : ''}.</p>
  </div>`;
}
