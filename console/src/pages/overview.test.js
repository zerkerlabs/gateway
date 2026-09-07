import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveAttention } from './overview.js';
import { foldGroups } from '../ui.js';

const failing = { id: 'agt_1', name: 'lead-enrichment' };
const foldedFailing = foldGroups([
  { agent_id: 'agt_1', count: 3, by_error_class: { upstream_5xx: 3 }, latency_ms: {} },
]);
const foldedHealthy = foldGroups([{ agent_id: 'agt_1', count: 300, by_error_class: {}, latency_ms: {} }]);

test('a failing agent is raised, with the numbers behind it', () => {
  const items = deriveAttention({ agents: [failing], folded: foldedFailing });
  assert.equal(items.length, 1);
  assert.equal(items[0].tone, 'bad');
  assert.match(items[0].html, /lead-enrichment/);
  assert.match(items[0].html, /3 of 3/);
});

test('a healthy agent raises nothing', () => {
  assert.deepEqual(deriveAttention({ agents: [failing], folded: foldedHealthy }), []);
});

// The load-bearing rule. A read that failed must not produce an all-clear.
test('a denial count that could not be read raises nothing, and neither does a real zero', () => {
  const unread = deriveAttention({ agents: [], folded: foldGroups([]), denials: { ok: false, reason: 'error' } });
  assert.deepEqual(unread, [], 'an unreadable count is not an alarm');

  const zero = deriveAttention({ agents: [], folded: foldGroups([]), denials: { ok: true, value: 0 } });
  assert.deepEqual(zero, [], 'a measured zero is not an alarm either');

  const some = deriveAttention({ agents: [], folded: foldGroups([]), denials: { ok: true, value: 4 } });
  assert.equal(some.length, 1);
  assert.match(some[0].html, /4 calls/);
});

test('a priced agent with no settlement destination is raised, but only when we know there is none', () => {
  const agents = [{ id: 'a', name: 'billing', pricing: { amount: '25000' } }];
  const known = deriveAttention({ agents, folded: foldGroups([]), settlementConfigured: false });
  assert.equal(known.length, 1);
  assert.match(known[0].html, /no settlement destination/);

  const unknown = deriveAttention({ agents, folded: foldGroups([]), settlementConfigured: null });
  assert.deepEqual(unknown, [], 'an unreadable settlement config must not be reported as missing');

  const configured = deriveAttention({ agents, folded: foldGroups([]), settlementConfigured: true });
  assert.deepEqual(configured, []);
});

test('missing receipt references are raised only when this gateway signs at all', () => {
  const completed = [{}, {}, {}];
  const signed = [{}];

  const on = deriveAttention({ agents: [], folded: foldGroups([]), posture: { receipts_enabled: true }, completed, signed });
  assert.equal(on.length, 1);
  assert.match(on[0].html, /2<\/b> of the newest 3/);

  const off = deriveAttention({ agents: [], folded: foldGroups([]), posture: { receipts_enabled: false }, completed, signed: [] });
  assert.deepEqual(off, [], 'a gateway that never signs is not missing receipts');
});

test('a non-durable store is raised as a deployment fact', () => {
  const items = deriveAttention({ agents: [], folded: foldGroups([]), posture: { store: 'memory' } });
  assert.equal(items.length, 1);
  assert.match(items[0].html, /in-memory store/);
});

test('an agent name from the gateway cannot inject markup', () => {
  const items = deriveAttention({
    agents: [{ id: 'x', name: '<img src=x onerror=alert(1)>' }],
    folded: foldGroups([{ agent_id: 'x', count: 3, by_error_class: { timeout: 3 }, latency_ms: {} }]),
  });
  assert.match(items[0].html, /&lt;img/);
  assert.doesNotMatch(items[0].html, /<img/);
});
