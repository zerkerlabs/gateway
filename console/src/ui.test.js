import assert from 'node:assert/strict';
import test from 'node:test';

import { big, bytes, denseBuckets, esc, fmt, foldGroups, hbars, ms, pct, spark, usdc } from './ui.js';

// The rule this console is built around: an absent value is never a zero, and
// a value still being read is neither.
test('an absent number renders Unknown, never zero', () => {
  assert.equal(fmt(undefined), 'Unknown');
  assert.equal(fmt(null), 'Unknown');
  assert.equal(fmt(0), '0');
  assert.equal(ms(null), 'Unknown');
  assert.equal(ms(0), '0 ms');
  assert.equal(bytes(undefined), 'Unknown');
  assert.equal(bytes(0), '0 B');
  assert.equal(pct(null), 'Unknown');
  assert.equal(pct(0), '0%');
});

test('the three states of a headline value are visually distinct', () => {
  const loading = big(null, { state: 'loading' });
  const unknown = big(null, { state: 'unknown' });
  const zero = big('0', { tone: 'good' });

  assert.match(loading, /skeleton/);
  assert.doesNotMatch(loading, /Unknown/);

  assert.match(unknown, /class="big unknown"/);
  assert.match(unknown, /Unknown/);

  assert.match(zero, /class="big"/);
  assert.doesNotMatch(zero, /unknown/);
  assert.match(zero, />0</);
});

test('USDC amounts are parsed as exact integer strings, not floats', () => {
  assert.equal(usdc('25000'), '$0.025');
  assert.equal(usdc('1000000'), '$1.00');
  assert.equal(usdc('250'), '$0.00025');
  assert.equal(usdc(''), 'Unknown');
  assert.equal(usdc('not-a-number'), 'Unknown');
});

test('markup from gateway values is escaped', () => {
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.match(hbars([{ k: '<b>x</b>', v: 1 }], String), /&lt;b&gt;x&lt;\/b&gt;/);
});

// A percentile cannot be merged across buckets. The fold must refuse to carry
// one rather than present a number that is not a percentile of anything.
test('a per-agent percentile is dropped once the window spans buckets', () => {
  const one = foldGroups([{ agent_id: 'a', count: 10, latency_ms: { p95: 120 }, by_error_class: {} }]);
  assert.equal(one.agents.get('a').p95, 120);

  const many = foldGroups([
    { agent_id: 'a', count: 10, latency_ms: { p95: 120 }, by_error_class: {} },
    { agent_id: 'a', count: 4, latency_ms: { p95: 900 }, by_error_class: { timeout: 2 } },
  ]);
  assert.equal(many.agents.get('a').p95, null, 'a merged percentile must not be invented');
  assert.equal(many.agents.get('a').merged, true);
  assert.equal(many.agents.get('a').calls, 14, 'counts do add across buckets');
  assert.equal(many.agents.get('a').errors, 2);
});

// The gateway returns only buckets that have rows. Charting just those makes
// one busy hour and a steady week look identical.
test('the chart axis spans the whole window, not just the buckets with data', () => {
  const now = Date.parse('2026-09-07T12:30:00Z');
  const groups = [{ agent_id: 'a', bucket_start: '2026-09-07T12:00:00Z', count: 25, by_error_class: {} }];
  const series = denseBuckets(groups, '24h', now);

  assert.equal(series.counts.length, 24, 'a 24-hour window is 24 hourly slots');
  assert.equal(series.counts.at(-1), 25, 'the populated bucket lands in the newest slot');
  assert.equal(series.counts.slice(0, -1).every((c) => c === 0), true, 'the rest are measured zeroes');
  assert.equal(series.labels.at(-1), '12:00');
});

test('a day-bucketed window places each day in its own slot', () => {
  const now = Date.parse('2026-09-07T12:30:00Z');
  const series = denseBuckets(
    [
      { agent_id: 'a', bucket_start: '2026-09-07T00:00:00Z', count: 3, by_error_class: {} },
      { agent_id: 'a', bucket_start: '2026-09-05T00:00:00Z', count: 7, by_error_class: {} },
    ],
    '7d',
    now
  );
  assert.equal(series.counts.length, 7);
  assert.equal(series.counts.at(-1), 3);
  assert.equal(series.counts.at(-3), 7);
});

test('an empty series renders an explanation rather than an empty chart', () => {
  assert.match(spark([], 'Calls'), /No traffic in this window/);
});
