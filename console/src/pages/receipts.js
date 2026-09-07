// Receipts: what carries proof, and how to check it without this console.

import { agentIndex, recentInvocations, settled } from './shared.js';
import { api } from '../live/api.js';
import { ago, answer, big, esc, fmt, sinceOf, table, tag, WINDOWS } from '../ui.js';

export async function receiptsPage(s) {
  const w = WINDOWS[s.win];
  const posture = s.capabilities?.posture || null;

  const [list, agents, denials] = await Promise.all([
    recentInvocations(s, { limit: 100 }),
    agentIndex(),
    settled(api.listPolicyDecisions({ since: sinceOf(s.win), action: 'deny', limit: 100, offset: 0 })),
  ]);

  const completed = (list.rows || []).filter((r) => r.status === 'succeeded' || r.status === 'failed');
  const signed = completed.filter((r) => r.receipt_artifact_id);
  const unsigned = completed.filter((r) => !r.receipt_artifact_id);
  const receiptsOffAgents = agents.agents.filter((a) => !a.emit_receipts && a.status === 'active');

  const denyRows = denials.ok ? denials.value?.data || [] : [];
  const denySigned = denyRows.filter((d) => d.receipt_artifact_id);

  const coverage = completed.length ? Math.round((signed.length / completed.length) * 100) : null;
  const sample = signed[0];

  return `<h1>Receipts</h1>
  <p class="lede">${
    !posture
      ? 'This Gateway does not report whether it signs receipts.'
      : posture.receipts_enabled
        ? `Every completed and refused call is signed as <b>${esc(posture.receipt_actor || 'this gateway')}</b>. A receipt is a Treeship artifact binding the call, its outcome and its shape — checkable by anyone, without trusting this console.`
        : '<b>Receipts are not enabled on this deployment.</b> Calls run normally and carry no signed evidence.'
  }</p>

  <div class="answers">
    ${answer({
      title: `Coverage, newest ${fmt(completed.length)} calls`,
      body: coverage === null ? big(null, { state: 'unknown' }) : big(`${coverage}%`, { tone: coverage === 100 ? 'good' : 'attn' }),
      detail: completed.length
        ? `${fmt(signed.length)} of ${fmt(completed.length)} completed calls carry an artifact reference. This counts the calls listed, not the whole window — the gateway offers no filter for attested calls, so a window figure would be a guess.`
        : `No completed calls in the ${w.label}.`,
      source: `Source: receipt_artifact_id on the newest ${fmt(completed.length)} invocations`,
    })}
    ${answer({
      title: 'Verify one yourself',
      body: sample
        ? `<pre class="mt6">treeship verify ${esc(sample.receipt_artifact_id)}</pre>`
        : '<p class="src m0" >No signed call in this window to demonstrate with.</p>',
      detail: 'Run it on any machine with Treeship installed. No login, no console, no gateway — the verifier checks the signature, the signing key, and the artifact chain on their own.',
      source: 'Gateway reports what it signed; it never reports that a signature holds.',
    })}
  </div>

  <div class="sec">
    <h2>Signed calls</h2>
    ${table(
      [{ label: 'When' }, { label: 'Agent' }, { label: 'Result' }, { label: 'Artifact' }],
      signed.slice(0, 25).map((r) => `<tr class="click" data-go="#traffic/${esc(r.id)}">
        <td>${esc(ago(r.created_at))}</td>
        <td class="name">${esc(agents.names.get(r.agent_id) || r.agent_id)}</td>
        <td>${r.status === 'failed' ? tag('bad', 'failed') : tag('good', 'succeeded')}</td>
        <td class="mono xs" >${esc(r.receipt_artifact_id)}</td>
      </tr>`),
      { emptyText: 'No call in this window carries an artifact reference.' }
    )}
  </div>

  ${unsigned.length ? `<div class="sec">
    <h2>Completed without a receipt reference</h2>
    ${table(
      [{ label: 'When' }, { label: 'Agent' }, { label: 'Why it might be missing' }],
      unsigned.slice(0, 15).map((r) => {
        const agent = agents.agents.find((a) => a.id === r.agent_id);
        return `<tr class="click" data-go="#traffic/${esc(r.id)}">
          <td>${esc(ago(r.created_at))}</td>
          <td class="name">${esc(agent?.name || r.agent_id)}</td>
          <td class="sub">${esc(
            !posture?.receipts_enabled
              ? 'Receipts are off on this deployment'
              : agent && !agent.emit_receipts
                ? 'This agent has emit_receipts off'
                : 'Emission is fail-open and can be skipped under load'
          )}</td>
        </tr>`;
      }),
      { emptyText: '' }
    )}
    <p class="src">Receipts are signed off the request path so they can never slow a call down. The cost is that a burst can skip some, and a skipped one is absent rather than hidden — absence here is not proof that nothing was signed.</p>
  </div>` : ''}

  <div class="sec card">
    <h2>Refusals are signed too</h2>
    <p class="mb8">A blocked call never becomes an invocation, so its receipt is the only durable evidence that the gateway stopped it. ${
      denials.ok
        ? `${fmt(denySigned.length)} of the ${fmt(denyRows.length)} refusals in this window carry their own artifact.`
        : 'The decision log could not be read, so refusal coverage is unknown.'
    } <a href="#policy">See the refusals</a></p>
    ${receiptsOffAgents.length ? `<p class="src">${fmt(receiptsOffAgents.length)} active agent${receiptsOffAgents.length === 1 ? ' has' : 's have'} receipts turned off and are not counted above: ${receiptsOffAgents.map((a) => esc(a.name)).join(', ')}.</p>` : ''}
  </div>`;
}
