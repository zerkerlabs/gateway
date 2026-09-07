// Activity: what the coding agents on your team's machines reported.
//
// This is the metadata-only surface. The adapters send session boundaries, tool
// names and outcomes, model identity, token counts and reported cost — and the
// contract has no field for a prompt, an argument, an output, a command, or a
// path. That boundary is the point of the page, so it is stated on it.

import { agentIndex, settled } from './shared.js';
import { api } from '../live/api.js';
import { esc, fmt, sinceOf, table, tag, WINDOWS } from '../ui.js';

export async function activityPage(s) {
  const w = WINDOWS[s.win];
  if (s.capabilities?.surfaces?.agent_events === false) {
    return `<h1>Agent activity</h1><p class="lede">This Gateway has no agent-activity surface mounted.</p>`;
  }

  const agents = await agentIndex();
  if (!agents.ok) return `<h1>Agent activity</h1><p class="lede">The agent catalog could not be read from Gateway.</p>`;

  const since = sinceOf(s.win);
  const until = new Date().toISOString();
  const summaries = await Promise.all(
    agents.agents.map(async (a) => ({
      agent: a,
      res: await settled(api.summarizeAgentEvents(a.id, { since, until })),
    }))
  );

  const reporting = summaries.filter((x) => x.res.ok && (x.res.value?.summary?.sessions || 0) > 0);
  const rows = summaries
    .filter((x) => x.res.ok)
    .map(({ agent, res }) => {
      const sum = res.value?.summary || {};
      const sessions = sum.sessions ?? 0;
      const tools = sum.tool_calls ?? 0;
      const failed = sum.tool_outcomes?.failed ?? 0;
      const tokens = (sum.input_tokens ?? 0) + (sum.output_tokens ?? 0);
      // cost_known false means an adapter reported tokens but no cost. That is
      // unknown, not zero, and rendering it as $0.00 would understate spend.
      const costKnown = sum.cost_known !== false && sum.cost_usd !== null && sum.cost_usd !== undefined;
      return `<tr>
        <td class="name">${esc(agent.name)}</td>
        <td>${sessions > 0 ? tag('good', 'reporting') : tag('off', 'no events')}</td>
        <td class="num">${fmt(sessions)}</td>
        <td class="num">${fmt(tools)}</td>
        <td class="num">${failed ? `<span class="fail-count">${fmt(failed)}</span>` : '0'}</td>
        <td class="num">${tokens ? `${(tokens / 1e6).toFixed(2)} M` : '—'}</td>
        <td class="num">${costKnown ? `$${Number(sum.cost_usd).toFixed(2)}` : tokens ? tag('attn', 'not reported') : '—'}</td>
      </tr>`;
    });

  return `<h1>Agent activity</h1>
  <p class="lede"><b>${fmt(reporting.length)} of ${fmt(agents.agents.length)} agents reported activity ${esc(w.word)}.</b> This is metadata only: sessions, tool names, outcomes, model identity, token counts and cost. The contract has no field for a prompt, an argument, a tool output, a shell command, or a file path, and the endpoint rejects unknown fields rather than quietly dropping them.</p>

  ${table(
    [
      { label: 'Agent' }, { label: 'Status' }, { label: 'Sessions', num: true },
      { label: 'Tool calls', num: true }, { label: 'Failed', num: true },
      { label: 'Tokens', num: true }, { label: 'Cost', num: true },
    ],
    rows,
    { emptyText: 'No agent has reported activity.' }
  )}
  <p class="src">Reported by adapters running on your machines, not measured by the gateway. A cost of "not reported" means the adapter sent token counts without a price — that is unknown, and is deliberately not shown as zero.</p>

  <div class="sec card">
    <h2>Connect another machine</h2>
    <p class="mb8">One command, then restart the coding agent. Nothing is collected until it is enrolled.</p>
    <pre>python3 integrations/claude-code/install.py   # or codex, gemini-cli, hermes
./bin/zerker status                            # shows what is and is not collected</pre>
    <p class="src">Adapters exist for Claude Code, Codex, Gemini CLI, Hermes and Pi. Each one fails open: if the gateway is unreachable, the agent keeps working and the events are dropped.</p>
  </div>`;
}
